"""轮询新 L1 时刻 + POST 到 agent-mem，含离线重试队列。

设计要点：
- 零侵入 — 不改 Distiller / Database 既有代码
- 按 id 单调递增轮询 moment_summaries
- session/start 幂等，每次 POST observation 前先 ensure session
- 失败入 retry_queue，指数退避 1/2/4/8…60s（上限）
- bridge 重启自动续传

设计文档：D:\\UGIT\\agent-memory\\docs\\memory-core\\features\\desktop-monitor-plugin\\design.md
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import aiosqlite

from src.agent_mem_bridge.mapper import build_observation_payload
from src.agent_mem_bridge.state import BridgeState
from src.storage.models import MomentSummary
from src.utils.logger import log

try:
    import httpx  # 通过 openai 间接依赖；显式导入便于报错明确
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "agent_mem_bridge 需要 httpx，请运行: pip install httpx"
    ) from exc


class BridgePoster:
    """ShadwMonitor → agent-mem 桥接的核心协程。

    跟其他 component 的接口风格保持一致（init / run / stop）。
    """

    def __init__(self, agent_mem_cfg: "AgentMemConfig", db_path: str):
        # agent_mem_cfg 是 src.config.AgentMemConfig 实例（避免循环 import 不直接 type）
        self.cfg = agent_mem_cfg
        self.db_path = db_path
        self.state = BridgeState(db_path)
        self._stop_event = asyncio.Event()
        self._ensured_sessions: set[str] = set()
        self._client: httpx.AsyncClient | None = None
        self._last_success_at: float = 0.0
        self._mirrored_today: int = 0
        self._today_date: str = ""

    # ── lifecycle ──

    async def init(self) -> None:
        """启动前调用一次：建表 + 高水位初始化。"""
        await self.state.init_tables()
        await self.state.initialize_high_water_mark()
        timeout = httpx.Timeout(10.0, connect=5.0)
        self._client = httpx.AsyncClient(
            base_url=self.cfg.endpoint.rstrip("/"),
            timeout=timeout,
            headers={"X-Plugin": "shadwmonitor-bridge"},
        )
        last_id = await self.state.get_last_mirrored_id()
        log.info(
            "agent_mem_bridge 初始化完成: endpoint=%s scope=%s last_mirrored_id=%s",
            self.cfg.endpoint, self.cfg.scope, last_id,
        )

    def stop(self) -> None:
        """跟其他 component 一致的同步停止接口。"""
        self._stop_event.set()

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def run(self) -> None:
        """主循环：拉新 moment + 处理 retry queue。"""
        log.info("agent_mem_bridge 启动主循环，间隔 %ss", self.cfg.poll_interval_seconds)
        try:
            while not self._stop_event.is_set():
                try:
                    await self._tick()
                except Exception as e:  # 单轮异常不影响后续
                    log.error("agent_mem_bridge tick 异常: %s", e)
                try:
                    await asyncio.wait_for(
                        self._stop_event.wait(),
                        timeout=self.cfg.poll_interval_seconds,
                    )
                except asyncio.TimeoutError:
                    continue
        finally:
            await self.aclose()
            log.info("agent_mem_bridge 已停止")

    # ── core ──

    async def _tick(self) -> None:
        await self._mirror_new_moments()
        await self._drain_retry_queue()

    async def _mirror_new_moments(self) -> None:
        last_id = await self.state.get_last_mirrored_id()
        moments = await self._fetch_new_moments(after_id=last_id, limit=self.cfg.batch_size)
        if not moments:
            return
        log.info("agent_mem_bridge 发现 %d 条新 L1 待镜像 (after id=%s)", len(moments), last_id)

        for moment in moments:
            ok = await self._mirror_one(moment, source="new")
            if ok:
                await self.state.set_last_mirrored_id(moment.id)
                self._bump_today_counter()
            else:
                # 失败但 retry_queue 已记录；推水位避免阻塞后续新 moment
                await self.state.set_last_mirrored_id(moment.id)

    async def _drain_retry_queue(self) -> None:
        items = await self.state.pop_due_retries(limit=self.cfg.batch_size)
        if not items:
            return
        log.info("agent_mem_bridge 处理 retry queue: %d 项到期", len(items))
        for item in items:
            ok = await self._post_observation_payload(item["payload"])
            if ok:
                await self.state.delete_retry(item["id"])
                self._bump_today_counter()
                log.info("agent_mem_bridge retry 成功 moment_id=%s", item["moment_id"])
            else:
                attempts = item["attempts"]
                if attempts >= self.cfg.retry_max_attempts:
                    await self.state.delete_retry(item["id"])
                    log.warning(
                        "agent_mem_bridge moment_id=%s 已达最大重试次数 %d，放弃",
                        item["moment_id"], attempts,
                    )
                else:
                    delay = self._backoff_delay(attempts)
                    await self.state.mark_retry_failed(item["id"], delay, "retry failed")

    async def _mirror_one(self, moment: MomentSummary, source: str) -> bool:
        screenshot_paths = await self._fetch_screenshot_paths(moment.capture_ids or [])
        payload = build_observation_payload(
            moment, scope=self.cfg.scope, screenshot_paths=screenshot_paths,
        )
        ok = await self._post_observation_payload(payload)
        if not ok:
            await self.state.enqueue_retry(
                moment_id=moment.id,
                payload=payload,
                delay_seconds=self.cfg.retry_initial_delay_seconds,
                last_error="initial post failed",
            )
            log.warning(
                "agent_mem_bridge 首次 POST 失败 moment_id=%s (source=%s)，已入 retry",
                moment.id, source,
            )
        return ok

    async def _post_observation_payload(self, payload: dict[str, Any]) -> bool:
        if self._client is None:
            return False
        # session/start 幂等
        scope = payload.pop("_scope", None) or self.cfg.scope
        session_id = payload.get("sessionId") or ""
        try:
            await self._ensure_session(session_id, scope)
        except Exception as e:
            log.warning("agent_mem_bridge session/start 失败: %s", e)
            return False
        try:
            resp = await self._client.post("/api/observation", json=payload)
            if 200 <= resp.status_code < 300:
                self._last_success_at = asyncio.get_event_loop().time()
                return True
            log.warning(
                "agent_mem_bridge POST /api/observation 返回 %s: %s",
                resp.status_code, resp.text[:200],
            )
            return False
        except Exception as e:
            log.warning("agent_mem_bridge POST /api/observation 异常: %s", e)
            return False

    async def _ensure_session(self, session_id: str, scope: str) -> None:
        if not session_id:
            return
        if session_id in self._ensured_sessions:
            return
        resp = await self._client.post(
            "/api/session/start",
            json={"sessionId": session_id, "project": scope},
        )
        if 200 <= resp.status_code < 300:
            self._ensured_sessions.add(session_id)
        else:
            raise RuntimeError(
                f"/api/session/start status={resp.status_code} body={resp.text[:200]}"
            )

    # ── helpers ──

    async def _fetch_new_moments(self, after_id: int, limit: int) -> list[MomentSummary]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            async with conn.execute(
                """
                SELECT id, time_start, time_end, summary, capture_ids, app_names
                FROM moment_summaries
                WHERE id > ?
                ORDER BY id ASC
                LIMIT ?
                """,
                (after_id, limit),
            ) as cur:
                rows = await cur.fetchall()
        out: list[MomentSummary] = []
        for r in rows:
            try:
                capture_ids = json.loads(r["capture_ids"]) if r["capture_ids"] else []
            except (json.JSONDecodeError, TypeError):
                capture_ids = []
            try:
                app_names = json.loads(r["app_names"]) if r["app_names"] else []
            except (json.JSONDecodeError, TypeError):
                app_names = []
            out.append(
                MomentSummary(
                    id=r["id"],
                    time_start=r["time_start"],
                    time_end=r["time_end"],
                    summary=r["summary"],
                    capture_ids=capture_ids,
                    app_names=app_names,
                )
            )
        return out

    async def _fetch_screenshot_paths(self, capture_ids: list[int]) -> list[str]:
        if not capture_ids:
            return []
        placeholders = ",".join("?" * len(capture_ids))
        async with aiosqlite.connect(self.db_path) as conn:
            async with conn.execute(
                f"SELECT screenshot_path FROM captures WHERE id IN ({placeholders}) ORDER BY id ASC",
                tuple(capture_ids),
            ) as cur:
                rows = await cur.fetchall()
        return [r[0] for r in rows if r and r[0]]

    def _backoff_delay(self, attempts: int) -> int:
        base = self.cfg.retry_initial_delay_seconds
        cap = self.cfg.retry_max_delay_seconds
        return min(cap, base * (2 ** max(0, attempts - 1)))

    def _bump_today_counter(self) -> None:
        from datetime import date

        today = date.today().isoformat()
        if today != self._today_date:
            self._today_date = today
            self._mirrored_today = 0
        self._mirrored_today += 1

    # ── 健康指标 ──

    async def health_snapshot(self) -> dict[str, Any]:
        """供 stats_api / Settings UI 拉取。"""
        return {
            "enabled": True,
            "bridge_alive": not self._stop_event.is_set(),
            "endpoint": self.cfg.endpoint,
            "scope": self.cfg.scope,
            "mirrored_today": self._mirrored_today,
            "retry_queue_size": await self.state.retry_queue_size(),
            "last_success_at": self._last_success_at,
            "last_mirrored_id": await self.state.get_last_mirrored_id(),
        }
