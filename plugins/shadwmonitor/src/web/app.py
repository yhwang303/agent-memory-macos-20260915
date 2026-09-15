import sys
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from src.agent.distiller import Distiller
from src.agent.query import QueryEngine
from src.agent_mem_bridge.stats_api import create_shadw_stats_router
from src.config import AppConfig, save_monitor_indices
from src.storage.database import Database

_config_path: str = ""

_db: Database | None = None
_query: QueryEngine | None = None
_distiller: Distiller | None = None
_config: AppConfig | None = None


def create_app(config: AppConfig, config_path: str = "") -> FastAPI:
    global _db, _query, _distiller, _config, _config_path
    _config = config
    _config_path = config_path

    db_path = str(Path(config.base_dir) / config.storage.db_path)
    _db = Database(db_path)
    _query = QueryEngine(_db)
    _distiller = Distiller(config=config.agent, db=_db)

    app = FastAPI(title="AI Monitor", docs_url="/docs")

    # CORS: 允许 agent-mem viewer (默认 http://localhost:3847) 跨域调 /api/shadw/*
    # 本插件自身的 / 和 /api/* 是同域访问，加 CORS 主要为了 agent-mem viewer
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # 本地工具，所有 origin 都允许
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    static_dir = Path(__file__).parent / "static"
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    screenshot_dir = str(Path(config.base_dir) / config.storage.screenshot_dir)
    app.mount("/screenshots", StaticFiles(directory=screenshot_dir), name="screenshots")

    register_routes(app)

    # 桥接 stats API: /api/shadw/*
    app.include_router(create_shadw_stats_router(db_path))

    return app


