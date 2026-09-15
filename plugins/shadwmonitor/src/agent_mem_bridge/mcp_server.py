"""stdio MCP server，把 ShadwMonitor 的 QueryEngine 暴露给 Claude / Cursor。

启动方式：
    python -m src.agent_mem_bridge.mcp_server

或在 Claude Desktop 的 mcpServers 配置里：
    {
      "shadwmonitor": {
        "command": "python",
        "args": ["-m", "src.agent_mem_bridge.mcp_server"],
        "cwd": "D:/UGIT/agent-memory/plugins/shadwmonitor"
      }
    }

所有工具加 `screen_` 前缀避免与 agent-mem MCP 的 search / timeline 冲突。
工具内部不返回原图 base64，仅返回路径与 Zone-Map 文本，保持 token 友好。
"""

from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

# 让脚本可以直接被 -m 启动
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from src.agent.query import QueryEngine
from src.config import load_config
from src.storage.database import Database
from src.utils.logger import log

try:
    from mcp.server.fastmcp import FastMCP
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "agent_mem_bridge.mcp_server 需要 mcp，请运行: pip install mcp>=1.10.0"
    ) from exc


_query: QueryEngine | None = None


def _config_path() -> str:
    # __file__ = plugins/shadwmonitor/src/agent_mem_bridge/mcp_server.py
    # plugin_root = plugins/shadwmonitor/
    plugin_root = Path(__file__).resolve().parent.parent.parent
    return str(plugin_root / "config" / "settings.yaml")


async def _ensure_query() -> QueryEngine:
    global _query
    if _query is not None:
        return _query
    config = load_config(_config_path())
    db_path = str(Path(config.base_dir) / config.storage.db_path)
    db = Database(db_path)
    await db.init_tables()
    _query = QueryEngine(db)
    log.info("MCP server: QueryEngine 初始化完成 db=%s", db_path)
    return _query


def _safe_asdict(obj: Any) -> Any:
    """把 dataclass / 列表 / 字典递归转为可 JSON 化的结构。"""
    if obj is None:
        return None
    if isinstance(obj, list):
        return [_safe_asdict(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _safe_asdict(v) for k, v in obj.items()}
    if hasattr(obj, "__dataclass_fields__"):
        return _safe_asdict(asdict(obj))
    return obj


mcp = FastMCP("shadwmonitor")


@mcp.tool()
async def screen_query_daily(date: str) -> dict:
    """获取某日的 L3 日摘要（用户当天活动的整体回顾）。

    Args:
        date: 日期 YYYY-MM-DD，例如 "2026-05-23"
    """
    q = await _ensure_query()
    summary = await q.get_daily_summary(date)
    return {"date": date, "summary": _safe_asdict(summary)}


@mcp.tool()
async def screen_query_session(date: str) -> dict:
    """获取某日所有 L2 时段摘要（每段 30 分钟左右）。

    Args:
        date: 日期 YYYY-MM-DD
    """
    q = await _ensure_query()
    sessions = await q.get_sessions_for_day(date)
    return {"date": date, "sessions": _safe_asdict(sessions)}


@mcp.tool()
async def screen_query_by_time(timestamp: str, window_minutes: int = 60) -> dict:
    """按时间戳查询该时刻附近的屏幕活动（L1 时刻 + L2 时段 + 关联截图列表）。

    Args:
        timestamp: ISO 8601 时间戳，例如 "2026-05-23T14:30:00"
        window_minutes: 查询窗口（分钟），默认 60；目前内部固定 ±5 分钟，参数预留
    """
    q = await _ensure_query()
    result = await q.query_by_time(timestamp)
    return _safe_asdict(result)


@mcp.tool()
async def screen_query_moments(date: str, app: str | None = None) -> dict:
    """列出某日的 L1 时刻（5 分钟粒度）。可选按应用名过滤。

    Args:
        date: 日期 YYYY-MM-DD
        app: 应用名（可选），不区分大小写模糊匹配 process_name
    """
    q = await _ensure_query()
    if app:
        moments = await q.query_by_app(app, date)
    else:
        # 复用 query_by_app 的全日聚合逻辑，传特殊匹配会全量返回
        moments = await q.query_by_app("", date)
        if not moments:
            # 兜底：直接按日期范围查
            moments = await q.db.get_moments_in_range(f"{date}T00:00:00", f"{date}T23:59:59")
    return {"date": date, "app": app, "moments": _safe_asdict(moments)}


@mcp.tool()
async def screen_get_capture(capture_id: int) -> dict:
    """获取单张截图详情（路径 + Zone-Map 文本，不返回原图 base64）。

    Args:
        capture_id: 截图记录 ID（从 screen_query_by_time 等工具返回中获取）
    """
    q = await _ensure_query()
    detail = await q.get_capture_detail(capture_id)
    if detail is None:
        return {"error": f"capture_id {capture_id} not found"}
    return _safe_asdict(detail)


def main() -> None:
    """stdio 模式入口。"""
    mcp.run()


if __name__ == "__main__":
    main()
