"""Unit tests for pegasus.runner (PegasusEngine + FakeAgentRunner)."""

from __future__ import annotations

import asyncio
import sqlite3
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
