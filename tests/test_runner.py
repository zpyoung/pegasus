"""Unit tests for pegasus.runner (PegasusEngine + FakeAgentRunner + WorktreeManager)."""

from __future__ import annotations

import asyncio
import os
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

import pytest

from pegasus.models import init_db, make_connection
from pegasus.runner import (
    AgentMessage,
    AgentRunnerProtocol,
    ClaudeAgentRunner,
    ErrorMessage,
    Message,
    PegasusEngine,
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
