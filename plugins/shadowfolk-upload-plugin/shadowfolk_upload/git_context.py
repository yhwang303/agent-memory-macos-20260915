from __future__ import annotations

import os
import subprocess
from pathlib import Path


def normalize_path(path: str | Path) -> str:
    return str(Path(path).resolve()).replace("\\", "/")


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
    return normalize_path(run_git(workspace, "rev-parse", "--show-toplevel"))


def get_branch(workspace: str | Path) -> str:
    branch = run_git(workspace, "branch", "--show-current")
    return branch or "HEAD"


def get_remote(workspace: str | Path) -> str:
    try:
        return run_git(workspace, "remote", "get-url", "origin")
    except RuntimeError:
        return ""


def get_git_user_identity(workspace: str | Path) -> tuple[str, str]:
    name = ""
    email = ""
    try:
        name = run_git(workspace, "config", "user.name")
    except RuntimeError:
        pass
    try:
        email = run_git(workspace, "config", "user.email")
    except RuntimeError:
        pass
    return name.strip(), email.strip()


def resolve_author_pattern(name: str, email: str) -> str | None:
    email = email.strip()
    if email:
        return email
    name = name.strip()
    if name:
        return name
    return None


def author_log_args(workspace: str | Path) -> list[str]:
    name, email = get_git_user_identity(workspace)
    pattern = resolve_author_pattern(name, email)
    return ["--author", pattern] if pattern else []


def parse_numstat_output(output: str) -> dict[str, int]:
    files: set[str] = set()
    insertions = 0
    deletions = 0
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        ins_raw, del_raw, file_path = parts
        files.add(file_path)
        if ins_raw == "-" or del_raw == "-":
            continue
        insertions += int(ins_raw)
        deletions += int(del_raw)
    return {
        "files_changed": len(files),
        "insertions": insertions,
        "deletions": deletions,
    }


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
            nested.append(normalize_path(current))
            dirnames.clear()
    return nested


def get_commits(workspace: str | Path, since_hash: str | None = None, days: int = 7) -> list[dict[str, str]]:
    author_args = author_log_args(workspace)
    try:
        if since_hash:
            output = run_git(
                workspace,
                "log",
                f"{since_hash}..HEAD",
                *author_args,
                "--pretty=format:%H|||%an|||%aI|||%s",
            )
        else:
            output = run_git(
                workspace,
                "log",
                f"--since={days} days ago",
                *author_args,
                "--pretty=format:%H|||%an|||%aI|||%s",
            )
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
    author_args = author_log_args(workspace)
    try:
        if since_hash:
            output = run_git(workspace, "log", f"{since_hash}..HEAD", *author_args, "--pretty=tformat:", "--numstat")
        else:
            output = run_git(workspace, "log", "-50", *author_args, "--pretty=tformat:", "--numstat")
    except RuntimeError:
        return {"files_changed": 0, "insertions": 0, "deletions": 0}
    return parse_numstat_output(output)
