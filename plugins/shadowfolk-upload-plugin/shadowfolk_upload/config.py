from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_SERVER = "http://localhost:3000"
DEFAULT_INTERVAL_SECONDS = 60
DEFAULT_RETRY_MAX_ATTEMPTS = 5
DEFAULT_RETRY_BASE_DELAY_SECONDS = 30
DEFAULT_RETRY_MAX_DELAY_SECONDS = 1800


@dataclass(frozen=True)
class UploadConfig:
    enabled: bool
    interval_seconds: int
    workspaces: list[str]
    retry_max_attempts: int
    retry_base_delay_seconds: int
    retry_max_delay_seconds: int
    status_file: str | None
    log_file: str | None


def read_json_file(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.expanduser().read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ValueError(f"Config file not found: {path}") from None
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {path}: {exc}") from exc


def load_shadow_config(path: Path) -> dict[str, Any]:
    config = read_json_file(path)
    if not config.get("api_token"):
        raise ValueError(f"Missing required field 'api_token' in {path}")
    config.setdefault("server", DEFAULT_SERVER)
    config["server"] = str(config["server"]).rstrip("/")
    return config


def load_upload_config(path: Path | None) -> UploadConfig:
    raw: dict[str, Any] = {}
    if path is not None and path.expanduser().exists():
        raw = read_json_file(path)

    retry = raw.get("retry") if isinstance(raw.get("retry"), dict) else {}
    return UploadConfig(
        enabled=bool(raw.get("enabled", True)),
        interval_seconds=int(raw.get("intervalSeconds", DEFAULT_INTERVAL_SECONDS)),
        workspaces=[str(p) for p in raw.get("workspaces", [])],
        retry_max_attempts=int(retry.get("maxAttempts", DEFAULT_RETRY_MAX_ATTEMPTS)),
        retry_base_delay_seconds=int(retry.get("baseDelaySeconds", DEFAULT_RETRY_BASE_DELAY_SECONDS)),
        retry_max_delay_seconds=int(retry.get("maxDelaySeconds", DEFAULT_RETRY_MAX_DELAY_SECONDS)),
        status_file=str(raw["statusFile"]) if raw.get("statusFile") else None,
        log_file=str(raw["logFile"]) if raw.get("logFile") else None,
    )


def merge_workspace_config(global_config: dict[str, Any], workspace: str | Path) -> dict[str, Any]:
    merged = dict(global_config)
    local_path = Path(workspace) / ".shadow" / "config.json"
    if local_path.exists():
        merged.update(read_json_file(local_path))
    if merged.get("server"):
        merged["server"] = str(merged["server"]).rstrip("/")
    return merged
