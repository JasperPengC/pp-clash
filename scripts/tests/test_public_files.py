"""在临时 Git 仓库验证候选源码边界，不暂存或读取工作区私密文件。"""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/check-public-files.mjs"


class PublicFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.write(".gitignore", ".cache/\n*.jks\ndocs/\n")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True,
                              capture_output=True, text=True)

    def write(self, name, text="public fixture\n"):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def check(self, cwd=None):
        return subprocess.run(["node", str(SCRIPT)], cwd=cwd or self.root,
                              capture_output=True, text=True)

    def test_release_notes_and_product_documents_are_publishable(self):
        for name in ["README.md", "README.zh-CN.md", "THIRD_PARTY_NOTICES.md",
                     "scripts/release-notes.md", "src/example.ts"]:
            self.write(name)
        self.assertEqual(self.check().returncode, 0)

    def test_development_documents_and_forced_ignored_files_are_rejected(self):
        for name in ["docs/history.md", "scripts/notes.md", ".cache/state.txt", "release.jks"]:
            with self.subTest(name=name):
                self.write(name)
                self.git("add", "-f", name)
                result = self.check()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(name, result.stderr)
                self.git("rm", "--cached", "--", name)
                (self.root / name).unlink()

    def test_untracked_and_tracked_files_at_50_mib_are_rejected_without_staging(self):
        for tracked in [False, True]:
            with self.subTest(tracked=tracked):
                path = self.write("runtime.bin")
                with path.open("wb") as stream:
                    stream.truncate(50 * 1024 * 1024)
                if tracked:
                    self.git("add", "runtime.bin")
                before = self.git("ls-files", "--stage", "-z").stdout
                result = self.check()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("runtime.bin", result.stderr)
                self.assertEqual(self.git("ls-files", "--stage", "-z").stdout, before)

    def test_external_and_absolute_symlinks_are_rejected_without_reading_target(self):
        if os.name == "nt":
            self.skipTest("Windows symlink creation requires developer mode")
        self.write("src/source.ts")
        for target in [str(self.root / "src/source.ts"), "../outside", "C:\\private\\source.ts"]:
            with self.subTest(target=target):
                link = self.root / "linked.ts"
                link.symlink_to(target)
                try:
                    result = self.check()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("linked.ts", result.stderr)
                    self.assertNotIn(target, result.stderr)
                finally:
                    link.unlink()

    def test_relative_link_through_external_directory_is_rejected(self):
        if os.name == "nt":
            self.skipTest("Windows symlink creation requires developer mode")
        with tempfile.TemporaryDirectory() as outside:
            (Path(outside) / "source.ts").write_text("source\n")
            (self.root / "ignored").symlink_to(outside, target_is_directory=True)
            self.write(".gitignore", "ignored\n")
            (self.root / "linked.ts").symlink_to("ignored/source.ts")
            result = self.check()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("linked.ts", result.stderr)

    def test_external_symlinked_parent_of_tracked_source_is_rejected(self):
        if os.name == "nt":
            self.skipTest("Windows symlink creation requires developer mode")
        original = self.write("src/source.ts")
        self.git("add", "src/source.ts")
        original.unlink()
        original.parent.rmdir()
        with tempfile.TemporaryDirectory() as outside:
            (Path(outside) / "source.ts").write_text("private source\n")
            original.parent.symlink_to(outside, target_is_directory=True)
            result = self.check()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("src/source.ts", result.stderr)
            self.assertNotIn("private source", result.stderr)

    def test_files_below_limit_and_ignored_large_artifacts_are_not_rejected(self):
        with self.write("source.bin").open("wb") as stream:
            stream.truncate(50 * 1024 * 1024 - 1)
        with self.write(".cache/generated.bin").open("wb") as stream:
            stream.truncate(100 * 1024 * 1024)
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_relative_internal_source_symlink_is_publishable(self):
        if os.name == "nt":
            self.skipTest("Windows symlink creation requires developer mode")
        self.write("src/source.ts")
        (self.root / "linked.ts").symlink_to("src/source.ts")
        self.assertEqual(self.check().returncode, 0)

    def test_nested_invocation_still_scans_repository_root(self):
        self.write("unsafe.md")
        folder = self.root / "src"
        folder.mkdir()
        result = self.check(cwd=folder)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsafe.md", result.stderr)

    def test_repository_ignores_generated_resources_but_keeps_source_and_license(self):
        self.write(".gitignore", (ROOT / ".gitignore").read_text())
        ignored = ["scripts/sub-store/android-runtime.md",
                   "scripts/sub-store/native-tests/target",
                   "another-crate/target/output.o",
                   "src-tauri/resources/sub-store/darwin-x64/node",
                   "src-tauri/resources/sub-store/android-arm64/LICENSE",
                   "src-tauri/resources/sub-store/future-target/manifest.json",
                   "src-tauri/resources/sub-store/sub-store.bundle.cjs",
                   "src-tauri/resources/sub-store/runtime-manifest.json",
                   "src-tauri/resources/sub-store/build-provenance.json"]
        public = ["src-tauri/resources/sub-store/service-bootstrap.cjs", "licenses/node.txt",
                  "scripts/sub-store/prepare-runtime.cjs", "scripts/sub-store/runtime-lock.json"]
        for name in ignored + public:
            self.write(name)
        result = subprocess.run(["git", "check-ignore", "-z", "--stdin"], cwd=self.root,
                                input=("\0".join(ignored + public) + "\0").encode(),
                                capture_output=True)
        self.assertEqual(set(result.stdout.decode().rstrip("\0").split("\0")), set(ignored))
        self.git("add", "-f", "src-tauri/resources/sub-store/darwin-x64/node")
        rejected = self.check()
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("src-tauri/resources/sub-store/darwin-x64/node", rejected.stderr)


if __name__ == "__main__":
    unittest.main()
