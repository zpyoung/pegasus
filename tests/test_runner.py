"""Unit tests for pegasus.runner (PegasusEngine + FakeAgentRunner + WorktreeManager)."""

from __future__ import annotations

import asyncio
import os
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

import pytest

from unittest.mock import patch

import yaml

from pegasus.models import init_db, make_connection
from pegasus.runner import (
    AgentMessage,
    AgentRunnerProtocol,
    ClaudeAgentRunner,
    ErrorMessage,
    Message,
    PegasusEngine,
    PipelineExecutor,
    ResultMessage,
    ToolUseMessage,
    WorktreeError,
    WorktreeManager,
    _pid_alive,
)
from tests.fakes import (
    FakeAgentRunner,
    make_fake_runner_with_error,
    make_fake_runner_with_tool_use,
)


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


def _insert_task(db_path: Path, task_id: str, status: str = "queued") -> None:
    """Insert a minimal task row for testing."""
    conn = make_connection(db_path)
    conn.execute(
        "INSERT INTO tasks (id, pipeline, description, status) VALUES (?, ?, ?, ?)",
        (task_id, "test-pipeline", "test task", status),
    )
    conn.commit()
    conn.close()


def _get_task(db_path: Path, task_id: str) -> sqlite3.Row | None:
    conn = make_connection(db_path, read_only=False)
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    conn.close()
    return row


def _get_stage_runs(db_path: Path, task_id: str) -> list[sqlite3.Row]:
    conn = make_connection(db_path, read_only=False)
    rows = conn.execute(
        "SELECT * FROM stage_runs WHERE task_id = ? ORDER BY id", (task_id,)
    ).fetchall()
    conn.close()
    return rows


def _run(coro: Any) -> Any:
    """Run an async coroutine synchronously for tests."""
    return asyncio.get_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# Protocol structural check
# ---------------------------------------------------------------------------


class TestAgentRunnerProtocol:
    def test_fake_satisfies_protocol(self) -> None:
        runner = FakeAgentRunner()
        assert isinstance(runner, AgentRunnerProtocol)

    def test_claude_runner_satisfies_protocol(self) -> None:
        runner = ClaudeAgentRunner()
        assert isinstance(runner, AgentRunnerProtocol)


# ---------------------------------------------------------------------------
# FakeAgentRunner
# ---------------------------------------------------------------------------


class TestFakeAgentRunner:
    def test_default_yields_result_message(self) -> None:
        runner = FakeAgentRunner()
        messages: list[Message] = []

        async def collect() -> None:
            stream = await runner.run_task("hello", "/tmp")
            async for msg in stream:
                messages.append(msg)

        _run(collect())
        assert len(messages) == 1
        assert isinstance(messages[0], ResultMessage)
        assert messages[0].total_cost_usd == 0.05
        assert messages[0].session_id == "fake-session-1"

    def test_records_run_calls(self) -> None:
        runner = FakeAgentRunner()
        _run(runner.run_task("my prompt", "/some/dir"))
        assert runner.run_calls == [("my prompt", "/some/dir")]

    def test_interrupt_sets_flag(self) -> None:
        runner = FakeAgentRunner()
        assert not runner.interrupt_called
        _run(runner.interrupt())
        assert runner.interrupt_called

    def test_raise_on_run(self) -> None:
        runner = FakeAgentRunner(raise_on_run=ValueError("boom"))
        with pytest.raises(ValueError, match="boom"):
            _run(runner.run_task("prompt", "/tmp"))

    def test_custom_messages(self) -> None:
        msgs = [
            AgentMessage(content="hello", cost=0.01),
            ResultMessage(output="done", total_cost_usd=0.02),
        ]
        runner = FakeAgentRunner(messages=msgs)
        collected: list[Message] = []

        async def collect() -> None:
            stream = await runner.run_task("p", "/tmp")
            async for m in stream:
                collected.append(m)

        _run(collect())
        assert collected == msgs

    def test_factory_with_tool_use(self) -> None:
        runner = make_fake_runner_with_tool_use()
        collected: list[Message] = []

        async def collect() -> None:
            stream = await runner.run_task("p", "/tmp")
            async for m in stream:
                collected.append(m)

        _run(collect())
        assert isinstance(collected[0], AgentMessage)
        assert isinstance(collected[1], ToolUseMessage)
        assert isinstance(collected[2], ResultMessage)

    def test_factory_with_error(self) -> None:
        runner = make_fake_runner_with_error("fail!")
        collected: list[Message] = []

        async def collect() -> None:
            stream = await runner.run_task("p", "/tmp")
            async for m in stream:
                collected.append(m)

        _run(collect())
        assert len(collected) == 1
        assert isinstance(collected[0], ErrorMessage)
        assert collected[0].error == "fail!"


# ---------------------------------------------------------------------------
# PegasusEngine — happy path
# ---------------------------------------------------------------------------


class TestPegasusEngineRunStage:
    def test_run_stage_success_updates_task_status(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "task-1", status="queued")
        runner = FakeAgentRunner()
        engine = PegasusEngine(runner, db)
        result = _run(engine.run_stage("task-1", "analyze", 0, "Do analysis", "/tmp"))
        assert result is True
        row = _get_task(db, "task-1")
        assert row is not None
        # Task should now be 'running' (PegasusEngine transitions queued->running;
        # completion of tasks is handled by the pipeline executor in 08-pipeline-executor)
        assert row["status"] == "running"

    def test_run_stage_creates_stage_run_row(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "task-2", status="queued")
        runner = FakeAgentRunner()
        engine = PegasusEngine(runner, db)
        _run(engine.run_stage("task-2", "build", 1, "Build the project", "/tmp"))
        rows = _get_stage_runs(db, "task-2")
        assert len(rows) == 1
        assert rows[0]["stage_id"] == "build"
        assert rows[0]["stage_index"] == 1
        assert rows[0]["status"] == "completed"

    def test_run_stage_already_running_still_succeeds(self, tmp_path: Path) -> None:
        """transition_task_state queued->running is a no-op if task is already 'running'."""
        db = _make_db(tmp_path)
        _insert_task(db, "task-3", status="running")
        runner = FakeAgentRunner()
        engine = PegasusEngine(runner, db)
        result = _run(engine.run_stage("task-3", "stage", 0, "prompt", "/tmp"))
        assert result is True


# ---------------------------------------------------------------------------
# PegasusEngine — cost tracking
# ---------------------------------------------------------------------------


