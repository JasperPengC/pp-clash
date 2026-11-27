"""Exercise Android Node input pinning and ELF validation through the real CLI."""
import json
import hashlib
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/sub-store/build-android-runtime.cjs'
NODE = shutil.which('node')
NDK = Path(os.environ.get('ANDROID_NDK_HOME', ROOT / '.cache/android-sdk/ndk/28.2.13676358'))
SOURCE_BUILDS_SUPPORTED = sys.platform in ('darwin', 'linux')
HOST = {'darwin': 'darwin-x86_64', 'linux': 'linux-x86_64', 'win32': 'windows-x86_64'}.get(sys.platform, 'unsupported')
TOOLS = NDK / 'toolchains/llvm/prebuilt' / HOST / 'bin'


def ndk_tool(name):
    if sys.platform == 'win32':
        name += '.cmd' if name.endswith(('-clang', '-clang++')) else '.exe'
    return TOOLS / name


def write_android_elf_fixture(file, *, machine=183, page_size=16384, api=24, dependency='libc.so'):
    """Write a minimal ELF64 PIE with independently specified Android metadata."""
    data = bytearray(1024)
    data[:7] = b'\x7fELF\x02\x01\x01'
    struct.pack_into('<HHIQQQIHHHHHH', data, 16, 3, machine, 1, 0x10100, 64, 0,
                     0, 64, 56, 4, 0, 0, 0)
    interpreter = b'/system/bin/linker64\0'
    data[0x200:0x200 + len(interpreter)] = interpreter
    note = struct.pack('<III', 8, 4, 1) + b'Android\0' + struct.pack('<I', api)
    data[0x240:0x240 + len(note)] = note
    struct.pack_into('<QQQQQQ', data, 0x300, 5, 0x10380, 1, 1, 0, 0)
    strings = b'\0' + dependency.encode() + b'\0'
    data[0x380:0x380 + len(strings)] = strings
    for index, (kind, flags, offset, address, size, alignment) in enumerate([
            (1, 5, 0, 0x10000, len(data), page_size),
            (3, 4, 0x200, 0x10200, len(interpreter), 1),
            (4, 4, 0x240, 0x10240, len(note), 4),
            (2, 6, 0x300, 0x10300, 48, 8)]):
        struct.pack_into('<IIQQQQQQ', data, 64 + index * 56,
                         kind, flags, offset, address, address, size, size, alignment)
    file.write_bytes(data)


