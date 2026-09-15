import json
from pathlib import Path

import aiosqlite

from src.storage.models import (
    CaptureDetail,
    CaptureRecord,
    DailySummary,
    MomentSummary,
    OCRResult,
    SessionSummary,
)
from src.utils.logger import log

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS captures (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL,
    process_name    TEXT,
    window_title    TEXT,
    screenshot_path TEXT NOT NULL,
    change_score    REAL,
    ocr_status      TEXT DEFAULT 'pending',
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_captures_timestamp ON captures(timestamp);
CREATE INDEX IF NOT EXISTS idx_captures_ocr_status ON captures(ocr_status);

CREATE TABLE IF NOT EXISTS ocr_results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id      INTEGER NOT NULL REFERENCES captures(id),
    zone_map_text   TEXT NOT NULL,
    raw_ocr_json    TEXT,
    text_length     INTEGER,
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ocr_capture ON ocr_results(capture_id);

CREATE TABLE IF NOT EXISTS moment_summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    time_start      TEXT NOT NULL,
    time_end        TEXT NOT NULL,
    summary         TEXT NOT NULL,
    capture_ids     TEXT NOT NULL,
    app_names       TEXT,
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_moment_time ON moment_summaries(time_start, time_end);

CREATE TABLE IF NOT EXISTS session_summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    time_start      TEXT NOT NULL,
    time_end        TEXT NOT NULL,
    summary         TEXT NOT NULL,
    moment_ids      TEXT NOT NULL,
    app_names       TEXT,
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_session_time ON session_summaries(time_start, time_end);

CREATE TABLE IF NOT EXISTS daily_summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    date            TEXT NOT NULL UNIQUE,
    summary         TEXT NOT NULL,
    app_usage_stats TEXT,
    session_ids     TEXT NOT NULL,
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_summaries(date);

CREATE TABLE IF NOT EXISTS window_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL,
    process_name    TEXT,
    window_title    TEXT,
    event_type      TEXT NOT NULL,
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_window_timestamp ON window_events(timestamp);
"""


class Database:
    def __init__(self, db_path: str):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    async def init_tables(self):
        async with aiosqlite.connect(self.db_path) as db:
            await db.executescript(_SCHEMA_SQL)
            await db.commit()
        log.info("数据库表初始化完成: %s", self.db_path)

    # ── captures ──

    async def insert_capture(self, rec: CaptureRecord) -> int:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "INSERT INTO captures (timestamp, process_name, window_title, screenshot_path, change_score, ocr_status) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (rec.timestamp, rec.process_name, rec.window_title,
                 rec.screenshot_path, rec.change_score, rec.ocr_status),
            )
            await db.commit()
            return cursor.lastrowid

    async def update_ocr_status(self, capture_id: int, status: str):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "UPDATE captures SET ocr_status = ? WHERE id = ?",
                (status, capture_id),
            )
            await db.commit()

    async def get_captures_in_range(self, time_start: str, time_end: str) -> list[CaptureRecord]:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM captures WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp",
                (time_start, time_end),
            )
            rows = await cursor.fetchall()
            return [CaptureRecord(
                id=r["id"], timestamp=r["timestamp"], process_name=r["process_name"],
                window_title=r["window_title"], screenshot_path=r["screenshot_path"],
                change_score=r["change_score"], ocr_status=r["ocr_status"],
            ) for r in rows]

    async def get_capture_by_id(self, capture_id: int) -> CaptureRecord | None:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("SELECT * FROM captures WHERE id = ?", (capture_id,))
            r = await cursor.fetchone()
            if not r:
                return None
            return CaptureRecord(
                id=r["id"], timestamp=r["timestamp"], process_name=r["process_name"],
                window_title=r["window_title"], screenshot_path=r["screenshot_path"],
                change_score=r["change_score"], ocr_status=r["ocr_status"],
            )

    # ── ocr_results ──

    async def insert_ocr_result(self, result: OCRResult) -> int:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "INSERT INTO ocr_results (capture_id, zone_map_text, raw_ocr_json, text_length) "
                "VALUES (?, ?, ?, ?)",
                (result.capture_id, result.zone_map_text, result.raw_ocr_json, result.text_length),
            )
            await db.commit()
            return cursor.lastrowid

    async def get_ocr_by_capture_id(self, capture_id: int) -> OCRResult | None:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM ocr_results WHERE capture_id = ?", (capture_id,)
            )
            r = await cursor.fetchone()
            if not r:
                return None
            return OCRResult(
                id=r["id"], capture_id=r["capture_id"],
                zone_map_text=r["zone_map_text"], raw_ocr_json=r["raw_ocr_json"],
                text_length=r["text_length"],
            )

    async def get_zone_maps_in_range(self, time_start: str, time_end: str) -> list[dict]:
        """获取时间范围内所有已完成 OCR 的 zone_map 数据，附带窗口信息"""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT c.id as capture_id, c.timestamp, c.process_name, c.window_title, "
                "o.zone_map_text FROM captures c "
                "JOIN ocr_results o ON c.id = o.capture_id "
                "WHERE c.timestamp >= ? AND c.timestamp < ? "
                "ORDER BY c.timestamp",
                (time_start, time_end),
            )
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]

    # ── window_events ──

    async def insert_window_event(self, timestamp: str, process_name: str,
                                  window_title: str, event_type: str):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "INSERT INTO window_events (timestamp, process_name, window_title, event_type) "
                "VALUES (?, ?, ?, ?)",
                (timestamp, process_name, window_title, event_type),
            )
            await db.commit()

    # ── moment_summaries ──

    async def insert_moment_summary(self, summary: MomentSummary) -> int:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "INSERT INTO moment_summaries (time_start, time_end, summary, capture_ids, app_names) "
                "VALUES (?, ?, ?, ?, ?)",
                (summary.time_start, summary.time_end, summary.summary,
                 json.dumps(summary.capture_ids), json.dumps(summary.app_names, ensure_ascii=False)),
            )
            await db.commit()
            return cursor.lastrowid

    async def get_moments_in_range(self, time_start: str, time_end: str) -> list[MomentSummary]:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM moment_summaries WHERE time_start >= ? AND time_end <= ? ORDER BY time_start",
                (time_start, time_end),
            )
            rows = await cursor.fetchall()
            return [MomentSummary(
                id=r["id"], time_start=r["time_start"], time_end=r["time_end"],
                summary=r["summary"],
                capture_ids=json.loads(r["capture_ids"]),
                app_names=json.loads(r["app_names"]) if r["app_names"] else [],
            ) for r in rows]

    async def get_undistilled_moment_range(self, time_end_before: str) -> list[dict]:
        """获取尚未被L2蒸馏的L1描述（即不在任何session的moment_ids中的moment）"""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM moment_summaries WHERE time_end <= ? ORDER BY time_start",
                (time_end_before,),
            )
            all_moments = await cursor.fetchall()

            cursor2 = await db.execute("SELECT moment_ids FROM session_summaries")
            session_rows = await cursor2.fetchall()
            used_ids: set[int] = set()
            for sr in session_rows:
                used_ids.update(json.loads(sr["moment_ids"]))

            return [dict(r) for r in all_moments if r["id"] not in used_ids]

    async def get_moment_by_id(self, moment_id: int) -> MomentSummary | None:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM moment_summaries WHERE id = ?", (moment_id,)
            )
            r = await cursor.fetchone()
            if not r:
                return None
            return MomentSummary(
                id=r["id"], time_start=r["time_start"], time_end=r["time_end"],
                summary=r["summary"],
                capture_ids=json.loads(r["capture_ids"]),
                app_names=json.loads(r["app_names"]) if r["app_names"] else [],
            )

    # ── session_summaries ──

    async def insert_session_summary(self, summary: SessionSummary) -> int:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "INSERT INTO session_summaries (time_start, time_end, summary, moment_ids, app_names) "
                "VALUES (?, ?, ?, ?, ?)",
                (summary.time_start, summary.time_end, summary.summary,
                 json.dumps(summary.moment_ids), json.dumps(summary.app_names, ensure_ascii=False)),
            )
            await db.commit()
            return cursor.lastrowid

    async def get_sessions_for_date(self, date: str) -> list[SessionSummary]:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM session_summaries WHERE time_start >= ? AND time_start < ? ORDER BY time_start",
                (f"{date}T00:00:00", f"{date}T23:59:59"),
            )
            rows = await cursor.fetchall()
            return [SessionSummary(
                id=r["id"], time_start=r["time_start"], time_end=r["time_end"],
                summary=r["summary"],
                moment_ids=json.loads(r["moment_ids"]),
                app_names=json.loads(r["app_names"]) if r["app_names"] else [],
            ) for r in rows]

    async def get_session_by_id(self, session_id: int) -> SessionSummary | None:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM session_summaries WHERE id = ?", (session_id,)
            )
            r = await cursor.fetchone()
            if not r:
                return None
            return SessionSummary(
                id=r["id"], time_start=r["time_start"], time_end=r["time_end"],
                summary=r["summary"],
                moment_ids=json.loads(r["moment_ids"]),
                app_names=json.loads(r["app_names"]) if r["app_names"] else [],
            )

    # ── daily_summaries ──

    async def insert_daily_summary(self, summary: DailySummary) -> int:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "INSERT OR REPLACE INTO daily_summaries (date, summary, app_usage_stats, session_ids) "
                "VALUES (?, ?, ?, ?)",
                (summary.date, summary.summary,
                 json.dumps(summary.app_usage_stats, ensure_ascii=False),
                 json.dumps(summary.session_ids)),
            )
            await db.commit()
            return cursor.lastrowid

    async def get_daily_summary(self, date: str) -> DailySummary | None:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM daily_summaries WHERE date = ?", (date,)
            )
            r = await cursor.fetchone()
            if not r:
                return None
            return DailySummary(
                id=r["id"], date=r["date"], summary=r["summary"],
                app_usage_stats=json.loads(r["app_usage_stats"]) if r["app_usage_stats"] else {},
                session_ids=json.loads(r["session_ids"]),
            )

    # ── capture_detail (联合查询) ──

    async def get_capture_detail(self, capture_id: int) -> CaptureDetail | None:
        capture = await self.get_capture_by_id(capture_id)
        if not capture:
            return None
        ocr = await self.get_ocr_by_capture_id(capture_id)
        return CaptureDetail(capture=capture, ocr=ocr)

    async def get_pending_ocr_count(self) -> int:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "SELECT COUNT(*) FROM captures WHERE ocr_status = 'pending'"
            )
            row = await cursor.fetchone()
            return row[0]

    async def get_recent_captures_with_ocr(self, limit: int = 20) -> list[dict]:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT c.id, c.timestamp, c.process_name, c.window_title, "
                "c.screenshot_path, c.change_score, c.ocr_status, "
                "o.zone_map_text "
                "FROM captures c "
                "LEFT JOIN ocr_results o ON c.id = o.capture_id "
                "ORDER BY c.timestamp DESC LIMIT ?",
                (limit,),
            )
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]