class TestPegasusEngineCostTracking:
    def test_cost_zero_by_default(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        runner = FakeAgentRunner(
            messages=[ResultMessage(output="ok", total_cost_usd=0.0)]
        )
        engine = PegasusEngine(runner, db)
        assert engine.total_cost == 0.0
        _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        assert engine.total_cost == 0.0

    def test_cost_accumulated_from_result_message(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t1", status="queued")
        runner = FakeAgentRunner(
            messages=[ResultMessage(output="done", total_cost_usd=0.10, session_id="s1")]
        )
        engine = PegasusEngine(runner, db)
        _run(engine.run_stage("t1", "s1", 0, "prompt", "/tmp"))
        assert engine.stage_cost == pytest.approx(0.10)
        assert engine.total_cost == pytest.approx(0.10)

    def test_cost_accumulated_from_agent_messages(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t2", status="queued")
        runner = FakeAgentRunner(
            messages=[
                AgentMessage(content="a", cost=0.03),
                AgentMessage(content="b", cost=0.02),
                ResultMessage(output="done", total_cost_usd=0.05),
            ]
        )
        engine = PegasusEngine(runner, db)
        _run(engine.run_stage("t2", "s", 0, "prompt", "/tmp"))
        assert engine.total_cost == pytest.approx(0.05)

    def test_cost_persisted_to_sqlite(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t3", status="queued")
        runner = FakeAgentRunner(
            messages=[ResultMessage(output="done", total_cost_usd=0.07, session_id="s")]
        )
        engine = PegasusEngine(runner, db)
        _run(engine.run_stage("t3", "s1", 0, "prompt", "/tmp"))
        row = _get_task(db, "t3")
        assert row is not None
        assert float(row["total_cost"]) == pytest.approx(0.07)

    def test_cost_cumulative_across_multiple_stages(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t4", status="queued")
        engine = PegasusEngine(
            FakeAgentRunner(
                messages=[ResultMessage(output="done", total_cost_usd=0.05)]
            ),
            db,
        )
        _run(engine.run_stage("t4", "s1", 0, "prompt 1", "/tmp"))
        assert engine.total_cost == pytest.approx(0.05)

        # Replace runner for second stage
        engine.runner = FakeAgentRunner(
            messages=[ResultMessage(output="done", total_cost_usd=0.03)]
        )
        _run(engine.run_stage("t4", "s2", 1, "prompt 2", "/tmp"))
        # Second stage: total_cost_usd=0.03 < current stage_cost=0 so delta=0.03
        assert engine.total_cost == pytest.approx(0.08)

    def test_stage_run_cost_persisted(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t5", status="queued")
        runner = FakeAgentRunner(
            messages=[ResultMessage(output="done", total_cost_usd=0.04)]
        )
        engine = PegasusEngine(runner, db)
        _run(engine.run_stage("t5", "build", 0, "p", "/tmp"))
        stage_rows = _get_stage_runs(db, "t5")
        assert len(stage_rows) == 1
        assert float(stage_rows[0]["cost"]) == pytest.approx(0.04)


# ---------------------------------------------------------------------------
# PegasusEngine — session_id management
# ---------------------------------------------------------------------------


class TestPegasusEngineSessionId:
    def test_session_id_none_before_run(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        engine = PegasusEngine(FakeAgentRunner(), db)
        assert engine.session_id is None

    def test_session_id_set_after_run(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        runner = FakeAgentRunner(
            messages=[
                ResultMessage(output="ok", total_cost_usd=0.0, session_id="sess-abc")
            ]
        )
        engine = PegasusEngine(runner, db)
        _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        assert engine.session_id == "sess-abc"

    def test_session_id_persisted_to_sqlite(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        runner = FakeAgentRunner(
            messages=[
                ResultMessage(output="ok", total_cost_usd=0.0, session_id="sess-xyz")
            ]
        )
        engine = PegasusEngine(runner, db)
        _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        row = _get_task(db, "t")
        assert row is not None
        assert row["session_id"] == "sess-xyz"

    def test_session_id_not_set_when_result_has_no_session(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        runner = FakeAgentRunner(
            messages=[ResultMessage(output="ok", total_cost_usd=0.0, session_id=None)]
        )
        engine = PegasusEngine(runner, db)
        _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        assert engine.session_id is None


# ---------------------------------------------------------------------------
# PegasusEngine — error handling
# ---------------------------------------------------------------------------


class TestPegasusEngineErrorHandling:
    def test_error_message_marks_stage_failed(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        runner = make_fake_runner_with_error("something went wrong")
        engine = PegasusEngine(runner, db)
        result = _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        assert result is False
        rows = _get_stage_runs(db, "t")
        assert rows[0]["status"] == "failed"
        assert rows[0]["error"] == "something went wrong"

    def test_error_message_marks_task_failed(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        runner = make_fake_runner_with_error("oops")
        engine = PegasusEngine(runner, db)
        _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        row = _get_task(db, "t")
        assert row is not None
        assert row["status"] == "failed"

    def test_exception_in_runner_marks_task_failed(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        runner = FakeAgentRunner(raise_on_run=RuntimeError("unexpected crash"))
        engine = PegasusEngine(runner, db)
        result = _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        assert result is False
        row = _get_task(db, "t")
        assert row is not None
        assert row["status"] == "failed"

    def test_on_error_callback_called(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        received: list[ErrorMessage] = []
        runner = make_fake_runner_with_error("error detail")
        engine = PegasusEngine(runner, db, on_error=received.append)
        _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        assert len(received) == 1
        assert received[0].error == "error detail"

    def test_exception_triggers_on_error_callback(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        received: list[ErrorMessage] = []
        runner = FakeAgentRunner(raise_on_run=ValueError("kaboom"))
        engine = PegasusEngine(runner, db, on_error=received.append)
        _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        assert len(received) == 1
        assert "kaboom" in received[0].error


# ---------------------------------------------------------------------------
# PegasusEngine — callbacks
# ---------------------------------------------------------------------------


class TestPegasusEngineCallbacks:
    def test_on_message_callback_called(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        received: list[AgentMessage] = []
        runner = FakeAgentRunner(
            messages=[
                AgentMessage(content="hello", cost=0.01),
                ResultMessage(output="done", total_cost_usd=0.01),
            ]
        )
        engine = PegasusEngine(runner, db, on_message=received.append)
        _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        assert len(received) == 1
        assert received[0].content == "hello"

    def test_on_tool_use_callback_called(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        tool_events: list[ToolUseMessage] = []
        runner = make_fake_runner_with_tool_use(tool_name="Read")
        engine = PegasusEngine(runner, db, on_tool_use=tool_events.append)
        _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        assert len(tool_events) == 1
        assert tool_events[0].tool_name == "Read"

    def test_on_result_callback_called(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        results: list[ResultMessage] = []
        runner = FakeAgentRunner()
        engine = PegasusEngine(runner, db, on_result=results.append)
        _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        assert len(results) == 1
        assert isinstance(results[0], ResultMessage)

    def test_no_callbacks_is_safe(self, tmp_path: Path) -> None:
        """Engine works correctly when no callbacks are provided."""
        db = _make_db(tmp_path)
        _insert_task(db, "t", status="queued")
        runner = make_fake_runner_with_tool_use()
        engine = PegasusEngine(runner, db)
        result = _run(engine.run_stage("t", "s", 0, "p", "/tmp"))
        assert result is True


# ---------------------------------------------------------------------------
# PegasusEngine — interrupt delegation
# ---------------------------------------------------------------------------


class TestPegasusEngineInterrupt:
    def test_interrupt_delegates_to_runner(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        runner = FakeAgentRunner()
        engine = PegasusEngine(runner, db)
        _run(engine.interrupt())
        assert runner.interrupt_called


# ---------------------------------------------------------------------------
# WorktreeManager helpers
# ---------------------------------------------------------------------------


def _init_git_repo(path: Path, branch: str = "main") -> None:
    """Initialise a git repo with an initial commit at *path*."""
    subprocess.run(
        ["git", "init", "-b", branch, str(path)],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=path,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test User"],
        cwd=path,
        check=True,
        capture_output=True,
    )
    # Create an initial commit so HEAD is valid.
    (path / "README.md").write_text("init\n")
    subprocess.run(["git", "add", "."], cwd=path, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=path,
        check=True,
        capture_output=True,
    )


# ---------------------------------------------------------------------------
# WorktreeManager — detect_default_branch
# ---------------------------------------------------------------------------


class TestDetectDefaultBranch:
    def test_returns_current_head_branch(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo, branch="main")
        mgr = WorktreeManager()
        assert mgr.detect_default_branch(repo) == "main"

    def test_returns_master_branch(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo, branch="master")
        mgr = WorktreeManager()
        assert mgr.detect_default_branch(repo) == "master"

    def test_config_default_overrides_detection(self, tmp_path: Path) -> None:
        """When config_default is set, auto-detection is skipped."""
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo, branch="main")
        mgr = WorktreeManager()
        assert mgr.detect_default_branch(repo, config_default="develop") == "develop"

    def test_fallback_for_repo_with_remote_head(self, tmp_path: Path) -> None:
        """When remote HEAD is set, that branch name is returned."""
        origin = tmp_path / "origin"
        origin.mkdir()
        _init_git_repo(origin, branch="develop")

        clone_dir = tmp_path / "clone"
        subprocess.run(
            ["git", "clone", str(origin), str(clone_dir)],
            check=True,
            capture_output=True,
        )
        mgr = WorktreeManager()
        assert mgr.detect_default_branch(clone_dir) == "develop"

    def test_slug_helper(self) -> None:
        mgr = WorktreeManager()
        assert mgr._slug("Fix login bug") == "fix-login-bug"
        assert mgr._slug("  spaces  ") == "spaces"
        assert mgr._slug("123") == "123"
        assert mgr._slug("") == "task"
        assert mgr._slug("a" * 50) == "a" * 40


# ---------------------------------------------------------------------------
# WorktreeManager — create_worktree
# ---------------------------------------------------------------------------


class TestCreateWorktree:
    def test_creates_worktree_directory(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        wt_path = mgr.create_worktree(
            repo_dir=repo,
            task_id="task-001",
            description="Fix the bug",
            base_path=tmp_path / "worktrees",
        )
        assert wt_path.is_dir()

    def test_creates_correct_branch(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        mgr.create_worktree(
            repo_dir=repo,
            task_id="task-002",
            description="Add feature",
            base_path=tmp_path / "worktrees",
        )
        # The new branch should exist.
        result = subprocess.run(
            ["git", "branch", "--list", "pegasus/task-002-add-feature"],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        assert "pegasus/task-002-add-feature" in result.stdout

    def test_worktree_listed_in_git(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        wt_path = mgr.create_worktree(
            repo_dir=repo,
            task_id="task-003",
            description="test task",
            base_path=tmp_path / "worktrees",
        )
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        assert str(wt_path) in result.stdout

    def test_setup_command_is_run(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        wt_path = mgr.create_worktree(
            repo_dir=repo,
            task_id="task-004",
            description="setup test",
            base_path=tmp_path / "worktrees",
            setup_command="touch setup_was_run",
        )
        assert (wt_path / "setup_was_run").exists()

    def test_setup_command_failure_raises(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        with pytest.raises(WorktreeError, match="setup_command failed"):
            mgr.create_worktree(
                repo_dir=repo,
                task_id="task-005",
                description="bad setup",
                base_path=tmp_path / "worktrees",
                setup_command="false",  # always exits 1 on POSIX
            )

    def test_returns_resolved_path(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        wt_path = mgr.create_worktree(
            repo_dir=repo,
            task_id="task-006",
            description="path check",
            base_path=tmp_path / "worktrees",
        )
        assert wt_path.is_absolute()


# ---------------------------------------------------------------------------
# WorktreeManager — health_check
# ---------------------------------------------------------------------------


class TestHealthCheck:
    def test_healthy_worktree(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        wt_path = mgr.create_worktree(
            repo_dir=repo,
            task_id="task-hc-1",
            description="health check",
            base_path=tmp_path / "worktrees",
        )
        result = mgr.health_check(wt_path)
        assert result["healthy"] is True
        assert result["exists"] is True
        assert result["clean"] is True
        assert result["no_lock"] is True
        assert result["error"] is None

    def test_nonexistent_worktree(self, tmp_path: Path) -> None:
        mgr = WorktreeManager()
        result = mgr.health_check(tmp_path / "does_not_exist")
        assert result["healthy"] is False
        assert result["exists"] is False
        assert "does not exist" in result["error"]

    def test_dirty_worktree(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        wt_path = mgr.create_worktree(
            repo_dir=repo,
            task_id="task-hc-2",
            description="dirty check",
            base_path=tmp_path / "worktrees",
        )
        # Create an untracked file to make the worktree dirty.
        (wt_path / "untracked.txt").write_text("dirty\n")

        result = mgr.health_check(wt_path)
        assert result["healthy"] is False
        assert result["clean"] is False
        assert "dirty" in result["error"]

    def test_stale_lock_detected(self, tmp_path: Path) -> None:
        """health_check detects a stale index.lock placed in the worktree."""
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        wt_path = mgr.create_worktree(
            repo_dir=repo,
            task_id="task-hc-3",
            description="lock check",
            base_path=tmp_path / "worktrees",
        )
        # In a real worktree, .git is a *file* (gitdir pointer), not a
        # directory.  The actual git objects live in the main repo under
        # .git/worktrees/<name>/.  We simulate a stale lock by placing the
        # index.lock file alongside the .git file.
        git_file = wt_path / ".git"
        assert git_file.is_file(), ".git should be a file in a worktree"
        lock = wt_path / ".git" / "index.lock"  # health_check looks here
        # Temporarily replace .git file with a directory so we can place a
        # lock inside it (mirrors the check path in health_check).
        git_content = git_file.read_text()
        git_file.unlink()
        git_file.mkdir()
        (git_file / "index.lock").write_text("lock\n")

        result = mgr.health_check(wt_path)
        assert result["healthy"] is False
        assert result["no_lock"] is False
        assert "lock" in result["error"]

        # Restore .git file so teardown doesn't get confused.
        import shutil
        shutil.rmtree(git_file)
        git_file.write_text(git_content)


# ---------------------------------------------------------------------------
# WorktreeManager — cleanup_worktree
# ---------------------------------------------------------------------------


class TestCleanupWorktree:
    def test_removes_worktree_directory(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        wt_path = mgr.create_worktree(
            repo_dir=repo,
            task_id="task-cl-1",
            description="cleanup test",
            base_path=tmp_path / "worktrees",
        )
        assert wt_path.is_dir()
        mgr.cleanup_worktree(wt_path, repo_dir=repo)
        assert not wt_path.exists()

    def test_removes_branch_when_specified(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        wt_path = mgr.create_worktree(
            repo_dir=repo,
            task_id="task-cl-2",
            description="branch remove",
            base_path=tmp_path / "worktrees",
        )
        branch = "pegasus/task-cl-2-branch-remove"
        mgr.cleanup_worktree(wt_path, repo_dir=repo, branch=branch)

        result = subprocess.run(
            ["git", "branch", "--list", branch],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        assert branch not in result.stdout

    def test_worktree_no_longer_in_git_list(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        wt_path = mgr.create_worktree(
            repo_dir=repo,
            task_id="task-cl-3",
            description="list check",
            base_path=tmp_path / "worktrees",
        )
        mgr.cleanup_worktree(wt_path, repo_dir=repo)

        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        assert str(wt_path) not in result.stdout


# ---------------------------------------------------------------------------
# WorktreeManager — orphan detection
# ---------------------------------------------------------------------------


class TestDetectOrphans:
    def test_no_orphans_with_empty_db(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        conn = make_connection(db)
        mgr = WorktreeManager()
        orphans = mgr.detect_orphans(conn, tmp_path)
        assert orphans == []
        conn.close()

    def test_no_orphans_when_tasks_not_running(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "task-or-1", status="queued")
        _insert_task(db, "task-or-2", status="completed")
        conn = make_connection(db)
        mgr = WorktreeManager()
        orphans = mgr.detect_orphans(conn, tmp_path)
        assert orphans == []
        conn.close()

    def test_detects_task_with_dead_pid(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "task-or-3", status="running")
        # Use PID 1 is alive on Unix; use a very large unlikely PID for "dead".
        dead_pid = 9_999_999
        conn = make_connection(db)
        conn.execute(
            "UPDATE tasks SET runner_pid = ?, heartbeat_at = CURRENT_TIMESTAMP "
            "WHERE id = ?",
            (dead_pid, "task-or-3"),
        )
        conn.commit()
        mgr = WorktreeManager()
        orphans = mgr.detect_orphans(conn, tmp_path)
        # Should only be detected if PID is actually dead.
        if not _pid_alive(dead_pid):
            assert "task-or-3" in orphans
            row = conn.execute(
                "SELECT status FROM tasks WHERE id = ?", ("task-or-3",)
            ).fetchone()
            assert row["status"] == "failed"
        conn.close()

    def test_detects_task_with_stale_heartbeat(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "task-or-4", status="running")
        conn = make_connection(db)
        # Set heartbeat to a time in the past (>30s).
        conn.execute(
            "UPDATE tasks SET heartbeat_at = datetime('now', '-60 seconds'), "
            "runner_pid = NULL WHERE id = ?",
            ("task-or-4",),
        )
        conn.commit()
        mgr = WorktreeManager()
        orphans = mgr.detect_orphans(conn, tmp_path)
        assert "task-or-4" in orphans
        row = conn.execute(
            "SELECT status FROM tasks WHERE id = ?", ("task-or-4",)
        ).fetchone()
        assert row["status"] == "failed"
        conn.close()

    def test_stale_heartbeat_marks_worktree_orphaned(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "task-or-5", status="running")
        conn = make_connection(db)
        conn.execute(
            "INSERT INTO worktrees (task_id, path, branch, status) VALUES (?, ?, ?, ?)",
            ("task-or-5", "/tmp/fake-wt", "pegasus/task-or-5-test", "active"),
        )
        conn.execute(
            "UPDATE tasks SET heartbeat_at = datetime('now', '-60 seconds'), "
            "runner_pid = NULL WHERE id = ?",
            ("task-or-5",),
        )
        conn.commit()
        mgr = WorktreeManager()
        mgr.detect_orphans(conn, tmp_path)
        wt_row = conn.execute(
            "SELECT status FROM worktrees WHERE task_id = ?", ("task-or-5",)
        ).fetchone()
        assert wt_row["status"] == "orphaned"
        conn.close()

    def test_no_heartbeat_treated_as_orphan(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "task-or-6", status="running")
        conn = make_connection(db)
        # Leave heartbeat_at as NULL (default).
        mgr = WorktreeManager()
        orphans = mgr.detect_orphans(conn, tmp_path)
        assert "task-or-6" in orphans
        conn.close()

    def test_live_pid_with_fresh_heartbeat_is_not_orphan(
        self, tmp_path: Path
    ) -> None:
        db = _make_db(tmp_path)
        _insert_task(db, "task-or-7", status="running")
        live_pid = os.getpid()  # The test process itself is alive.
        conn = make_connection(db)
        conn.execute(
            "UPDATE tasks SET runner_pid = ?, heartbeat_at = CURRENT_TIMESTAMP "
            "WHERE id = ?",
            (live_pid, "task-or-7"),
        )
        conn.commit()
        mgr = WorktreeManager()
        orphans = mgr.detect_orphans(conn, tmp_path)
        assert "task-or-7" not in orphans
        conn.close()


# ---------------------------------------------------------------------------
# WorktreeManager — cleanup_orphans
# ---------------------------------------------------------------------------


class TestCleanupOrphans:
    def test_cleanup_orphans_removes_worktree(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        wt_path = mgr.create_worktree(
            repo_dir=repo,
            task_id="task-co-1",
            description="orphan cleanup",
            base_path=tmp_path / "worktrees",
        )
        db = _make_db(tmp_path)
        _insert_task(db, "task-co-1", status="failed")
        conn = make_connection(db)
        conn.execute(
            "INSERT INTO worktrees (task_id, path, branch, status) VALUES (?, ?, ?, ?)",
            (
                "task-co-1",
                str(wt_path),
                "pegasus/task-co-1-orphan-cleanup",
                "orphaned",
            ),
        )
        conn.commit()

        removed = mgr.cleanup_orphans(conn, tmp_path, repo_dir=repo)
        assert str(wt_path) in removed
        assert not wt_path.exists()
        conn.close()

    def test_cleanup_orphans_removes_db_row(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        repo.mkdir()
        _init_git_repo(repo)
        mgr = WorktreeManager()

        wt_path = mgr.create_worktree(
            repo_dir=repo,
            task_id="task-co-2",
            description="db row removal",
            base_path=tmp_path / "worktrees",
        )
        db = _make_db(tmp_path)
        _insert_task(db, "task-co-2", status="failed")
        conn = make_connection(db)
        conn.execute(
            "INSERT INTO worktrees (task_id, path, branch, status) VALUES (?, ?, ?, ?)",
            (
                "task-co-2",
                str(wt_path),
                "pegasus/task-co-2-db-row-removal",
                "orphaned",
            ),
        )
        conn.commit()

        mgr.cleanup_orphans(conn, tmp_path, repo_dir=repo)
        row = conn.execute(
            "SELECT * FROM worktrees WHERE task_id = ?", ("task-co-2",)
        ).fetchone()
        assert row is None
        conn.close()

    def test_cleanup_orphans_no_orphans_is_noop(self, tmp_path: Path) -> None:
        db = _make_db(tmp_path)
        conn = make_connection(db)
        mgr = WorktreeManager()
        removed = mgr.cleanup_orphans(conn, tmp_path)
        assert removed == []
        conn.close()

    def test_cleanup_orphans_tolerates_missing_worktree(
        self, tmp_path: Path
    ) -> None:
        """If the worktree directory no longer exists, cleanup logs a warning
        and continues rather than raising."""
        db = _make_db(tmp_path)
        _insert_task(db, "task-co-3", status="failed")
        conn = make_connection(db)
        conn.execute(
            "INSERT INTO worktrees (task_id, path, branch, status) VALUES (?, ?, ?, ?)",
            ("task-co-3", "/nonexistent/path", "pegasus/task-co-3", "orphaned"),
        )
        conn.commit()
        mgr = WorktreeManager()
        # Should not raise; returns empty list since cleanup failed.
        removed = mgr.cleanup_orphans(conn, tmp_path)
        assert removed == []
        conn.close()


# ---------------------------------------------------------------------------
# _pid_alive
# ---------------------------------------------------------------------------


class TestPidAlive:
    def test_own_pid_is_alive(self) -> None:
        assert _pid_alive(os.getpid()) is True

    def test_impossible_pid_is_dead(self) -> None:
        assert _pid_alive(9_999_999) is False


# ---------------------------------------------------------------------------
# PipelineExecutor helpers
# ---------------------------------------------------------------------------


def _make_pipeline_yaml(
    tmp_path: Path,
    stages: list[dict[str, Any]] | None = None,
    name: str = "test-pipeline",
) -> tuple[Path, str]:
    """Write a minimal pipeline YAML and return (project_dir, pipeline_name).

    The pipeline YAML is placed at:
        <tmp_path>/project/.pegasus/pipelines/<name>.yaml
    """
    if stages is None:
        stages = [
            {"id": "analyze", "name": "Analyze", "prompt": "Analyze the codebase."},
            {"id": "implement", "name": "Implement", "prompt": "Implement the fix."},
        ]

    project_dir = tmp_path / "project"
    project_dir.mkdir(parents=True, exist_ok=True)
    pipeline_dir = project_dir / ".pegasus" / "pipelines"
    pipeline_dir.mkdir(parents=True, exist_ok=True)

    pipeline_data = {
        "name": name,
        "description": "Test pipeline",
        "stages": stages,
    }
    pipeline_file = pipeline_dir / f"{name}.yaml"
    pipeline_file.write_text(yaml.dump(pipeline_data))
    return project_dir, name


def _make_executor(
    tmp_path: Path,
    project_dir: Path,
    runner: FakeAgentRunner,
    *,
    heartbeat_interval: float = 0.1,
    poll_interval: float = 0.05,
    on_approval_needed: Any = None,
    on_question_asked: Any = None,
) -> tuple[PipelineExecutor, Path]:
    """Create a PipelineExecutor with a tmp SQLite db, returning (executor, db_path)."""
    db_path = tmp_path / "pegasus.db"
    executor = PipelineExecutor(
        db_path=db_path,
        agent_runner=runner,
        project_dir=project_dir,
        heartbeat_interval=heartbeat_interval,
        poll_interval=poll_interval,
        on_approval_needed=on_approval_needed,
        on_question_asked=on_question_asked,
    )
    return executor, db_path


def _make_project_with_git(
    tmp_path: Path,
    stages: list[dict[str, Any]] | None = None,
    pipeline_name: str = "test-pipeline",
) -> tuple[Path, str]:
    """Create a git repo + pipeline YAML; return (project_dir, pipeline_name).

    Also writes a .pegasus/config.yaml that redirects worktrees to tmp_path/worktrees
    to avoid polluting ~/.pegasus/worktrees during tests.
    """
    project_dir, pl_name = _make_pipeline_yaml(tmp_path, stages=stages, name=pipeline_name)
    _init_git_repo(project_dir)

    # Override worktrees base_path to use tmp_path so tests are isolated
    config_dir = project_dir / ".pegasus"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "config.yaml"
    if not config_path.exists():
        worktrees_base = tmp_path / "worktrees"
        config_path.write_text(
            f"worktrees:\n  base_path: {worktrees_base}\n"
        )

    return project_dir, pl_name


# ---------------------------------------------------------------------------
# PipelineExecutor — happy path
# ---------------------------------------------------------------------------


class TestPipelineExecutorHappyPath:
    def test_all_stages_complete_marks_task_completed(self, tmp_path: Path) -> None:
        project_dir, pl_name = _make_project_with_git(tmp_path)
        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        task_id = "exec-happy-1"
        result = _run(executor.run_task(task_id, pl_name, "fix login bug"))

        assert result is True
        row = _get_task(db_path, task_id)
        assert row is not None
        assert row["status"] == "completed"

    def test_all_stages_create_stage_run_rows(self, tmp_path: Path) -> None:
        stages = [
            {"id": "analyze", "name": "Analyze", "prompt": "Analyze."},
            {"id": "implement", "name": "Implement", "prompt": "Implement."},
            {"id": "test", "name": "Test", "prompt": "Test."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)
        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        task_id = "exec-happy-2"
        result = _run(executor.run_task(task_id, pl_name, "add feature"))

        assert result is True
        stage_rows = _get_stage_runs(db_path, task_id)
        assert len(stage_rows) == 3
        assert {r["stage_id"] for r in stage_rows} == {"analyze", "implement", "test"}
        assert all(r["status"] == "completed" for r in stage_rows)

    def test_task_row_inserted_in_db(self, tmp_path: Path) -> None:
        project_dir, pl_name = _make_project_with_git(tmp_path)
        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        task_id = "exec-happy-3"
        _run(executor.run_task(task_id, pl_name, "description here"))

        row = _get_task(db_path, task_id)
        assert row is not None
        assert row["pipeline"] == pl_name
        assert row["description"] == "description here"

    def test_worktree_row_inserted_in_db(self, tmp_path: Path) -> None:
        project_dir, pl_name = _make_project_with_git(tmp_path)
        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        task_id = "exec-happy-4"
        _run(executor.run_task(task_id, pl_name, "worktree test"))

        conn = make_connection(db_path, read_only=False)
        wt_row = conn.execute(
            "SELECT * FROM worktrees WHERE task_id = ?", (task_id,)
        ).fetchone()
        conn.close()
        assert wt_row is not None
        assert wt_row["status"] == "active"


# ---------------------------------------------------------------------------
# PipelineExecutor — stage failure handling
# ---------------------------------------------------------------------------


class TestPipelineExecutorStageFailure:
    def test_stage_failure_marks_task_failed(self, tmp_path: Path) -> None:
        stages = [
            {"id": "analyze", "name": "Analyze", "prompt": "Analyze."},
            {"id": "implement", "name": "Implement", "prompt": "Implement."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)

        # Runner that fails on second call
        call_count = 0

        class FailOnSecondCall:
            interrupt_called = False
            run_calls: list[tuple[str, str]] = []

            async def run_task(self, prompt: str, cwd: str, claude_flags: dict | None = None, session_id: str | None = None) -> Any:
                nonlocal call_count
                call_count += 1
                self.run_calls.append((prompt, cwd))

                async def _gen() -> Any:
                    if call_count == 1:
                        yield ResultMessage(output="ok", total_cost_usd=0.01, session_id="s1")
                    else:
                        yield ErrorMessage(error="stage 2 exploded", cost=0.0)

                return _gen()

            async def interrupt(self) -> None:
                self.interrupt_called = True

        runner = FailOnSecondCall()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        task_id = "exec-fail-1"
        result = _run(executor.run_task(task_id, pl_name, "failing task"))

        assert result is False
        row = _get_task(db_path, task_id)
        assert row is not None
        assert row["status"] == "failed"

    def test_first_stage_failure_marks_task_failed(self, tmp_path: Path) -> None:
        project_dir, pl_name = _make_project_with_git(tmp_path)
        runner = make_fake_runner_with_error("first stage error")
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        task_id = "exec-fail-2"
        result = _run(executor.run_task(task_id, pl_name, "fails immediately"))

        assert result is False
        row = _get_task(db_path, task_id)
        assert row is not None
        assert row["status"] == "failed"

    def test_failure_stops_at_failed_stage(self, tmp_path: Path) -> None:
        """When stage 1 fails, stage 2 should not run."""
        stages = [
            {"id": "stage1", "name": "Stage 1", "prompt": "First."},
            {"id": "stage2", "name": "Stage 2", "prompt": "Second."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)
        runner = make_fake_runner_with_error("fail at stage1")
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        task_id = "exec-fail-3"
        _run(executor.run_task(task_id, pl_name, "stops early"))

        stage_rows = _get_stage_runs(db_path, task_id)
        # Only stage1 should have a run row (stage2 never started)
        assert len(stage_rows) == 1
        assert stage_rows[0]["stage_id"] == "stage1"
        assert stage_rows[0]["status"] == "failed"


# ---------------------------------------------------------------------------
# PipelineExecutor — requires_approval gate
# ---------------------------------------------------------------------------


class TestPipelineExecutorApprovalGate:
    def test_approval_pauses_then_resumes(self, tmp_path: Path) -> None:
        stages = [
            {
                "id": "write",
                "name": "Write",
                "prompt": "Write code.",
                "claude_flags": {"permission_mode": "acceptEdits"},
            },
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)
        runner = FakeAgentRunner()
        approvals: list[tuple[str, str]] = []

        async def approve(task_id: str, stage_id: str) -> bool:
            approvals.append((task_id, stage_id))
            return True  # Always approve

        executor, db_path = _make_executor(
            tmp_path, project_dir, runner, on_approval_needed=approve
        )

        task_id = "exec-approval-1"
        result = _run(executor.run_task(task_id, pl_name, "write task"))

        assert result is True
        # The approval callback was called once for the write stage
        assert len(approvals) == 1
        assert approvals[0][1] == "write"
        row = _get_task(db_path, task_id)
        assert row["status"] == "completed"

    def test_rejected_approval_marks_task_failed(self, tmp_path: Path) -> None:
        stages = [
            {
                "id": "write",
                "name": "Write",
                "prompt": "Write code.",
                "claude_flags": {"permission_mode": "acceptEdits"},
            },
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)
        runner = FakeAgentRunner()

        async def reject(task_id: str, stage_id: str) -> bool:
            return False  # Always reject

        executor, db_path = _make_executor(
            tmp_path, project_dir, runner, on_approval_needed=reject
        )

        task_id = "exec-approval-2"
        result = _run(executor.run_task(task_id, pl_name, "rejected write task"))

        assert result is False
        row = _get_task(db_path, task_id)
        assert row["status"] == "failed"

    def test_no_approval_handler_polls_sqlite(self, tmp_path: Path) -> None:
        """When no on_approval_needed handler is set, the runner polls SQLite.

        Simulate TUI approval by writing 'queued' to the task status from a
        background coroutine while the runner is polling.
        """
        stages = [
            {
                "id": "write",
                "name": "Write",
                "prompt": "Write code.",
                "claude_flags": {"permission_mode": "acceptEdits"},
            },
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)
        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        task_id = "exec-approval-3"

        async def _run_with_bg_approve() -> bool:
            """Run the task while a background coroutine approves it via SQLite."""
            import asyncio

            async def _approve_after_delay() -> None:
                # Wait for the runner to set status to 'paused', then approve.
                for _ in range(50):  # up to 5 seconds
                    await asyncio.sleep(0.1)
                    conn = make_connection(db_path, read_only=True)
                    row = conn.execute(
                        "SELECT status FROM tasks WHERE id = ?", (task_id,)
                    ).fetchone()
                    conn.close()
                    if row and row["status"] == "paused":
                        conn = make_connection(db_path)
                        conn.execute(
                            "UPDATE tasks SET status = 'queued', "
                            "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                            (task_id,),
                        )
                        conn.commit()
                        conn.close()
                        return

            bg = asyncio.ensure_future(_approve_after_delay())
            result = await executor.run_task(task_id, pl_name, "poll-approve write task")
            bg.cancel()
            return result

        result = _run(_run_with_bg_approve())

        assert result is True
        row = _get_task(db_path, task_id)
        assert row["status"] == "completed"


# ---------------------------------------------------------------------------
# PipelineExecutor — resume_task
# ---------------------------------------------------------------------------


class TestPipelineExecutorResumeTask:
    def test_resume_completes_from_failed_stage(self, tmp_path: Path) -> None:
        stages = [
            {"id": "stage1", "name": "Stage 1", "prompt": "First."},
            {"id": "stage2", "name": "Stage 2", "prompt": "Second."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)
        db_path = tmp_path / "pegasus.db"

        # Manually set up a task that "already completed stage1"
        # We do this by running the full pipeline first with a success runner
        # then marking it as failed and removing stage2 completion.
        runner = FakeAgentRunner()
        executor = PipelineExecutor(
            db_path=db_path,
            agent_runner=runner,
            project_dir=project_dir,
            heartbeat_interval=0.1,
            poll_interval=0.05,
        )

        # Run the full pipeline to create the worktree and insert task/stage rows
        task_id = "exec-resume-1"
        _run(executor.run_task(task_id, pl_name, "resumable task"))

        # Now simulate a failure: reset task to 'failed', remove stage2 completion
        conn = make_connection(db_path, read_only=False)
        conn.execute("UPDATE tasks SET status = 'failed' WHERE id = ?", (task_id,))
        conn.execute(
            "DELETE FROM stage_runs WHERE task_id = ? AND stage_id = 'stage2'",
            (task_id,),
        )
        conn.commit()
        conn.close()

        # Resume should re-run stage2 only and complete
        runner2 = FakeAgentRunner()
        executor2 = PipelineExecutor(
            db_path=db_path,
            agent_runner=runner2,
            project_dir=project_dir,
            heartbeat_interval=0.1,
            poll_interval=0.05,
        )
        result = _run(executor2.resume_task(task_id))

        assert result is True
        row = _get_task(db_path, task_id)
        assert row["status"] == "completed"
        # stage2 should have been re-run
        assert runner2.run_calls, "runner2 should have been called for stage2"

    def test_resume_raises_for_missing_task(self, tmp_path: Path) -> None:
        project_dir, pl_name = _make_project_with_git(tmp_path)
        db_path = tmp_path / "pegasus.db"
        conn = make_connection(db_path, read_only=False)
        init_db(conn)
        conn.close()

        executor = PipelineExecutor(
            db_path=db_path,
            agent_runner=FakeAgentRunner(),
            project_dir=project_dir,
            heartbeat_interval=0.1,
            poll_interval=0.05,
        )
        with pytest.raises(ValueError, match="not found"):
            _run(executor.resume_task("nonexistent-task"))

    def test_resume_raises_for_non_resumable_status(self, tmp_path: Path) -> None:
        project_dir, pl_name = _make_project_with_git(tmp_path)
        db_path = tmp_path / "pegasus.db"
        conn = make_connection(db_path, read_only=False)
        init_db(conn)
        conn.execute(
            "INSERT INTO tasks (id, pipeline, description, status) VALUES (?, ?, ?, ?)",
            ("exec-resume-bad", pl_name, "running task", "running"),
        )
        conn.commit()
        conn.close()

        executor = PipelineExecutor(
            db_path=db_path,
            agent_runner=FakeAgentRunner(),
            project_dir=project_dir,
            heartbeat_interval=0.1,
            poll_interval=0.05,
        )
        with pytest.raises(ValueError, match="cannot be resumed"):
            _run(executor.resume_task("exec-resume-bad"))


# ---------------------------------------------------------------------------
# PipelineExecutor — heartbeat
# ---------------------------------------------------------------------------


class TestPipelineExecutorHeartbeat:
    def test_heartbeat_updates_during_execution(self, tmp_path: Path) -> None:
        """Heartbeat should be updated at least once during a pipeline run."""
        stages = [
            {"id": "analyze", "name": "Analyze", "prompt": "Analyze."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)

        # Use a runner with a slight delay to allow heartbeat to fire
        class SlowRunner:
            run_calls: list[tuple[str, str]] = []
            interrupt_called = False

            async def run_task(self, prompt: str, cwd: str, claude_flags: dict | None = None, session_id: str | None = None) -> Any:
                self.run_calls.append((prompt, cwd))

                async def _gen() -> Any:
                    await asyncio.sleep(0.15)  # allow at least 1 heartbeat at 0.1s
                    yield ResultMessage(output="done", total_cost_usd=0.0, session_id="s")

                return _gen()

            async def interrupt(self) -> None:
                self.interrupt_called = True

        runner = SlowRunner()
        db_path = tmp_path / "pegasus.db"
        executor = PipelineExecutor(
            db_path=db_path,
            agent_runner=runner,
            project_dir=project_dir,
            heartbeat_interval=0.1,
            poll_interval=0.05,
        )

        task_id = "exec-hb-1"
        result = _run(executor.run_task(task_id, pl_name, "heartbeat test"))

        assert result is True
        # Verify heartbeat_at is set in the DB
        row = _get_task(db_path, task_id)
        assert row is not None
        assert row["heartbeat_at"] is not None


# ---------------------------------------------------------------------------
# PipelineExecutor — rate limit retry
# ---------------------------------------------------------------------------


class TestPipelineExecutorRateLimitRetry:
    def test_rate_limit_retried_and_succeeds(self, tmp_path: Path) -> None:
        """A rate-limit error on attempt 0 should trigger retry; second attempt succeeds."""
        stages = [
            {"id": "analyze", "name": "Analyze", "prompt": "Analyze."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)

        call_count = 0

        class RateLimitThenOkRunner:
            run_calls: list[tuple[str, str]] = []
            interrupt_called = False

            async def run_task(self, prompt: str, cwd: str, claude_flags: dict | None = None, session_id: str | None = None) -> Any:
                nonlocal call_count
                call_count += 1
                self.run_calls.append((prompt, cwd))

                async def _gen() -> Any:
                    if call_count == 1:
                        yield ErrorMessage(error="rate limit exceeded: 429", cost=0.0)
                    else:
                        yield ResultMessage(output="ok", total_cost_usd=0.01, session_id="s")

                return _gen()

            async def interrupt(self) -> None:
                self.interrupt_called = True

        runner = RateLimitThenOkRunner()
        db_path = tmp_path / "pegasus.db"
        executor = PipelineExecutor(
            db_path=db_path,
            agent_runner=runner,
            project_dir=project_dir,
            heartbeat_interval=0.1,
            poll_interval=0.05,
        )
        # Override retry base delay to 0.01s (very fast for tests)
        # We achieve this via a minimal config: write a custom config.yaml
        worktrees_base = tmp_path / "worktrees"
        config_path = project_dir / ".pegasus" / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(
            f"concurrency:\n  retry_max: 3\n  retry_base_delay: 0.01\n"
            f"worktrees:\n  base_path: {worktrees_base}\n"
        )

        task_id = "exec-retry-1"
        result = _run(executor.run_task(task_id, pl_name, "rate limit test"))

        assert result is True
        assert call_count >= 2, "Runner should have been called at least twice"
        row = _get_task(db_path, task_id)
        assert row["status"] == "completed"

    def test_rate_limit_exhausted_marks_failed(self, tmp_path: Path) -> None:
        """If all retries are exhausted, the task should be marked failed."""
        stages = [
            {"id": "analyze", "name": "Analyze", "prompt": "Analyze."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)

        class AlwaysRateLimitRunner:
            run_calls: list[tuple[str, str]] = []
            interrupt_called = False

            async def run_task(self, prompt: str, cwd: str, claude_flags: dict | None = None, session_id: str | None = None) -> Any:
                self.run_calls.append((prompt, cwd))

                async def _gen() -> Any:
                    yield ErrorMessage(error="too many requests: 429", cost=0.0)

                return _gen()

            async def interrupt(self) -> None:
                self.interrupt_called = True

        runner = AlwaysRateLimitRunner()
        db_path = tmp_path / "pegasus.db"

        # Write a config.yaml with only 2 retries + tiny delay + isolated worktrees
        worktrees_base = tmp_path / "worktrees"
        config_path = project_dir / ".pegasus" / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(
            f"concurrency:\n  retry_max: 2\n  retry_base_delay: 0.01\n"
            f"worktrees:\n  base_path: {worktrees_base}\n"
        )

        executor = PipelineExecutor(
            db_path=db_path,
            agent_runner=runner,
            project_dir=project_dir,
            heartbeat_interval=0.1,
            poll_interval=0.05,
        )

        task_id = "exec-retry-2"
        result = _run(executor.run_task(task_id, pl_name, "always rate limited"))

        assert result is False
        row = _get_task(db_path, task_id)
        assert row["status"] == "failed"
        # runner was called retry_max+1 times (1 initial + 2 retries)
        assert len(runner.run_calls) == 3


# ---------------------------------------------------------------------------
# PipelineExecutor — desktop notifications
# ---------------------------------------------------------------------------


class TestPipelineExecutorNotifications:
    def test_notification_called_on_completion(self, tmp_path: Path) -> None:
        """Verify _send_notification is called at least once on pipeline completion."""
        project_dir, pl_name = _make_project_with_git(tmp_path)
        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        notifications: list[tuple[str, str]] = []
        original_send = executor._send_notification

        def capture_notification(title: str, message: str) -> None:
            notifications.append((title, message))
            # Don't actually fire the OS notification
            pass

        executor._send_notification = capture_notification  # type: ignore[method-assign]

        task_id = "exec-notif-1"
        result = _run(executor.run_task(task_id, pl_name, "notification test"))

        assert result is True
        assert len(notifications) >= 1  # At minimum a completion notification
        row = _get_task(db_path, task_id)
        assert row["status"] == "completed"

    def test_send_notification_macos(self, tmp_path: Path) -> None:
        project_dir, pl_name = _make_project_with_git(tmp_path)
        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        with (
            patch("pegasus.runner.platform.system", return_value="Darwin"),
            patch("pegasus.runner.subprocess.run") as mock_run,
        ):
            executor._send_notification("Test Title", "Test message")
            assert mock_run.called
            call_args = mock_run.call_args[0][0]
            assert call_args[0] == "osascript"

    def test_send_notification_linux(self, tmp_path: Path) -> None:
        project_dir, pl_name = _make_project_with_git(tmp_path)
        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        with (
            patch("pegasus.runner.platform.system", return_value="Linux"),
            patch("pegasus.runner.subprocess.run") as mock_run,
        ):
            executor._send_notification("Test Title", "Test message")
            assert mock_run.called
            call_args = mock_run.call_args[0][0]
            assert call_args[0] == "notify-send"

    def test_send_notification_failure_does_not_raise(self, tmp_path: Path) -> None:
        project_dir, pl_name = _make_project_with_git(tmp_path)
        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        with (
            patch("pegasus.runner.platform.system", return_value="Darwin"),
            patch(
                "pegasus.runner.subprocess.run",
                side_effect=FileNotFoundError("osascript not found"),
            ),
        ):
            # Should not raise
            executor._send_notification("Title", "Message")

    def test_send_notification_windows_skips(self, tmp_path: Path) -> None:
        project_dir, pl_name = _make_project_with_git(tmp_path)
        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        with (
            patch("pegasus.runner.platform.system", return_value="Windows"),
            patch("pegasus.runner.subprocess.run") as mock_run,
        ):
            executor._send_notification("Title", "Message")
            assert not mock_run.called


# ---------------------------------------------------------------------------
# PipelineExecutor — rate limit detection helper
# ---------------------------------------------------------------------------


class TestRateLimitDetection:
    def test_detects_rate_limit_keyword(self) -> None:
        assert PipelineExecutor._is_rate_limit_error("rate limit exceeded")
        assert PipelineExecutor._is_rate_limit_error("Rate Limit Error")
        assert PipelineExecutor._is_rate_limit_error("too many requests")
        assert PipelineExecutor._is_rate_limit_error("429 Too Many Requests")
        assert PipelineExecutor._is_rate_limit_error("API is overloaded")
        assert PipelineExecutor._is_rate_limit_error("ratelimit hit")

    def test_does_not_false_positive(self) -> None:
        assert not PipelineExecutor._is_rate_limit_error("network error")
        assert not PipelineExecutor._is_rate_limit_error("timeout")
        assert not PipelineExecutor._is_rate_limit_error("file not found")
        assert not PipelineExecutor._is_rate_limit_error("")


# ---------------------------------------------------------------------------
# WorktreeManager — commit_stage_work
# ---------------------------------------------------------------------------


class TestWorktreeManagerCommitStageWork:
    def test_creates_commit_when_changes_exist(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        _init_git_repo(repo)
        (repo / "output.txt").write_text("stage output")

        mgr = WorktreeManager()
        committed = mgr.commit_stage_work(
            repo,
            stage_name="Analyze",
            stage_id="analyze",
            task_id="t1",
            pipeline_name="test",
            description="fix bug",
        )
        assert committed is True

        result = subprocess.run(
            ["git", "log", "--oneline", "-1"],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        assert "pegasus: Analyze [t1]" in result.stdout

    def test_skips_when_worktree_is_clean(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        _init_git_repo(repo)

        mgr = WorktreeManager()
        committed = mgr.commit_stage_work(
            repo,
            stage_name="Analyze",
            stage_id="analyze",
            task_id="t1",
            pipeline_name="test",
            description="fix bug",
        )
        assert committed is False

    def test_commit_message_contains_metadata(self, tmp_path: Path) -> None:
        repo = tmp_path / "repo"
        _init_git_repo(repo)
        (repo / "code.py").write_text("print('hello')")

        mgr = WorktreeManager()
        mgr.commit_stage_work(
            repo,
            stage_name="Implement",
            stage_id="implement",
            task_id="task-42",
            pipeline_name="feature",
            description="add login",
        )

        result = subprocess.run(
            ["git", "log", "-1", "--format=%B"],
            cwd=repo,
            capture_output=True,
            text=True,
        )
        body = result.stdout
        assert "Pipeline: feature" in body
        assert "Stage: implement (Implement)" in body
        assert "Task: add login" in body


# ---------------------------------------------------------------------------
# PipelineExecutor — auto-commit between stages
# ---------------------------------------------------------------------------


class TestPipelineExecutorAutoCommit:
    def test_auto_commit_called_after_each_stage(self, tmp_path: Path) -> None:
        """commit_stage_work is called for each stage by default."""
        stages = [
            {"id": "analyze", "name": "Analyze", "prompt": "Analyze."},
            {"id": "implement", "name": "Implement", "prompt": "Implement."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)
        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        committed_stages: list[str] = []
        original_commit = executor._worktree_manager.commit_stage_work

        def spy_commit(worktree_path: Any, **kwargs: Any) -> bool:
            committed_stages.append(kwargs["stage_id"])
            return False  # clean tree in test

        executor._worktree_manager.commit_stage_work = spy_commit  # type: ignore[assignment]

        result = _run(executor.run_task("t-ac-1", pl_name, "test auto commit"))
        assert result is True
        assert committed_stages == ["analyze", "implement"]

    def test_auto_commit_disabled_per_pipeline(self, tmp_path: Path) -> None:
        """Pipeline-level auto_commit: false skips commits for all stages."""
        stages = [
            {"id": "analyze", "name": "Analyze", "prompt": "Analyze."},
            {"id": "implement", "name": "Implement", "prompt": "Implement."},
        ]
        project_dir = tmp_path / "project"
        project_dir.mkdir(parents=True, exist_ok=True)
        pipeline_dir = project_dir / ".pegasus" / "pipelines"
        pipeline_dir.mkdir(parents=True, exist_ok=True)

        pipeline_data = {
            "name": "no-commit-pl",
            "description": "Test pipeline",
            "defaults": {"auto_commit": False},
            "stages": stages,
        }
        (pipeline_dir / "no-commit-pl.yaml").write_text(yaml.dump(pipeline_data))
        _init_git_repo(project_dir)

        config_dir = project_dir / ".pegasus"
        worktrees_base = tmp_path / "worktrees"
        (config_dir / "config.yaml").write_text(
            f"worktrees:\n  base_path: {worktrees_base}\n"
        )

        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        committed_stages: list[str] = []

        def spy_commit(worktree_path: Any, **kwargs: Any) -> bool:
            committed_stages.append(kwargs["stage_id"])
            return False

        executor._worktree_manager.commit_stage_work = spy_commit  # type: ignore[assignment]

        result = _run(executor.run_task("t-ac-2", "no-commit-pl", "test disabled"))
        assert result is True
        assert committed_stages == []

    def test_auto_commit_disabled_per_stage(self, tmp_path: Path) -> None:
        """Stage-level auto_commit: false skips commit for that stage only."""
        stages = [
            {"id": "analyze", "name": "Analyze", "prompt": "Analyze.", "auto_commit": False},
            {"id": "implement", "name": "Implement", "prompt": "Implement."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)
        runner = FakeAgentRunner()
        executor, db_path = _make_executor(tmp_path, project_dir, runner)

        committed_stages: list[str] = []

        def spy_commit(worktree_path: Any, **kwargs: Any) -> bool:
            committed_stages.append(kwargs["stage_id"])
            return False

        executor._worktree_manager.commit_stage_work = spy_commit  # type: ignore[assignment]

        result = _run(executor.run_task("t-ac-3", pl_name, "test per-stage"))
        assert result is True
        assert committed_stages == ["implement"]


# ---------------------------------------------------------------------------
# PipelineExecutor — AskUserQuestion detection
# ---------------------------------------------------------------------------


def _get_agent_questions(db_path: Path, task_id: str) -> list[sqlite3.Row]:
    """Return all agent_questions rows for *task_id*, ordered by id."""
    conn = make_connection(db_path, read_only=True)
    rows = conn.execute(
        "SELECT * FROM agent_questions WHERE task_id = ? ORDER BY id",
        (task_id,),
    ).fetchall()
    conn.close()
    return rows


class TestAskUserQuestionDetection:
    """Tests for detecting AskUserQuestion tool calls during stage execution."""

    def test_ask_user_question_inserts_agent_questions(self, tmp_path: Path) -> None:
        """When the agent uses AskUserQuestion, questions are inserted into
        the agent_questions table and the task pauses for answers."""
        stages = [
            {"id": "plan", "name": "Plan", "prompt": "Plan the work."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)

        runner = FakeAgentRunner(
            messages=[
                AgentMessage(content="Let me ask some questions.", cost=0.01),
                ToolUseMessage(
                    tool_name="AskUserQuestion",
                    tool_input={"question": "What framework do you use?"},
                ),
                AgentMessage(content="I asked the question.", cost=0.01),
                ResultMessage(
                    output="Questions asked.",
                    total_cost_usd=0.05,
                    session_id="fake-q-session",
                ),
            ]
        )

        approvals: list[tuple[str, str]] = []

        async def approve(task_id: str, stage_id: str) -> bool:
            approvals.append((task_id, stage_id))
            return True

        executor, db_path = _make_executor(
            tmp_path, project_dir, runner, on_approval_needed=approve,
        )
        task_id = "ask-q-1"
        result = _run(executor.run_task(task_id, pl_name, "test ask user"))

        assert result is True
        # The approval callback should have been triggered (agent questions auto-pause).
        assert len(approvals) == 1
        assert approvals[0][1] == "plan"

        # Verify the question was inserted into agent_questions.
        questions = _get_agent_questions(db_path, task_id)
        assert len(questions) == 1
        assert questions[0]["question"] == "What framework do you use?"
        assert questions[0]["stage_id"] == "plan"
        assert questions[0]["status"] == "pending"

    def test_multiple_ask_user_questions_all_inserted(self, tmp_path: Path) -> None:
        """Multiple AskUserQuestion calls in a stage produce multiple rows."""
        stages = [
            {"id": "plan", "name": "Plan", "prompt": "Plan."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)

        runner = FakeAgentRunner(
            messages=[
                ToolUseMessage(
                    tool_name="AskUserQuestion",
                    tool_input={"question": "Question 1?"},
                ),
                ToolUseMessage(
                    tool_name="AskUserQuestion",
                    tool_input={"question": "Question 2?"},
                ),
                ToolUseMessage(
                    tool_name="AskUserQuestion",
                    tool_input={"question": "Question 3?"},
                ),
                ResultMessage(
                    output="done",
                    total_cost_usd=0.05,
                    session_id="fake-multi-q",
                ),
            ]
        )

        async def approve(task_id: str, stage_id: str) -> bool:
            return True

        executor, db_path = _make_executor(
            tmp_path, project_dir, runner, on_approval_needed=approve,
        )
        task_id = "ask-q-multi"
        _run(executor.run_task(task_id, pl_name, "multi-question test"))

        questions = _get_agent_questions(db_path, task_id)
        assert len(questions) == 3
        assert questions[0]["question"] == "Question 1?"
        assert questions[1]["question"] == "Question 2?"
        assert questions[2]["question"] == "Question 3?"

    def test_no_ask_user_question_no_extra_pause(self, tmp_path: Path) -> None:
        """When no AskUserQuestion is used and no requires_approval, the
        stage does not pause."""
        stages = [
            {"id": "impl", "name": "Impl", "prompt": "Implement."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)
        runner = FakeAgentRunner()

        approvals: list[tuple[str, str]] = []

        async def approve(task_id: str, stage_id: str) -> bool:
            approvals.append((task_id, stage_id))
            return True

        executor, db_path = _make_executor(
            tmp_path, project_dir, runner, on_approval_needed=approve,
        )
        task_id = "no-q-1"
        result = _run(executor.run_task(task_id, pl_name, "no questions"))

        assert result is True
        assert len(approvals) == 0
        assert _get_agent_questions(db_path, task_id) == []

    def test_ask_user_question_answers_available_to_next_stage(
        self, tmp_path: Path,
    ) -> None:
        """After questions are answered and the pipeline resumes, answers
        are available in question_responses for subsequent stages."""
        stages = [
            {"id": "plan", "name": "Plan", "prompt": "Plan."},
            {"id": "implement", "name": "Implement", "prompt": "Implement using {{stages.plan.question_response}}"},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)

        runner = FakeAgentRunner(
            messages=[
                ToolUseMessage(
                    tool_name="AskUserQuestion",
                    tool_input={"question": "Which DB?"},
                ),
                ResultMessage(
                    output="done",
                    total_cost_usd=0.05,
                    session_id="fake-qa-session",
                ),
            ]
        )

        call_count = [0]

        async def approve_and_answer(task_id: str, stage_id: str) -> bool:
            call_count[0] += 1
            if call_count[0] == 1:
                # Simulate answering the question before approving.
                conn = make_connection(db_path)
                conn.execute(
                    "UPDATE agent_questions SET status = 'answered', "
                    "answer = 'PostgreSQL' WHERE task_id = ? AND status = 'pending'",
                    (task_id,),
                )
                conn.commit()
                conn.close()
            return True

        executor, db_path = _make_executor(
            tmp_path, project_dir, runner, on_approval_needed=approve_and_answer,
        )
        task_id = "ask-qa-1"
        result = _run(executor.run_task(task_id, pl_name, "test qa flow"))

        assert result is True
        # The second stage's prompt should have the answer resolved.
        # runner.run_calls[1] is the implement stage call.
        assert len(runner.run_calls) == 2
        assert "Q: Which DB?\nA: PostgreSQL" in runner.run_calls[1][0]

    def test_structured_questions_payload(self, tmp_path: Path) -> None:
        """The SDK sends ``{"questions": [{"question": "...", "header": "...",
        "options": [...]}]}`` — each question in the array should become a
        separate ``agent_questions`` row with readable text."""
        stages = [
            {"id": "plan", "name": "Plan", "prompt": "Plan."},
        ]
        project_dir, pl_name = _make_project_with_git(tmp_path, stages=stages)

        runner = FakeAgentRunner(
            messages=[
                ToolUseMessage(
                    tool_name="AskUserQuestion",
                    tool_input={
                        "questions": [
                            {
                                "question": "What reset scope?",
                                "header": "Reset scope",
                                "options": [
                                    {"label": "Full reset", "description": "Delete worktree"},
                                    {"label": "Soft reset", "description": "Keep worktree"},
                                ],
                            },
                            {
                                "question": "Which branch?",
                                "header": "Branch",
                            },
                        ],
                    },
                ),
                ResultMessage(
                    output="done",
                    total_cost_usd=0.05,
                    session_id="fake-structured",
                ),
            ]
        )

        async def approve(task_id: str, stage_id: str) -> bool:
            return True

        executor, db_path = _make_executor(
            tmp_path, project_dir, runner, on_approval_needed=approve,
        )
        task_id = "ask-structured"
        _run(executor.run_task(task_id, pl_name, "structured questions"))

        questions = _get_agent_questions(db_path, task_id)
        assert len(questions) == 2
        # First question should include header, text, and options.
        q1 = questions[0]["question"]
        assert "[Reset scope]" in q1
        assert "What reset scope?" in q1
        assert "Full reset: Delete worktree" in q1
        assert "Soft reset: Keep worktree" in q1
        # First question should have structured meta with options.
        import json
        meta1 = json.loads(questions[0]["question_meta"])
        assert meta1["type"] == "single_select"
        assert len(meta1["options"]) == 2
        assert meta1["options"][0]["label"] == "Full reset"

        # Second question: header + text, no options → no meta.
        q2 = questions[1]["question"]
        assert "[Branch]" in q2
        assert "Which branch?" in q2
        assert questions[1]["question_meta"] is None


# ---------------------------------------------------------------------------
# _extract_ask_user_questions unit tests
# ---------------------------------------------------------------------------


class TestExtractAskUserQuestions:
    """Unit tests for the question extraction helper."""

    def test_simple_form(self) -> None:
        from pegasus.runner import _extract_ask_user_questions

        result = _extract_ask_user_questions({"question": "What language?"})
        assert len(result) == 1
        assert result[0].text == "What language?"
        assert result[0].meta is None

    def test_structured_form_no_options(self) -> None:
        from pegasus.runner import _extract_ask_user_questions

        result = _extract_ask_user_questions({
            "questions": [
                {"question": "Q1?", "header": "H1"},
                {"question": "Q2?"},
            ],
        })
        assert len(result) == 2
        assert "[H1]" in result[0].text
        assert "Q1?" in result[0].text
        assert result[0].meta is None  # no options → no meta
        assert "Q2?" in result[1].text

    def test_structured_with_options_returns_meta(self) -> None:
        from pegasus.runner import _extract_ask_user_questions

        result = _extract_ask_user_questions({
            "questions": [
                {
                    "question": "Pick one?",
                    "options": [
                        {"label": "A", "description": "Option A"},
                        {"label": "B"},
                    ],
                },
            ],
        })
        assert len(result) == 1
        assert "Pick one?" in result[0].text
        assert "A: Option A" in result[0].text
        # Meta should carry structured options for the TUI.
        assert result[0].meta is not None
        assert result[0].meta["type"] == "single_select"
        assert len(result[0].meta["options"]) == 2
        assert result[0].meta["options"][0]["label"] == "A"

    def test_multi_select_flag(self) -> None:
        from pegasus.runner import _extract_ask_user_questions

        result = _extract_ask_user_questions({
            "questions": [
                {
                    "question": "Pick many?",
                    "multiple": True,
                    "options": [
                        {"label": "X"},
                        {"label": "Y"},
                    ],
                },
            ],
        })
        assert len(result) == 1
        assert result[0].meta is not None
        assert result[0].meta["type"] == "multi_select"

    def test_multi_select_type_field(self) -> None:
        from pegasus.runner import _extract_ask_user_questions

        result = _extract_ask_user_questions({
            "questions": [
                {
                    "question": "Pick many?",
                    "type": "multi_select",
                    "options": [{"label": "A"}, {"label": "B"}],
                },
            ],
        })
        assert result[0].meta is not None
        assert result[0].meta["type"] == "multi_select"

    def test_fallback_on_unknown_shape(self) -> None:
        from pegasus.runner import _extract_ask_user_questions

        result = _extract_ask_user_questions({"unexpected_key": 42})
        assert len(result) == 1
        assert "unexpected_key" in result[0].text
        assert result[0].meta is None