@unittest.skipUnless(NODE, 'Node.js runtime is unavailable')
class AndroidNodeRuntimeTests(unittest.TestCase):
    def cli(self, *args):
        return subprocess.run([NODE, str(SCRIPT), *args], cwd=ROOT, text=True, capture_output=True)

    @unittest.skipUnless(SOURCE_BUILDS_SUPPORTED, 'Android source builds require Darwin or Linux')
    def test_build_input_pins_source_ndk_api_and_complete_features(self):
        result = self.cli('--target', 'android-arm64', '--print-input')
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value['input']['nodeVersion'], '24.18.0')
        self.assertEqual(value['input']['source']['sha256'], 'e94afde24db08e0c564ee7110a2d5aab51ee0059382c9fd8233c54eec47b28f9')
        self.assertEqual(value['input']['ndkVersion'], '28.2.13676358')
        self.assertEqual(value['input']['androidApi'], 24)
        self.assertEqual(value['input']['features'], ['worker_threads', 'child_process', 'sqlite', 'tls'])
        x64 = json.loads(self.cli('--target', 'android-x64', '--print-input').stdout)
        self.assertNotEqual(value['sha256'], x64['sha256'])

    @unittest.skipUnless(SOURCE_BUILDS_SUPPORTED, 'Android source builds require Darwin or Linux')
    def test_stale_build_input_is_rejected_before_reuse(self):
        current = json.loads(self.cli('--target', 'android-arm64', '--print-input').stdout)
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / 'input.json'
            record.write_text(json.dumps(current))
            result = self.cli('--target', 'android-arm64', '--verify-input', str(record))
            self.assertEqual(result.returncode, 0, result.stderr)
            current['input']['androidApi'] = 23
            record.write_text(json.dumps(current))
            result = self.cli('--target', 'android-arm64', '--verify-input', str(record))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Build input mismatch', result.stderr)

    @unittest.skipUnless(ndk_tool('aarch64-linux-android24-clang').exists(), 'Pinned NDK is unavailable')
    def test_android_arm64_zlib_detects_cpu_features_without_unlinked_ndk_helpers(self):
        source = ROOT / '.cache/cross-platform-20261124/node/node-v24.18.0/deps/zlib'
        if not source.exists():
            self.skipTest('Official Node source is unavailable')
        with tempfile.TemporaryDirectory() as directory:
            obj = Path(directory) / 'cpu_features.o'
            subprocess.run([str(ndk_tool('aarch64-linux-android24-clang')), '-c',
                            str(source / 'cpu_features.c'), '-I', str(source),
                            '-I', str(NDK / 'sources/android/cpufeatures'),
                            '-DARMV8_OS_ANDROID', '-D__ARM_NEON__', '-fPIC',
                            '-o', str(obj)], check=True, capture_output=True)
            result = subprocess.run([str(ndk_tool('llvm-nm')), '-u', str(obj)],
                                    check=True, text=True, capture_output=True)
            self.assertNotIn('android_getCpuFeatures', result.stdout)
            self.assertIn('getauxval', result.stdout)

    @unittest.skipUnless(SOURCE_BUILDS_SUPPORTED, 'Android source builds require Darwin or Linux')
    @unittest.skipUnless((ROOT / '.cache/cross-platform-20261124/node/node-v24.18.0/config.gypi').exists(), 'Configured Android Node source is unavailable')
    def test_build_orchestration_targets_only_runtime_with_complete_configuration(self):
        code = r'''
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const script=path.resolve('scripts/sub-store/build-android-runtime.cjs');
const nativeRequire=require('node:module').createRequire(script),calls=[];
const source=path.resolve('.cache/cross-platform-20261124/node/node-v24.18.0');
const fakeModule={exports:{}};
const controlledRequire=(name)=>name==='node:child_process'?{spawnSync:(cmd,args,opts)=>{calls.push({cmd,args});return {status:cmd==='make'?1:0};}}:name==='node:fs'?{...fs,writeFileSync:()=>{},openSync:()=>1,closeSync:()=>{}}:nativeRequire(name);
controlledRequire.main=fakeModule;
const controlledProcess={...process,argv:[process.execPath,script,'--target','android-arm64','--source-dir',source,'--cache',path.resolve('.cache/cross-platform-20261124/node'),'--offline','--jobs','6'],exitCode:0};
vm.runInNewContext(fs.readFileSync(script,'utf8'),{require:controlledRequire,module:fakeModule,__dirname:path.dirname(script),process:controlledProcess,console:{log:()=>{},error:()=>{}},Buffer});
console.log(JSON.stringify({calls,source}));
'''
        result = subprocess.run([NODE, '-e', code], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        configure = next(call for call in value['calls'] if 'configure' in call['args'])
        self.assertEqual(configure['args'], ['configure', '--dest-cpu=arm64', '--dest-os=android', '--openssl-no-asm', '--cross-compiling'])
        make = next(call for call in value['calls'] if call['cmd'] == 'make')
        self.assertEqual(make['args'][:5], ['-j6', '-C', 'out', 'BUILDTYPE=Release', 'V=0'])
        self.assertEqual(make['args'][5], str(Path(value['source']) / 'out/Release/node'))
        self.assertIn('LDFLAGS.target=-static-libstdc++ -Wl,-z,max-page-size=16384 -pie', make['args'])

    def test_desktop_and_missing_binary_are_rejected(self):
        result = self.cli('--target', 'android-arm64', '--verify-elf', NODE)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ELF', result.stderr)

    def test_elf_fixture_validation_and_smoke_binding_are_platform_independent(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'android-node'
            write_android_elf_fixture(binary)
            result = self.cli('--target', 'android-arm64', '--verify-elf', str(binary))
            self.assertEqual(result.returncode, 0, result.stderr)
            metadata = json.loads(result.stdout)
            self.assertEqual(metadata['machine'], 183)
            self.assertEqual(metadata['androidApi'], 24)
            self.assertEqual(metadata['loadAlignment'], 16384)
            self.assertEqual(metadata['needed'], ['libc.so'])
            for options, error in [({'machine': 62}, 'ELF architecture mismatch'),
                                   ({'page_size': 4096}, '16KB'),
                                   ({'api': 25}, 'API note'),
                                   ({'dependency': 'libc++_shared.so'}, 'dynamic dependencies')]:
                write_android_elf_fixture(binary, **options)
                result = self.cli('--target', 'android-arm64', '--verify-elf', str(binary))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)
            write_android_elf_fixture(binary)
            smoke = {'nodeVersion': '24.18.0', 'platform': 'android', 'arch': 'arm64',
                     'runtimeSha256': metadata['sha256'],
                     'execPath': '/data/app/ppclash/lib/arm64/libppclash_node.so',
                     'worker_threads': 'ok', 'child_process': 'ok', 'sqlite': 'ok', 'tls': 'TLSv1.3'}
            smoke_file = Path(directory) / 'smoke.json'
            smoke_file.write_text(json.dumps(smoke))
            result = self.cli('--target', 'android-arm64', '--verify-elf', str(binary),
                              '--smoke-result', str(smoke_file))
            self.assertEqual(result.returncode, 0, result.stderr)
            smoke['runtimeSha256'] = '0' * 64
            smoke_file.write_text(json.dumps(smoke))
            result = self.cli('--target', 'android-arm64', '--verify-elf', str(binary),
                              '--smoke-result', str(smoke_file))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('executable checksum mismatch', result.stderr)

    def test_official_node_config_comment_header_preserves_builtin_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.gypi'
            variables = {'target_arch': 'arm64', 'node_use_sqlite': 'true', 'node_use_openssl': 'true'}
            config.write_text('# Do not edit. Generated by the configure script.\n' + json.dumps({'variables': variables}))
            code = 'const api=require("./scripts/sub-store/build-android-runtime.cjs");console.log(JSON.stringify(api.readNodeConfig(process.argv[1]).variables));'
            result = subprocess.run([NODE, '-e', code, str(config)], cwd=ROOT, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), variables)

    @unittest.skipUnless(ndk_tool('aarch64-linux-android24-clang').exists(), 'Pinned NDK is unavailable')
    def test_real_android_elf_rejects_wrong_abi_and_four_k_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'main.c'
            source.write_text('#include <stdio.h>\nint main(void) { puts("android"); return 0; }\n')
            for page_size in (16384, 4096):
                binary = Path(directory) / f'android-{page_size}'
                subprocess.run([str(ndk_tool('aarch64-linux-android24-clang')), str(source), '-pie',
                                f'-Wl,-z,max-page-size={page_size}', '-o', str(binary)], check=True, capture_output=True)
                result = self.cli('--target', 'android-arm64', '--verify-elf', str(binary))
                if page_size == 16384:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    metadata = json.loads(result.stdout)
                    self.assertEqual(metadata['interpreter'], '/system/bin/linker64')
                    self.assertEqual(metadata['androidApi'], 24)
                    self.assertEqual(metadata['machine'], 183)
                    probe = ROOT / 'scripts/sub-store/android-runtime-probe.cjs'
                    host_smoke = subprocess.run([NODE, str(probe), '--allow-host'], text=True, capture_output=True, check=True)
                    smoke_file = Path(directory) / 'smoke.json'
                    smoke_file.write_text(host_smoke.stdout)
                    smoke = self.cli('--target', 'android-arm64', '--verify-elf', str(binary), '--smoke-result', str(smoke_file))
                    self.assertNotEqual(smoke.returncode, 0)
                    self.assertIn('Android smoke', smoke.stderr)
                    wrong_abi = self.cli('--target', 'android-x64', '--verify-elf', str(binary))
                    self.assertNotEqual(wrong_abi.returncode, 0)
                    self.assertIn('ELF architecture mismatch', wrong_abi.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('16KB', result.stderr)


    @unittest.skipUnless(ndk_tool('aarch64-linux-android24-clang++').exists(), 'Pinned NDK is unavailable')
    def test_android_elf_rejects_newer_api_and_shared_cpp_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'main.cc'
            source.write_text('#include <iostream>\nint main() { std::cout << "android"; return 0; }\n')
            for api, flags, error in [(25, ['-static-libstdc++'], 'API note'),
                                      (24, ['-lc++_shared'], 'dynamic dependencies')]:
                binary = Path(directory) / f'android-{api}'
                subprocess.run([str(ndk_tool(f'aarch64-linux-android{api}-clang++')), str(source), '-pie',
                                '-Wl,-z,max-page-size=16384', *flags, '-o', str(binary)], check=True, capture_output=True)
                result = self.cli('--target', 'android-arm64', '--verify-elf', str(binary))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin-specific host configuration')
    @unittest.skipUnless((ROOT / '.cache/cross-platform-20261124/node/android-x64/node-v24.18.0/out/deps/uv/libuv.host.mk').exists(), 'Configured Android Node source is unavailable')
    def test_darwin_host_libuv_selects_complete_bsd_sources(self):
        makefile = ROOT / '.cache/cross-platform-20261124/node/android-x64/node-v24.18.0/out/deps/uv/libuv.host.mk'
        text = makefile.read_text()
        self.assertTrue('/unix/kqueue.o' in text, 'Darwin host libuv must include kqueue')
        self.assertIn('/unix/bsd-ifaddrs.o', text)
        self.assertIn('/unix/darwin.o', text)
        self.assertNotIn('/unix/linux.o', text)

    @unittest.skipUnless(sys.platform == 'linux', 'Linux-specific host configuration')
    @unittest.skipUnless(ndk_tool('aarch64-linux-android24-clang').exists(), 'Pinned NDK is unavailable')
    def test_linux_host_snapshot_configuration_selects_required_trap_handlers(self):
        archive = Path(os.environ.get('PPCLASH_NODE_SOURCE_ARCHIVE',
                                     ROOT / '.cache/sub-store-android/node-v24.18.0.tar.xz'))
        if not archive.is_file():
            self.skipTest('Pinned official Node source archive is unavailable')
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            shutil.copy2(archive, cache / archive.name)
            for target in ['android-arm64', 'android-x64']:
                with self.subTest(target=target):
                    configured = self.cli('--target', target, '--cache', str(cache),
                                          '--host-cc', 'gcc-12', '--host-cxx', 'g++-12',
                                          '--offline', '--configure-only')
                    self.assertEqual(configured.returncode, 0, configured.stderr)
                    generated = cache / target / 'node-v24.18.0/out/tools/v8_gypfiles'
                    host = set(re.findall(r'/trap-handler/([a-z-]+)\.o',
                                          (generated / 'v8_base_without_compiler.host.mk').read_text()))
                    required = {'handler-inside-posix', 'handler-outside-posix'}
                    if target == 'android-arm64':
                        required.add('handler-outside-simulator')
                    self.assertTrue(required <= host, f'Snapshot linker lacks host implementations: {required - host}')
                    android = set(re.findall(r'/trap-handler/([a-z-]+)\.o',
                                             (generated / 'v8_base_without_compiler.target.mk').read_text()))
                    self.assertFalse({'handler-inside-posix', 'handler-outside-posix',
                                      'handler-outside-simulator'} & android,
                                     'Host trap handlers must not be enabled in the Android target')

    def test_probe_exercises_complete_host_builtins_and_requires_android_by_default(self):
        probe = ROOT / 'scripts/sub-store/android-runtime-probe.cjs'
        result = subprocess.run([NODE, str(probe), '--allow-host'], text=True, capture_output=True,
                                env={**os.environ, 'PATH': ''})
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        for feature in ('worker_threads', 'child_process', 'sqlite'):
            self.assertEqual(output[feature], 'ok')
        self.assertEqual(output['tls'], 'TLSv1.3')
        self.assertEqual(output['runtimeSha256'], hashlib.sha256(Path(NODE).read_bytes()).hexdigest())
        if output['platform'] != 'android':
            result = subprocess.run([NODE, str(probe)], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('android', result.stderr)

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin-specific host configuration')
    @unittest.skipUnless((ROOT / '.cache/cross-platform-20261124/node/node-v24.18.0/out/tools/v8_gypfiles/v8_base_without_compiler.host.mk').exists(), 'Configured Android Node source is unavailable')
    def test_darwin_host_v8_trap_handlers_support_snapshot_tools(self):
        sources = [ROOT / '.cache/cross-platform-20261124/node/node-v24.18.0',
                   ROOT / '.cache/cross-platform-20261124/node/android-x64/node-v24.18.0']
        for source in sources:
            text = (source / 'out/tools/v8_gypfiles/v8_base_without_compiler.host.mk').read_text()
            self.assertTrue('/trap-handler/handler-inside-posix.o' in text, 'Host V8 must handle POSIX signals')
            self.assertTrue('/trap-handler/handler-outside-posix.o' in text, 'Host V8 must register POSIX trap handlers')
        arm64 = (sources[0] / 'out/tools/v8_gypfiles/v8_base_without_compiler.host.mk').read_text()
        self.assertTrue('/trap-handler/handler-outside-simulator.o' in arm64, 'ARM64 snapshot simulator must probe host memory')


if __name__ == '__main__':
    unittest.main()
