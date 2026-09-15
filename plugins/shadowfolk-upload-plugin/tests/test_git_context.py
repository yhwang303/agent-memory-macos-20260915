import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from shadowfolk_upload.git_context import (
    author_log_args,
    find_nested_repos,
    get_branch,
    get_commits,
    get_diff_stats,
    get_git_root,
    get_remote,
    resolve_author_pattern,
)


def git(cwd: Path, *args: str, env: dict[str, str] | None = None, input_text: str | None = None) -> str:
    merged_env = {**os.environ, **(env or {})}
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=merged_env,
        input=input_text,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


def create_commit(
    cwd: Path,
    message: str,
    content: str,
    parent: str | None = None,
    author: tuple[str, str] | None = None,
) -> str:
    blob = git(cwd, "hash-object", "-w", "--stdin", input_text=content)
    tree = git(cwd, "mktree", input_text=f"100644 blob {blob}\trange.txt\n")
    args = ["commit-tree", tree, "-m", message]
    if parent:
        args.extend(["-p", parent])
    env = None
    if author:
        name, email = author
        env = {
            "GIT_AUTHOR_NAME": name,
            "GIT_AUTHOR_EMAIL": email,
            "GIT_COMMITTER_NAME": name,
            "GIT_COMMITTER_EMAIL": email,
        }
    commit = git(cwd, *args, env=env)
    git(cwd, "update-ref", "refs/heads/master", commit)
    return commit


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

    def test_resolve_author_pattern_prefers_email(self):
        self.assertEqual(resolve_author_pattern("Tester", "test@example.com"), "test@example.com")
        self.assertEqual(resolve_author_pattern("Tester", ""), "Tester")
        self.assertIsNone(resolve_author_pattern("", ""))

    def test_author_log_args_uses_local_git_email(self):
        repo = Path(tempfile.mkdtemp())
        git(repo, "init")
        git(repo, "config", "user.email", "test@example.com")
        git(repo, "config", "user.name", "Tester")

        self.assertEqual(author_log_args(repo), ["--author", "test@example.com"])

    def test_get_commits_filters_other_authors(self):
        repo = Path(tempfile.mkdtemp())
        git(repo, "init")
        git(repo, "config", "user.email", "test@example.com")
        git(repo, "config", "user.name", "Tester")

        first = create_commit(repo, "mine-first", "v1\n")
        create_commit(repo, "other-commit", "v2\n", first, ("Other Dev", "other@example.com"))
        create_commit(repo, "mine-second", "v3\n", git(repo, "rev-parse", "HEAD"))

        commits = get_commits(repo, since_hash=first)

        self.assertEqual(len(commits), 1)
        self.assertEqual(commits[0]["message"], "mine-second")
        self.assertEqual(commits[0]["author"], "Tester")

    def test_diff_stats_ignore_other_authors(self):
        repo = Path(tempfile.mkdtemp())
        git(repo, "init")
        git(repo, "config", "user.email", "test@example.com")
        git(repo, "config", "user.name", "Tester")

        first = create_commit(repo, "mine-first", "v1\n")
        create_commit(repo, "other-big-change", "v2\n" * 20, first, ("Other Dev", "other@example.com"))
        create_commit(repo, "mine-small-change", "v3\n", git(repo, "rev-parse", "HEAD"))

        stats = get_diff_stats(repo, since_hash=first)

        self.assertEqual(stats["insertions"], 1)
        self.assertEqual(stats["deletions"], 20)
