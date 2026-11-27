"""Exercise sealed runtime reuse through real CLI and archive boundaries."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

from scripts.tests.test_android_node_runtime import write_android_elf_fixture

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/sub-store/android-runtime-artifact.cjs'
NODE = shutil.which('node')


def digest(content):
    return hashlib.sha256(content).hexdigest()


@unittest.skipUnless(NODE, 'Node.js is unavailable')
class AndroidRuntimeArtifactTests(unittest.TestCase):
    def run_cli(self, command, *args):
        env = dict(os.environ, PYTHON=sys.executable, ANDROID_NDK_HOME='/missing-ndk', NDK_HOME='/missing-ndk')
        return subprocess.run([NODE, str(SCRIPT), command, '--root', str(self.project), *map(str, args)],
                              env=env, text=True, capture_output=True, timeout=20)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name) / 'project'
        self.project.mkdir()
        files = ['build-android-runtime.cjs', 'android-runtime-lock.json', 'download-pinned.cjs',
                 'prepare-shared.cjs', 'upstream-lock.json', 'strict-errors.patch',
                 'android-linux-host.patch', 'android-darwin-host.patch', 'android-target.patch']
        for name in files:
            destination = self.project / 'scripts/sub-store' / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / 'scripts/sub-store' / name, destination)
        self.resources = self.project / 'src-tauri/resources/sub-store'
        self.resources.mkdir(parents=True)
        shutil.copy2(ROOT / 'src-tauri/resources/sub-store/service-bootstrap.cjs', self.resources)
        self.set_engine(b'first independently built JS bundle')
        source_files = {p.relative_to(self.project).as_posix(): digest(p.read_bytes())
                        for p in (self.project / 'scripts/sub-store').iterdir()}
        self.source_manifest = self.project / 'source-manifest.json'
        self.source_manifest.write_text(json.dumps({'files': source_files,
            'sourceDigest': digest(json.dumps(source_files, sort_keys=True).encode())}))
        self.archives = {}
        for target, machine in [('android-arm64', 183), ('android-x64', 62)]:
            directory = self.resources / target
            directory.mkdir()
            write_android_elf_fixture(directory / 'node', machine=machine)
            (directory / 'node').chmod(0o755)
            (directory / 'LICENSE').write_bytes(b'Node and statically linked LLVM licenses')
            code = 'const a=require(process.argv[1]);console.log(JSON.stringify({input:a.buildInput(process.argv[2],"linux"),elf:a.verifyElf(process.argv[3],process.argv[2])}))'
            value = json.loads(subprocess.check_output([NODE, '-e', code,
                str(self.project / 'scripts/sub-store/build-android-runtime.cjs'), target, str(directory / 'node')]))
            value['input']['input']['buildHost'] = 'linux-x64'
            value['input']['sha256'] = digest(json.dumps(value['input']['input'], separators=(',', ':'), ensure_ascii=False).encode())
            source_build = {**value['input'], 'licenseSources': [
                {'source': 'Node source LICENSE', 'sha256': 'a' * 64},
                {'source': 'Android NDK LLVM toolchain NOTICE', 'sha256': 'b' * 64}],
                'configSha256': 'c' * 64, 'compiler': '/ndk/clang++', 'compilerVersion': 'Android clang',
                'compilerSha256': 'd' * 64, 'linkerSha256': 'e' * 64,
                'hostCompiler': 'g++-12', 'hostCompilerVersion': 'GCC 12', 'makeGoal': 'out/Release/node',
                'deviceSmoke': {'status': 'pending'}, 'unstrippedSha256': digest((directory / 'node').read_bytes()),
                'strip': ['llvm-strip', '--strip-debug'], 'elf': value['elf'], 'nativeLibraryName': 'libppclash_node.so'}
            paths = ['sub-store.bundle.cjs', 'service-bootstrap.cjs', 'build-provenance.json',
                     'runtime-manifest.json', target + '/node', target + '/LICENSE']
            manifest = {'schemaVersion': 1, 'engineVersion': '2.44.16', 'nodeVersion': '24.18.0', 'target': target,
                        'sourceBuild': source_build, 'files': [{'path': name,
                        'bytes': (self.resources / name).stat().st_size,
                        'sha256': digest((self.resources / name).read_bytes())} for name in paths]}
            (directory / 'manifest.json').write_text(json.dumps(manifest))
            archive = self.project / (target + '.tar.gz')
            result = self.run_cli('pack', '--target', target, '--resources', self.resources,
                                  '--source-manifest', self.source_manifest, '--output', archive)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.archives[target] = archive
        self.lock = self.project / 'artifacts-lock.json'
        result = self.run_cli('lock', '--arm64', self.archives['android-arm64'],
                             '--x64', self.archives['android-x64'], '--output', self.lock)
        self.assertEqual(result.returncode, 0, result.stderr)

    def set_engine(self, bundle):
        engine = self.project / '.cache/cloud-tools-20261121/runtime'
        engine.mkdir(parents=True, exist_ok=True)
        (engine / 'sub-store.strict.bundle.cjs').write_bytes(bundle)
        (engine / 'runtime-manifest-strict.json').write_bytes(b'{"engine":"fixture"}')
        upstream = json.loads((self.project / 'scripts/sub-store/upstream-lock.json').read_text())
        provenance = {**upstream, 'patch': 'scripts/sub-store/strict-errors.patch',
                      'patchSha256': digest((self.project / 'scripts/sub-store/strict-errors.patch').read_bytes()),
                      'output': {'bundle': {'sha256': digest(bundle)},
                                 'manifest': {'sha256': digest(b'{"engine":"fixture"}')}}}
        (engine / 'build-provenance.json').write_text(json.dumps(provenance))
        # The producer fixture has a verified current six-file resource layout.
        shutil.copy2(engine / 'sub-store.strict.bundle.cjs', self.resources / 'sub-store.bundle.cjs')
        shutil.copy2(engine / 'runtime-manifest-strict.json', self.resources / 'runtime-manifest.json')
        shutil.copy2(engine / 'build-provenance.json', self.resources / 'build-provenance.json')

    def prepare(self, target='android-arm64'):
        return self.run_cli('prepare', '--target', target, '--lock', self.lock,
                            '--archive', self.archives[target], '--offline')

    def rewrite_archive(self, mutate):
        archive = self.archives['android-arm64']
        with tarfile.open(archive, 'r:gz') as stream:
            contents = {m.name: stream.extractfile(m).read() for m in stream if m.isfile()}
        mutate(contents)
        with archive.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as stream:
                for name, content in contents.items():
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    info.mode = 0o755 if name == 'node' else 0o644
                    stream.addfile(info, io.BytesIO(content))
        lock = json.loads(self.lock.read_text())
        row = lock['targets']['android-arm64']
        row['sha256'] = digest(archive.read_bytes())
        row['bytes'] = archive.stat().st_size
        self.lock.write_text(json.dumps(lock))

    def test_prepared_runtime_reuses_binary_without_ndk_and_tracks_current_js(self):
        binary = (self.resources / 'android-arm64/node').read_bytes()
        shutil.rmtree(self.resources / 'android-arm64')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.resources / 'android-arm64/node').read_bytes(), binary)
        self.set_engine(b'second JS bundle; Node remains identical')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.resources / 'android-arm64/node').read_bytes(), binary)
        self.assertEqual((self.resources / 'sub-store.bundle.cjs').read_bytes(), b'second JS bundle; Node remains identical')
        manifest = json.loads((self.resources / 'android-arm64/manifest.json').read_text())
        row = next(r for r in manifest['files'] if r['path'] == 'sub-store.bundle.cjs')
        self.assertEqual(row['sha256'], digest(b'second JS bundle; Node remains identical'))
        verified = self.run_cli('verify', '--target', 'android-arm64', '--lock', self.lock, '--resources', self.resources)
        self.assertEqual(verified.returncode, 0, verified.stderr)

    def test_verify_rejects_resources_from_a_previous_shared_engine(self):
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        binary = (self.resources / 'android-arm64/node').read_bytes()
        names = ['sub-store.bundle.cjs', 'build-provenance.json', 'runtime-manifest.json']
        previous = {name: (self.resources / name).read_bytes() for name in names}
        self.set_engine(b'new engine artifact awaiting resource preparation')
        for name, content in previous.items():
            (self.resources / name).write_bytes(content)
        result = self.run_cli('verify', '--target', 'android-arm64', '--lock', self.lock, '--resources', self.resources)
        self.assertNotEqual(result.returncode, 0, 'Cached resources must track the current shared engine')
        self.assertIn('shared engine', result.stderr.lower())
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.resources / 'android-arm64/node').read_bytes(), binary)
        result = self.run_cli('verify', '--target', 'android-arm64', '--lock', self.lock, '--resources', self.resources)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_corrupt_archive_is_rejected_without_replacing_existing_binary(self):
        sentinel = self.resources / 'android-arm64/node'
        sentinel.write_bytes(b'existing resource must survive')
        archive = self.archives['android-arm64']
        archive.write_bytes(archive.read_bytes() + b'changed')
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('checksum', result.stderr.lower())
        self.assertEqual(sentinel.read_bytes(), b'existing resource must survive')

    def test_changed_compile_input_is_rejected_before_resource_mutation(self):
        original = (self.resources / 'android-arm64/node').read_bytes()
        path = self.project / 'scripts/sub-store/android-runtime-lock.json'
        value = json.loads(path.read_text())
        value['androidApi'] = 25
        path.write_text(json.dumps(value))
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('input', result.stderr.lower())
        self.assertEqual((self.resources / 'android-arm64/node').read_bytes(), original)

    def test_wrong_abi_is_rejected_even_when_archive_digest_matches(self):
        def change(contents):
            file = self.project / 'wrong-node'
            write_android_elf_fixture(file, machine=62)
            contents['node'] = file.read_bytes()
        self.rewrite_archive(change)
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('architecture mismatch', result.stderr.lower())

    def test_unsafe_archive_cannot_escape_staging_directory(self):
        self.rewrite_archive(lambda files: files.update({'../escaped': b'unsafe'}))
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('archive', result.stderr.lower())
        self.assertFalse((self.project / '.cache/escaped').exists())

    def test_missing_offline_artifact_fails_without_starting_source_build(self):
        result = self.run_cli('prepare', '--target', 'android-arm64', '--lock', self.lock, '--offline')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('missing', result.stderr.lower())
        self.assertFalse((self.project / '.cache/sub-store-android').exists())

    def test_changed_builder_source_cannot_reuse_old_sealed_artifact(self):
        path = self.project / 'scripts/sub-store/build-android-runtime.cjs'
        path.write_bytes(path.read_bytes() + b'\n// Changed runtime build recipe\n')
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('source', result.stderr.lower())

    def test_unrelated_darwin_patch_metadata_does_not_rebuild_linux_runtime(self):
        path = self.project / 'scripts/sub-store/android-runtime-lock.json'
        value = json.loads(path.read_text())
        value['darwinHostLdflags'].append('-unrelated-to-linux')
        path.write_text(json.dumps(value))
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_cached_resources_with_tampered_provenance_are_rejected(self):
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        path = self.resources / 'android-arm64/manifest.json'
        manifest = json.loads(path.read_text())
        manifest['sourceBuild']['compilerVersion'] = 'different compiler'
        path.write_text(json.dumps(manifest))
        verified = self.run_cli('verify', '--target', 'android-arm64', '--lock', self.lock, '--resources', self.resources)
        self.assertNotEqual(verified.returncode, 0)


if __name__ == '__main__':
    unittest.main()
