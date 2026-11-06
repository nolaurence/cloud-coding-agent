"""Offline workspace tests. Docker and SSH are never invoked."""
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("gateway", Path(__file__).with_name("gateway.py"))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
FIXTURES = json.loads((Path(__file__).resolve().parents[2] / "apps/server/src/dockerSandboxFixtures.json").read_text())


def entry(value):
    return {"data": base64.b64encode(value.encode()).decode(), "executable": False}


def output(**changes):
    return {"stdout": "", "stderr": "", "exitCode": 0, "timedOut": False, "truncated": False, **changes}


def write(root, name, data="generated"):
    file = root / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(data)
    return file


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="cca-gateway-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        root_patch = patch.object(gateway, "ROOT", self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        # Any accidental attempt to run Docker fails this offline test.
        docker_patch = patch.object(gateway, "docker", side_effect=AssertionError("Docker must not be invoked"))
        docker_patch.start()
        self.addCleanup(docker_patch.stop)
        self.workspace = self.root / ("a" * 32)
        self.dirty = self.root / (self.workspace.name + ".dirty")
        self.request = {"workspace_policy_version": 2, "run": "b" * 32, "code": "print('ok')",
                        "files": {"nested/src/main.py": entry("source")}}

    def test_nested_language_filter_matches_upload_policy(self):
        for name in FIXTURES["source"] + FIXTURES["generated"]:
            write(self.workspace, name, name)
        huge = write(self.workspace, "services/java/target/huge.jar")
        with huge.open("wb") as file:
            file.truncate(9 * 1024 * 1024)
        self.assertEqual(sorted(gateway.snapshot(self.workspace)), sorted(FIXTURES["source"]))
        for name in FIXTURES["generated"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                gateway.safe_path(self.workspace, name)

    def test_every_completed_run_discards_caches_including_timeout_cancel_and_output_limit(self):
        for status in [output(), output(exitCode=1), output(exitCode=-9, timedOut=True),
                       output(exitCode=-9), output(exitCode=-9, truncated=True)]:
            with self.subTest(status=status):
                # Upgrade from an older gateway must not reuse its dependencies.
                write(self.workspace, "old/node_modules/stale.js")

                def execute(request, workspace, code, timeout):
                    self.assertFalse((workspace / "old").exists())
                    self.assertEqual((workspace / "nested/src/main.py").read_text(), "source")
                    for name in FIXTURES["generated"]:
                        write(workspace, name)
                    write(workspace, "nested/src/main.py", "edited")
                    return status

                with patch.object(gateway, "execute_code", side_effect=execute):
                    result = gateway.run_locked(self.request, self.workspace)
                self.assertEqual(result["files"]["nested/src/main.py"]["data"], entry("edited")["data"])
                self.assertEqual(list(result["files"]), ["nested/src/main.py"])
                self.assertFalse(self.workspace.exists())
                self.assertFalse(self.dirty.exists())
                self.assertEqual(result["timedOut"], status["timedOut"])

    def test_next_code_block_is_seeded_from_latest_source_and_propagates_deletions(self):
        def first(request, workspace, code, timeout):
            write(workspace, "apps/web/node_modules/index.js")
            write(workspace, "nested/src/main.py", "edited")
            return output()

        with patch.object(gateway, "execute_code", side_effect=first):
            result = gateway.run_locked(self.request, self.workspace)
        self.request["files"].update(result["files"])

        def second(request, workspace, code, timeout):
            self.assertFalse((workspace / "apps").exists())
            self.assertEqual((workspace / "nested/src/main.py").read_text(), "edited")
            (workspace / "nested/src/main.py").unlink()
            return output()

        with patch.object(gateway, "execute_code", side_effect=second):
            result = gateway.run_locked(self.request, self.workspace)
        self.assertEqual(result["deleted"], ["nested/src/main.py"])
        self.assertFalse(self.workspace.exists())

    def test_read_only_dependency_files_do_not_prevent_cleanup(self):
        def execute(request, workspace, code, timeout):
            cached = write(workspace, "nested/pkg/mod/example/module.go")
            cached.chmod(0o444)
            cached.parent.chmod(0o555)
            return output()

        with patch.object(gateway, "execute_code", side_effect=execute):
            gateway.run_locked(self.request, self.workspace)
        self.assertFalse(self.workspace.exists())
        self.assertFalse(self.dirty.exists())

    def test_failed_export_preserves_source_for_recovery_but_prunes_caches(self):
        def execute(request, workspace, code, timeout):
            for name in FIXTURES["generated"]:
                write(workspace, name)
            with write(workspace, "large-source.dat").open("wb") as file:
                file.truncate(9 * 1024 * 1024)
            write(workspace, "nested/src/main.py", "unsynchronized")
            return output()

        with patch.object(gateway, "execute_code", side_effect=execute):
            with self.assertRaisesRegex(ValueError, "limit exceeded"):
                gateway.run_locked(self.request, self.workspace)
        self.assertTrue(self.dirty.exists())
        self.assertEqual((self.workspace / "nested/src/main.py").read_text(), "unsynchronized")
        self.assertTrue((self.workspace / "large-source.dat").exists())
        for name in FIXTURES["generated"]:
            self.assertFalse((self.workspace / name).exists(), name)
        with patch.object(gateway, "execute_code") as execute:
            with self.assertRaisesRegex(ValueError, "recover remote files"):
                gateway.run_locked(self.request, self.workspace)
            execute.assert_not_called()

    def test_cleanup_failure_preserves_complete_export_even_after_partial_removal(self):
        def execute(request, workspace, code, timeout):
            write(workspace, "nested/src/main.py", "edited")
            return output()

        def discard(workspace):
            (workspace / "nested/src/main.py").unlink()
            raise PermissionError("simulated cleanup failure")

        with patch.object(gateway, "execute_code", side_effect=execute), patch.object(gateway, "discard_tree", side_effect=discard):
            with self.assertRaisesRegex(RuntimeError, "recover exported changes"):
                gateway.run_locked(self.request, self.workspace)
        recovery = json.loads((self.root / (self.workspace.name + ".recovery.json")).read_text())
        self.assertEqual(recovery["files"]["nested/src/main.py"]["data"], entry("edited")["data"])
        self.assertTrue(self.dirty.exists())

    def test_old_clients_and_invalid_requests_cannot_reset_workspace(self):
        source = write(self.workspace, "keep.txt", "keep")
        for changes in [{"workspace_policy_version": 1}, {"code": ""},
                        {"files": {"apps/web/node_modules/x": entry("invalid")}}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                gateway.run_locked({**self.request, **changes}, self.workspace)
            self.assertEqual(source.read_text(), "keep")
        cancelled = self.root / (self.request["run"] + ".cancelled")
        cancelled.touch()
        with self.assertRaisesRegex(ValueError, "cancelled"):
            gateway.run_locked(self.request, self.workspace)
        self.assertEqual(source.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
