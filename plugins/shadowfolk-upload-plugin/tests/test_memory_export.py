import sqlite3
import tempfile
import unittest
from pathlib import Path

from shadowfolk_upload.memory_export import export_observations, export_session_summaries, find_memory_db


class MemoryExportTests(unittest.TestCase):
    def make_db(self) -> Path:
        tmp = Path(tempfile.mkdtemp())
        db_path = tmp / "agent-memory.db"
        conn = sqlite3.connect(db_path)
        conn.execute(
            """
            CREATE TABLE observations (
                id INTEGER PRIMARY KEY,
                project TEXT NOT NULL,
                title TEXT,
                created_at_epoch INTEGER
            )
        """
        )
        conn.execute(
            """
            CREATE TABLE session_summaries (
                id INTEGER PRIMARY KEY,
                project TEXT NOT NULL,
                request TEXT,
                created_at_epoch INTEGER
            )
        """
        )
        conn.execute("INSERT INTO observations VALUES (1, ?, 'old', 10)", ("E:/Github/app",))
        conn.execute("INSERT INTO observations VALUES (2, ?, 'new', 20)", ("E:/Github/app",))
        conn.execute("INSERT INTO observations VALUES (3, ?, 'nested', 30)", ("E:/Github/app/vendor/lib",))
        conn.execute("INSERT INTO observations VALUES (4, ?, 'other', 40)", ("E:/Github/other",))
        conn.execute("INSERT INTO session_summaries VALUES (1, ?, 'old summary', 10)", ("E:/Github/app",))
        conn.execute("INSERT INTO session_summaries VALUES (2, ?, 'new summary', 20)", ("E:/Github/app",))
        conn.commit()
        conn.close()
        return db_path

    def test_find_memory_db_uses_configured_path(self):
        db = self.make_db()

        self.assertEqual(find_memory_db({"memory_db": str(db)}), str(db))

    def test_export_observations_filters_by_project_id_and_nested_repos(self):
        db = self.make_db()

        rows = export_observations(str(db), "E:/Github/app", ["E:/Github/app/vendor"], last_id=1)

        self.assertEqual([row["id"] for row in rows], [2])
        self.assertEqual(rows[0]["title"], "new")

    def test_export_summaries_filters_by_project_and_last_id(self):
        db = self.make_db()

        rows = export_session_summaries(str(db), "E:/Github/app", [], last_id=1)

        self.assertEqual([row["id"] for row in rows], [2])
        self.assertEqual(rows[0]["request"], "new summary")
