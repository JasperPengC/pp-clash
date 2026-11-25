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
