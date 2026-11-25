"""Exercise range recovery and checksum rejection over a real local HTTP server."""
import hashlib
import http.server
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

HELPER = Path(__file__).resolve().parents[1] / 'sub-store/download-pinned.cjs'
PAYLOAD = b'pinned archive fixture' * 100


class PinnedDownloadTests(unittest.TestCase):
    def run_download(self, root, mode, expected=None, cached=None, partial=None):
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                header = self.headers.get('Range')
                requests.append(header)
                start = int(header[6:-1]) if header else 0
                if header and mode == 'range-unsatisfiable':
                    self.send_response(416)
                    self.end_headers()
                    return
                use_range = header and mode != 'range-ignored'
                if not use_range:
                    start = 0
                self.send_response(206 if use_range else 200)
                self.send_header('Content-Length', str(len(PAYLOAD) - start))
                if use_range:
                    self.send_header('Content-Range', f'bytes {start}-{len(PAYLOAD)-1}/{len(PAYLOAD)}')
                self.end_headers()
                self.wfile.write(PAYLOAD[start:])

        archive = root / 'archive.tgz'
        if cached is not None:
            archive.write_bytes(cached)
        if partial is not None:
            (root / 'archive.tgz.partial').write_bytes(partial)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        script = 'require(process.argv[1]).downloadPinned(process.argv[2],process.argv[3],process.argv[4])'
        try:
            result = subprocess.run(['node', '-e', script, str(HELPER),
                                     f'http://127.0.0.1:{server.server_port}/archive', str(archive),
                                     expected or hashlib.sha256(PAYLOAD).hexdigest()],
                                    capture_output=True, text=True, timeout=20)
            return result, requests, archive
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_stored_partial_resumes_and_only_then_becomes_an_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result, requests, archive = self.run_download(root, 'normal', partial=PAYLOAD[:123])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(requests, ['bytes=123-'])
            self.assertEqual(archive.read_bytes(), PAYLOAD)
            self.assertFalse((root / 'archive.tgz.partial').exists())

    def test_server_without_range_support_restarts_from_zero(self):
        for mode in ('range-ignored', 'range-unsatisfiable'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                result, requests, archive = self.run_download(Path(directory), mode, partial=PAYLOAD[:123])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(requests, ['bytes=123-', None])
                self.assertEqual(archive.read_bytes(), PAYLOAD)

    def test_changed_download_never_becomes_a_usable_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result, _, archive = self.run_download(root, 'normal', expected='0' * 64)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('checksum mismatch', result.stderr)
            self.assertFalse(archive.exists())
            self.assertFalse((root / 'archive.tgz.partial').exists())

    def test_cached_archive_is_verified_before_network_access(self):
        for cached, success in ((PAYLOAD, True), (b'tampered', False)):
            with self.subTest(success=success), tempfile.TemporaryDirectory() as directory:
                result, requests, _ = self.run_download(Path(directory), 'normal', cached=cached)
                self.assertEqual(result.returncode == 0, success, result.stderr)
                self.assertEqual(requests, [])


if __name__ == '__main__':
    unittest.main()
