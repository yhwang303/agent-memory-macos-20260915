from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable

from .config import merge_workspace_config
from .git_context import find_nested_repos, get_branch, get_commits, get_diff_stats, get_git_root, get_remote
from .memory_export import export_observations, export_session_summaries, find_memory_db
from .shadow_client import ShadowClient, ShadowClientError


@dataclass
class UploadResult:
    workspace: str
    uploaded: bool
    batch_id: str | None
    observations_count: int
    summaries_count: int
    error: str | None = None


def should_upload(commits: list[dict[str, Any]], observations: list[dict[str, Any]], summaries: list[dict[str, Any]]) -> bool:
    return bool(commits or observations or summaries)


def build_payload(
    git_root: str,
    remote: str,
    branch: str,
    commits: list[dict[str, Any]],
    stats: dict[str, int],
    nested_repos: list[str],
    observations: list[dict[str, Any]],
    session_summaries: list[dict[str, Any]],
    last_commit: str | None,
) -> dict[str, Any]:
    return {
        "git": {
            "root": git_root,
            "remote": remote,
            "branch": branch,
            "commit_range_start": last_commit or (commits[-1]["hash"] if commits else ""),
            "commit_range_end": commits[0]["hash"] if commits else "",
            "commits": commits,
            "stats": stats,
        },
        "memory": {
            "scope": git_root,
            "excluded_prefixes": nested_repos,
            "observations": observations,
            "session_summaries": session_summaries,
        },
    }


def compute_new_cursors(
    last_commit: str | None,
    commits: list[dict[str, Any]],
    observations: list[dict[str, Any]],
    summaries: list[dict[str, Any]],
    last_obs_id: int,
    last_sum_id: int,
    batch_id: str,
) -> dict[str, Any]:
    return {
        "last_commit_hash": commits[0]["hash"] if commits else (last_commit or ""),
        "task_id": batch_id,
        "last_observation_id": max((int(o.get("id", 0)) for o in observations), default=last_obs_id),
        "last_summary_id": max((int(s.get("id", 0)) for s in summaries), default=last_sum_id),
    }


def write_status(path: str | Path | None, result: UploadResult) -> None:
    if not path:
        return
    status_path = Path(path).expanduser()
    status_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.write_text(
        json.dumps({**asdict(result), "updated_at": int(time.time())}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def upload_once(workspace: str | Path, shadow_config: dict[str, Any], status_file: str | None = None) -> UploadResult:
    workspace_str = str(workspace)
    client = ShadowClient(str(shadow_config["server"]), str(shadow_config["api_token"]))
    git_root = get_git_root(workspace)
    branch = get_branch(workspace)
    remote = get_remote(workspace)
    nested_repos = find_nested_repos(git_root)

    record = client.get_push_record(git_root)
    last_commit = record.get("last_commit_hash") if record else None
    last_obs_id = int(record.get("last_observation_id", 0) or 0) if record else 0
    last_sum_id = int(record.get("last_summary_id", 0) or 0) if record else 0

    commits = get_commits(workspace, last_commit)
    stats = get_diff_stats(workspace, last_commit)
    db_path = find_memory_db(shadow_config)
    observations = export_observations(db_path, git_root, nested_repos, last_obs_id)
    summaries = export_session_summaries(db_path, git_root, nested_repos, last_sum_id)

    if not should_upload(commits, observations, summaries):
        result = UploadResult(workspace=workspace_str, uploaded=False, batch_id=None, observations_count=0, summaries_count=0)
        write_status(status_file, result)
        return result

    payload = build_payload(git_root, remote, branch, commits, stats, nested_repos, observations, summaries, last_commit)
    response = client.push_raw(payload)
    batch_id = str(response.get("batch_id", "unknown"))
    client.update_push_record(
        git_root,
        compute_new_cursors(last_commit, commits, observations, summaries, last_obs_id, last_sum_id, batch_id),
    )
    result = UploadResult(
        workspace=workspace_str,
        uploaded=True,
        batch_id=batch_id,
        observations_count=len(observations),
        summaries_count=len(summaries),
    )
    write_status(status_file, result)
    return result


def is_retryable_error(error: BaseException) -> bool:
    return isinstance(error, ShadowClientError) and error.retryable


def compute_backoff_seconds(attempt: int, base_delay: int, max_delay: int) -> int:
    return min(base_delay * (2**attempt), max_delay)


def run_daemon(
    workspaces: list[str],
    shadow_config: dict[str, Any],
    interval_seconds: int,
    retry_max_attempts: int,
    retry_base_delay_seconds: int,
    retry_max_delay_seconds: int,
    status_file: str | None = None,
    sleep: Callable[[int], None] = time.sleep,
) -> None:
    attempts_by_workspace: dict[str, int] = {workspace: 0 for workspace in workspaces}
    while True:
        for workspace in workspaces:
            workspace_config = merge_workspace_config(shadow_config, workspace)
            try:
                upload_once(workspace, workspace_config, status_file)
                attempts_by_workspace[workspace] = 0
            except Exception as exc:
                attempts_by_workspace[workspace] = attempts_by_workspace.get(workspace, 0) + 1
                result = UploadResult(
                    workspace=workspace,
                    uploaded=False,
                    batch_id=None,
                    observations_count=0,
                    summaries_count=0,
                    error=str(exc),
                )
                write_status(status_file, result)
                if attempts_by_workspace[workspace] >= retry_max_attempts or not is_retryable_error(exc):
                    attempts_by_workspace[workspace] = 0
                    continue
                sleep(compute_backoff_seconds(attempts_by_workspace[workspace], retry_base_delay_seconds, retry_max_delay_seconds))
        sleep(interval_seconds)
