import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class PerceptionConfig:
    window_poll_interval: float = 1.0
    check_interval: float = 2.0
    change_threshold: float = 0.02
    force_capture_interval: float = 60.0
    screenshot_quality: int = 80
    downscale_for_compare: list[int] = field(default_factory=lambda: [480, 270])
    monitor_indices: list[int] = field(default_factory=lambda: [1])


@dataclass
class OCRConfig:
    engine: str = "paddleocr"
    language: str = "ch"
    confidence_threshold: float = 0.6
    zone_grid: list[int] = field(default_factory=lambda: [3, 3])
    max_queue_size: int = 100
    workers: int = 2


@dataclass
class LLMConfig:
    base_url: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = "gpt-4o-mini"
    model_daily: str = "gpt-4o"
    temperature: float = 0.3
    max_tokens: int = 500


@dataclass
class DistillConfig:
    moment_window: int = 300
    session_window: int = 1800
    daily_trigger_time: str = "23:00"
    min_captures_for_moment: int = 2


@dataclass
class AgentConfig:
    llm: LLMConfig = field(default_factory=LLMConfig)
    distill: DistillConfig = field(default_factory=DistillConfig)


@dataclass
class StorageConfig:
    db_path: str = "data/ai_monitor.db"
    screenshot_dir: str = "data/screenshots"
    max_retention_days: int = 30


@dataclass
class PrivacyConfig:
    excluded_processes: list[str] = field(default_factory=list)
    excluded_titles: list[str] = field(default_factory=list)


@dataclass
class AgentMemMirrorConfig:
    moment: bool = True
    session: bool = False
    daily: bool = False


@dataclass
class AgentMemConfig:
    """agent-mem 桥接配置。详见
    D:\\UGIT\\agent-memory\\docs\\memory-core\\features\\desktop-monitor-plugin\\design.md
    """
    enabled: bool = False
    endpoint: str = "http://127.0.0.1:3847"
    scope: str = "desktop-monitor"
    poll_interval_seconds: int = 30
    batch_size: int = 50
    retry_max_attempts: int = 10
    retry_initial_delay_seconds: int = 1
    retry_max_delay_seconds: int = 60
    mirror: AgentMemMirrorConfig = field(default_factory=AgentMemMirrorConfig)


@dataclass
class AppConfig:
    perception: PerceptionConfig = field(default_factory=PerceptionConfig)
    ocr: OCRConfig = field(default_factory=OCRConfig)
    agent: AgentConfig = field(default_factory=AgentConfig)
    storage: StorageConfig = field(default_factory=StorageConfig)
    privacy: PrivacyConfig = field(default_factory=PrivacyConfig)
    agent_mem: AgentMemConfig = field(default_factory=AgentMemConfig)
    base_dir: str = ""


def _resolve_env_vars(value: str) -> str:
    if isinstance(value, str) and value.startswith("${") and value.endswith("}"):
        env_key = value[2:-1]
        return os.environ.get(env_key, "")
    return value


def load_config(config_path: str = "config/settings.yaml") -> AppConfig:
    base_dir = str(Path(config_path).resolve().parent.parent)

    with open(config_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    perception_raw = raw.get("perception", {})
    ocr_raw = raw.get("ocr", {})
    agent_raw = raw.get("agent", {})
    storage_raw = raw.get("storage", {})
    privacy_raw = raw.get("privacy", {})
    agent_mem_raw = raw.get("agent_mem", {})

    llm_raw = agent_raw.get("llm", {})
    llm_raw["api_key"] = _resolve_env_vars(llm_raw.get("api_key", ""))
    llm_raw["base_url"] = _resolve_env_vars(llm_raw.get("base_url", ""))

    mirror_raw = agent_mem_raw.get("mirror", {}) or {}

    config = AppConfig(
        perception=PerceptionConfig(**perception_raw),
        ocr=OCRConfig(**ocr_raw),
        agent=AgentConfig(
            llm=LLMConfig(**llm_raw),
            distill=DistillConfig(**agent_raw.get("distill", {})),
        ),
        storage=StorageConfig(**storage_raw),
        privacy=PrivacyConfig(**privacy_raw),
        agent_mem=AgentMemConfig(
            enabled=bool(agent_mem_raw.get("enabled", False)),
            endpoint=str(agent_mem_raw.get("endpoint", "http://127.0.0.1:3847")),
            scope=str(agent_mem_raw.get("scope", "desktop-monitor")),
            poll_interval_seconds=int(agent_mem_raw.get("poll_interval_seconds", 30)),
            batch_size=int(agent_mem_raw.get("batch_size", 50)),
            retry_max_attempts=int(agent_mem_raw.get("retry_max_attempts", 10)),
            retry_initial_delay_seconds=int(agent_mem_raw.get("retry_initial_delay_seconds", 1)),
            retry_max_delay_seconds=int(agent_mem_raw.get("retry_max_delay_seconds", 60)),
            mirror=AgentMemMirrorConfig(
                moment=bool(mirror_raw.get("moment", True)),
                session=bool(mirror_raw.get("session", False)),
                daily=bool(mirror_raw.get("daily", False)),
            ),
        ),
        base_dir=base_dir,
    )

    return config


def save_monitor_indices(config_path: str, indices: list[int]) -> None:
    """仅更新 YAML 中的 perception.monitor_indices，其余字段保持原样。"""
    with open(config_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    if "perception" not in raw:
        raw["perception"] = {}
    raw["perception"]["monitor_indices"] = indices

    with open(config_path, "w", encoding="utf-8") as f:
        yaml.dump(raw, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
