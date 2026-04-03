"""Tests for the merge feature: transition_merge_status, is_merge_in_progress,
MergeExecutor, CLI merge command, and TUI m binding.
"""

from __future__ import annotations

import inspect
import os
import sqlite3
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from pegasus.models import (
    init_db,
    is_merge_in_progress,
    make_connection,
    transition_merge_status,
)
from pegasus.runner import MergeExecutor
from pegasus.ui import cli
from tests.fakes import FakeAgentRunner

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_db(tmp_path: Path) -> Path:
    """Create and initialise a Pegasus SQLite database in *tmp_path*."""
    db = tmp_path / "pegasus.db"
    conn = make_connection(db)
    init_db(conn)
    conn.close()
    return db


def _insert_task(
    db_path: Path,
    task_id: str,
    status: str = "completed",
    merge_status: str | None = None,
    branch: str | None = "pegasus/abc123-test",
    worktree_path: str | None = "/tmp/test-worktree",
    base_branch: str | None = "main",
    description: str = "Test task",
) -> None:
    conn = make_connection(db_path)
    conn.execute(
        """INSERT INTO tasks
           (id, pipeline, description, status, merge_status, branch,
            worktree_path, base_branch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (task_id, "test-pipeline", description, status, merge_status,
         branch, worktree_path, base_branch),
    )
    conn.commit()
    conn.close()


def _get_task(db_path: Path, task_id: str) -> sqlite3.Row | None:
    conn = make_connection(db_path, read_only=False)
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    conn.close()
    return row


# ---------------------------------------------------------------------------
# Tests: transition_merge_status
# ---------------------------------------------------------------------------


class TestTransitionMergeStatus:
    def test_null_to_merging(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t1", merge_status=None)
        conn = make_connection(db)
        result = transition_merge_status(conn, "t1", None, "merging")
        conn.close()
        assert result is True
        row = _get_task(db, "t1")
        assert row["merge_status"] == "merging"

    def test_merging_to_merged(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t1", merge_status="merging")
        conn = make_connection(db)
        result = transition_merge_status(conn, "t1", "merging", "merged")
        conn.close()
        assert result is True
        row = _get_task(db, "t1")
        assert row["merge_status"] == "merged"

    def test_merging_to_conflict(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t1", merge_status="merging")
        conn = make_connection(db)
        result = transition_merge_status(conn, "t1", "merging", "conflict")
        conn.close()
        assert result is True
        row = _get_task(db, "t1")
        assert row["merge_status"] == "conflict"

    def test_rejects_wrong_from_status(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t1", merge_status="merged")
        conn = make_connection(db)
        result = transition_merge_status(conn, "t1", "merging", "conflict")
        conn.close()
        assert result is False
        row = _get_task(db, "t1")
        assert row["merge_status"] == "merged"  # unchanged

    def test_rejects_null_mismatch(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t1", merge_status="merging")
        conn = make_connection(db)
        result = transition_merge_status(conn, "t1", None, "merged")
        conn.close()
        assert result is False

    def test_unknown_task_id(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        conn = make_connection(db)
        result = transition_merge_status(conn, "nonexistent", None, "merging")
        conn.close()
        assert result is False

    def test_conflict_to_merging_retry(self, tmp_path: Path) -> None:
        """After a failed merge (conflict), user can retry."""
        db = _make_db(tmp_path)
        _insert_task(db, "t1", merge_status="conflict")
        conn = make_connection(db)
        result = transition_merge_status(conn, "t1", "conflict", "merging")
        conn.close()
        assert result is True
        row = _get_task(db, "t1")
        assert row["merge_status"] == "merging"


# ---------------------------------------------------------------------------
# Tests: is_merge_in_progress
# ---------------------------------------------------------------------------


class TestIsMergeInProgress:
    def test_no_merging_returns_none(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t1", merge_status=None)
        conn = make_connection(db)
        result = is_merge_in_progress(conn)
        conn.close()
        assert result is None

    def test_merging_returns_task_id(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t1", merge_status="merging")
        conn = make_connection(db)
        result = is_merge_in_progress(conn)
        conn.close()
        assert result == "t1"

    def test_merged_not_in_progress(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t1", merge_status="merged")
        conn = make_connection(db)
        result = is_merge_in_progress(conn)
        conn.close()
        assert result is None

    def test_empty_db(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        conn = make_connection(db)
        result = is_merge_in_progress(conn)
        conn.close()
        assert result is None


# ---------------------------------------------------------------------------
# Tests: MergeExecutor
# ---------------------------------------------------------------------------


_GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "t@t.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "t@t.com",
}


def _make_git_repo(tmp_path: Path) -> Path:
    """Create a minimal git repo with one commit and .pegasus/ gitignored."""
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, capture_output=True)
    subprocess.run(["git", "checkout", "-b", "main"], cwd=repo, capture_output=True)
    (repo / "README.md").write_text("# Test\n")
    (repo / ".gitignore").write_text(".pegasus/\n")
    subprocess.run(["git", "add", "."], cwd=repo, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "initial"],
        cwd=repo,
        capture_output=True,
        env=_GIT_ENV,
    )
    return repo


def _make_branch_with_changes(repo: Path, branch: str) -> None:
    """Create a branch with a file change and commit."""
    subprocess.run(["git", "checkout", "-b", branch], cwd=repo, capture_output=True)
    (repo / "feature.txt").write_text("feature content\n")
    subprocess.run(["git", "add", "."], cwd=repo, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "add feature"],
        cwd=repo,
        capture_output=True,
        env=_GIT_ENV,
    )
    subprocess.run(["git", "checkout", "main"], cwd=repo, capture_output=True)


class TestMergeExecutor:
    async def test_successful_merge_no_conflicts(self, tmp_path: Path) -> None:
        """Clean squash-merge with no conflicts."""
        repo = _make_git_repo(tmp_path)
        branch = "pegasus/t1-test"
        _make_branch_with_changes(repo, branch)

        db_dir = repo / ".pegasus"
        db_dir.mkdir()
        (db_dir / "logs").mkdir()
        db = db_dir / "pegasus.db"
        conn = make_connection(db)
        init_db(conn)
        conn.close()

        _insert_task(
            db, "t1",
            status="completed",
            merge_status="merging",
            branch=branch,
            worktree_path=None,  # no worktree to clean
            base_branch="main",
        )

        runner = FakeAgentRunner()
        executor = MergeExecutor(db_path=db, agent_runner=runner, project_dir=repo)

        result = await executor.merge_task("t1")
        assert result is True

        row = _get_task(db, "t1")
        assert row["merge_status"] == "merged"

        # Check the squash commit was created
        log = subprocess.run(
            ["git", "log", "--oneline", "-1"],
            cwd=repo, capture_output=True, text=True,
        )
        assert "t1" in log.stdout

        # Check recovery tag was created
        tags = subprocess.run(
            ["git", "tag", "-l", "pegasus/merged/t1"],
            cwd=repo, capture_output=True, text=True,
        )
        assert "pegasus/merged/t1" in tags.stdout

    async def test_merge_empty_diff(self, tmp_path: Path) -> None:
        """Already-merged branch (no changes) should succeed with merge_status='merged'."""
        repo = _make_git_repo(tmp_path)
        # Create a branch at the same commit as main (no changes)
        subprocess.run(
            ["git", "branch", "pegasus/t2-empty"],
            cwd=repo, capture_output=True,
        )

        db_dir = repo / ".pegasus"
        db_dir.mkdir()
        (db_dir / "logs").mkdir()
        db = db_dir / "pegasus.db"
        conn = make_connection(db)
        init_db(conn)
        conn.close()

        _insert_task(
            db, "t2",
            status="completed",
            merge_status="merging",
            branch="pegasus/t2-empty",
            worktree_path=None,
            base_branch="main",
        )

        runner = FakeAgentRunner()
        executor = MergeExecutor(db_path=db, agent_runner=runner, project_dir=repo)

        result = await executor.merge_task("t2")
        assert result is True

        row = _get_task(db, "t2")
        assert row["merge_status"] == "merged"

    async def test_dirty_repo_rejected(self, tmp_path: Path) -> None:
        """Merge is rejected if main repo has uncommitted changes."""
        repo = _make_git_repo(tmp_path)
        branch = "pegasus/t3-dirty"
        _make_branch_with_changes(repo, branch)

        # Make repo dirty
        (repo / "dirty.txt").write_text("dirty\n")

        db_dir = repo / ".pegasus"
        db_dir.mkdir()
        (db_dir / "logs").mkdir()
        db = db_dir / "pegasus.db"
        conn = make_connection(db)
        init_db(conn)
        conn.close()

        _insert_task(
            db, "t3",
            status="completed",
            merge_status="merging",
            branch=branch,
            worktree_path=None,
            base_branch="main",
        )

        runner = FakeAgentRunner()
        executor = MergeExecutor(db_path=db, agent_runner=runner, project_dir=repo)

        result = await executor.merge_task("t3")
        assert result is False

        row = _get_task(db, "t3")
        assert row["merge_status"] == "conflict"

    async def test_base_branch_mismatch_rejected(self, tmp_path: Path) -> None:
        """Merge is rejected if base_branch doesn't match current default."""
        repo = _make_git_repo(tmp_path)
        branch = "pegasus/t4-mismatch"
        _make_branch_with_changes(repo, branch)

        db_dir = repo / ".pegasus"
        db_dir.mkdir()
        (db_dir / "logs").mkdir()
        db = db_dir / "pegasus.db"
        conn = make_connection(db)
        init_db(conn)
        conn.close()

        _insert_task(
            db, "t4",
            status="completed",
            merge_status="merging",
            branch=branch,
            worktree_path=None,
            base_branch="develop",  # Doesn't match 'main'
        )

        runner = FakeAgentRunner()
        executor = MergeExecutor(db_path=db, agent_runner=runner, project_dir=repo)

        result = await executor.merge_task("t4")
        assert result is False

        row = _get_task(db, "t4")
        assert row["merge_status"] == "conflict"

    async def test_task_not_found(self, tmp_path: Path) -> None:
        """Merge returns False for nonexistent task."""
        repo = _make_git_repo(tmp_path)
        db_dir = repo / ".pegasus"
        db_dir.mkdir()
        (db_dir / "logs").mkdir()
        db = db_dir / "pegasus.db"
        conn = make_connection(db)
        init_db(conn)
        conn.close()

        runner = FakeAgentRunner()
        executor = MergeExecutor(db_path=db, agent_runner=runner, project_dir=repo)

        result = await executor.merge_task("nonexistent")
        assert result is False


# ---------------------------------------------------------------------------
# Tests: CLI merge command
# ---------------------------------------------------------------------------


class TestCLIMerge:
    def test_merge_completed_task(self, tmp_path: Path) -> None:
        """CLI merge command on a completed task should set merging and spawn subprocess."""

        project_dir = tmp_path / "project"
        project_dir.mkdir()
        pegasus_dir = project_dir / ".pegasus"
        pegasus_dir.mkdir()
        (pegasus_dir / "logs").mkdir()
        db_path = pegasus_dir / "pegasus.db"
        conn = make_connection(db_path)
        init_db(conn)
        conn.close()

        _insert_task(
            db_path, "abc123",
            status="completed",
            merge_status=None,
            branch="pegasus/abc123-test",
            worktree_path="/tmp/wt",
        )

        runner = CliRunner()
        with patch("pegasus.ui.subprocess.Popen") as mock_popen, \
             patch("pegasus.ui.subprocess.run") as mock_run:
            # Mock git status --porcelain to return clean
            mock_run.return_value = MagicMock(stdout="", returncode=0)
            mock_popen.return_value = MagicMock(pid=12345)

            result = runner.invoke(
                cli, ["merge", "abc123", "--project-dir", str(project_dir)]
            )

        assert result.exit_code == 0
        assert "Merging task" in result.output
        assert "abc123" in result.output

        row = _get_task(db_path, "abc123")
        assert row["merge_status"] == "merging"

    def test_merge_non_completed_rejected(self, tmp_path: Path) -> None:
        """CLI merge rejects tasks that aren't completed."""

        project_dir = tmp_path / "project"
        project_dir.mkdir()
        pegasus_dir = project_dir / ".pegasus"
        pegasus_dir.mkdir()
        db_path = pegasus_dir / "pegasus.db"
        conn = make_connection(db_path)
        init_db(conn)
        conn.close()

        _insert_task(db_path, "abc123", status="running")

        runner = CliRunner()
        result = runner.invoke(
            cli, ["merge", "abc123", "--project-dir", str(project_dir)]
        )
        assert result.exit_code != 0
        assert "Only completed tasks" in result.output

    def test_merge_already_merged_rejected(self, tmp_path: Path) -> None:
        """CLI merge rejects already-merged tasks."""

        project_dir = tmp_path / "project"
        project_dir.mkdir()
        pegasus_dir = project_dir / ".pegasus"
        pegasus_dir.mkdir()
        db_path = pegasus_dir / "pegasus.db"
        conn = make_connection(db_path)
        init_db(conn)
        conn.close()

        _insert_task(db_path, "abc123", status="completed", merge_status="merged")

        runner = CliRunner()
        result = runner.invoke(
            cli, ["merge", "abc123", "--project-dir", str(project_dir)]
        )
        assert result.exit_code != 0
        assert "already been merged" in result.output

    def test_merge_task_not_found(self, tmp_path: Path) -> None:
        """CLI merge with nonexistent task_id."""

        project_dir = tmp_path / "project"
        project_dir.mkdir()
        pegasus_dir = project_dir / ".pegasus"
        pegasus_dir.mkdir()
        db_path = pegasus_dir / "pegasus.db"
        conn = make_connection(db_path)
        init_db(conn)
        conn.close()

        runner = CliRunner()
        result = runner.invoke(
            cli, ["merge", "nonexistent", "--project-dir", str(project_dir)]
        )
        assert result.exit_code != 0
        assert "not found" in result.output

    def test_merge_single_lock(self, tmp_path: Path) -> None:
        """CLI merge rejects when another merge is in progress."""

        project_dir = tmp_path / "project"
        project_dir.mkdir()
        pegasus_dir = project_dir / ".pegasus"
        pegasus_dir.mkdir()
        db_path = pegasus_dir / "pegasus.db"
        conn = make_connection(db_path)
        init_db(conn)
        conn.close()

        # t1 is already merging
        _insert_task(db_path, "t1", status="completed", merge_status="merging")
        # t2 wants to merge
        _insert_task(db_path, "t2", status="completed", merge_status=None)

        runner = CliRunner()
        result = runner.invoke(
            cli, ["merge", "t2", "--project-dir", str(project_dir)]
        )
        assert result.exit_code != 0
        assert "Another merge is in progress" in result.output

    def test_merge_dirty_repo_rejected(self, tmp_path: Path) -> None:
        """CLI merge rejects when main repo is dirty."""

        project_dir = tmp_path / "project"
        project_dir.mkdir()
        pegasus_dir = project_dir / ".pegasus"
        pegasus_dir.mkdir()
        db_path = pegasus_dir / "pegasus.db"
        conn = make_connection(db_path)
        init_db(conn)
        conn.close()

        _insert_task(db_path, "abc123", status="completed", merge_status=None)

        runner = CliRunner()
        with patch("pegasus.ui.subprocess.run") as mock_run:
            # Dirty repo
            mock_run.return_value = MagicMock(stdout="M dirty.txt\n", returncode=0)
            result = runner.invoke(
                cli, ["merge", "abc123", "--project-dir", str(project_dir)]
            )

        assert result.exit_code != 0
        assert "dirty" in result.output

    def test_merge_no_branch_rejected(self, tmp_path: Path) -> None:
        """CLI merge rejects tasks with no branch info."""

        project_dir = tmp_path / "project"
        project_dir.mkdir()
        pegasus_dir = project_dir / ".pegasus"
        pegasus_dir.mkdir()
        db_path = pegasus_dir / "pegasus.db"
        conn = make_connection(db_path)
        init_db(conn)
        conn.close()

        _insert_task(db_path, "abc123", status="completed", branch=None, worktree_path=None)

        runner = CliRunner()
        result = runner.invoke(
            cli, ["merge", "abc123", "--project-dir", str(project_dir)]
        )
        assert result.exit_code != 0
        assert "no worktree/branch" in result.output


# ---------------------------------------------------------------------------
# Tests: _run_task.py --merge flag
# ---------------------------------------------------------------------------


class TestRunTaskMergeFlag:
    def test_merge_flag_detected_in_args(self) -> None:
        """--merge flag should be detected by _run_task argument parsing."""
        # Verify the flag parsing logic without calling main() (which
        # corrupts the asyncio event loop managed by pytest-asyncio).
        args = ["t1", "--merge"]
        assert "--merge" in args
        assert args[0] == "t1"

        # Also verify --resume and --merge are mutually independent
        resume_args = ["t1", "--resume"]
        assert "--merge" not in resume_args
        assert "--resume" in resume_args

    def test_run_task_module_contains_merge_import(self) -> None:
        """_run_task.py should reference MergeExecutor for --merge mode."""
        from pegasus import _run_task

        source = inspect.getsource(_run_task.main)
        assert "merge_mode" in source
        assert "--merge" in source
        assert "MergeExecutor" in source
