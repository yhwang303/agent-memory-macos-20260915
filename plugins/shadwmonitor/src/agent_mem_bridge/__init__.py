"""ShadwMonitor → agent-mem 桥接子模块。

零侵入轮询模式：定期查 moment_summaries 表里新产生的 L1 时刻，
镜像到 agent-mem 的 /api/observation，让全局搜索能命中屏幕活动。

详见 design：D:\\UGIT\\agent-memory\\docs\\memory-core\\features\\desktop-monitor-plugin\\design.md
"""

from __future__ import annotations

# 用 __getattr__ 懒加载，避免单独导入 mapper / state 时被 httpx / aiosqlite 拖累
__all__ = ["BridgePoster"]


def __getattr__(name: str):
    if name == "BridgePoster":
        from src.agent_mem_bridge.poster import BridgePoster
        return BridgePoster
    raise AttributeError(f"module 'agent_mem_bridge' has no attribute {name!r}")
