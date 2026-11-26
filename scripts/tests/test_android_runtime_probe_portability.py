"""Keep Android artifact checks usable without a supported source build host."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME_TESTS = ROOT / 'scripts/tests/test_android_node_runtime.py'
PROBE = ROOT / 'scripts/sub-store/android-runtime-probe.cjs'
NODE = shutil.which('node')


class AndroidRuntimePortabilityTests(unittest.TestCase):
    def import_runtime_tests(self, setup='', env=None):
        code = f'''
import builtins, importlib.util, json, os, sys, types
# Scope the simulated platform to the target module; standard-library imports
# must keep the real host platform (Python 3.12 shutil imports _winapi on Windows).
host_import = builtins.__import__
os = types.SimpleNamespace(**vars(os))
sys = types.SimpleNamespace(**vars(sys))
{setup}
def target_import(name, *args, **kwargs):
    if name == 'os': return os
    if name == 'sys': return sys
    return host_import(name, *args, **kwargs)
spec = importlib.util.spec_from_file_location('android_runtime_tests', {str(RUNTIME_TESTS)!r})
module = importlib.util.module_from_spec(spec)
module.__dict__['__builtins__'] = {{**vars(builtins), '__import__': target_import}}
spec.loader.exec_module(module)
tests = module.AndroidNodeRuntimeTests
print(json.dumps({{'node': module.NODE, 'classSkipped': bool(getattr(tests, '__unittest_skip__', False)),
                  'skips': {{name: bool(getattr(getattr(tests, name), '__unittest_skip__', False))
                            for name in dir(tests) if name.startswith('test_')}}}}))
'''
        return subprocess.run([sys.executable, '-c', code], cwd=ROOT, text=True,
                              capture_output=True, env=env)

    def test_windows_without_uname_skips_builds_and_keeps_artifact_checks(self):
        result = self.import_runtime_tests(
            "if hasattr(os, 'uname'): del os.uname\nsys.platform = 'win32'")
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        if NODE:
            self.assertFalse(value['classSkipped'])
        for name in ('test_build_input_pins_source_ndk_api_and_complete_features',
                     'test_stale_build_input_is_rejected_before_reuse',
                     'test_build_orchestration_targets_only_runtime_with_complete_configuration',
                     'test_darwin_host_libuv_selects_complete_bsd_sources',
                     'test_darwin_host_v8_trap_handlers_support_snapshot_tools'):
            self.assertTrue(value['skips'][name], name)
        for name in ('test_desktop_and_missing_binary_are_rejected',
                     'test_official_node_config_comment_header_preserves_builtin_checks',
                     'test_elf_fixture_validation_and_smoke_binding_are_platform_independent',
                     'test_probe_exercises_complete_host_builtins_and_requires_android_by_default'):
            self.assertFalse(value['skips'][name], name)

    def test_missing_node_skips_instead_of_using_machine_specific_fallback(self):
        result = self.import_runtime_tests(env={**os.environ, 'PATH': ''})
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertIsNone(value['node'])
        self.assertTrue(value['classSkipped'])

    @unittest.skipUnless(NODE and shutil.which('git'), 'Node.js and Git are required by the scanner')
    def test_probe_source_passes_the_existing_private_key_scanner(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts = Path(directory) / 'scripts'
            scripts.mkdir()
            for name in ('secret-scan.mjs', 'source-candidates.mjs'):
                shutil.copyfile(ROOT / 'scripts' / name, scripts / name)
            shutil.copyfile(PROBE, scripts / PROBE.name)
            subprocess.run(['git', 'init', '--quiet', directory], check=True,
                           text=True, capture_output=True)
            result = subprocess.run([NODE, str(scripts / 'secret-scan.mjs')], cwd=directory,
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(NODE, 'Node.js runtime is unavailable')
    def test_elf_cli_accepts_windows_host_without_build_inputs(self):
        from scripts.tests.test_android_node_runtime import write_android_elf_fixture
        code = r'''
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const script = path.resolve('scripts/sub-store/build-android-runtime.cjs');
const fakeModule = { exports: {} };
const nativeRequire = require('node:module').createRequire(script);
const controlledRequire = (name) => nativeRequire(name);
controlledRequire.main = fakeModule;
const controlledProcess = { ...process, platform: 'win32',
  argv: [process.execPath, script, '--target', 'android-arm64', '--verify-elf', process.argv[1]], exitCode: 0 };
vm.runInNewContext(fs.readFileSync(script, 'utf8'), {
  require: controlledRequire, module: fakeModule, __dirname: path.dirname(script),
  process: controlledProcess, console, Buffer,
});
process.exitCode = controlledProcess.exitCode;
'''
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'android-node'
            write_android_elf_fixture(binary)
            result = subprocess.run([NODE, '-e', code, str(binary)], cwd=ROOT,
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['androidApi'], 24)

    @unittest.skipUnless(NODE, 'Node.js runtime is unavailable')
    def test_probe_generates_fresh_valid_localhost_credentials_in_memory(self):
        code = r'''
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createProbeCredentials } = require('./scripts/sub-store/android-runtime-probe.cjs');
const first = createProbeCredentials(), second = createProbeCredentials();
const firstCert = new crypto.X509Certificate(first.cert);
const secondCert = new crypto.X509Certificate(second.cert);
for (const [identity, cert] of [[first, firstCert], [second, secondCert]]) {
  assert.equal(cert.verify(cert.publicKey), true);
  assert.equal(cert.checkPrivateKey(crypto.createPrivateKey(identity.key)), true);
  assert.equal(cert.checkHost('localhost'), 'localhost');
  assert.ok(Date.parse(cert.validFrom) < Date.now());
  assert.ok(Date.parse(cert.validTo) > Date.now());
  assert.ok(Date.parse(cert.validTo) - Date.now() <= 25 * 60 * 60 * 1000);
}
assert.notEqual(firstCert.fingerprint256, secondCert.fingerprint256);
assert.notEqual(first.key.toString(), second.key.toString());
console.log(JSON.stringify({ selfSigned: true, freshKeys: true, localhost: true }));
'''
        result = subprocess.run([NODE, '-e', code], cwd=ROOT, text=True,
                                capture_output=True, env={**os.environ, 'PATH': ''})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout),
                         {'selfSigned': True, 'freshKeys': True, 'localhost': True})


if __name__ == '__main__':
    unittest.main()