def register_routes(app: FastAPI):

    @app.get("/", response_class=HTMLResponse)
    async def index():
        html_path = Path(__file__).parent / "static" / "index.html"
        return HTMLResponse(html_path.read_text(encoding="utf-8"))

    # ── L3: 日摘要 ──

    @app.get("/api/daily/{date}")
    async def get_daily(date: str):
        summary = await _query.get_daily_summary(date)
        if not summary:
            return {"date": date, "summary": None, "sessions": []}
        sessions = await _query.get_sessions_for_day(date)
        return {
            "date": date,
            "summary": summary.summary,
            "app_usage_stats": summary.app_usage_stats,
            "sessions": [
                {
                    "id": s.id,
                    "time_start": s.time_start,
                    "time_end": s.time_end,
                    "summary": s.summary,
                    "app_names": s.app_names,
                }
                for s in sessions
            ],
        }

    # ── L2: 时段摘要列表 ──

    @app.get("/api/sessions/{date}")
    async def get_sessions(date: str):
        sessions = await _query.get_sessions_for_day(date)
        return [
            {
                "id": s.id,
                "time_start": s.time_start,
                "time_end": s.time_end,
                "summary": s.summary,
                "app_names": s.app_names,
                "moment_count": len(s.moment_ids),
            }
            for s in sessions
        ]

    # ── L2 → L1: 展开时段 ──

    @app.get("/api/session/{session_id}/moments")
    async def get_session_moments(session_id: int):
        moments = await _query.get_moments_for_session(session_id)
        return [
            {
                "id": m.id,
                "time_start": m.time_start,
                "time_end": m.time_end,
                "summary": m.summary,
                "app_names": m.app_names,
                "capture_count": len(m.capture_ids),
            }
            for m in moments
        ]

    # ── L1 → 原始数据: 展开时刻 ──

    @app.get("/api/moment/{moment_id}/captures")
    async def get_moment_captures(moment_id: int):
        details = await _query.get_captures_for_moment(moment_id)
        return [
            {
                "capture_id": d.capture.id,
                "timestamp": d.capture.timestamp,
                "process_name": d.capture.process_name,
                "window_title": d.capture.window_title,
                "screenshot_url": f"/screenshots/{d.capture.screenshot_path}",
                "change_score": d.capture.change_score,
                "zone_map_text": d.ocr.zone_map_text if d.ocr else None,
            }
            for d in details
        ]

    # ── 按时间查询 ──

    @app.get("/api/query/time/{timestamp}")
    async def query_by_time(timestamp: str):
        result = await _query.query_by_time(timestamp)
        moment = result["moment"]
        session = result["session"]
        captures = result["captures"]
        return {
            "moment": {
                "id": moment.id,
                "time_start": moment.time_start,
                "time_end": moment.time_end,
                "summary": moment.summary,
                "app_names": moment.app_names,
            } if moment else None,
            "session": {
                "id": session.id,
                "time_start": session.time_start,
                "time_end": session.time_end,
                "summary": session.summary,
            } if session else None,
            "captures": [
                {
                    "capture_id": d.capture.id,
                    "timestamp": d.capture.timestamp,
                    "process_name": d.capture.process_name,
                    "screenshot_url": f"/screenshots/{d.capture.screenshot_path}",
                    "zone_map_text": d.ocr.zone_map_text if d.ocr else None,
                }
                for d in captures
            ],
        }

    # ── 按应用查询 ──

    @app.get("/api/query/app/{app_name}")
    async def query_by_app(app_name: str, date: str | None = None):
        moments = await _query.query_by_app(app_name, date)
        return [
            {
                "id": m.id,
                "time_start": m.time_start,
                "time_end": m.time_end,
                "summary": m.summary,
                "app_names": m.app_names,
            }
            for m in moments
        ]

    # ── 手动触发蒸馏 ──

    @app.post("/api/distill/daily/{date}")
    async def trigger_daily_distill(date: str):
        result = await _distiller.distill_daily(date)
        if result:
            return {"status": "ok", "summary": result.summary}
        return {"status": "no_data", "summary": None}

    @app.post("/api/distill/moment")
    async def trigger_moment_distill(time_start: str, time_end: str):
        result = await _distiller.distill_moment(time_start, time_end)
        if result:
            return {"status": "ok", "summary": result.summary}
        return {"status": "no_data", "summary": None}

    # ── 最近截图 + OCR ──

    @app.get("/api/recent/{limit}")
    async def get_recent_captures(limit: int = 20):
        rows = await _db.get_recent_captures_with_ocr(min(limit, 50))
        return [
            {
                "id": r["id"],
                "timestamp": r["timestamp"],
                "process_name": r["process_name"],
                "window_title": r["window_title"],
                "screenshot_url": f"/screenshots/{r['screenshot_path']}",
                "change_score": r["change_score"],
                "ocr_status": r["ocr_status"],
                "zone_map_text": r["zone_map_text"],
            }
            for r in rows
        ]

    # ── 显示器信息 ──

    @app.get("/api/monitor_info")
    async def get_monitor_info():
        import mss
        with mss.mss() as sct:
            total = len(sct.monitors) - 1
            active_indices = set(_config.perception.monitor_indices or [1])
            monitors = []
            for i in range(1, len(sct.monitors)):
                m = sct.monitors[i]
                monitors.append({
                    "index": i,
                    "width": m["width"],
                    "height": m["height"],
                    "left": m["left"],
                    "top": m["top"],
                    "active": i in active_indices,
                })
            return {
                "active_indices": sorted(active_indices),
                "total_monitors": total,
                "monitors": monitors,
            }

    class MonitorSettingsBody(BaseModel):
        indices: list[int]

    @app.post("/api/settings/monitors")
    async def save_monitor_settings(body: MonitorSettingsBody):
        if not _config_path:
            raise HTTPException(status_code=500, detail="配置文件路径未设置")
        indices = sorted(set(i for i in body.indices if i >= 1))
        if not indices:
            indices = [1]
        save_monitor_indices(_config_path, indices)
        _config.perception.monitor_indices = indices
        return {"saved": True, "indices": indices, "requires_restart": True}

    # ── 统计概览 ──

    @app.get("/api/stats/{date}")
    async def get_stats(date: str):
        time_start = f"{date}T00:00:00"
        time_end = f"{date}T23:59:59"
        captures = await _db.get_captures_in_range(time_start, time_end)
        moments = await _db.get_moments_in_range(time_start, time_end)
        sessions = await _db.get_sessions_for_date(date)

        app_counts: dict[str, int] = {}
        for c in captures:
            if c.process_name:
                app_counts[c.process_name] = app_counts.get(c.process_name, 0) + 1

        return {
            "date": date,
            "total_captures": len(captures),
            "total_moments": len(moments),
            "total_sessions": len(sessions),
            "app_counts": app_counts,
        }
