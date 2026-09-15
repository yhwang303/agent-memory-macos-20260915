import json
import tempfile
import unittest
from pathlib import Path

from shadowfolk_upload.config import (
    DEFAULT_SERVER,
    UploadConfig,
    load_shadow_config,
    load_upload_config,
    merge_workspace_config,
)


class ConfigTests(unittest.TestCase):
    def test_load_shadow_config_requires_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            config_path.write_text(json.dumps({"server": "https://example.test"}), encoding="utf-8")

            with self.assertRaises(ValueError) as ctx:
                load_shadow_config(config_path)

            self.assertIn("api_token", str(ctx.exception))

    def test_load_shadow_config_defaults_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            config_path.write_text(json.dumps({"api_token": "sf_test"}), encoding="utf-8")

            config = load_shadow_config(config_path)

            self.assertEqual(config["server"], DEFAULT_SERVER)
            self.assertEqual(config["api_token"], "sf_test")

    def test_upload_config_defaults(self):
        config = load_upload_config(None)

        self.assertIsInstance(config, UploadConfig)
        self.assertTrue(config.enabled)
        self.assertEqual(config.interval_seconds, 60)
        self.assertEqual(config.workspaces, [])

    def test_upload_config_from_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "upload.json"
            config_path.write_text(
                json.dumps(
                    {
                        "enabled": False,
                        "intervalSeconds": 5,
                        "workspaces": ["E:/Github/agent-memory"],
                        "retry": {
                            "maxAttempts": 3,
                            "baseDelaySeconds": 2,
                            "maxDelaySeconds": 30,
                        },
                        "statusFile": str(Path(tmp) / "status.json"),
                        "logFile": str(Path(tmp) / "upload.log"),
                    }
                ),
                encoding="utf-8",
            )

            config = load_upload_config(config_path)

            self.assertFalse(config.enabled)
            self.assertEqual(config.interval_seconds, 5)
            self.assertEqual(config.workspaces, ["E:/Github/agent-memory"])
            self.assertEqual(config.retry_max_attempts, 3)
            self.assertEqual(config.retry_base_delay_seconds, 2)
            self.assertEqual(config.retry_max_delay_seconds, 30)

    def test_workspace_config_overrides_global_values(self):
        global_config = {
            "server": "https://global.example",
            "api_token": "sf_global",
            "memory_db": "/tmp/global.db",
        }
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            shadow_dir = workspace / ".shadow"
            shadow_dir.mkdir()
            (shadow_dir / "config.json").write_text(
                json.dumps(
                    {
                        "server": "https://local.example",
                        "project_id": "proj_123",
                    }
                ),
                encoding="utf-8",
            )

            merged = merge_workspace_config(global_config, workspace)

            self.assertEqual(merged["server"], "https://local.example")
            self.assertEqual(merged["api_token"], "sf_global")
            self.assertEqual(merged["project_id"], "proj_123")
