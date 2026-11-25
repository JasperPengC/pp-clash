"""Exercise actual gomobile module handling, stopping before native compilation."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
PREPARED = os.environ.get('PPCLASH_GOMOBILE_PREPARED')
GOMOBILE = os.environ.get('PPCLASH_GOMOBILE')


@unittest.skipUnless(PREPARED and GOMOBILE, 'Set the prepared workspace and installed gomobile for the real integration probe')
class GomobileModuleTests(unittest.TestCase):
    def probe(self, modfile):
        prepared = Path(PREPARED)
        metadata = json.loads((prepared / 'prepared.json').read_text())
        directory = ROOT / '.cache/android-gomobile-verification' / str(uuid.uuid4())
        directory.mkdir(parents=True)
        fixture = directory / 'fixture'
        fixture.mkdir()
        shutil.copyfile(prepared / 'core/go.mod', fixture / 'go.mod')
        shutil.copyfile(prepared / 'core/go.sum', fixture / 'go.sum')
        # Keep the alternate file beside go.mod to distinguish gomobile's
        # modfile handling from an alternate file in an unrelated directory.
        shutil.copyfile(prepared / 'core.mod', fixture / 'core.mod')
        shutil.copyfile(prepared / 'core.sum', fixture / 'core.sum')
        (fixture / 'probe.go').write_text('package probe\nimport "github.com/metacubex/mihomo/constant"\nfunc Version() string { return constant.Version }\n')
        helper = directory / 'version.go'
        helper.write_text('package main\nimport ("fmt"; "github.com/metacubex/mihomo/constant")\nfunc main() { fmt.Println(constant.Version) }\n')
        real_go = shutil.which('go')
        runtime = subprocess.run([real_go, 'run', '-ldflags=' + metadata['ldflags'], str(helper)],
                                 cwd=fixture, env=dict(os.environ, GOFLAGS='', GOWORK='off'),
                                 capture_output=True, text=True, timeout=60)
        self.assertEqual(0, runtime.returncode, runtime.stderr)
        self.assertEqual('v1.19.34', runtime.stdout.strip())
        trace, checkpoint = directory / 'go-trace.jsonl', directory / 'native-checkpoint.json'
        shim = directory / 'bin/go'
        shim.parent.mkdir()
        shim.write_text(f'''#!{sys.executable}
import json, os, subprocess, sys
real_go = {real_go!r}
arguments = sys.argv[1:]
with open({str(trace)!r}, 'a') as log:
    log.write(json.dumps({{'cwd': os.getcwd(), 'args': arguments, 'GOFLAGS': os.environ.get('GOFLAGS', '')}}) + '\\n')
if 'build' in arguments and '-buildmode=c-shared' in arguments:
    result = subprocess.run([real_go, 'list', '-mod=readonly', '-m', '-json', 'github.com/metacubex/mihomo'], capture_output=True, text=True)
    with open({str(checkpoint)!r}, 'w') as log:
        json.dump({{'args': arguments, 'module': json.loads(result.stdout) if result.returncode == 0 else None, 'error': result.stderr}}, log)
    print('PPCLASH_PROBE_STOPPED_BEFORE_NATIVE_BUILD', file=sys.stderr)
    sys.exit(86)
os.execv(real_go, [real_go, *arguments])
''')
        shim.chmod(0o755)
        environment = dict(os.environ, GOFLAGS='-modfile=' + str(fixture / 'core.mod') if modfile else '', GOWORK='off')
        environment['PATH'] = str(shim.parent) + os.pathsep + str(Path(GOMOBILE).parent) + os.pathsep + environment['PATH']
        result = subprocess.run([GOMOBILE, 'bind', '-v', '-target=android/arm64', '-androidapi=24',
                                 '-ldflags=' + metadata['ldflags'], '-o', str(directory / 'must-not-exist.aar'), '.'],
                                cwd=fixture, env=environment, capture_output=True, text=True, timeout=120)
        (directory / 'gomobile.log').write_text(result.stdout + result.stderr)
        (directory / 'version.log').write_text(runtime.stdout)
        self.assertFalse((directory / 'must-not-exist.aar').exists())
        self.assertNotEqual(0, result.returncode)
        print(f'gomobile probe modfile={modfile}: {directory}', flush=True)
        return metadata, directory, checkpoint, result

    def test_global_modfile_cannot_override_gomobile_generated_module(self):
        _, directory, checkpoint, result = self.probe(True)
        self.assertFalse(checkpoint.exists(), result.stdout + result.stderr)
        trace = (directory / 'go-trace.jsonl').read_text()
        self.assertIn('core.mod', trace)
        self.assertIn('golang.org/x/mobile', (directory / 'fixture/core.mod').read_text())
        self.assertIn('missing golang.org/x/mobile dependency', result.stdout + result.stderr)

    def test_local_workspace_preserves_replacement_and_linker_version(self):
        metadata, _, checkpoint, result = self.probe(False)
        self.assertTrue(checkpoint.exists(), result.stdout + result.stderr)
        state = json.loads(checkpoint.read_text())
        self.assertEqual('', state['error'])
        self.assertEqual('v1.19.34', state['module']['Version'])
        self.assertEqual(metadata['moduleDir'], state['module']['Replace']['Dir'])
        self.assertIn('constant.Version=v1.19.34', ' '.join(state['args']))
        self.assertIn('PPCLASH_PROBE_STOPPED_BEFORE_NATIVE_BUILD', result.stderr)


if __name__ == '__main__':
    unittest.main()
