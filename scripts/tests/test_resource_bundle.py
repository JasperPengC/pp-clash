"""仅合成 ZIP/PE/Mach-O/ELF，验证发布门禁的真实退出码。"""
import hashlib
import json
import os
import pathlib
import struct
import shutil
import shlex
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "validate-resources.py"
GEO = {"geosite.dat": 1_000_000, "geoip.metadb": 1_000_000,
       "geoip.dat": 1_000_000, "country.mmdb": 100_000, "ASN.mmdb": 1_000_000}


def binary(os_name, arch):
    data = bytearray(256)
    if os_name == "macos":
        struct.pack_into("<IIII", data, 0, 0xFEEDFACF,
                         0x01000007 if arch == "x86_64" else 0x0100000C, 0, 2)
    elif os_name == "linux":
        data[:7] = b"\x7fELF\x02\x01\x01"
        struct.pack_into("<HHI", data, 16, 2, 62 if arch == "x86_64" else 183, 1)
        struct.pack_into("<H", data, 52, 64)
    else:
        data[:2] = b"MZ"
        struct.pack_into("<I", data, 60, 64)
        data[64:68] = b"PE\0\0"
        struct.pack_into("<H", data, 68, 0x8664 if arch == "x86_64" else 0xAA64)
        struct.pack_into("<HHH", data, 84, 112, 2, 0x20B)
    return data


class BundleGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ppclash-resource-test-")
        self.root = pathlib.Path(self.temp.name)
        self.python_bin = self.root / "test-python-bin"
        self.python_bin.mkdir()
        # 子脚本使用本轮测试解释器，不继承用户 PATH 中可能失效的 pyenv shim。
        for name in ["python", "python3"]:
            shim = self.python_bin / name
            shim.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' "$@"\n')
            shim.chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    def bundle(self, os_name="macos", arch="x86_64", bad=None):
        path = self.root / "kernel.zip"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as out:
            out.writestr("version.txt", "placeholder" if bad == "placeholder" else "v1.2.3")
            name = "bin/mihomo.exe" if os_name == "windows" else "bin/mihomo"
            out.writestr(name, b"broken" if bad == "binary" else binary(os_name, arch))
            for name, minimum in GEO.items():
                if bad == "missing-geo" and name == "country.mmdb":
                    continue
                out.writestr(name, bytes(minimum))
            if bad == "traversal":
                out.writestr("../outside", b"bad")
            if bad == "duplicate":
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    out.writestr("bin/mihomo", binary(os_name, arch))
        return path

    def run_gate(self, path, os_name, arch, digest="auto"):
        if digest == "auto":
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        args = [sys.executable, str(SCRIPT), str(path), os_name, arch]
        if digest is not None:
            args += ["--sha256", digest]
        return subprocess.run(args, capture_output=True, text=True)

    def test_correct_platform_architecture_passes(self):
        for os_name in ["macos", "windows", "linux"]:
            for arch in ["x86_64", "aarch64"]:
                result = self.run_gate(self.bundle(os_name, arch), os_name, arch)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_wrong_os_or_architecture_fails(self):
        for os_name, arch in [("windows", "x86_64"), ("macos", "aarch64")]:
            result = self.run_gate(self.bundle(), os_name, arch)
            self.assertNotEqual(result.returncode, 0)

    def test_linux_rejects_other_architectures_and_invalid_elf(self):
        for arch in ["x86_64", "aarch64"]:
            other = "aarch64" if arch == "x86_64" else "x86_64"
            self.assertNotEqual(self.run_gate(self.bundle("linux", arch), "linux", other).returncode, 0)
            self.assertNotEqual(self.run_gate(self.bundle("macos", arch), "linux", arch).returncode, 0)
        path = self.bundle("linux", "x86_64")
        for field, value in [(4, 1), (5, 2), (6, 0), (16, 1), (20, 0), (52, 0)]:
            with zipfile.ZipFile(path) as source:
                entries = {name: source.read(name) for name in source.namelist()}
            data = binary("linux", "x86_64"); data[field] = value
            entries["bin/mihomo"] = data
            with zipfile.ZipFile(path, "w") as out:
                for name, payload in entries.items(): out.writestr(name, payload)
            self.assertNotEqual(self.run_gate(path, "linux", "x86_64").returncode, 0, field)

    def test_digest_missing_invalid_or_mismatched_fails(self):
        for digest in [None, "not-a-digest", "0" * 64]:
            result = self.run_gate(self.bundle(), "macos", "x86_64", digest)
            self.assertNotEqual(result.returncode, 0)

    def test_placeholder_bad_binary_missing_geo_and_unsafe_paths_fail(self):
        for bad in ["placeholder", "binary", "missing-geo", "traversal", "duplicate"]:
            result = self.run_gate(self.bundle(bad=bad), "macos", "x86_64")
            self.assertNotEqual(result.returncode, 0, bad)
        self.assertFalse((self.root.parent / "outside").exists())

    def test_corrupt_zip_fails_without_extracting(self):
        path = self.root / "kernel.zip"
        path.write_bytes(b"not a zip")
        self.assertNotEqual(self.run_gate(path, "windows", "x86_64").returncode, 0)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["kernel.zip", "test-python-bin"])

    def test_aliases_case_conflicts_and_unexpected_members_fail(self):
        for os_name, name in [("macos", "bin/./mihomo"), ("macos", "BIN/MIHOMO"),
                              ("macos", "bin//mihomo"), ("macos", "unrelated.txt"),
                              ("windows", "BIN/MIHOMO.EXE"), ("windows", "bin/./mihomo.exe")]:
            with self.subTest(os=os_name, name=name):
                path = self.bundle(os_name)
                with zipfile.ZipFile(path, "a") as archive:
                    archive.writestr(name, b"wrong-platform overwritten binary")
                result = self.run_gate(path, os_name, "x86_64")
                self.assertNotEqual(result.returncode, 0, result.stdout)

    @unittest.skipIf(sys.platform == "win32", "本测试验证 Bash 发布入口；Windows CI 另跑 PowerShell fixture")
    def test_release_entry_rejects_bad_resources_before_install_or_build(self):
        scripts = self.root / "scripts"
        scripts.mkdir()
        shutil.copy2(SCRIPT, scripts / SCRIPT.name)
        shutil.copy2(SCRIPT.parent / "ci.sh", scripts / "ci.sh")
        resources = self.root / "src-tauri" / "resources"
        resources.mkdir(parents=True)
        bundle = self.bundle()
        shutil.copy2(bundle, resources / "kernel.zip")
        fake_bin = self.root / "fake-bin"
        fake_bin.mkdir()
        npm = fake_bin / "npm"
        npm.write_text('#!/bin/sh\ntouch "$RELEASE_TEST_SENTINEL"\nexit 91\n')
        npm.chmod(0o755)
        sentinel = self.root / "build-started"
        env = {**os.environ, "PATH": os.pathsep.join([str(fake_bin), str(self.python_bin), os.environ["PATH"]]),
               "RELEASE_TEST_SENTINEL": str(sentinel), "KERNEL_ZIP_SHA256": "", "KERNEL_ZIP_SHA256_WINDOWS": ""}
        # 缺摘要和 Windows 混入 macOS ZIP 都必须在 npm install / 打包前停止。
        for command, digest in [("build-macos-release", ""), ("build-windows-release", hashlib.sha256(bundle.read_bytes()).hexdigest())]:
            env["KERNEL_ZIP_SHA256_WINDOWS"] = digest
            result = subprocess.run(["bash", str(scripts / "ci.sh"), command], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertRegex(result.stderr, "必须单独配置|资源校验失败")
            self.assertFalse(sentinel.exists(), result.stdout + result.stderr)

    @unittest.skipIf(sys.platform == "win32", "POSIX Bash fixture")
    def test_all_release_targets_reject_other_architecture_before_build(self):
        scripts = self.root / "scripts"; scripts.mkdir()
        for name in ["ci.sh", "validate-resources.py"]: shutil.copy2(SCRIPT.parent/name,scripts/name)
        resources = self.root/"src-tauri/resources";resources.mkdir(parents=True)
        fake_bin=self.root/"fake-bin";fake_bin.mkdir(); sentinel=self.root/"started"
        npm=fake_bin/"npm";npm.write_text('#!/bin/sh\ntouch "$RELEASE_TEST_SENTINEL"\n');npm.chmod(0o755)
        for os_name,suffix in [("macos","apple-darwin"),("windows","pc-windows-msvc"),("linux","unknown-linux-gnu")]:
            for arch in ["x86_64","aarch64"]:
                other="aarch64" if arch=="x86_64" else "x86_64"
                bundle=self.bundle(os_name,other); shutil.copy2(bundle,resources/"kernel.zip")
                env={**os.environ,"PATH":os.pathsep.join([str(fake_bin),str(self.python_bin),os.environ["PATH"]]),"KERNEL_ZIP_SHA256":hashlib.sha256(bundle.read_bytes()).hexdigest(),"RELEASE_TARGET":arch+"-"+suffix,"MACOS_TARGET":arch+"-"+suffix,"RELEASE_TEST_SENTINEL":str(sentinel)}
                result=subprocess.run(["bash",str(scripts/"ci.sh"),"build-"+os_name+"-release"],env=env,capture_output=True,text=True)
                self.assertEqual(result.returncode,1,result.stdout+result.stderr)
                self.assertIn("资源校验失败",result.stderr)
                self.assertFalse(sentinel.exists())

    def local_bundle_fixture(self, bad=None):
        scripts = self.root / "scripts"
        scripts.mkdir(exist_ok=True)
        for name in ["bundle.sh", "build-dmg.sh", "validate-resources.py", "validate-sub-store-resources.py", "macos-resource-gate.sh"]:
            if (SCRIPT.parent / name).exists():
                shutil.copy2(SCRIPT.parent / name, scripts / name)
        (self.root / "src-tauri/resources").mkdir(parents=True, exist_ok=True)
        (self.root / "src-tauri/icons").mkdir(parents=True, exist_ok=True)
        for name in ["icon.png", "icon.icns"]:
            (self.root / "src-tauri/icons" / name).write_bytes(b"fixture icon")
        service = self.root / "src-tauri/resources/sub-store"
        (service / "darwin-x64").mkdir(parents=True, exist_ok=True)
        self.service_files = {"sub-store.bundle.cjs": b"fixture service",
                              "service-bootstrap.cjs": b"fixture bootstrap",
                              "build-provenance.json": b"{}",
                              "runtime-manifest.json": b"{}",
                              "darwin-x64/node": bytes(binary("macos", "x86_64")),
                              "darwin-x64/LICENSE": b"fixture license"}
        for name, content in self.service_files.items():
            (service / name).write_bytes(content)
        (service / "darwin-x64/node").chmod(0o755)
        manifest = {"schemaVersion": 1, "engineVersion": "2.44.16", "nodeVersion": "24.18.0", "target": "darwin-x64",
                    "files": [{"path": name, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                              for name, content in self.service_files.items()]}
        (service / "darwin-x64/manifest.json").write_text(json.dumps(manifest))
        bundle = self.bundle(bad=bad)
        shutil.copy2(bundle, self.root / "src-tauri/resources/kernel.zip")
        mocks = self.root / "mocks.sh"
        mocks.write_text('''node() { printf '1.2.3\\n'; }
npm() { touch "$BUNDLE_TEST_ROOT/build-started"; }
cargo() {
  touch "$BUNDLE_TEST_ROOT/build-started"
  for target in release x86_64-apple-darwin/release aarch64-apple-darwin/release; do
    mkdir -p "src-tauri/target/$target"
    printf 'fixture executable' > "src-tauri/target/$target/ppclash"
  done
  if [ "$BUNDLE_TAMPER_ZIP" = 1 ]; then printf 'corrupt fixture' > src-tauri/resources/kernel.zip; fi
  if [ "$BUNDLE_TAMPER_SUB_STORE" = 1 ]; then printf 'corrupt node' > src-tauri/resources/sub-store/darwin-x64/node; fi
}
rustup() { :; }
lipo() { :; }
file() { printf 'fixture executable\\n'; }
cp() { if [ "$1" = /tmp/ppclash-universal ]; then printf 'fixture executable' > "$2"; else command cp "$@"; fi; }
codesign() { touch "$BUNDLE_TEST_ROOT/signed"; }
hdiutil() { touch "$BUNDLE_TEST_ROOT/dmg-started"; }
uname() { printf 'x86_64\\n'; }
''')
        env = {**os.environ, "PATH": str(self.python_bin) + os.pathsep + os.environ["PATH"],
               "BASH_ENV": str(mocks), "BUNDLE_TEST_ROOT": str(self.root), "BUNDLE_TAMPER_ZIP": "0", "BUNDLE_TAMPER_SUB_STORE": "0",
               "KERNEL_ZIP_SHA256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
               "UNIVERSAL": "0", "MACOS_TARGET": "x86_64-apple-darwin", "PPCLASH_COMPILE_ONLY": "0"}
        return scripts, env

    @unittest.skipIf(sys.platform == "win32", "POSIX Bash fixture")
    def test_legacy_universal_entry_only_compiles_both_architectures(self):
        scripts, env = self.local_bundle_fixture()
        shutil.copy2(SCRIPT.parent / "build-macos-universal.sh", scripts / "build-macos-universal.sh")
        result = subprocess.run(["bash", str(scripts / "build-macos-universal.sh")],
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for target in ["x86_64-apple-darwin", "aarch64-apple-darwin"]:
            self.assertTrue((self.root / "src-tauri/target" / target / "release/ppclash").exists())
        self.assertFalse((self.root / "signed").exists())
        self.assertFalse((self.root / "dmg-started").exists())

    @unittest.skipIf(sys.platform == "win32", "POSIX Bash fixture")
    def test_windows_gnu_rejects_mac_resources_before_any_build(self):
        scripts, env = self.local_bundle_fixture()
        shutil.copy2(SCRIPT.parent / "build-windows-gnu.sh", scripts / "build-windows-gnu.sh")
        result = subprocess.run(["bash", str(scripts / "build-windows-gnu.sh"),
                                 str(self.root / "src-tauri/resources/kernel.zip")],
                                env=env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "build-started").exists())

    @unittest.skipIf(sys.platform == "win32", "本地 macOS bundle 的纯 Bash mock")
    def test_local_bundle_requires_valid_resource_gate_before_build(self):
        for bad, changes in [(None, {"KERNEL_ZIP_SHA256": ""}), ("placeholder", {}),
                             (None, {"MACOS_TARGET": "aarch64-apple-darwin"}), (None, {"UNIVERSAL": "1"})]:
            with self.subTest(bad=bad, env=changes):
                scripts, env = self.local_bundle_fixture(bad)
                (self.root / "build-started").unlink(missing_ok=True)
                result = subprocess.run(["bash", str(scripts / "bundle.sh")], env={**env, **changes}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertRegex(result.stderr, "必须配置|资源校验失败|禁止 Universal")
                self.assertFalse((self.root / "build-started").exists())

    @unittest.skipIf(sys.platform == "win32", "本地 macOS bundle 的纯 Bash mock")
    def test_local_bundle_accepts_valid_single_architecture_resources(self):
        scripts, env = self.local_bundle_fixture()
        result = subprocess.run(["bash", str(scripts / "bundle.sh")], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / "signed").exists())
        self.assertTrue((self.root / "src-tauri/target/release/bundle/macos/PP Clash.app/Contents/Resources/resources/kernel.zip").exists())

    @unittest.skipIf(sys.platform == "win32", "POSIX Bash fixture")
    def test_local_bundle_keeps_complete_sub_store_resources(self):
        scripts, env = self.local_bundle_fixture()
        result = subprocess.run(["bash", str(scripts / "bundle.sh")], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        target = self.root / "src-tauri/target/release/bundle/macos/PP Clash.app/Contents/Resources/sub-store"
        for name, content in self.service_files.items():
            self.assertTrue((target / name).is_file(), f"missing bundled service resource: {name}")
            self.assertEqual((target / name).read_bytes(), content)
        self.assertEqual((target / "darwin-x64/manifest.json").read_bytes(),
                         (self.root / "src-tauri/resources/sub-store/darwin-x64/manifest.json").read_bytes())

    @unittest.skipIf(sys.platform == "win32", "POSIX Bash fixture")
    def test_missing_sub_store_resources_preserve_previous_app(self):
        scripts, env = self.local_bundle_fixture()
        shutil.rmtree(self.root / "src-tauri/resources/sub-store")
        previous = self.root / "Previous.app"
        previous.mkdir()
        (previous / "keep").write_bytes(b"previous app")
        result = subprocess.run(["bash", str(scripts / "bundle.sh")], env={**env, "APP_PATH": str(previous)}, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((previous / "keep").read_bytes(), b"previous app")
        self.assertFalse((self.root / "build-started").exists())
        self.assertFalse((self.root / "signed").exists())

    @unittest.skipIf(sys.platform == "win32", "POSIX Bash fixture")
    def test_invalid_sub_store_resources_preserve_previous_app(self):
        for failure in ["missing-node", "corrupt-bootstrap", "wrong-target", "wrong-architecture"]:
            with self.subTest(failure=failure):
                scripts, env = self.local_bundle_fixture()
                source = self.root / "src-tauri/resources/sub-store"
                manifest_path = source / "darwin-x64/manifest.json"
                manifest = json.loads(manifest_path.read_text())
                if failure == "missing-node":
                    (source / "darwin-x64/node").unlink()
                elif failure == "corrupt-bootstrap":
                    (source / "service-bootstrap.cjs").write_bytes(b"broken")
                elif failure == "wrong-target":
                    manifest["target"] = "darwin-arm64"
                    manifest_path.write_text(json.dumps(manifest))
                else:
                    content = bytes(binary("macos", "aarch64"))
                    (source / "darwin-x64/node").write_bytes(content)
                    next(row for row in manifest["files"] if row["path"] == "darwin-x64/node")["sha256"] = hashlib.sha256(content).hexdigest()
                    manifest_path.write_text(json.dumps(manifest))
                previous = self.root / "Previous.app"
                previous.mkdir(exist_ok=True)
                (previous / "keep").write_bytes(b"previous app")
                for name in ["build-started", "signed"]:
                    (self.root / name).unlink(missing_ok=True)
                result = subprocess.run(["bash", str(scripts / "bundle.sh")], env={**env, "APP_PATH": str(previous)}, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual((previous / "keep").read_bytes(), b"previous app")
                self.assertFalse((self.root / "build-started").exists())
                self.assertFalse((self.root / "signed").exists())

    @unittest.skipIf(sys.platform == "win32", "POSIX Bash fixture")
    def test_sub_store_copy_is_revalidated_before_signing(self):
        scripts, env = self.local_bundle_fixture()
        previous = self.root / "Previous.app"
        previous.mkdir()
        (previous / "keep").write_bytes(b"previous app")
        result = subprocess.run(["bash", str(scripts / "bundle.sh")], env={**env, "APP_PATH": str(previous), "BUNDLE_TAMPER_SUB_STORE": "1"}, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((previous / "keep").read_bytes(), b"previous app")
        self.assertFalse((self.root / "signed").exists())

    @unittest.skipIf(sys.platform == "win32", "本地 macOS bundle 的纯 Bash mock")
    def test_compile_only_never_packages_or_signs_and_dmg_refuses_it(self):
        scripts, env = self.local_bundle_fixture("placeholder")
        shutil.rmtree(self.root / "src-tauri/resources/sub-store")
        env.update({"PPCLASH_COMPILE_ONLY": "1", "UNIVERSAL": "1", "KERNEL_ZIP_SHA256": ""})
        result = subprocess.run(["bash", str(scripts / "bundle.sh")], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / "build-started").exists())
        self.assertFalse((self.root / "signed").exists())
        self.assertEqual(list((self.root / "src-tauri/target").rglob("*.app")), [])
        result = subprocess.run(["bash", str(scripts / "build-dmg.sh")], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("compile-only", result.stderr)
        self.assertFalse((self.root / "dmg-started").exists())

    @unittest.skipIf(sys.platform == "win32", "本地 macOS DMG 的纯 Bash mock")
    def test_dmg_revalidates_resources_in_an_existing_app(self):
        scripts, env = self.local_bundle_fixture()
        app = self.root / "Existing.app/Contents/Resources/resources"
        app.mkdir(parents=True)
        shutil.copy2(self.bundle(bad="placeholder"), app / "kernel.zip")
        env["APP_PATH"] = str(self.root / "Existing.app")
        result = subprocess.run(["bash", str(scripts / "build-dmg.sh")], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("资源校验失败", result.stderr)
        self.assertFalse((self.root / "dmg-started").exists())

    @unittest.skipIf(sys.platform == "win32", "本地 macOS bundle 的纯 Bash mock")
    def test_bundle_checks_final_copy_before_signing_and_preserves_previous_app(self):
        scripts, env = self.local_bundle_fixture()
        previous = self.root / "src-tauri/target/release/bundle/macos/PP Clash.app"
        previous.mkdir(parents=True)
        (previous / "keep").write_bytes(b"previous artifact")
        env["BUNDLE_TAMPER_ZIP"] = "1"
        result = subprocess.run(["bash", str(scripts / "bundle.sh")], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("SHA-256", result.stderr)
        self.assertTrue((self.root / "build-started").exists())
        self.assertFalse((self.root / "signed").exists())
        self.assertEqual((previous / "keep").read_bytes(), b"previous artifact")


if __name__ == "__main__":
    unittest.main()
