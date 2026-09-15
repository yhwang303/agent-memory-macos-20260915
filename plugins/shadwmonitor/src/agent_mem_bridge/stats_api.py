"""挂到插件 8080 Web 端的 FastAPI router。

供 agent-mem viewer.html 的 ShadwMonitor Tab 跨域调用，
返回今日时间线 / 应用排行 / 统计数字 / 桥接健康。

设计：D:\\UGIT\\agent-memory\\docs\\memory-core\\features\\desktop-monitor-plugin\\design.md §A
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from typing import Any

import aiosqlite
from fastapi import APIRouter, Query


def create_shadw_stats_router(db_path: str) -> APIRouter:
    """构造 /api/shadw/* 路由。

    所有端点都不依赖 BridgePoster 进程内存状态——直接查 SQLite，
    这样 Web 进程和 capture 进程跨进程时也能正确读到 bridge 状态。
    """
    router = APIRouter(prefix="/api/shadw", tags=["shadwmonitor"])

    @router.get("/stats/today")
    async def stats_today() -> dict[str, Any]:
        d = _date_str()
        l1, caps, active_hours, apps_count = await _gather_today_basics(db_path, d)
        bridge = await _bridge_health(db_path)
        return {
            "date": d,
            "l1_count": l1,
            "capture_count": caps,
            "active_hours": round(active_hours, 1),
            "apps_count": apps_count,
            "mirrored_today": bridge["mirrored_today"],
            "retry_queue_size": bridge["retry_queue_size"],
            "last_mirrored_id": bridge["last_mirrored_id"],
            "mirror_rate": _safe_ratio(bridge["mirrored_today"], l1),
        }

    @router.get("/timeline/today")
    async def timeline_today() -> dict[str, Any]:
        """返回当日按时间排序的应用使用段。

        策略：以 captures 表的 process_name 切分，同进程连续时间合并成一段；
        相邻段之间间隔超过 5 分钟视为有空闲（gap）。
        """
        d = _date_str()
        rows = await _query_captures_for_date(db_path, d)
        segments = _collapse_to_segments(rows, gap_seconds=300)
        return {
            "date": d,
            "segments": segments,
        }

    @router.get("/apps/today")
    async def apps_today() -> dict[str, Any]:
        d = _date_str()
        rows = await _query_app_distribution(db_path, d)
        return {"date": d, "apps": rows}

    @router.get("/moments")
    async def moments_list(
        date_str: str = Query("", alias="date"),
        limit: int = Query(20, ge=1, le=200),
    ) -> dict[str, Any]:
        d = date_str or _date_str()
        moments = await _query_moments_for_date(db_path, d, limit=limit)
        return {"date": d, "moments": moments}

    @router.get("/health")
    async def health() -> dict[str, Any]:
        bridge = await _bridge_health(db_path)
        return {
            "ok": True,
            "endpoint_hint": "configured in settings.yaml agent_mem.endpoint",
            **bridge,
        }

    return router


# ── helpers ──

def _date_str() -> str:
    return date.today().isoformat()


def _safe_ratio(a: int, b: int) -> float:
    if not b:
        return 1.0 if a == 0 else 0.0
    return round(a / b, 3)


async def _gather_today_basics(db_path: str, d: str) -> tuple[int, int, float, int]:
    ts = f"{d}T00:00:00"
    te = f"{d}T23:59:59"
    async with aiosqlite.connect(db_path) as conn:
        async with conn.execute(
            "SELECT COUNT(*) FROM moment_summaries WHERE time_start >= ? AND time_start <= ?",
            (ts, te),
        ) as cur:
            l1 = int((await cur.fetchone() or [0])[0])
        async with conn.execute(
            "SELECT COUNT(*) FROM captures WHERE timestamp >= ? AND timestamp <= ?",
            (ts, te),
        ) as cur:
            caps = int((await cur.fetchone() or [0])[0])
        async with conn.execute(
            """
            SELECT MIN(timestamp), MAX(timestamp), COUNT(DISTINCT process_name)
            FROM captures
            WHERE timestamp >= ? AND timestamp <= ?
            """,
            (ts, te),
        ) as cur:
            row = await cur.fetchone()
    active_hours = 0.0
    apps_count = 0
    if row and row[0] and row[1]:
        try:
            t_min = datetime.fromisoformat(row[0])
            t_max = datetime.fromisoformat(row[1])
            active_hours = (t_max - t_min).total_seconds() / 3600.0
        except ValueError:
            active_hours = 0.0
        apps_count = int(row[2] or 0)
    return l1, caps, active_hours, apps_count


async def _bridge_health(db_path: str) -> dict[str, Any]:
    """从 bridge_state + bridge_retry_queue 表反推健康指标。"""
    last_mirrored_id = 0
    retry_q = 0
    today_str = _date_str()
    mirrored_today = 0
    try:
        async with aiosqlite.connect(db_path) as conn:
            async with conn.execute(
                "SELECT v FROM bridge_state WHERE k='last_mirrored_moment_id'"
            ) as cur:
                row = await cur.fetchone()
                if row:
                    try:
                        last_mirrored_id = int(row[0])
                    except (TypeError, ValueError):
                        last_mirrored_id = 0
            async with conn.execute("SELECT COUNT(*) FROM bridge_retry_queue") as cur:
                row = await cur.fetchone()
                retry_q = int((row or [0])[0])
            # 近似：统计今日已镜像 L1 数 = today 范围内 id <= last_mirrored_id 的 moment 数
            ts = f"{today_str}T00:00:00"
            te = f"{today_str}T23:59:59"
            async with conn.execute(
                """
                SELECT COUNT(*) FROM moment_summaries
                WHERE id <= ? AND time_start >= ? AND time_start <= ?
                """,
                (last_mirrored_id, ts, te),
            ) as cur:
                row = await cur.fetchone()
                mirrored_today = int((row or [0])[0])
    except aiosqlite.OperationalError:
        # bridge_state / bridge_retry_queue 尚未建表（bridge 从未启用）
        pass
    return {
        "last_mirrored_id": last_mirrored_id,
        "retry_queue_size": retry_q,
        "mirrored_today": mirrored_today,
    }


async def _query_captures_for_date(db_path: str, d: str) -> list[dict[str, Any]]:
    ts = f"{d}T00:00:00"
    te = f"{d}T23:59:59"
    async with aiosqlite.connect(db_path) as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute(
            """
            SELECT timestamp, process_name
            FROM captures
            WHERE timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
            """,
            (ts, te),
        ) as cur:
            rows = await cur.fetchall()
    return [{"timestamp": r["timestamp"], "process_name": r["process_name"] or ""} for r in rows]


def _collapse_to_segments(rows: list[dict[str, Any]], gap_seconds: int = 300) -> list[dict[str, Any]]:
    if not rows:
        return []
    segments: list[dict[str, Any]] = []
    current = {
        "app": rows[0]["process_name"],
        "time_start": rows[0]["timestamp"],
        "time_end": rows[0]["timestamp"],
    }
    last_ts = datetime.fromisoformat(rows[0]["timestamp"])
    for r in rows[1:]:
        try:
            this_ts = datetime.fromisoformat(r["timestamp"])
        except ValueError:
            continue
        if r["process_name"] == current["app"] and (this_ts - last_ts).total_seconds() <= gap_seconds:
            current["time_end"] = r["timestamp"]
        else:
            segments.append(current)
            current = {
                "app": r["process_name"],
                "time_start": r["timestamp"],
                "time_end": r["timestamp"],
            }
        last_ts = this_ts
    segments.append(current)
    return segments


async def _query_app_distribution(db_path: str, d: str) -> list[dict[str, Any]]:
    """按 app 聚合：每 app 当日产生的 L1 数 + 该 app 出现过的 captures 时间跨度估算。"""
    ts = f"{d}T00:00:00"
    te = f"{d}T23:59:59"
    async with aiosqlite.connect(db_path) as conn:
        conn.row_factory = aiosqlite.Row
        # captures 按 app 聚合（持续时长粗算）
        async with conn.execute(
            """
            SELECT process_name AS app, COUNT(*) AS capture_count,
                   MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen
            FROM captures
            WHERE timestamp >= ? AND timestamp <= ? AND process_name IS NOT NULL AND process_name != ''
            GROUP BY process_name
            ORDER BY capture_count DESC
            """,
            (ts, te),
        ) as cur:
            cap_rows = await cur.fetchall()
        # moments 按 app 聚合
        async with conn.execute(
            "SELECT app_names FROM moment_summaries WHERE time_start >= ? AND time_start <= ?",
            (ts, te),
        ) as cur:
            moment_rows = await cur.fetchall()
    moment_count_per_app: dict[str, int] = {}
    for r in moment_rows:
        try:
            apps = json.loads(r["app_names"]) if r["app_names"] else []
        except json.JSONDecodeError:
            apps = []
        for a in apps:
            moment_count_per_app[a] = moment_count_per_app.get(a, 0) + 1
    out: list[dict[str, Any]] = []
    for r in cap_rows:
        app = r["app"]
        try:
            duration = (datetime.fromisoformat(r["last_seen"]) - datetime.fromisoformat(r["first_seen"])).total_seconds()
        except (TypeError, ValueError):
            duration = 0.0
        out.append({
            "app": app,
            "capture_count": int(r["capture_count"] or 0),
            "moment_count": int(moment_count_per_app.get(app, 0)),
            "duration_seconds": round(max(0.0, duration), 1),
        })
    return out


async def _query_moments_for_date(db_path: str, d: str, limit: int) -> list[dict[str, Any]]:
    ts = f"{d}T00:00:00"
    te = f"{d}T23:59:59"
    async with aiosqlite.connect(db_path) as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute(
            """
            SELECT id, time_start, time_end, summary, capture_ids, app_names
            FROM moment_summaries
            WHERE time_start >= ? AND time_start <= ?
            ORDER BY time_start DESC
            LIMIT ?
            """,
            (ts, te, limit),
        ) as cur:
            rows = await cur.fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        try:
            capture_ids = json.loads(r["capture_ids"]) if r["capture_ids"] else []
        except json.JSONDecodeError:
            capture_ids = []
        try:
            app_names = json.loads(r["app_names"]) if r["app_names"] else []
        except json.JSONDecodeError:
            app_names = []
        # 取前几张截图路径
        screenshot_paths: list[str] = []
        if capture_ids:
            placeholders = ",".join("?" * min(5, len(capture_ids)))
            async with aiosqlite.connect(db_path) as conn2:
                async with conn2.execute(
                    f"SELECT screenshot_path FROM captures WHERE id IN ({placeholders}) ORDER BY id ASC",
                    tuple(capture_ids[:5]),
                ) as cur2:
                    sp_rows = await cur2.fetchall()
            screenshot_paths = [r2[0] for r2 in sp_rows if r2 and r2[0]]
        out.append({
            "id": r["id"],
            "time_start": r["time_start"],
            "time_end": r["time_end"],
            "summary": r["summary"],
            "capture_count": len(capture_ids),
            "app_names": app_names,
            "screenshot_paths": screenshot_paths,
        })
    return out
