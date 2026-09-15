"""桥接状态持久化：last_mirrored_moment_id + retry queue。

复用 ShadwMonitor 既有的 aiosqlite 连接，不新建数据库文件，
两张新表直接放在 ai_monitor.db 里。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

import aiosqlite

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS bridge_state (
    k          TEXT PRIMARY KEY,
    v          TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS bridge_retry_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    moment_id       INTEGER NOT NULL,
    payload_json    TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT,
    created_at      TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(moment_id)
);
CREATE INDEX IF NOT EXISTS idx_bridge_retry_next ON bridge_retry_queue(next_attempt_at);
"""

_KEY_LAST_MIRRORED = "last_mirrored_moment_id"


class BridgeState:
    """封装 bridge 用的两张状态表。"""

    def __init__(self, db_path: str):
        self.db_path = db_path

    async def init_tables(self) -> None:
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.executescript(_SCHEMA_SQL)
            await conn.commit()

    # ── last_mirrored_moment_id ──

    async def get_last_mirrored_id(self) -> int:
        async with aiosqlite.connect(self.db_path) as conn:
            async with conn.execute(
                "SELECT v FROM bridge_state WHERE k = ?", (_KEY_LAST_MIRRORED,)
            ) as cur:
                row = await cur.fetchone()
        if not row:
            return 0
        try:
            return int(row[0])
        except (TypeError, ValueError):
            return 0

    async def set_last_mirrored_id(self, moment_id: int) -> None:
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                """
                INSERT INTO bridge_state(k, v, updated_at)
                VALUES (?, ?, datetime('now', 'localtime'))
                ON CONFLICT(k) DO UPDATE SET
                    v = excluded.v, updated_at = excluded.updated_at
                """,
                (_KEY_LAST_MIRRORED, str(moment_id)),
            )
            await conn.commit()

    async def initialize_high_water_mark(self) -> None:
        """首次启用时不补传历史，把水位推到现有最大 moment id。"""
        if await self.get_last_mirrored_id() > 0:
            return
        async with aiosqlite.connect(self.db_path) as conn:
            async with conn.execute("SELECT COALESCE(MAX(id), 0) FROM moment_summaries") as cur:
                row = await cur.fetchone()
        max_id = int(row[0]) if row and row[0] is not None else 0
        await self.set_last_mirrored_id(max_id)

    # ── retry queue ──

    async def enqueue_retry(
        self,
        moment_id: int,
        payload: dict[str, Any],
        delay_seconds: int,
        last_error: str,
    ) -> None:
        next_at = (datetime.now() + timedelta(seconds=delay_seconds)).strftime("%Y-%m-%d %H:%M:%S")
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                """
                INSERT INTO bridge_retry_queue (moment_id, payload_json, attempts, next_attempt_at, last_error)
                VALUES (?, ?, 1, ?, ?)
                ON CONFLICT(moment_id) DO UPDATE SET
                    attempts        = attempts + 1,
                    next_attempt_at = excluded.next_attempt_at,
                    last_error      = excluded.last_error
                """,
                (moment_id, json.dumps(payload, ensure_ascii=False), next_at, last_error[:1000]),
            )
            await conn.commit()

    async def pop_due_retries(self, limit: int = 20) -> list[dict[str, Any]]:
        """取当前到期的重试项。返回列表，调用方负责 delete_retry/enqueue_retry。"""
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            async with conn.execute(
                """
                SELECT id, moment_id, payload_json, attempts, last_error
                FROM bridge_retry_queue
                WHERE next_attempt_at <= ?
                ORDER BY next_attempt_at ASC
                LIMIT ?
                """,
                (now, limit),
            ) as cur:
                rows = await cur.fetchall()
        result: list[dict[str, Any]] = []
        for r in rows:
            try:
                payload = json.loads(r["payload_json"])
            except json.JSONDecodeError:
                payload = {}
            result.append(
                {
                    "id": r["id"],
                    "moment_id": r["moment_id"],
                    "payload": payload,
                    "attempts": r["attempts"],
                    "last_error": r["last_error"] or "",
                }
            )
        return result

    async def delete_retry(self, retry_id: int) -> None:
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute("DELETE FROM bridge_retry_queue WHERE id = ?", (retry_id,))
            await conn.commit()

    async def mark_retry_failed(
        self, retry_id: int, delay_seconds: int, last_error: str
    ) -> None:
        next_at = (datetime.now() + timedelta(seconds=delay_seconds)).strftime("%Y-%m-%d %H:%M:%S")
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                """
                UPDATE bridge_retry_queue
                SET attempts = attempts + 1,
                    next_attempt_at = ?,
                    last_error = ?
                WHERE id = ?
                """,
                (next_at, last_error[:1000], retry_id),
            )
            await conn.commit()

    async def retry_queue_size(self) -> int:
        async with aiosqlite.connect(self.db_path) as conn:
            async with conn.execute("SELECT COUNT(*) FROM bridge_retry_queue") as cur:
                row = await cur.fetchone()
        return int(row[0]) if row else 0
