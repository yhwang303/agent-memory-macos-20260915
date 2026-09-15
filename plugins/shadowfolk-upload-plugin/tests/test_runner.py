import unittest

from shadowfolk_upload.runner import build_payload, compute_new_cursors, should_upload


class RunnerTests(unittest.TestCase):
    def test_should_upload_false_when_no_content(self):
        self.assertFalse(should_upload([], [], []))

    def test_should_upload_true_when_any_content_exists(self):
        self.assertTrue(should_upload([{"hash": "abc"}], [], []))
        self.assertTrue(should_upload([], [{"id": 1}], []))
        self.assertTrue(should_upload([], [], [{"id": 2}]))

    def test_build_payload_preserves_git_and_memory_blocks(self):
        payload = build_payload(
            git_root="E:/Github/app",
            remote="https://example.test/app.git",
            branch="main",
            commits=[{"hash": "h1"}],
            stats={"files_changed": 1},
            nested_repos=["E:/Github/app/vendor"],
            observations=[{"id": 2}],
            session_summaries=[{"id": 3}],
            last_commit="h0",
        )

        self.assertEqual(payload["git"]["root"], "E:/Github/app")
        self.assertEqual(payload["git"]["commit_range_start"], "h0")
        self.assertEqual(payload["git"]["commit_range_end"], "h1")
        self.assertEqual(payload["memory"]["scope"], "E:/Github/app")
        self.assertEqual(payload["memory"]["excluded_prefixes"], ["E:/Github/app/vendor"])

    def test_compute_new_cursors(self):
        cursors = compute_new_cursors(
            last_commit="old",
            commits=[{"hash": "new"}],
            observations=[{"id": 2}, {"id": 5}],
            summaries=[{"id": 4}],
            last_obs_id=1,
            last_sum_id=0,
            batch_id="batch_1",
        )

        self.assertEqual(cursors["last_commit_hash"], "new")
        self.assertEqual(cursors["last_observation_id"], 5)
        self.assertEqual(cursors["last_summary_id"], 4)
        self.assertEqual(cursors["task_id"], "batch_1")
