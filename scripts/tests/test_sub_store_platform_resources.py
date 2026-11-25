"""Exercise resource gates against independent platform binary fixtures."""
import hashlib
import json
import pathlib
import struct
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'validate-sub-store-resources.py'


class PlatformRuntimeTests(unittest.TestCase):
    def fixture(self, root, platform, arch):
        target = {'macos': 'darwin', 'windows': 'win', 'linux': 'linux', 'android': 'android'}[platform] + '-' + ('x64' if arch == 'x86_64' else 'arm64')
        data = bytearray(256)
        if platform == 'macos':
            struct.pack_into('<IIII', data, 0, 0xFEEDFACF, 0x01000007 if arch == 'x86_64' else 0x0100000C, 0, 2)
        elif platform in ('linux', 'android'):
            data[:7] = b'\x7fELF\x02\x01\x01'
            struct.pack_into('<HHI', data, 16, 3, 62 if arch == 'x86_64' else 183, 1)
            struct.pack_into('<H', data, 52, 64)
        else:
            data[:2] = b'MZ'
            struct.pack_into('<I', data, 60, 64)
            data[64:68] = b'PE\0\0'
            struct.pack_into('<H', data, 68, 0x8664 if arch == 'x86_64' else 0xAA64)
            struct.pack_into('<HHH', data, 84, 112, 2, 0x20B)
        executable = f"{target}/{'node.exe' if platform == 'windows' else 'node'}"
        files = {'sub-store.bundle.cjs': b'engine', 'service-bootstrap.cjs': b'bootstrap', 'build-provenance.json': b'{}', 'runtime-manifest.json': b'{}', executable: data, f'{target}/LICENSE': b'license'}
        rows = []
        for name, content in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            path.chmod(0o755)
            rows.append({'path': name, 'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)})
        manifest = root / target / 'manifest.json'
        manifest.write_text(json.dumps({'schemaVersion': 1, 'engineVersion': '2.44.16', 'nodeVersion': '24.18.0', 'target': target, 'files': rows}))
        return target, root / executable, manifest

    def run_gate(self, root, platform, arch):
        return subprocess.run([sys.executable, str(SCRIPT), str(root), arch, '--platform', platform], capture_output=True, text=True)

    def test_each_target_accepts_its_binary_and_rejects_tampering(self):
        for platform in ('macos', 'windows', 'linux', 'android'):
            for arch in ('x86_64', 'aarch64'):
                with self.subTest(platform=platform, arch=arch), tempfile.TemporaryDirectory() as directory:
                    root = pathlib.Path(directory)
                    target, node, _ = self.fixture(root, platform, arch)
                    result = self.run_gate(root, platform, arch)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn(target, result.stdout)
                    node.write_bytes(node.read_bytes() + b'tampered')
                    self.assertNotEqual(self.run_gate(root, platform, arch).returncode, 0)

    def test_wrong_binary_architecture_is_rejected_even_with_matching_hash(self):
        for platform in ('macos', 'windows', 'linux', 'android'):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                _, node, manifest = self.fixture(root, platform, 'x86_64')
                wrong = bytearray(node.read_bytes())
                struct.pack_into('<I' if platform == 'macos' else '<H', wrong, {'macos': 4, 'windows': 68, 'linux': 18, 'android': 18}[platform], {'macos': 0x0100000C, 'windows': 0xAA64, 'linux': 183, 'android': 183}[platform])
                node.write_bytes(wrong)
                document = json.loads(manifest.read_text())
                for row in document['files']:
                    if row['path'].endswith(('node', 'node.exe')): row['sha256'] = hashlib.sha256(wrong).hexdigest()
                manifest.write_text(json.dumps(document))
                self.assertNotEqual(self.run_gate(root, platform, 'x86_64').returncode, 0)


if __name__ == '__main__':
    unittest.main()
