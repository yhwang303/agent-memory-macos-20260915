from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any


def normalize_prefix(path: str) -> str:
    return str(path).replace("\\", "/").rstrip("/")


def find_memory_db(config: dict[str, Any]) -> str:
    configured = config.get("memory_db")
    if configured:
        candidate = Path(os.path.expanduser(str(configured)))
        if candidate.exists():
            return str(candidate)
        raise ValueError(f"Configured memory_db does not exist: {candidate}")

    candidates = [
        Path.home() / ".agent-memory" / "agent-memory.db",
        Path.home() / ".codebuddy" / "agent-memory.db",
        Path.home() / "agent-memory.db",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    raise ValueError("Cannot find agent-memory.db. Set 'memory_db' in ShadowFolk config.")


def fetch_rows(db_path: str, table: str, git_root: str, nested_repos: list[str], last_id: int) -> list[dict[str, Any]]:
    if table not in {"observations", "session_summaries"}:
        raise ValueError(f"Unsupported export table: {table}")

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        sql = f"SELECT * FROM {table} WHERE project LIKE ? AND id > ?"
        params: list[Any] = [f"{normalize_prefix(git_root)}%", last_id]
        for nested in nested_repos:
            sql += " AND project NOT LIKE ?"
            params.append(f"{normalize_prefix(nested)}%")
        sql += " ORDER BY id ASC"
        cursor = conn.execute(sql, params)
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def export_observations(db_path: str, git_root: str, nested_repos: list[str], last_id: int) -> list[dict[str, Any]]:
    return fetch_rows(db_path, "observations", git_root, nested_repos, last_id)


def export_session_summaries(db_path: str, git_root: str, nested_repos: list[str], last_id: int) -> list[dict[str, Any]]:
    return fetch_rows(db_path, "session_summaries", git_root, nested_repos, last_id)
