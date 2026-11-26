"""使用临时 Git 候选文件验证敏感信息门禁，断言输出从不包含秘密值。"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/secret-scan.sh"


class SecretScanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.write(".gitignore", ".cache/\n.env\n*.key\n")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True,
                              capture_output=True, text=True)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode())
        return path

    def scan(self, cwd=None):
        # Resolve PATH ourselves so Windows does not prefer System32's WSL Bash.
        return subprocess.run([shutil.which("bash") or "bash", SCRIPT.as_posix()], cwd=cwd or self.root,
                              capture_output=True, text=True)

    def test_untracked_source_secret_is_rejected_with_line_only_and_without_staging(self):
        token = "ghp_" + "A" * 36
        self.write("src/new.ts", "// source\r\nconst token = '" + token + "';\r\n")
        before = self.git("ls-files", "--stage", "-z").stdout
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("src/new.ts:2", result.stderr)
        self.assertNotIn(token, result.stdout + result.stderr)
        self.assertEqual(self.git("ls-files", "--stage", "-z").stdout, before)

    def test_forced_tracked_ignored_secret_is_rejected(self):
        token = "github_pat_" + "B" * 30
        self.write(".cache/credential.ts", token + "\n")
        self.git("add", "-f", ".cache/credential.ts")
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".cache/credential.ts:1", result.stderr)
        self.assertNotIn(token, result.stdout + result.stderr)

    def test_ignored_untracked_secret_is_not_read(self):
        self.write(".cache/credential.ts", "ghp_" + "C" * 36)
        result = self.scan()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_tracked_source_modified_with_secret_is_rejected(self):
        path = self.write("src/existing.ts", "public source\n")
        self.git("add", "src/existing.ts")
        token = "xoxb-" + "G" * 30
        path.write_text("public source\n" + token + "\n")
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("src/existing.ts:2", result.stderr)
        self.assertNotIn(token, result.stdout + result.stderr)

    def test_sensitive_filename_is_rejected_even_when_content_is_benign(self):
        self.write("signing.key", "placeholder\r\n")
        self.git("add", "-f", "signing.key")
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("signing.key", result.stderr)
        self.assertNotIn("placeholder", result.stderr)

    def test_env_example_is_allowed_but_its_contents_are_scanned(self):
        path = self.write(".env.example", "ENDPOINT=https://example.invalid\r\n")
        self.assertEqual(self.scan().returncode, 0)
        token = "AKIA" + "D" * 16
        path.write_text("ACCESS_KEY=" + token + "\n")
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".env.example:1", result.stderr)
        self.assertNotIn(token, result.stderr)

    def test_inline_private_key_fixture_is_not_exempted(self):
        marker = "-----BEGIN " + "PRIVATE KEY-----"
        self.write("test/credential-fixture.ts", "const fixture = `" + marker + "`;\n")
        result = self.scan()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("test/credential-fixture.ts:1", result.stderr)
        self.assertNotIn(marker, result.stderr)

    def test_nested_invocation_scans_all_candidate_files(self):
        self.write("new.ts", "glpat-" + "E" * 24)
        folder = self.root / "nested"
        folder.mkdir()
        result = self.scan(cwd=folder)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("new.ts:1", result.stderr)

    def test_external_symlink_is_rejected_without_reading_secret(self):
        if os.name == "nt":
            self.skipTest("Windows symlink creation requires developer mode")
        with tempfile.TemporaryDirectory() as outside:
            token = "ghp_" + "F" * 36
            target = Path(outside) / "private.ts"
            target.write_text(token)
            (self.root / "source.ts").symlink_to(target)
            result = self.scan()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("source.ts", result.stderr)
            self.assertNotIn(token, result.stderr)
            self.assertNotIn(str(target), result.stderr)


if __name__ == "__main__":
    unittest.main()
