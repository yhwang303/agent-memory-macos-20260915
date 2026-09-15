import asyncio
import json
from datetime import datetime, timedelta

from openai import AsyncOpenAI

from src.agent.prompts import (
    L1_PROMPT, L1_SYSTEM,
    L2_PROMPT, L2_SYSTEM,
    L3_PROMPT, L3_SYSTEM,
)
from src.config import AgentConfig
from src.storage.database import Database
from src.storage.models import DailySummary, MomentSummary, SessionSummary
from src.utils.logger import log


class Distiller:
    def __init__(self, config: AgentConfig, db: Database):
        self.config = config
        self.db = db
        self._client = AsyncOpenAI(
            base_url=config.llm.base_url,
            api_key=config.llm.api_key,
        )
        self._running = False

    async def _call_llm(self, system: str, user: str, model: str | None = None) -> str:
        model = model or self.config.llm.model
        try:
            resp = await self._client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=self.config.llm.temperature,
                max_tokens=self.config.llm.max_tokens,
            )
            return resp.choices[0].message.content.strip()
        except Exception as e:
            log.error("LLM 调用失败 (model=%s): %s", model, e)
            return ""

    async def distill_moment(self, time_start: str, time_end: str) -> MomentSummary | None:
        zone_data = await self.db.get_zone_maps_in_range(time_start, time_end)

        if len(zone_data) < self.config.distill.min_captures_for_moment:
            return None

        zone_maps_text = "\n---\n".join(
            d["zone_map_text"] for d in zone_data if d.get("zone_map_text")
        )
        if not zone_maps_text.strip():
            return None

        prompt = L1_PROMPT.format(
            time_start=time_start, time_end=time_end, zone_maps=zone_maps_text,
        )
        summary_text = await self._call_llm(L1_SYSTEM, prompt)
        if not summary_text:
            return None

        capture_ids = [d["capture_id"] for d in zone_data]
        app_names = list({d["process_name"] for d in zone_data if d.get("process_name")})

        moment = MomentSummary(
            time_start=time_start,
            time_end=time_end,
            summary=summary_text,
            capture_ids=capture_ids,
            app_names=app_names,
        )
        moment.id = await self.db.insert_moment_summary(moment)
        log.info("L1 蒸馏完成: %s ~ %s -> %s", time_start, time_end, summary_text[:60])
        return moment

    async def distill_session(self, moments: list[MomentSummary]) -> SessionSummary | None:
        if not moments:
            return None

        lines = []
        for m in moments:
            lines.append(f"[{m.time_start}~{m.time_end}] {m.summary}")

        time_start = moments[0].time_start
        time_end = moments[-1].time_end

        prompt = L2_PROMPT.format(
            time_start=time_start, time_end=time_end,
            moment_summaries="\n".join(lines),
        )
        summary_text = await self._call_llm(L2_SYSTEM, prompt)
        if not summary_text:
            return None

        moment_ids = [m.id for m in moments if m.id]
        all_apps: set[str] = set()
        for m in moments:
            all_apps.update(m.app_names)

        session = SessionSummary(
            time_start=time_start,
            time_end=time_end,
            summary=summary_text,
            moment_ids=moment_ids,
            app_names=list(all_apps),
        )
        session.id = await self.db.insert_session_summary(session)
        log.info("L2 蒸馏完成: %s ~ %s -> %s", time_start, time_end, summary_text[:60])
        return session

    async def distill_daily(self, date: str) -> DailySummary | None:
        sessions = await self.db.get_sessions_for_date(date)
        if not sessions:
            log.info("L3: 日期 %s 无时段摘要，跳过", date)
            return None

        lines = []
        for s in sessions:
            lines.append(f"[{s.time_start}~{s.time_end}] {s.summary}")

        prompt = L3_PROMPT.format(
            date=date, session_summaries="\n".join(lines),
        )
        summary_text = await self._call_llm(L3_SYSTEM, prompt, model=self.config.llm.model_daily)
        if not summary_text:
            return None

        app_stats: dict[str, int] = {}
        for s in sessions:
            for app in s.app_names:
                app_stats[app] = app_stats.get(app, 0) + 1

        daily = DailySummary(
            date=date,
            summary=summary_text,
            app_usage_stats=app_stats,
            session_ids=[s.id for s in sessions if s.id],
        )
        daily.id = await self.db.insert_daily_summary(daily)
        log.info("L3 日摘要完成: %s -> %s", date, summary_text[:80])
        return daily

    async def _run_l1_cycle(self):
        """检查是否有已过期的5分钟窗口需要 L1 蒸馏"""
        now = datetime.now()
        window_sec = self.config.distill.moment_window

        window_end = now - timedelta(seconds=window_sec)
        window_end_str = window_end.isoformat(timespec="seconds")

        window_start = window_end - timedelta(seconds=window_sec)
        window_start_str = window_start.isoformat(timespec="seconds")

        existing = await self.db.get_moments_in_range(window_start_str, window_end_str)
        if existing:
            return

        captures = await self.db.get_captures_in_range(window_start_str, window_end_str)
        done_captures = [c for c in captures if c.ocr_status == "done"]

        if len(done_captures) >= self.config.distill.min_captures_for_moment:
            await self.distill_moment(window_start_str, window_end_str)

    async def _run_l2_cycle(self):
        """检查是否有足够的未蒸馏 L1 可以触发 L2"""
        now = datetime.now()
        undistilled = await self.db.get_undistilled_moment_range(
            now.isoformat(timespec="seconds")
        )

        session_window = self.config.distill.session_window
        batch: list[MomentSummary] = []

        for row in undistilled:
            m = MomentSummary(
                id=row["id"],
                time_start=row["time_start"],
                time_end=row["time_end"],
                summary=row["summary"],
                capture_ids=json.loads(row["capture_ids"]),
                app_names=json.loads(row["app_names"]) if row["app_names"] else [],
            )
            batch.append(m)

        if len(batch) >= 6:
            await self.distill_session(batch)

    async def _run_l3_check(self):
        """检查是否到了日摘要触发时间"""
        now = datetime.now()
        trigger_time = self.config.distill.daily_trigger_time
        try:
            trigger_hour, trigger_minute = map(int, trigger_time.split(":"))
        except ValueError:
            return

        if now.hour == trigger_hour and now.minute == trigger_minute:
            date_str = now.strftime("%Y-%m-%d")
            existing = await self.db.get_daily_summary(date_str)
            if not existing:
                await self.distill_daily(date_str)

    async def schedule(self):
        self._running = True
        log.info("蒸馏调度器已启动")

        while self._running:
            try:
                await self._run_l1_cycle()
                await self._run_l2_cycle()
                await self._run_l3_check()
            except Exception as e:
                log.error("蒸馏调度异常: %s", e)

            await asyncio.sleep(30)

    def stop(self):
        self._running = False
