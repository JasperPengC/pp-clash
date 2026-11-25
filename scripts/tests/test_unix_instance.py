"""Compile the real Unix entrypoint against a harmless application loop."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform in ("darwin", "linux") and shutil.which("rustc"), "Unix Rust required")
class UnixInstanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix="ppclash-instance-build-")
        folder = Path(cls.build.name)
        stub = folder / "stub.rs"
        stub.write_text('pub fn run() { println!("APP_READY"); let mut s = String::new(); std::io::stdin().read_line(&mut s).unwrap(); }')
        library = folder / "libppclash_lib.rlib"
        subprocess.run(["rustc", "--crate-name", "ppclash_lib", "--crate-type", "rlib", str(stub), "-o", str(library)], check=True, capture_output=True)
        cls.binary = folder / "ppclash-instance-test"
        subprocess.run(["rustc", "--edition=2021", str(ROOT / "src-tauri/src/main.rs"), "--extern", f"ppclash_lib={library}", "-o", str(cls.binary)], check=True, capture_output=True)
        legacy = folder / "legacy"
        legacy.mkdir()
        source = legacy / "main.rs"
        source.write_text('fn main() { std::fs::write(std::env::args().nth(1).unwrap(), std::process::id().to_string()).unwrap(); println!("APP_READY"); let mut s = String::new(); std::io::stdin().read_line(&mut s).unwrap(); }')
        cls.legacy = legacy / cls.binary.name
        subprocess.run(["rustc", str(source), "-o", str(cls.legacy)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        self.home = tempfile.TemporaryDirectory(prefix="ppclash-instance-home-")
        self.addCleanup(self.home.cleanup)
        folder = Path(self.home.name)
        self.env = {**os.environ, "HOME": str(folder), "XDG_DATA_HOME": str(folder / "xdg")}
        self.data = folder / ("Library/Application Support/PPClash" if sys.platform == "darwin" else "xdg/PPClash")
        self.data.mkdir(parents=True)
        self.lock = self.data / "instance.lock"

    def launch(self):
        process = subprocess.Popen([str(self.binary)], env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def cleanup():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        self.addCleanup(cleanup)
        return process

    def run_once(self):
        return subprocess.run([str(self.binary)], env=self.env, input="\n", text=True, capture_output=True, timeout=5)

    def test_unrelated_live_pid_in_stale_file_does_not_block_startup(self):
        self.lock.write_text(str(os.getpid()))
        result = self.run_once()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("APP_READY", result.stdout)

    def test_corrupt_stale_pid_is_replaced(self):
        self.lock.write_bytes(b"\xff\xfeinvalid\x00pid")
        result = self.run_once()
        self.assertIn("APP_READY", result.stdout)
        self.assertTrue(self.lock.read_text().isdigit())

    def test_live_instance_is_excluded_and_normal_exit_releases_lock(self):
        first = self.launch()
        self.assertEqual(first.stdout.readline().strip(), "APP_READY")
        self.assertNotIn("APP_READY", self.run_once().stdout)
        first.communicate("\n", timeout=5)
        self.assertIn("APP_READY", self.run_once().stdout)

    def test_crash_releases_lock_without_deleting_file(self):
        first = self.launch()
        self.assertEqual(first.stdout.readline().strip(), "APP_READY")
        first.kill()
        first.communicate(timeout=5)
        self.assertTrue(self.lock.exists())
        self.assertIn("APP_READY", self.run_once().stdout)

    def test_lock_io_failure_never_starts_unprotected(self):
        self.lock.mkdir()
        result = self.run_once()
        self.assertNotIn("APP_READY", result.stdout)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(result.stderr.strip())

    def test_concurrent_startups_leave_only_one_owner(self):
        processes = [self.launch() for _ in range(12)]
        ready = [p for p in processes if p.stdout.readline().strip() == "APP_READY"]
        self.assertEqual(len(ready), 1)

    @unittest.skipUnless(sys.platform == "linux", "Linux /proc executable replacement")
    def test_upgrade_respects_deleted_legacy_executable(self):
        legacy = Path(self.home.name) / self.binary.name
        shutil.copy2(self.legacy, legacy)
        process = subprocess.Popen([str(legacy), str(self.lock)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "APP_READY")
            legacy.unlink()
            self.assertNotIn("APP_READY", self.run_once().stdout)
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)

    def test_upgrade_respects_running_legacy_app_without_os_lock(self):
        process = subprocess.Popen([str(self.legacy), str(self.lock)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "APP_READY")
            self.assertNotIn("APP_READY", self.run_once().stdout)
            process.communicate("\n", timeout=5)
            self.assertIn("APP_READY", self.run_once().stdout)
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
