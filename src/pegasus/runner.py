"""Pegasus headless pipeline executor — Agent SDK abstraction layer.

This module defines:

- ``AgentRunnerProtocol``  — structural Protocol shielding runner from SDK internals
- Internal message dataclasses: ``AgentMessage``, ``ToolUseMessage``,
  ``ResultMessage``, ``ErrorMessage``
- ``ClaudeAgentRunner``  — concrete SDK wrapper (SDK import is optional; guarded
  by try/except so tests work without the package installed)
- ``PegasusEngine``       — high-level wrapper managing session_id, cost
  tracking, SQLite state transitions, and SDK callback mapping

**IMPORTANT**: this module NEVER imports from ``pegasus.ui``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from pegasus.models import init_db, make_connection, transition_task_state

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Internal message types
# These are Pegasus-internal message representations, NOT SDK types.
# ---------------------------------------------------------------------------


@dataclass
class AgentMessage:
    """A text message produced by the agent (AssistantMessage equivalent)."""

    content: str
    cost: float = 0.0


@dataclass
class ToolUseMessage:
    """Notification that the agent used a tool."""

    tool_name: str
    tool_input: dict[str, Any] = field(default_factory=dict)
    cost: float = 0.0


@dataclass
class ResultMessage:
    """The final result of a completed agent run."""

    output: str
    total_cost_usd: float = 0.0
    session_id: str | None = None


@dataclass
class ErrorMessage:
    """An error produced during agent execution."""

    error: str
    cost: float = 0.0


# Union type alias for any internal message.
Message = AgentMessage | ToolUseMessage | ResultMessage | ErrorMessage


# ---------------------------------------------------------------------------
# AgentRunnerProtocol
# ---------------------------------------------------------------------------


@runtime_checkable
class AgentRunnerProtocol(Protocol):
    """Structural Protocol that shields PegasusEngine from SDK internals.

    Any class that provides ``run_task`` and ``interrupt`` satisfies this
    protocol, enabling ``FakeAgentRunner`` as a drop-in test replacement.
    """

    async def run_task(
        self,
        prompt: str,
        cwd: str,
    ) -> AsyncIterator[Message]:
        """Execute a single stage prompt inside *cwd*.

        Yields:
            A sequence of ``AgentMessage``, ``ToolUseMessage``, ``ResultMessage``,
            or ``ErrorMessage`` instances.  The sequence always ends with either
            a ``ResultMessage`` or an ``ErrorMessage``.
        """
        ...  # pragma: no cover

    async def interrupt(self) -> None:
        """Request a graceful cancellation of the current run."""
        ...  # pragma: no cover


# ---------------------------------------------------------------------------
# ClaudeAgentRunner — concrete SDK wrapper
# ---------------------------------------------------------------------------

# The claude-agent-sdk may not be installed in every environment (e.g. CI).
# We guard the import and raise a helpful error only when the runner is used.
try:
    import claude_agent_sdk as _sdk  # type: ignore[import-untyped]

    _SDK_AVAILABLE = True
except ImportError:  # pragma: no cover
    _sdk = None  # type: ignore[assignment]
    _SDK_AVAILABLE = False


class ClaudeAgentRunner:
    """Concrete ``AgentRunnerProtocol`` implementation that wraps claude-agent-sdk.

    Key behaviours:
    - Unsets the ``CLAUDECODE`` environment variable before spawning the SDK
      session to prevent nested Claude Code conflicts.
    - Maps SDK events to Pegasus internal message types.
    - The SDK may not be installed in test environments; a ``RuntimeError`` is
      raised only when ``run_task`` is called without the SDK present.
    """

    def __init__(self) -> None:
        self._current_task: asyncio.Task[None] | None = None

    async def run_task(
        self,
        prompt: str,
        cwd: str,
    ) -> AsyncIterator[Message]:
        if not _SDK_AVAILABLE:  # pragma: no cover
            raise RuntimeError(
                "claude-agent-sdk is not installed. "
                "Run: pip install 'claude-agent-sdk>=0.1.48,<0.2.0'"
            )

        # Unset CLAUDECODE=1 to avoid nested Claude Code conflicts.
        env = {**os.environ, "CLAUDECODE": ""}

        # The SDK exposes an async query() interface.  Adapt it to our
        # internal message types.
        async def _generate() -> AsyncIterator[Message]:  # pragma: no cover
            try:
                async for sdk_message in _sdk.query(
                    prompt=prompt,
                    options=_sdk.ClaudeCodeOptions(
                        cwd=cwd,
                        env=env,
                    ),
                ):
                    msg_type = type(sdk_message).__name__
                    if msg_type == "AssistantMessage":
                        text = ""
                        for block in getattr(sdk_message, "content", []):
                            if hasattr(block, "text"):
                                text += block.text
                        cost = getattr(sdk_message, "total_cost_usd", 0.0) or 0.0
                        yield AgentMessage(content=text, cost=cost)
                    elif msg_type == "ToolUseBlock":
                        yield ToolUseMessage(
                            tool_name=getattr(sdk_message, "name", ""),
                            tool_input=getattr(sdk_message, "input", {}),
                        )
                    elif msg_type == "ResultMessage":
                        yield ResultMessage(
                            output=getattr(sdk_message, "result", ""),
                            total_cost_usd=getattr(
                                sdk_message, "total_cost_usd", 0.0
                            )
                            or 0.0,
                            session_id=getattr(sdk_message, "session_id", None),
                        )
                    else:
                        # Unknown SDK message type — skip silently.
                        pass
            except Exception as exc:
                yield ErrorMessage(error=str(exc))

        return _generate()

    async def interrupt(self) -> None:
        """Request cancellation of the current SDK task."""
        if self._current_task and not self._current_task.done():
            self._current_task.cancel()


# ---------------------------------------------------------------------------
# PegasusEngine
# ---------------------------------------------------------------------------


class PegasusEngine:
    """High-level orchestration wrapper around an ``AgentRunnerProtocol``.

    Responsibilities:
    - Accepts a protocol-compliant runner (``ClaudeAgentRunner`` or
      ``FakeAgentRunner`` in tests).
    - Manages ``session_id`` for the active task (persisted to SQLite via
      ``tasks.session_id``).
    - Accumulates per-stage cost and cumulative task cost.
    - Writes SQLite state transitions via ``transition_task_state``.
    - Dispatches SDK event callbacks: ``on_message``, ``on_tool_use``,
      ``on_result``, ``on_error``.

    Args:
        runner: An ``AgentRunnerProtocol``-compliant instance.
        db_path: Path to the Pegasus SQLite database.  ``init_db`` is called
            automatically when a connection is first opened.
    """

    def __init__(
        self,
        runner: AgentRunnerProtocol,
        db_path: str | os.PathLike[str],
        *,
        on_message: Callable[[AgentMessage], None] | None = None,
        on_tool_use: Callable[[ToolUseMessage], None] | None = None,
        on_result: Callable[[ResultMessage], None] | None = None,
        on_error: Callable[[ErrorMessage], None] | None = None,
    ) -> None:
        self.runner = runner
        self.db_path = str(db_path)
        self._on_message = on_message
        self._on_tool_use = on_tool_use
        self._on_result = on_result
        self._on_error = on_error

        # Cost tracking
        self._stage_cost: float = 0.0
        self._total_cost: float = 0.0

        # Session id (persisted to SQLite)
        self._session_id: str | None = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_conn(self) -> sqlite3.Connection:
        """Open a writable SQLite connection and ensure the schema exists."""
        conn = make_connection(self.db_path, read_only=False)
        init_db(conn)
        return conn

    def _save_session_id(self, conn: sqlite3.Connection, task_id: str) -> None:
        """Persist ``_session_id`` to ``tasks.session_id``."""
        conn.execute(
            "UPDATE tasks SET session_id = ?, updated_at = CURRENT_TIMESTAMP "
            "WHERE id = ?",
            (self._session_id, task_id),
        )
        conn.commit()

    def _save_cost(
        self,
        conn: sqlite3.Connection,
        task_id: str,
        stage_run_id: int | None = None,
    ) -> None:
        """Flush accumulated cost values to SQLite."""
        conn.execute(
            "UPDATE tasks SET total_cost = ?, updated_at = CURRENT_TIMESTAMP "
            "WHERE id = ?",
            (self._total_cost, task_id),
        )
        if stage_run_id is not None:
            conn.execute(
                "UPDATE stage_runs SET cost = ? WHERE id = ?",
                (self._stage_cost, stage_run_id),
            )
        conn.commit()

    def _create_stage_run(
        self,
        conn: sqlite3.Connection,
        task_id: str,
        stage_id: str,
        stage_index: int,
    ) -> int:
        """Insert a new ``stage_runs`` row and return its rowid."""
        cursor = conn.execute(
            "INSERT INTO stage_runs (task_id, stage_id, stage_index, status, started_at) "
            "VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP)",
            (task_id, stage_id, stage_index),
        )
        conn.commit()
        return cursor.lastrowid  # type: ignore[return-value]

    def _finish_stage_run(
        self,
        conn: sqlite3.Connection,
        stage_run_id: int,
        status: str,
        error: str | None = None,
    ) -> None:
        """Mark a stage_run as finished."""
        conn.execute(
            "UPDATE stage_runs SET status = ?, finished_at = CURRENT_TIMESTAMP, "
            "error = ? WHERE id = ?",
            (status, error, stage_run_id),
        )
        conn.commit()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def session_id(self) -> str | None:
        """The current SDK session id (None until a stage completes)."""
        return self._session_id

    @property
    def total_cost(self) -> float:
        """Cumulative cost across all stages run so far."""
        return self._total_cost

    @property
    def stage_cost(self) -> float:
        """Cost accumulated during the most-recently completed stage."""
        return self._stage_cost

    async def run_stage(
        self,
        task_id: str,
        stage_id: str,
        stage_index: int,
        prompt: str,
        cwd: str,
    ) -> bool:
        """Execute a single pipeline stage and update SQLite state.

        1. Inserts a ``stage_runs`` row with status ``'running'``.
        2. Transitions ``tasks`` status from ``'queued'`` to ``'running'``
           (no-op if already ``'running'``).
        3. Streams messages from the runner, dispatching callbacks.
        4. On ``ResultMessage``: marks stage successful, records cost +
           session_id.
        5. On ``ErrorMessage`` or unexpected exception: marks stage failed.

        Args:
            task_id:     Row ``id`` in the ``tasks`` table.
            stage_id:    Stage identifier from the pipeline YAML.
            stage_index: Zero-based position of the stage in the pipeline.
            prompt:      The fully-resolved stage prompt.
            cwd:         Working directory for the runner subprocess.

        Returns:
            ``True`` if the stage completed successfully, ``False`` on error.
        """
        conn = self._get_conn()
        self._stage_cost = 0.0

        # Ensure task is in 'running' state (may already be from a previous stage).
        transition_task_state(conn, task_id, "queued", "running")

        stage_run_id = self._create_stage_run(conn, task_id, stage_id, stage_index)

        success = False
        try:
            message_stream = await self.runner.run_task(prompt, cwd)
            async for message in message_stream:
                if isinstance(message, AgentMessage):
                    self._stage_cost += message.cost
                    self._total_cost += message.cost
                    logger.debug(
                        "task=%s stage=%s agent_message len=%d",
                        task_id,
                        stage_id,
                        len(message.content),
                    )
                    if self._on_message:
                        self._on_message(message)

                elif isinstance(message, ToolUseMessage):
                    self._stage_cost += message.cost
                    self._total_cost += message.cost
                    logger.debug(
                        "task=%s stage=%s tool_use tool=%s",
                        task_id,
                        stage_id,
                        message.tool_name,
                    )
                    if self._on_tool_use:
                        self._on_tool_use(message)

                elif isinstance(message, ResultMessage):
                    # Record final cost from the result (authoritative).
                    delta = message.total_cost_usd - self._stage_cost
                    if delta > 0:
                        self._stage_cost = message.total_cost_usd
                        self._total_cost += delta

                    if message.session_id:
                        self._session_id = message.session_id

                    self._finish_stage_run(conn, stage_run_id, "completed")
                    self._save_cost(conn, task_id, stage_run_id)
                    self._save_session_id(conn, task_id)

                    logger.info(
                        "task=%s stage=%s completed cost=%.6f",
                        task_id,
                        stage_id,
                        self._stage_cost,
                    )
                    if self._on_result:
                        self._on_result(message)
                    success = True

                elif isinstance(message, ErrorMessage):
                    self._stage_cost += message.cost
                    self._total_cost += message.cost
                    self._finish_stage_run(
                        conn, stage_run_id, "failed", error=message.error
                    )
                    self._save_cost(conn, task_id, stage_run_id)
                    transition_task_state(conn, task_id, "running", "failed")
                    logger.error(
                        "task=%s stage=%s error: %s", task_id, stage_id, message.error
                    )
                    if self._on_error:
                        self._on_error(message)
                    success = False

        except Exception as exc:
            error_msg = str(exc)
            self._finish_stage_run(conn, stage_run_id, "failed", error=error_msg)
            self._save_cost(conn, task_id, stage_run_id)
            transition_task_state(conn, task_id, "running", "failed")
            logger.exception(
                "task=%s stage=%s unexpected exception", task_id, stage_id
            )
            if self._on_error:
                self._on_error(ErrorMessage(error=error_msg))
            success = False
        finally:
            conn.close()

        return success

    async def interrupt(self) -> None:
        """Delegate an interrupt request to the underlying runner."""
        await self.runner.interrupt()
