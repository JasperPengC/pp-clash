"""Run lifecycle regressions against a prepared copy via a test-only overlay."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class AndroidControllerGenerationTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('PPCLASH_CONTROLLER_PREPARED'),
                         'requires a controlled prepared Android core')
    def test_controller_generation_boundaries(self):
        prepared = Path(os.environ['PPCLASH_CONTROLLER_PREPARED']).resolve()
        metadata = json.loads((prepared / 'prepared.json').read_text())
        self.assertEqual(str(prepared / 'mihomo'), metadata['moduleDir'])
        test_source = Path(__file__).with_name('android_controller_generation_test.go')
        with tempfile.TemporaryDirectory(prefix='controller-test-', dir=prepared) as directory:
            overlay = Path(directory) / 'overlay.json'
            overlay.write_text(json.dumps({'Replace': {
                str(prepared / 'mihomo/hub/route/ppclash_controller_generation_test.go'): str(test_source)
            }}))
            arguments = ['go', 'test', '-mod=readonly', '-overlay=' + str(overlay),
                         '-tags=with_gvisor,cmfa', '-ldflags=' + metadata['ldflags'],
                         'github.com/metacubex/mihomo/hub/route', '-run=^TestController',
                         '-count=1', '-v', '-timeout=45s']
            if os.environ.get('PPCLASH_CONTROLLER_RACE') == '1':
                arguments.insert(2, '-race')
            result = subprocess.run(arguments, cwd=prepared / 'core',
                                    env=dict(os.environ, GOFLAGS='', GOWORK='off', GOMAXPROCS='2'),
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
            print(result.stdout)
            self.assertEqual(0, result.returncode, result.stdout)


if __name__ == '__main__':
    unittest.main()
