"""发布入口必须在安装依赖前拒绝缺失、损坏或错误架构的完整服务。"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

from test_resource_bundle import GEO, binary

SCRIPTS = Path(__file__).resolve().parents[1]


@unittest.skipIf(sys.platform == "win32", "POSIX Bash fixture")
class ReleaseServiceGateTests(unittest.TestCase):
    def test_invalid_service_never_starts_dependency_install(self):
        for platform, suffix, prefix in [("linux", "unknown-linux-gnu", "linux"),
                                         ("windows", "pc-windows-msvc", "win")]:
            for architecture, node_arch in [("x86_64", "x64"), ("aarch64", "arm64")]:
                for invalid in ["missing", "tampered", "wrong-architecture"]:
                    with self.subTest(platform=platform, architecture=architecture, invalid=invalid), tempfile.TemporaryDirectory() as temporary:
                        root = Path(temporary)
                        scripts = root / "scripts"
                        scripts.mkdir()
                        for name in ["ci.sh", "validate-resources.py", "validate-sub-store-resources.py"]:
                            shutil.copy2(SCRIPTS / name, scripts / name)
                        resources = root / "src-tauri/resources"
                        resources.mkdir(parents=True)
                        kernel = resources / "kernel.zip"
                        with zipfile.ZipFile(kernel, "w", zipfile.ZIP_DEFLATED) as archive:
                            archive.writestr("version.txt", "1.2.3")
                            archive.writestr("bin/mihomo.exe" if platform == "windows" else "bin/mihomo", binary(platform, architecture))
                            for name, size in GEO.items():
                                archive.writestr(name, bytes(size))
                        target = f"{prefix}-{node_arch}"
                        store = resources / "sub-store"
                        if invalid != "missing":
                            (store / target).mkdir(parents=True)
                            executable = f"{target}/node.exe" if platform == "windows" else f"{target}/node"
                            node_cpu = architecture if invalid != "wrong-architecture" else ("aarch64" if architecture == "x86_64" else "x86_64")
                            files = {"sub-store.bundle.cjs": b"engine", "service-bootstrap.cjs": b"bootstrap", "build-provenance.json": b"{}", "runtime-manifest.json": b"{}", executable: bytes(binary(platform, node_cpu)), f"{target}/LICENSE": b"license"}
                            for name, content in files.items():
                                (store / name).write_bytes(content)
                            (store / executable).chmod(0o755)
                            manifest = {"schemaVersion": 1, "engineVersion": "2.44.16", "nodeVersion": "24.18.0", "target": target, "files": [{"path": name, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()} for name, content in files.items()]}
                            (store / target / "manifest.json").write_text(json.dumps(manifest))
                            if invalid == "tampered":
                                (store / "service-bootstrap.cjs").write_bytes(b"changed")
                        bins = root / "bin"
                        bins.mkdir()
                        for name in ["python", "python3"]:
                            (bins / name).write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' "$@"\n')
                            (bins / name).chmod(0o755)
                        sentinel = root / "dependency-install-started"
                        (bins / "npm").write_text('#!/bin/sh\ntouch "$RELEASE_TEST_SENTINEL"\nexit 97\n')
                        (bins / "npm").chmod(0o755)
                        env = {**os.environ, "PATH": str(bins) + os.pathsep + os.environ["PATH"], "RELEASE_TARGET": f"{architecture}-{suffix}", "KERNEL_ZIP_SHA256": hashlib.sha256(kernel.read_bytes()).hexdigest(), "RELEASE_TEST_SENTINEL": str(sentinel)}
                        result = subprocess.run(["bash", str(scripts / "ci.sh"), f"build-{platform}-release"], env=env, capture_output=True, text=True)
                        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertFalse(sentinel.exists(), "Invalid complete runtime reached npm ci")


if __name__ == "__main__":
    unittest.main()
