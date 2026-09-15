# ShadowFolk Upload Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a third-party ShadowFolk upload plugin that reuses the pure-script `shadow-push.py` idea to upload local agent-memory records to ShadowFolk without changing agent-memory's existing sync pipeline.

**Architecture:** Add an isolated Python package under `plugins/shadowfolk-upload-plugin/`. The package reads config, discovers git context, exports incremental `observations` and `session_summaries` from `agent-memory.db`, uploads to ShadowFolk `/api/push/raw`, updates push-record cursors, and exposes `once` and `daemon` CLI modes. Windows UI integration is represented by stable config, status, and log files that a UI shell can consume later.

**Tech Stack:** Python 3 standard library (`argparse`, `json`, `sqlite3`, `subprocess`, `urllib`, `pathlib`, `time`, `logging`, `unittest`), no local LLM, no agent-memory DB schema changes.

**Branch:** `feature/shadowfolk-upload-plugin`

**Do Not Touch:** `src/services/sync/SyncQueue.ts`, `src/services/sync/RemoteClient.ts`, `src/shared/identity.ts`, agent-memory SQLite schema, OpenClaw plugin code.

---

## File Structure

- Create `plugins/shadowfolk-upload-plugin/README.md`: user-facing install, config, CLI, daemon, and Windows UI contract.
- Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/__init__.py`: package marker and version.
- Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/config.py`: config loading, default paths, workspace overrides.
- Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/git_context.py`: git root/branch/remote/commit/diff/nested repo discovery.
- Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/memory_export.py`: read-only SQLite export for observations and summaries.
- Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/shadow_client.py`: ShadowFolk HTTP client and push-record helpers.
- Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/runner.py`: upload orchestration, once mode, daemon loop, retry, status output.
- Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/cli.py`: command-line entry point.
- Create `plugins/shadowfolk-upload-plugin/tests/*.py`: stdlib `unittest` coverage for each module.
- Create `plugins/shadowfolk-upload-plugin/examples/upload.example.json`: upload plugin config example.

All implementation must remain isolated under `plugins/shadowfolk-upload-plugin/` plus this plan/spec doc. Do not commit changes unless the user explicitly asks for a commit.

---

### Task 1: Scaffold Plugin Package and Config Loader

**Files:**
- Create: `plugins/shadowfolk-upload-plugin/shadowfolk_upload/__init__.py`
- Create: `plugins/shadowfolk-upload-plugin/shadowfolk_upload/config.py`
- Create: `plugins/shadowfolk-upload-plugin/examples/upload.example.json`
- Create: `plugins/shadowfolk-upload-plugin/tests/test_config.py`
- Create: `plugins/shadowfolk-upload-plugin/README.md`

- [ ] **Step 1: Create package marker**

Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/__init__.py`:

```python
"""ShadowFolk upload plugin.

Pure-script uploader for exporting local agent-memory records to ShadowFolk.
"""

__version__ = "0.1.0"
```

- [ ] **Step 2: Write config tests**

Create `plugins/shadowfolk-upload-plugin/tests/test_config.py`:

```python
import json
import tempfile
import unittest
from pathlib import Path

from shadowfolk_upload.config import (
    DEFAULT_SERVER,
    UploadConfig,
    load_shadow_config,
    load_upload_config,
    merge_workspace_config,
)


class ConfigTests(unittest.TestCase):
    def test_load_shadow_config_requires_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            config_path.write_text(json.dumps({"server": "https://example.test"}), encoding="utf-8")

            with self.assertRaises(ValueError) as ctx:
                load_shadow_config(config_path)

            self.assertIn("api_token", str(ctx.exception))

    def test_load_shadow_config_defaults_server(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            config_path.write_text(json.dumps({"api_token": "sf_test"}), encoding="utf-8")

            config = load_shadow_config(config_path)

            self.assertEqual(config["server"], DEFAULT_SERVER)
            self.assertEqual(config["api_token"], "sf_test")

    def test_upload_config_defaults(self):
        config = load_upload_config(None)

        self.assertIsInstance(config, UploadConfig)
        self.assertTrue(config.enabled)
        self.assertEqual(config.interval_seconds, 60)
        self.assertEqual(config.workspaces, [])

    def test_upload_config_from_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "upload.json"
            config_path.write_text(json.dumps({
                "enabled": False,
                "intervalSeconds": 5,
                "workspaces": ["E:/Github/agent-memory"],
                "retry": {
                    "maxAttempts": 3,
                    "baseDelaySeconds": 2,
                    "maxDelaySeconds": 30,
                },
                "statusFile": str(Path(tmp) / "status.json"),
                "logFile": str(Path(tmp) / "upload.log"),
            }), encoding="utf-8")

            config = load_upload_config(config_path)

            self.assertFalse(config.enabled)
            self.assertEqual(config.interval_seconds, 5)
            self.assertEqual(config.workspaces, ["E:/Github/agent-memory"])
            self.assertEqual(config.retry_max_attempts, 3)
            self.assertEqual(config.retry_base_delay_seconds, 2)
            self.assertEqual(config.retry_max_delay_seconds, 30)

    def test_workspace_config_overrides_global_values(self):
        global_config = {
            "server": "https://global.example",
            "api_token": "sf_global",
            "memory_db": "/tmp/global.db",
        }
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            shadow_dir = workspace / ".shadow"
            shadow_dir.mkdir()
            (shadow_dir / "config.json").write_text(json.dumps({
                "server": "https://local.example",
                "project_id": "proj_123",
            }), encoding="utf-8")

            merged = merge_workspace_config(global_config, workspace)

            self.assertEqual(merged["server"], "https://local.example")
            self.assertEqual(merged["api_token"], "sf_global")
            self.assertEqual(merged["project_id"], "proj_123")
```

- [ ] **Step 3: Verify tests fail before implementation**

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```

Expected: FAIL with `ModuleNotFoundError` or missing functions from `shadowfolk_upload.config`.

- [ ] **Step 4: Implement config loader**

Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/config.py`:

```python
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
        return json.loads(path.read_text(encoding="utf-8"))
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
    if path is not None and path.exists():
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
        local = read_json_file(local_path)
        merged.update(local)
    if merged.get("server"):
        merged["server"] = str(merged["server"]).rstrip("/")
    return merged
```

- [ ] **Step 5: Add example upload config**

Create `plugins/shadowfolk-upload-plugin/examples/upload.example.json`:

```json
{
  "enabled": true,
  "intervalSeconds": 60,
  "workspaces": [
    "E:/Github/agent-memory"
  ],
  "retry": {
    "maxAttempts": 5,
    "baseDelaySeconds": 30,
    "maxDelaySeconds": 1800
  },
  "statusFile": "~/.shadow/upload-status.json",
  "logFile": "~/.shadow/upload.log"
}
```

- [ ] **Step 6: Add README skeleton**

Create `plugins/shadowfolk-upload-plugin/README.md`:

```markdown
# ShadowFolk Upload Plugin

Pure-script uploader for sending local agent-memory records to ShadowFolk.

## Scope

This plugin reads local `agent-memory.db` records and uploads them to ShadowFolk. It does not modify agent-memory's sync queue, remote client, database schema, or OpenClaw plugin.

## Modes

- `once`: upload one workspace once, then exit.
- `daemon`: loop over configured workspaces and upload incrementally.

## Configuration

Global ShadowFolk auth config lives at `~/.shadow/config.json`.

Upload daemon config can be based on `examples/upload.example.json`.

## Testing

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```
```

- [ ] **Step 7: Verify config tests pass**

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```

Expected: all `ConfigTests` pass.

---

### Task 2: Implement Git Context Discovery

**Files:**
- Create: `plugins/shadowfolk-upload-plugin/shadowfolk_upload/git_context.py`
- Create: `plugins/shadowfolk-upload-plugin/tests/test_git_context.py`

- [ ] **Step 1: Write git context tests**

Create `plugins/shadowfolk-upload-plugin/tests/test_git_context.py`:

```python
import subprocess
import tempfile
import unittest
from pathlib import Path

from shadowfolk_upload.git_context import (
    find_nested_repos,
    get_branch,
    get_commits,
    get_diff_stats,
    get_git_root,
    get_remote,
)


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


class GitContextTests(unittest.TestCase):
    def make_repo(self) -> Path:
        tmp = Path(tempfile.mkdtemp())
        git(tmp, "init")
        git(tmp, "config", "user.email", "test@example.com")
        git(tmp, "config", "user.name", "Tester")
        (tmp / "README.md").write_text("one\n", encoding="utf-8")
        git(tmp, "add", "README.md")
        git(tmp, "commit", "-m", "first")
        (tmp / "README.md").write_text("one\ntwo\n", encoding="utf-8")
        git(tmp, "add", "README.md")
        git(tmp, "commit", "-m", "second")
        return tmp

    def test_git_root_branch_remote(self):
        repo = self.make_repo()
        git(repo, "remote", "add", "origin", "https://example.test/repo.git")

        self.assertEqual(Path(get_git_root(repo)), repo.resolve())
        self.assertIn(get_branch(repo), {"master", "main"})
        self.assertEqual(get_remote(repo), "https://example.test/repo.git")

    def test_get_commits_since_hash(self):
        repo = self.make_repo()
        first = git(repo, "rev-list", "--max-parents=0", "HEAD")

        commits = get_commits(repo, since_hash=first)

        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]["message"], "second")

    def test_diff_stats_since_hash(self):
        repo = self.make_repo()
        first = git(repo, "rev-list", "--max-parents=0", "HEAD")

        stats = get_diff_stats(repo, since_hash=first)

        self.assertGreaterEqual(stats["files_changed"], 1)
        self.assertGreaterEqual(stats["insertions"], 1)

    def test_find_nested_repos(self):
        repo = self.make_repo()
        nested = repo / "nested"
        nested.mkdir()
        git(nested, "init")

        nested_repos = find_nested_repos(repo)

        self.assertEqual([Path(p).name for p in nested_repos], ["nested"])
```

- [ ] **Step 2: Verify tests fail before implementation**

Run:

```bash
python -m unittest plugins.shadowfolk-upload-plugin.tests.test_git_context -v
```

Expected: FAIL because `shadowfolk_upload.git_context` does not exist.

- [ ] **Step 3: Implement git context module**

Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/git_context.py`:

```python
from __future__ import annotations

import os
import subprocess
from pathlib import Path


def run_git(workspace: str | Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=str(workspace),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def get_git_root(workspace: str | Path) -> str:
    return str(Path(run_git(workspace, "rev-parse", "--show-toplevel")).resolve()).replace("\\", "/")


def get_branch(workspace: str | Path) -> str:
    branch = run_git(workspace, "branch", "--show-current")
    return branch or "HEAD"


def get_remote(workspace: str | Path) -> str:
    try:
        return run_git(workspace, "remote", "get-url", "origin")
    except RuntimeError:
        return ""


def find_nested_repos(git_root: str | Path) -> list[str]:
    root = Path(git_root).resolve()
    nested: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        current = Path(dirpath)
        if current == root:
            if ".git" in dirnames:
                dirnames.remove(".git")
            continue
        if ".git" in dirnames or ".git" in filenames:
            nested.append(str(current.resolve()).replace("\\", "/"))
            dirnames.clear()
    return nested


def get_commits(workspace: str | Path, since_hash: str | None = None, days: int = 7) -> list[dict[str, str]]:
    try:
        if since_hash:
            output = run_git(workspace, "log", f"{since_hash}..HEAD", "--pretty=format:%H|||%an|||%aI|||%s")
        else:
            output = run_git(workspace, "log", f"--since={days} days ago", "--pretty=format:%H|||%an|||%aI|||%s")
    except RuntimeError:
        return []
    if not output:
        return []
    commits: list[dict[str, str]] = []
    for line in output.splitlines():
        parts = line.split("|||", 3)
        if len(parts) == 4:
            commits.append({"hash": parts[0], "author": parts[1], "date": parts[2], "message": parts[3]})
    return commits


def get_diff_stats(workspace: str | Path, since_hash: str | None = None) -> dict[str, int]:
    try:
        if since_hash:
            output = run_git(workspace, "diff", "--stat", since_hash, "HEAD")
        else:
            output = run_git(workspace, "diff", "--stat", "HEAD~50", "HEAD")
    except RuntimeError:
        return {"files_changed": 0, "insertions": 0, "deletions": 0}

    files_changed = 0
    insertions = 0
    deletions = 0
    for line in output.splitlines():
        if " changed" not in line:
            continue
        for part in line.split(","):
            words = part.strip().split()
            if not words:
                continue
            try:
                value = int(words[0])
            except ValueError:
                continue
            if "file" in part:
                files_changed = value
            elif "insertion" in part:
                insertions = value
            elif "deletion" in part:
                deletions = value
    return {"files_changed": files_changed, "insertions": insertions, "deletions": deletions}
```

- [ ] **Step 4: Verify git context tests pass**

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```

Expected: config and git context tests pass.

---

### Task 3: Implement Read-Only Memory Export

**Files:**
- Create: `plugins/shadowfolk-upload-plugin/shadowfolk_upload/memory_export.py`
- Create: `plugins/shadowfolk-upload-plugin/tests/test_memory_export.py`

- [ ] **Step 1: Write memory export tests**

Create `plugins/shadowfolk-upload-plugin/tests/test_memory_export.py`:

```python
import sqlite3
import tempfile
import unittest
from pathlib import Path

from shadowfolk_upload.memory_export import export_observations, export_session_summaries, find_memory_db


class MemoryExportTests(unittest.TestCase):
    def make_db(self) -> Path:
        tmp = Path(tempfile.mkdtemp())
        db_path = tmp / "agent-memory.db"
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE observations (
                id INTEGER PRIMARY KEY,
                project TEXT NOT NULL,
                title TEXT,
                created_at_epoch INTEGER
            )
        """)
        conn.execute("""
            CREATE TABLE session_summaries (
                id INTEGER PRIMARY KEY,
                project TEXT NOT NULL,
                request TEXT,
                created_at_epoch INTEGER
            )
        """)
        conn.execute("INSERT INTO observations VALUES (1, ?, 'old', 10)", ("E:/Github/app",))
        conn.execute("INSERT INTO observations VALUES (2, ?, 'new', 20)", ("E:/Github/app",))
        conn.execute("INSERT INTO observations VALUES (3, ?, 'nested', 30)", ("E:/Github/app/vendor/lib",))
        conn.execute("INSERT INTO observations VALUES (4, ?, 'other', 40)", ("E:/Github/other",))
        conn.execute("INSERT INTO session_summaries VALUES (1, ?, 'old summary', 10)", ("E:/Github/app",))
        conn.execute("INSERT INTO session_summaries VALUES (2, ?, 'new summary', 20)", ("E:/Github/app",))
        conn.commit()
        conn.close()
        return db_path

    def test_find_memory_db_uses_configured_path(self):
        db = self.make_db()

        self.assertEqual(find_memory_db({"memory_db": str(db)}), str(db))

    def test_export_observations_filters_by_project_id_and_nested_repos(self):
        db = self.make_db()

        rows = export_observations(str(db), "E:/Github/app", ["E:/Github/app/vendor"], last_id=1)

        self.assertEqual([row["id"] for row in rows], [2])
        self.assertEqual(rows[0]["title"], "new")

    def test_export_summaries_filters_by_project_and_last_id(self):
        db = self.make_db()

        rows = export_session_summaries(str(db), "E:/Github/app", [], last_id=1)

        self.assertEqual([row["id"] for row in rows], [2])
        self.assertEqual(rows[0]["request"], "new summary")
```

- [ ] **Step 2: Verify tests fail before implementation**

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```

Expected: FAIL because `shadowfolk_upload.memory_export` does not exist.

- [ ] **Step 3: Implement memory export module**

Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/memory_export.py`:

```python
from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any


def normalize_prefix(path: str) -> str:
    return str(path).replace("\\", "/").rstrip("/")


def find_memory_db(config: dict[str, Any]) -> str:
    configured = config.get("memory_db")
    if configured:
        candidate = Path(os.path.expanduser(str(configured)))
        if candidate.exists():
            return str(candidate)
        raise ValueError(f"Configured memory_db does not exist: {candidate}")

    candidates = [
        Path.home() / ".agent-memory" / "agent-memory.db",
        Path.home() / ".codebuddy" / "agent-memory.db",
        Path.home() / "agent-memory.db",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    raise ValueError("Cannot find agent-memory.db. Set 'memory_db' in ShadowFolk config.")


def fetch_rows(db_path: str, table: str, git_root: str, nested_repos: list[str], last_id: int) -> list[dict[str, Any]]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        sql = f"SELECT * FROM {table} WHERE project LIKE ? AND id > ?"
        params: list[Any] = [f"{normalize_prefix(git_root)}%", last_id]
        for nested in nested_repos:
            sql += " AND project NOT LIKE ?"
            params.append(f"{normalize_prefix(nested)}%")
        sql += " ORDER BY id ASC"
        cursor = conn.execute(sql, params)
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def export_observations(db_path: str, git_root: str, nested_repos: list[str], last_id: int) -> list[dict[str, Any]]:
    return fetch_rows(db_path, "observations", git_root, nested_repos, last_id)


def export_session_summaries(db_path: str, git_root: str, nested_repos: list[str], last_id: int) -> list[dict[str, Any]]:
    return fetch_rows(db_path, "session_summaries", git_root, nested_repos, last_id)
```

- [ ] **Step 4: Verify memory export tests pass**

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```

Expected: config, git context, and memory export tests pass.

---

### Task 4: Implement ShadowFolk HTTP Client

**Files:**
- Create: `plugins/shadowfolk-upload-plugin/shadowfolk_upload/shadow_client.py`
- Create: `plugins/shadowfolk-upload-plugin/tests/test_shadow_client.py`

- [ ] **Step 1: Write HTTP client tests**

Create `plugins/shadowfolk-upload-plugin/tests/test_shadow_client.py`:

```python
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from shadowfolk_upload.shadow_client import ShadowClient, ShadowClientError


class Handler(BaseHTTPRequestHandler):
    records = {}
    raw_payloads = []

    def _send(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer sf_test":
            self._send(401, {"error": "unauthorized"})
            return
        if self.path.startswith("/api/push/push-records/"):
            record = self.records.get(self.path)
            if record is None:
                self._send(404, {"error": "not found"})
            else:
                self._send(200, {"record": record})
            return
        self._send(404, {"error": "unknown"})

    def do_POST(self):
        if self.path == "/api/push/raw":
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
            self.raw_payloads.append(body)
            self._send(201, {"batch_id": "batch_1", "observations_count": len(body["memory"]["observations"]), "summaries_count": len(body["memory"]["session_summaries"])})
            return
        self._send(404, {"error": "unknown"})

    def do_PUT(self):
        if self.path.startswith("/api/push/push-records/"):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
            self.records[self.path] = body
            self._send(200, {"record": body})
            return
        self._send(404, {"error": "unknown"})

    def log_message(self, format, *args):
        return


class ShadowClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Handler.records = {}
        Handler.raw_payloads = []

    def test_missing_push_record_returns_none(self):
        client = ShadowClient(self.base_url, "sf_test")

        self.assertIsNone(client.get_push_record("E:/Github/app"))

    def test_push_raw_and_update_record(self):
        client = ShadowClient(self.base_url, "sf_test")
        payload = {
            "git": {"root": "E:/Github/app", "commits": [], "stats": {}},
            "memory": {"scope": "E:/Github/app", "excluded_prefixes": [], "observations": [{"id": 2}], "session_summaries": [{"id": 3}]},
        }

        result = client.push_raw(payload)
        record = client.update_push_record("E:/Github/app", {"last_observation_id": 2, "last_summary_id": 3})

        self.assertEqual(result["batch_id"], "batch_1")
        self.assertEqual(record["last_observation_id"], 2)
        self.assertEqual(len(Handler.raw_payloads), 1)

    def test_auth_error_raises_non_retryable_error(self):
        client = ShadowClient(self.base_url, "wrong")

        with self.assertRaises(ShadowClientError) as ctx:
            client.get_push_record("E:/Github/app")

        self.assertFalse(ctx.exception.retryable)
        self.assertEqual(ctx.exception.status, 401)
```

- [ ] **Step 2: Verify tests fail before implementation**

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```

Expected: FAIL because `shadowfolk_upload.shadow_client` does not exist.

- [ ] **Step 3: Implement HTTP client**

Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/shadow_client.py`:

```python
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class ShadowClientError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class ShadowClient:
    def __init__(self, server: str, token: str, timeout: int = 300):
        self.server = server.rstrip("/")
        self.token = token
        self.timeout = timeout

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[dict[str, Any], int]:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        request = urllib.request.Request(f"{self.server}{path}", data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        request.add_header("Content-Type", "application/json; charset=utf-8")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                text = response.read().decode("utf-8")
                return (json.loads(text) if text else {}, response.status)
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
            retryable = exc.code >= 500
            raise ShadowClientError(f"HTTP {exc.code}: {text}", status=exc.code, retryable=retryable) from exc
        except urllib.error.URLError as exc:
            raise ShadowClientError(f"Network error: {exc}", retryable=True) from exc

    def get_push_record(self, project_path: str) -> dict[str, Any] | None:
        encoded = urllib.parse.quote(project_path, safe="")
        try:
            data, _ = self.request("GET", f"/api/push/push-records/{encoded}")
        except ShadowClientError as exc:
            if exc.status == 404:
                return None
            raise
        return data.get("record", data)

    def push_raw(self, payload: dict[str, Any]) -> dict[str, Any]:
        data, status = self.request("POST", "/api/push/raw", payload)
        if status not in (200, 201):
            raise ShadowClientError(f"Unexpected push status: {status}", status=status, retryable=status >= 500)
        return data

    def update_push_record(self, project_path: str, data: dict[str, Any]) -> dict[str, Any]:
        encoded = urllib.parse.quote(project_path, safe="")
        response, _ = self.request("PUT", f"/api/push/push-records/{encoded}", data)
        return response.get("record", response)
```

- [ ] **Step 4: Verify client tests pass**

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```

Expected: all tests pass.

---

### Task 5: Implement Upload Runner and CLI Once Mode

**Files:**
- Create: `plugins/shadowfolk-upload-plugin/shadowfolk_upload/runner.py`
- Create: `plugins/shadowfolk-upload-plugin/shadowfolk_upload/cli.py`
- Create: `plugins/shadowfolk-upload-plugin/tests/test_runner.py`
- Modify: `plugins/shadowfolk-upload-plugin/README.md`

- [ ] **Step 1: Write runner tests**

Create `plugins/shadowfolk-upload-plugin/tests/test_runner.py`:

```python
import unittest

from shadowfolk_upload.runner import build_payload, compute_new_cursors, should_upload


class RunnerTests(unittest.TestCase):
    def test_should_upload_false_when_no_content(self):
        self.assertFalse(should_upload([], [], []))

    def test_should_upload_true_when_any_content_exists(self):
        self.assertTrue(should_upload([{"hash": "abc"}], [], []))
        self.assertTrue(should_upload([], [{"id": 1}], []))
        self.assertTrue(should_upload([], [], [{"id": 2}]))

    def test_build_payload_preserves_git_and_memory_blocks(self):
        payload = build_payload(
            git_root="E:/Github/app",
            remote="https://example.test/app.git",
            branch="main",
            commits=[{"hash": "h1"}],
            stats={"files_changed": 1},
            nested_repos=["E:/Github/app/vendor"],
            observations=[{"id": 2}],
            session_summaries=[{"id": 3}],
            last_commit="h0",
        )

        self.assertEqual(payload["git"]["root"], "E:/Github/app")
        self.assertEqual(payload["git"]["commit_range_start"], "h0")
        self.assertEqual(payload["git"]["commit_range_end"], "h1")
        self.assertEqual(payload["memory"]["scope"], "E:/Github/app")
        self.assertEqual(payload["memory"]["excluded_prefixes"], ["E:/Github/app/vendor"])

    def test_compute_new_cursors(self):
        cursors = compute_new_cursors(
            last_commit="old",
            commits=[{"hash": "new"}],
            observations=[{"id": 2}, {"id": 5}],
            summaries=[{"id": 4}],
            last_obs_id=1,
            last_sum_id=0,
            batch_id="batch_1",
        )

        self.assertEqual(cursors["last_commit_hash"], "new")
        self.assertEqual(cursors["last_observation_id"], 5)
        self.assertEqual(cursors["last_summary_id"], 4)
        self.assertEqual(cursors["task_id"], "batch_1")
```

- [ ] **Step 2: Verify tests fail before implementation**

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```

Expected: FAIL because `shadowfolk_upload.runner` does not exist.

- [ ] **Step 3: Implement runner helpers and once orchestration**

Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/runner.py`:

```python
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

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
    status_path.write_text(json.dumps({**asdict(result), "updated_at": int(time.time())}, ensure_ascii=False, indent=2), encoding="utf-8")


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
```

- [ ] **Step 4: Implement CLI once mode**

Create `plugins/shadowfolk-upload-plugin/shadowfolk_upload/cli.py`:

```python
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import load_shadow_config, load_upload_config, merge_workspace_config
from .runner import upload_once


def default_shadow_config_path() -> Path:
    return Path.home() / ".shadow" / "config.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Upload local agent-memory records to ShadowFolk")
    subparsers = parser.add_subparsers(dest="command")

    once = subparsers.add_parser("once", help="Upload one workspace once")
    once.add_argument("--workspace", "-w", required=True)
    once.add_argument("--shadow-config", default=str(default_shadow_config_path()))
    once.add_argument("--upload-config")

    args = parser.parse_args(argv)
    if args.command != "once":
        parser.print_help()
        return 2

    try:
        shadow_config = load_shadow_config(Path(args.shadow_config))
        shadow_config = merge_workspace_config(shadow_config, args.workspace)
        upload_config = load_upload_config(Path(args.upload_config) if args.upload_config else None)
        result = upload_once(args.workspace, shadow_config, upload_config.status_file)
        print(json.dumps(result.__dict__, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(f"[shadowfolk-upload] ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Update README with CLI usage**

Append to `plugins/shadowfolk-upload-plugin/README.md`:

```markdown

## Once Upload

Run:

```bash
PYTHONPATH=plugins/shadowfolk-upload-plugin python -m shadowfolk_upload.cli once --workspace E:/Github/agent-memory
```

This performs one pure-script upload. It reads local memory records and sends them to ShadowFolk. No local LLM is called.
```

- [ ] **Step 6: Verify runner and CLI tests pass**

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```

Expected: all tests pass.

---

### Task 6: Implement Daemon Loop, Retry, and Status Contract

**Files:**
- Modify: `plugins/shadowfolk-upload-plugin/shadowfolk_upload/runner.py`
- Modify: `plugins/shadowfolk-upload-plugin/shadowfolk_upload/cli.py`
- Create: `plugins/shadowfolk-upload-plugin/tests/test_daemon.py`
- Modify: `plugins/shadowfolk-upload-plugin/README.md`

- [ ] **Step 1: Write daemon helper tests**

Create `plugins/shadowfolk-upload-plugin/tests/test_daemon.py`:

```python
import unittest

from shadowfolk_upload.runner import compute_backoff_seconds


class DaemonTests(unittest.TestCase):
    def test_backoff_is_exponential_and_capped(self):
        self.assertEqual(compute_backoff_seconds(1, base_delay=30, max_delay=1800), 60)
        self.assertEqual(compute_backoff_seconds(2, base_delay=30, max_delay=1800), 120)
        self.assertEqual(compute_backoff_seconds(99, base_delay=30, max_delay=1800), 1800)
```

- [ ] **Step 2: Verify daemon tests fail before implementation**

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```

Expected: FAIL because `compute_backoff_seconds` is missing.

- [ ] **Step 3: Add daemon helpers**

Append to `plugins/shadowfolk-upload-plugin/shadowfolk_upload/runner.py`:

```python

def compute_backoff_seconds(attempt: int, base_delay: int, max_delay: int) -> int:
    return min(base_delay * (2 ** attempt), max_delay)


def run_daemon(
    workspaces: list[str],
    shadow_config: dict[str, Any],
    interval_seconds: int,
    retry_max_attempts: int,
    retry_base_delay_seconds: int,
    retry_max_delay_seconds: int,
    status_file: str | None = None,
    sleep=time.sleep,
) -> None:
    attempts_by_workspace: dict[str, int] = {workspace: 0 for workspace in workspaces}
    while True:
        for workspace in workspaces:
            try:
                upload_once(workspace, shadow_config, status_file)
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
```

- [ ] **Step 4: Add CLI daemon mode**

Modify `plugins/shadowfolk-upload-plugin/shadowfolk_upload/cli.py` so `main()` includes a `daemon` subcommand:

```python
    daemon = subparsers.add_parser("daemon", help="Run continuous upload loop")
    daemon.add_argument("--shadow-config", default=str(default_shadow_config_path()))
    daemon.add_argument("--upload-config", required=True)
```

Then replace the command handling block with:

```python
    try:
        if args.command == "once":
            shadow_config = load_shadow_config(Path(args.shadow_config))
            shadow_config = merge_workspace_config(shadow_config, args.workspace)
            upload_config = load_upload_config(Path(args.upload_config) if args.upload_config else None)
            result = upload_once(args.workspace, shadow_config, upload_config.status_file)
            print(json.dumps(result.__dict__, ensure_ascii=False, indent=2))
            return 0

        if args.command == "daemon":
            from .runner import run_daemon

            shadow_config = load_shadow_config(Path(args.shadow_config))
            upload_config = load_upload_config(Path(args.upload_config))
            if not upload_config.enabled:
                print("[shadowfolk-upload] disabled by upload config")
                return 0
            if not upload_config.workspaces:
                print("[shadowfolk-upload] no workspaces configured", file=sys.stderr)
                return 1
            run_daemon(
                upload_config.workspaces,
                shadow_config,
                upload_config.interval_seconds,
                upload_config.retry_max_attempts,
                upload_config.retry_base_delay_seconds,
                upload_config.retry_max_delay_seconds,
                upload_config.status_file,
            )
            return 0

        parser.print_help()
        return 2
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"[shadowfolk-upload] ERROR: {exc}", file=sys.stderr)
        return 1
```

- [ ] **Step 5: Update README with daemon and UI contract**

Append to `plugins/shadowfolk-upload-plugin/README.md`:

```markdown

## Daemon Mode

Run:

```bash
PYTHONPATH=plugins/shadowfolk-upload-plugin python -m shadowfolk_upload.cli daemon --upload-config ~/.shadow/upload.json
```

Linux can run this under systemd. Windows UI shells can start and stop this process.

## Windows UI Contract

The UI shell should not reimplement upload logic. It should:

- Write upload config JSON.
- Start or stop the Python daemon process.
- Call `once` for manual upload.
- Read `statusFile` for current workspace status.
- Show `logFile` if configured by the wrapper.
```

- [ ] **Step 6: Verify daemon tests pass**

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```

Expected: all tests pass.

---

### Task 7: Final Verification and Boundary Check

**Files:**
- Modify: `plugins/shadowfolk-upload-plugin/README.md` if verification reveals missing usage notes.

- [ ] **Step 1: Run full Python test suite**

Run:

```bash
python -m unittest discover -s plugins/shadowfolk-upload-plugin/tests -v
```

Expected: all tests pass.

- [ ] **Step 2: Confirm no forbidden core files changed**

Run:

```bash
git diff --name-only
```

Expected: changes are limited to:

```text
docs/superpowers/specs/2026-05-07-shadowfolk-upload-plugin-design.md
docs/superpowers/plans/2026-05-07-shadowfolk-upload-plugin.md
plugins/shadowfolk-upload-plugin/...
```

If unrelated pre-existing dirty files appear, do not revert them. Only ensure the plugin implementation did not modify forbidden core files.

- [ ] **Step 3: Run red-flag scan**

Run:

```bash
rg "TB[D]|TO[DO]|xx[x]" "plugins/shadowfolk-upload-plugin" "docs/superpowers/plans/2026-05-07-shadowfolk-upload-plugin.md"
```

Expected: no matches.

- [ ] **Step 4: Verify CLI help works**

Run:

```bash
PYTHONPATH=plugins/shadowfolk-upload-plugin python -m shadowfolk_upload.cli --help
```

Expected: command exits with status 0 and lists `once` and `daemon` commands.

- [ ] **Step 5: Self-review implementation**

Check these points manually:

- The uploader calls no local LLM.
- The uploader only reads `agent-memory.db`.
- The uploader does not write `synced_at` or any agent-memory source table.
- The uploader does not import or modify `SyncQueue`, `RemoteClient`, `getSyncConfig`, or OpenClaw plugin files.
- The daemon can run without Windows UI.
- The status file contains enough information for a future UI: workspace, uploaded, batch_id, counts, error, updated_at.

- [ ] **Step 6: Leave work uncommitted**

Do not commit. Report changed files, test results, and any known limitations to the parent agent.

---

## Self-Review Notes

- Spec coverage: tasks cover config, git context, SQLite export, ShadowFolk API client, once upload, daemon loop, retry, status contract, docs, and boundary checks.
- Red-flag scan: no implementation step relies on fill-in work.
- Scope control: MVP implements the backend and UI contract, not a full Electron UI. This matches the approved design's separation of management layer and Python backend while keeping the first implementation testable.
