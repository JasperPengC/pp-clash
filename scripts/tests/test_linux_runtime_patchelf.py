"""linuxdeploy 只能改写应用库，不得改写锁定官方运行时。"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "linux-runtime-patchelf.sh"


@unittest.skipIf(sys.platform == "win32", "POSIX Bash fixture")
class LinuxRuntimePatchelfTests(unittest.TestCase):
    def test_set_rpath_preserves_embedded_node_and_patches_application(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / "real-patchelf"
            real.write_text('#!/bin/sh\nif [ "$1" = --set-rpath ]; then printf rewritten > "$3"; else printf "queried\\n"; fi\n')
            real.chmod(0o755)
            env = {**os.environ, "PPCLASH_REAL_PATCHELF": str(real)}
            for target in ["linux-x64", "linux-arm64"]:
                node = root / "PP Clash.AppDir/usr/lib/PP Clash/sub-store" / target / "node"
                node.parent.mkdir(parents=True)
                node.write_bytes(b"official runtime")
                result = subprocess.run(["bash", str(SCRIPT), "--set-rpath", "$ORIGIN", str(node)], env=env, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(node.read_bytes(), b"official runtime")
                query = subprocess.run(["bash", str(SCRIPT), "--print-rpath", str(node)], env=env, capture_output=True)
                self.assertEqual(query.returncode, 0, query.stderr)
                self.assertEqual(query.stdout, b"queried\n")
            application = root / "PP Clash.AppDir/usr/bin/ppclash"
            application.parent.mkdir(parents=True)
            application.write_bytes(b"application")
            result = subprocess.run(["bash", str(SCRIPT), "--set-rpath", "$ORIGIN", str(application)], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(application.read_bytes(), b"rewritten")


if __name__ == "__main__":
    unittest.main()
