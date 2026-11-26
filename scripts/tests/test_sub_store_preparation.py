"""Prepare the shared engine without any desktop runtime or machine cache."""
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile
import threading
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]


class SharedEnginePreparationTests(unittest.TestCase):
    def fixture(self, root):
        scripts = root / 'scripts/sub-store'
        shutil.copytree(ROOT / 'scripts/sub-store', scripts,
                        ignore=shutil.ignore_patterns('target', 'node_modules', 'native-tests', '__pycache__'))
        output = root / 'src-tauri/resources/sub-store'
        output.mkdir(parents=True)
        shutil.copy2(ROOT / 'src-tauri/resources/sub-store/service-bootstrap.cjs', output)
        cache = root / '.cache/cloud-tools-20261121/runtime'
        cache.mkdir(parents=True)
        bundle = cache / 'sub-store.strict.bundle.cjs'
        bundle.write_bytes(b'console.log("fixture");\n')
        manifest = cache / 'runtime-manifest-strict.json'
        manifest.write_bytes(b'{"fixture":true}\n')
        lock = json.loads((scripts / 'upstream-lock.json').read_text())
        digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
        provenance = {**lock, 'patch': 'scripts/sub-store/strict-errors.patch',
                      'patchSha256': digest(scripts / 'strict-errors.patch'),
                      'output': {'bundle': {'sha256': digest(bundle)},
                                 'manifest': {'sha256': digest(manifest)}}}
        (cache / 'build-provenance.json').write_text(json.dumps(provenance))
        return cache, output

    def prepare(self, root):
        return subprocess.run(['node', 'scripts/sub-store/prepare-runtime.cjs', '--shared-only', '--offline'],
                              cwd=root, text=True, capture_output=True)

    def test_shared_engine_prepares_without_a_desktop_archive_or_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache, output = self.fixture(root)
            result = self.prepare(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((output / 'sub-store.bundle.cjs').read_bytes(),
                             (cache / 'sub-store.strict.bundle.cjs').read_bytes())
            self.assertEqual(sorted(p.name for p in output.iterdir()),
                             ['build-provenance.json', 'runtime-manifest.json',
                              'service-bootstrap.cjs', 'sub-store.bundle.cjs'])

    def test_shared_engine_rejects_changed_bundle_lock_and_patch(self):
        for changed in ('bundle', 'lock', 'patch'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                cache, output = self.fixture(root)
                if changed == 'bundle':
                    (cache / 'sub-store.strict.bundle.cjs').write_bytes(b'tampered')
                elif changed == 'patch':
                    (root / 'scripts/sub-store/strict-errors.patch').write_bytes(b'tampered')
                else:
                    record = cache / 'build-provenance.json'
                    data = json.loads(record.read_text())
                    data['commit'] = 'untrusted'
                    record.write_text(json.dumps(data))
                result = self.prepare(root)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((output / 'sub-store.bundle.cjs').exists())

    def test_windows_checkout_preserves_linux_engine_patch_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            paths = ['scripts/sub-store', 'src-tauri/resources/sub-store/service-bootstrap.cjs']
            attributes = ROOT / '.gitattributes'
            if attributes.exists():
                shutil.copyfile(attributes, root / '.gitattributes')
                paths.append('.gitattributes')
            for arguments in (['init', '--quiet'],
                              ['-c', 'core.autocrlf=false', 'add', '--', *paths]):
                subprocess.run(['git', *arguments], cwd=root, check=True,
                               text=True, capture_output=True)
            (root / 'scripts/sub-store/strict-errors.patch').unlink()
            subprocess.run(['git', '-c', 'core.autocrlf=true', 'checkout-index', '--all', '--force'],
                           cwd=root, check=True, text=True, capture_output=True)
            result = self.prepare(root)
            self.assertEqual(result.returncode, 0, result.stderr)

    def zip_fixture(self, root, corrupt=False):
        self.fixture(root)
        cache = root / '.cache/sub-store-runtime'
        cache.mkdir(parents=True)
        archive = cache / 'node-v24.18.0-win-x64.zip'
        binary = b'MZ fixture runtime\r\n'
        if corrupt:
            archive.write_bytes(b'invalid zip archive')
        else:
            with zipfile.ZipFile(archive, 'w') as package:
                package.writestr('node-v24.18.0-win-x64/node.exe', binary)
                package.writestr('node-v24.18.0-win-x64/LICENSE', b'fixture license')
        lock_path = root / 'scripts/sub-store/runtime-lock.json'
        lock = json.loads(lock_path.read_text())
        lock['targets']['win-x64']['sha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
        lock_path.write_text(json.dumps(lock))
        return binary

    def test_windows_zip_extracts_with_inherited_powershell_module_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "runtime's source"
            binary = self.zip_fixture(root)
            # Model an intermediate process inheriting PowerShell 7 module paths
            # that are unusable by the Windows PowerShell extraction child.
            env = {key: value for key, value in os.environ.items() if key.upper() != 'PSMODULEPATH'}
            modules = root / 'incompatible-powershell-modules'
            module = modules / 'Microsoft.PowerShell.Archive/Microsoft.PowerShell.Archive.psm1'
            module.parent.mkdir(parents=True)
            module.write_text("function Expand-Archive { Write-Error 'Inherited module is incompatible' }\n"
                              "Export-ModuleMember -Function Expand-Archive\n")
            env['PsModulePath'] = str(modules)
            result = subprocess.run(['node', 'scripts/sub-store/prepare-runtime.cjs',
                                     '--target', 'win-x64', '--offline'],
                                    cwd=root, env=env, text=True, errors='replace', capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = root / 'src-tauri/resources/sub-store/win-x64'
            self.assertEqual((output / 'node.exe').read_bytes(), binary)
            manifest = json.loads((output / 'manifest.json').read_text())
            record = next(row for row in manifest['files'] if row['path'] == 'win-x64/node.exe')
            self.assertEqual(record['sha256'], hashlib.sha256(binary).hexdigest())
            self.assertFalse(list((root / '.cache/sub-store-runtime').glob('prepare-*')))

    def test_corrupt_windows_zip_fails_at_extraction_without_publishing_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.zip_fixture(root, corrupt=True)
            result = subprocess.run(['node', 'scripts/sub-store/prepare-runtime.cjs',
                                     '--target', 'win-x64', '--offline'],
                                    cwd=root, text=True, errors='replace', capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('powershell.exe failed' if os.name == 'nt' else 'unzip failed', result.stderr)
            self.assertFalse((root / 'src-tauri/resources/sub-store/win-x64/manifest.json').exists())
            self.assertFalse(list((root / '.cache/sub-store-runtime').glob('prepare-*')))

    def test_interrupted_archive_download_resumes_before_checksum_and_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            node = b'\xcf\xfa\xed\xfe' + os.urandom(8192)
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w:gz') as tar:
                for name, value in [('bin/node', node), ('LICENSE', b'license')]:
                    item = tarfile.TarInfo('node-v24.18.0-darwin-x64/' + name)
                    item.size = len(value)
                    item.mode = 0o755
                    tar.addfile(item, io.BytesIO(value))
            payload = archive.getvalue()
            ranges = []

            class Handler(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass

                def do_GET(self):
                    header = self.headers.get('Range')
                    ranges.append(header)
                    start = int(header[6:-1]) if header else 0
                    self.send_response(206 if header else 200)
                    self.send_header('Content-Length', str(len(payload) - start))
                    if header:
                        self.send_header('Content-Range', f'bytes {start}-{len(payload)-1}/{len(payload)}')
                    self.end_headers()
                    self.wfile.write(payload[:len(payload)//2] if len(ranges) == 1 else payload[start:])
                    self.close_connection = True

            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            lock_path = root / 'scripts/sub-store/runtime-lock.json'
            lock = json.loads(lock_path.read_text())
            lock['distribution'] = f'http://127.0.0.1:{server.server_port}/'
            lock['targets']['darwin-x64']['sha256'] = hashlib.sha256(payload).hexdigest()
            lock_path.write_text(json.dumps(lock))
            try:
                result = subprocess.run(['node', 'scripts/sub-store/prepare-runtime.cjs', '--target', 'darwin-x64'],
                                        cwd=root, text=True, capture_output=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(ranges, [None, f'bytes={len(payload)//2}-'])
                self.assertEqual((root / 'src-tauri/resources/sub-store/darwin-x64/node').read_bytes(), node)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
