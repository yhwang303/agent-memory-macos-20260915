from datetime import datetime, timedelta

from src.storage.database import Database
from src.storage.models import (
    CaptureDetail,
    DailySummary,
    MomentSummary,
    SessionSummary,
)
from src.utils.logger import log


class QueryEngine:
    def __init__(self, db: Database):
        self.db = db

    async def get_daily_summary(self, date: str) -> DailySummary | None:
        return await self.db.get_daily_summary(date)

    async def get_sessions_for_day(self, date: str) -> list[SessionSummary]:
        return await self.db.get_sessions_for_date(date)

    async def get_moments_for_session(self, session_id: int) -> list[MomentSummary]:
        session = await self.db.get_session_by_id(session_id)
        if not session:
            return []
        moments = []
        for mid in session.moment_ids:
            m = await self.db.get_moment_by_id(mid)
            if m:
                moments.append(m)
        return moments

    async def get_captures_for_moment(self, moment_id: int) -> list[CaptureDetail]:
        moment = await self.db.get_moment_by_id(moment_id)
        if not moment:
            return []
        details = []
        for cid in moment.capture_ids:
            d = await self.db.get_capture_detail(cid)
            if d:
                details.append(d)
        return details

    async def get_capture_detail(self, capture_id: int) -> CaptureDetail | None:
        return await self.db.get_capture_detail(capture_id)

    async def query_by_time(self, timestamp: str) -> dict:
        """
        按时间戳查询，返回最匹配的各层级数据。
        返回: {"moment": ..., "session": ..., "captures": [...]}
        """
        try:
            ts = datetime.fromisoformat(timestamp)
        except ValueError:
            log.warning("无效时间戳: %s", timestamp)
            return {"moment": None, "session": None, "captures": []}

        window_start = (ts - timedelta(minutes=5)).isoformat(timespec="seconds")
        window_end = (ts + timedelta(minutes=5)).isoformat(timespec="seconds")

        moments = await self.db.get_moments_in_range(window_start, window_end)

        best_moment = None
        if moments:
            best_moment = min(
                moments,
                key=lambda m: abs(
                    (datetime.fromisoformat(m.time_start) - ts).total_seconds()
                ),
            )

        session = None
        if best_moment and best_moment.id:
            date_str = ts.strftime("%Y-%m-%d")
            sessions = await self.db.get_sessions_for_date(date_str)
            for s in sessions:
                if best_moment.id in s.moment_ids:
                    session = s
                    break

        captures = []
        if best_moment:
            for cid in best_moment.capture_ids:
                detail = await self.db.get_capture_detail(cid)
                if detail:
                    captures.append(detail)

        return {
            "moment": best_moment,
            "session": session,
            "captures": captures,
        }

    async def query_by_app(self, app_name: str, date: str | None = None) -> list[MomentSummary]:
        date = date or datetime.now().strftime("%Y-%m-%d")
        time_start = f"{date}T00:00:00"
        time_end = f"{date}T23:59:59"
        all_moments = await self.db.get_moments_in_range(time_start, time_end)

        app_lower = app_name.lower()
        return [
            m for m in all_moments
            if any(app_lower in a.lower() for a in m.app_names)
        ]
