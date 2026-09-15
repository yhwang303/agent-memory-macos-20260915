import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shadowfolk_upload.runner import UploadResult, compute_backoff_seconds, run_daemon


class DaemonTests(unittest.TestCase):
    def test_backoff_is_exponential_and_capped(self):
        self.assertEqual(compute_backoff_seconds(1, base_delay=30, max_delay=1800), 60)
        self.assertEqual(compute_backoff_seconds(2, base_delay=30, max_delay=1800), 120)
        self.assertEqual(compute_backoff_seconds(99, base_delay=30, max_delay=1800), 1800)

    def test_daemon_applies_workspace_config_overrides(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            shadow_dir = workspace / ".shadow"
            shadow_dir.mkdir()
            (shadow_dir / "config.json").write_text(json.dumps({"server": "https://local.example"}), encoding="utf-8")
            seen_configs = []

            def fake_upload_once(workspace_arg, shadow_config, status_file=None):
                seen_configs.append(shadow_config)
                return UploadResult(str(workspace_arg), False, None, 0, 0)

            def stop_after_cycle(_seconds):
                raise KeyboardInterrupt()

            with patch("shadowfolk_upload.runner.upload_once", side_effect=fake_upload_once):
                with self.assertRaises(KeyboardInterrupt):
                    run_daemon(
                        [str(workspace)],
                        {"server": "https://global.example", "api_token": "sf_test"},
                        interval_seconds=60,
                        retry_max_attempts=1,
                        retry_base_delay_seconds=1,
                        retry_max_delay_seconds=2,
                        sleep=stop_after_cycle,
                    )

            self.assertEqual(seen_configs[0]["server"], "https://local.example")
            self.assertEqual(seen_configs[0]["api_token"], "sf_test")
