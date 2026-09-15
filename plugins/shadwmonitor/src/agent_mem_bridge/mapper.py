"""把 ShadwMonitor 的 MomentSummary 映射为 agent-mem /api/observation 的 payload。

agent-mem 的 /api/observation 走 SDKAgent.processObservation 二次加工，
所以我们把 L1 完整 summary 当作 toolOutput 喂进去；agent-mem 端的 LLM
会基于这段文本再生成结构化 observation（type/title/narrative/concepts/...）。

字段约定见 design.md §A 数据映射。
"""

from __future__ import annotations

from typing import Iterable

from src.storage.models import MomentSummary


SESSION_ID_PREFIX = "desktop-monitor"


def session_id_for_moment(moment: MomentSummary) -> str:
    """按 time_start 的日期前缀分桶 session："desktop-monitor-YYYY-MM-DD"。"""
    date_part = (moment.time_start or "")[:10] or "unknown"
    return f"{SESSION_ID_PREFIX}-{date_part}"


def build_observation_payload(
    moment: MomentSummary,
    scope: str,
    screenshot_paths: Iterable[str] | None = None,
) -> dict:
    """构造 POST /api/observation 的 JSON body。

    Parameters
    ----------
    moment : MomentSummary
        ShadwMonitor 蒸馏出的 L1 时刻。
    scope : str
        observation.project 字段值（agent-mem 用此分类）。默认 desktop-monitor。
    screenshot_paths : 可选
        若提供，会一并放进 toolInput.screenshot_paths，便于 agent-mem 侧的 LLM 引用。
    """
    app_names = list(moment.app_names or [])
    paths = list(screenshot_paths or [])
    capture_count = len(moment.capture_ids or [])

    tool_input = {
        "time_start": moment.time_start,
        "time_end": moment.time_end,
        "app_names": app_names,
        "capture_count": capture_count,
        "screenshot_paths": paths,
        "source": "shadwmonitor",
    }

    return {
        "sessionId": session_id_for_moment(moment),
        "toolName": "screen_capture",
        "toolInput": tool_input,
        "toolOutput": _build_tool_output(moment, app_names, paths),
        "observationType": "screen_moment",
        "sourceIDE": "shadwmonitor",
        # 携带 scope 用于 session/start 时填 project
        "_scope": scope,
    }


def _build_tool_output(moment: MomentSummary, app_names: list[str], paths: list[str]) -> str:
    """组织一段结构化文本喂给 agent-mem SDKAgent。

    把 L1 summary 作为主体，并显式列出时间窗口 / 应用 / 截图路径，
    让 agent-mem 端的 LLM 在 buildObservationPrompt 中能正确提取
    title / narrative / concepts / files_read。
    """
    lines: list[str] = []
    lines.append(f"[屏幕活动 · L1 时刻摘要] {moment.time_start} → {moment.time_end}")
    if app_names:
        lines.append(f"前台应用: {', '.join(app_names)}")
    lines.append("")
    lines.append(moment.summary or "(无内容)")
    if paths:
        lines.append("")
        lines.append("关联截图:")
        for p in paths[:10]:
            lines.append(f"  - {p}")
        if len(paths) > 10:
            lines.append(f"  ... (共 {len(paths)} 张)")
    return "\n".join(lines)
