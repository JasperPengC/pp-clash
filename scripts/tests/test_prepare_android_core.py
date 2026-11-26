"""Pinned source preparation must leave production and global module files intact."""
import difflib
import hashlib
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'prepare-android-core.py'
API = runpy.run_path(str(SCRIPT))


class PrepareAndroidCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.core = self.root / 'production'
        self.source = self.root / 'module-cache/mihomo'
        self.output = self.root / '.cache/prepared'
        self.lock = self.root / 'patches/source-lock.json'
        self.core.mkdir()
        self.source.mkdir(parents=True)
        self.lock.parent.mkdir()
        self.core.joinpath('go.mod').write_text('module test.local/core\n\ngo 1.26.0\n\nrequire github.com/metacubex/mihomo v1.19.34\n')
        self.core.joinpath('go.sum').write_text('')
        self.core.joinpath('sentinel.txt').write_text('production snapshot')
        self.source.joinpath('go.mod').write_text('module github.com/metacubex/mihomo\n\ngo 1.26.0\n')
        files, parts = {}, []
        for name in sorted(API['FILES']):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            original, patched = 'original fixture\n', 'patched fixture\n'
            path.write_bytes(original.encode())
            files[name] = {'sourceSha256': hashlib.sha256(original.encode()).hexdigest(),
                           'patchedSha256': hashlib.sha256(patched.encode()).hexdigest()}
            parts.extend(difflib.unified_diff(original.splitlines(True), patched.splitlines(True),
                                             fromfile='a/' + name, tofile='b/' + name))
        patch = ''.join(parts).encode()
        self.patch = self.lock.parent / 'server-lifecycle.patch'
        self.patch.write_bytes(patch)
        self.lock_data = {'module': API['MODULE'], 'version': API['VERSION'], 'files': files,
                          'patch': self.patch.name, 'patchSha256': hashlib.sha256(patch).hexdigest()}
        self.write_lock()
        self.production_bytes = {name: (self.core / name).read_bytes() for name in ['go.mod', 'go.sum']}

    def write_lock(self):
        self.lock.write_text(json.dumps(self.lock_data))

    def prepare(self):
        return API['prepare'](self.core, self.source, self.output, self.lock)

    def assert_originals(self):
        for name, before in self.production_bytes.items():
            self.assertEqual(before, (self.core / name).read_bytes())
        for name in API['FILES']:
            self.assertEqual('original fixture\n', (self.source / name).read_text())

    def previous_output(self):
        self.output.mkdir(parents=True)
        (self.output / 'previous').write_text('keep this build')

    def test_real_go_mod_replacement_retains_version_and_originals(self):
        result = self.prepare()
        self.assertEqual('v1.19.34', result['version'])
        self.assertIn('constant.Version=v1.19.34', result['ldflags'])
        self.assertEqual('', result['gomobileGoFlags'])
        self.assertEqual('production snapshot', (self.output / 'core/sentinel.txt').read_text())
        for name in API['FILES']:
            self.assertEqual('patched fixture\n', (self.output / 'mihomo' / name).read_text())
        self.assertIn(str(self.output / 'mihomo'), (self.output / 'core.mod').read_text())
        self.assertIn(str(self.output / 'mihomo'), (self.output / 'core/go.mod').read_text())
        self.assert_originals()
        self.prepare()
        self.assert_originals()

    def test_tampered_source_preserves_previous_build(self):
        self.previous_output()
        (self.source / 'dns/server.go').write_text('untrusted source\n')
        with self.assertRaisesRegex(ValueError, 'source SHA mismatch'):
            self.prepare()
        self.assertEqual('keep this build', (self.output / 'previous').read_text())

    def test_source_lock_cannot_omit_controller_mutation_patch(self):
        self.previous_output()
        self.lock_data['files'].pop('hub/route/configs.go', None)
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'Unsupported Mihomo source lock'):
            self.prepare()
        self.assertEqual('keep this build', (self.output / 'previous').read_text())

    def test_tampered_patch_preserves_previous_build_and_sources(self):
        self.previous_output()
        self.patch.write_bytes(self.patch.read_bytes() + b'tampering')
        with self.assertRaisesRegex(ValueError, 'patch integrity mismatch'):
            self.prepare()
        self.assertEqual('keep this build', (self.output / 'previous').read_text())
        self.assert_originals()

    def test_incorrect_patched_hash_never_publishes_partial_build(self):
        self.previous_output()
        self.lock_data['files']['dns/server.go']['patchedSha256'] = '0' * 64
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'Patched Mihomo SHA mismatch'):
            self.prepare()
        self.assertEqual('keep this build', (self.output / 'previous').read_text())
        self.assert_originals()

    def test_output_cannot_replace_upstream_or_production(self):
        for target in [self.source, self.source / 'nested', self.core, self.core.parent]:
            with self.subTest(target=target), self.assertRaisesRegex(ValueError, 'Output must be separate'):
                API['prepare'](self.core, self.source, target, self.lock)
        self.assert_originals()

    def test_cli_rejects_cache_root_before_replacing_existing_artifacts(self):
        cache = self.root / '.cache'
        cache.mkdir()
        sentinel = cache / 'unrelated-artifact'
        sentinel.write_text('keep unrelated cache files')
        real_go = API['go']
        real_prepare = API['prepare']

        def select_fixture(args, cwd):
            if args[:4] == ['list', '-mod=readonly', '-m', '-json']:
                return json.dumps({'Version': API['VERSION'], 'Dir': str(self.source)})
            return real_go(args, cwd)

        arguments = [str(SCRIPT), '--core-root', str(self.core), '--source', str(self.source), '--output', str(cache)]
        with mock.patch.object(sys, 'argv', arguments), mock.patch.dict(API['main'].__globals__, ROOT=self.root, go=select_fixture,
                prepare=lambda core, source, output: real_prepare(core, source, output, self.lock)):
            with self.assertRaises(SystemExit) as rejected:
                API['main']()
        self.assertEqual(2, rejected.exception.code)
        self.assertEqual('keep unrelated cache files', sentinel.read_text())


if __name__ == '__main__':
    unittest.main()
