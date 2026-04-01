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
import json
import logging
import os
import platform
import re
import shlex
import signal
import sqlite3
import subprocess
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from pegasus.models import (
    init_db,
    load_config,
    load_pipeline_config,
    make_connection,
    resolve_stage_flags,
    transition_task_state,
)

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
        claude_flags: dict[str, Any] | None = None,
        session_id: str | None = None,
    ) -> AsyncIterator[Message]:
        """Execute a single stage prompt inside *cwd*.

        Args:
            claude_flags: Resolved stage flags (permission_mode, model, max_turns, etc.)
                          passed through to the SDK's ClaudeAgentOptions.
            session_id: Optional session ID to resume a previous conversation.

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

    def __init__(self, on_stderr: Callable[[str], None] | None = None) -> None:
        self._current_task: asyncio.Task[None] | None = None
        self._on_stderr = on_stderr

    async def run_task(
        self,
        prompt: str,
        cwd: str,
        claude_flags: dict[str, Any] | None = None,
        session_id: str | None = None,
    ) -> AsyncIterator[Message]:
        if not _SDK_AVAILABLE:  # pragma: no cover
            raise RuntimeError(
                "claude-agent-sdk is not installed. "
                "Run: pip install 'claude-agent-sdk>=0.1.48,<0.2.0'"
            )

        # Unset CLAUDECODE=1 to avoid nested Claude Code conflicts.
        env = {**os.environ, "CLAUDECODE": ""}

        # Build SDK options from resolved claude_flags
        flags = claude_flags or {}
        # Prefer system claude over bundled — the bundled binary may be
        # an older version that doesn't respond to the initialize handshake.
        import shutil
        system_claude = shutil.which("claude")
        sdk_opts: dict[str, Any] = {"cwd": cwd, "env": env}
        if system_claude:
            sdk_opts["cli_path"] = system_claude
        if self._on_stderr:
            sdk_opts["stderr"] = self._on_stderr
        # Resume a previous session if provided (enables multi-stage continuity).
        if session_id:
            sdk_opts["resume"] = session_id
        # Map pegasus flag names to SDK ClaudeAgentOptions field names
        _flag_map = {
            "model": "model",
            "permission_mode": "permission_mode",
            "max_turns": "max_turns",
            "allowed_tools": "allowed_tools",
            "disallowed_tools": "disallowed_tools",
            "add_dir": "add_dirs",
            "append_system_prompt": "system_prompt",
            "output_format": "output_format",
        }
        for pegasus_key, sdk_key in _flag_map.items():
            if pegasus_key in flags and flags[pegasus_key] is not None:
                sdk_opts[sdk_key] = flags[pegasus_key]

        # The SDK exposes an async query() interface.  Adapt it to our
        # internal message types.
        async def _generate() -> AsyncIterator[Message]:  # pragma: no cover
            try:
                async for sdk_message in _sdk.query(
                    prompt=prompt,
                    options=_sdk.ClaudeAgentOptions(**sdk_opts),
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
        claude_flags: dict[str, Any] | None = None,
        session_id: str | None = None,
    ) -> bool:
        """Execute a single pipeline stage and update SQLite state.

        Args:
            task_id:      Row ``id`` in the ``tasks`` table.
            stage_id:     Stage identifier from the pipeline YAML.
            stage_index:  Zero-based position of the stage in the pipeline.
            prompt:       The fully-resolved stage prompt.
            cwd:          Working directory for the runner subprocess.
            claude_flags: Resolved stage flags passed through to the agent runner.
            session_id:   Optional session ID to resume (for session-mode continuity).

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
            message_stream = await self.runner.run_task(
                prompt, cwd, claude_flags=claude_flags, session_id=session_id,
            )
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
                    if success:
                        # A ResultMessage already marked this stage completed.
                        # The trailing error (e.g. exit code 1 from plan mode)
                        # should not override a successful result.
                        logger.warning(
                            "task=%s stage=%s post-result error (ignored): %s",
                            task_id,
                            stage_id,
                            message.error,
                        )
                        if self._on_error:
                            self._on_error(message)
                    else:
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


# ---------------------------------------------------------------------------
# WorktreeManager
# ---------------------------------------------------------------------------


class WorktreeError(Exception):
    """Raised when a git worktree operation fails."""


class WorktreeManager:
    """Manages git worktree lifecycle for Pegasus tasks.

    Each task runs in an isolated git worktree branched from the project's
    default branch.  This class handles:

    - Detecting the repository's default branch (``detect_default_branch``).
    - Creating a worktree with an optional setup command
      (``create_worktree``).
    - Health-checking an existing worktree (``health_check``).
    - Cleaning up a worktree and its branch (``cleanup_worktree``).
    - Detecting and marking orphaned worktrees on startup
      (``detect_orphans``).
    - Removing all orphaned worktrees (``cleanup_orphans``).
    """

    #: Seconds after which a running task with no heartbeat is considered stale.
    HEARTBEAT_TIMEOUT: int = 30

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _run_git(
        args: list[str],
        cwd: str | os.PathLike[str] | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        """Run a git sub-command and return the completed process.

        Args:
            args:  Argument list, e.g. ``["worktree", "list"]``.
            cwd:   Working directory for the git command.
            check: If ``True`` (default), raise ``WorktreeError`` on non-zero
                   exit code instead of ``subprocess.CalledProcessError``.

        Raises:
            WorktreeError: When *check* is True and git exits non-zero.
        """
        cmd = ["git", *args]
        try:
            result = subprocess.run(
                cmd,
                cwd=cwd,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError as exc:
            raise WorktreeError("git executable not found") from exc

        if check and result.returncode != 0:
            raise WorktreeError(
                f"git {' '.join(args)} failed (exit {result.returncode}): "
                f"{result.stderr.strip()}"
            )
        return result

    @staticmethod
    def _slug(text: str) -> str:
        """Convert *text* to a branch-safe slug (lowercase, hyphens only)."""
        text = text.lower()
        text = re.sub(r"[^a-z0-9]+", "-", text)
        text = text.strip("-")
        return text[:40] or "task"

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect_default_branch(self, repo_dir: str | os.PathLike[str]) -> str:
        """Return the default branch name for *repo_dir*.

        Strategy:
        1. Try ``git symbolic-ref refs/remotes/origin/HEAD`` (fast, works with
           a remote).
        2. Fall back to the current HEAD branch name.
        3. Fall back to ``"main"`` if the repo has no commits.

        Args:
            repo_dir: Path to the git repository root.

        Returns:
            Branch name string, e.g. ``"main"`` or ``"master"``.
        """
        # Try remote HEAD first (most reliable).
        result = self._run_git(
            ["symbolic-ref", "refs/remotes/origin/HEAD"],
            cwd=repo_dir,
            check=False,
        )
        if result.returncode == 0:
            ref = result.stdout.strip()
            # ref looks like "refs/remotes/origin/main" — extract last component.
            return ref.split("/")[-1]

        # Fall back to current HEAD branch.
        result = self._run_git(
            ["symbolic-ref", "--short", "HEAD"],
            cwd=repo_dir,
            check=False,
        )
        if result.returncode == 0:
            branch = result.stdout.strip()
            if branch:
                return branch

        # Last resort: assume "main".
        return "main"

    def create_worktree(
        self,
        repo_dir: str | os.PathLike[str],
        task_id: str,
        description: str,
        base_path: str | os.PathLike[str],
        setup_command: str | None = None,
    ) -> Path:
        """Create a new git worktree for *task_id*.

        Steps:
        1. Detect the default branch.
        2. Derive a branch name ``pegasus/<task-id>-<slug>``.
        3. Create the worktree directory under *base_path*.
        4. Run ``git worktree add <path> -b <branch> <default-branch>``.
        5. Optionally run *setup_command* inside the new worktree.

        Args:
            repo_dir:      Path to the git repository root.
            task_id:       Unique task identifier (used in branch name).
            description:   Human-readable task description (slugified for branch name).
            base_path:     Parent directory under which the worktree is created.
            setup_command: Shell command to run inside the worktree after creation
                           (e.g. ``"pip install -e ."``).

        Returns:
            Absolute ``Path`` to the newly created worktree directory.

        Raises:
            WorktreeError: If ``git worktree add`` fails or *setup_command* exits
                           non-zero.
        """
        repo_dir = Path(repo_dir)
        base_path = Path(base_path)
        base_path.mkdir(parents=True, exist_ok=True)

        default_branch = self.detect_default_branch(repo_dir)
        slug = self._slug(description)
        branch_name = f"pegasus/{task_id}-{slug}"
        worktree_path = base_path / f"{task_id}-{slug}"

        self._run_git(
            ["worktree", "add", str(worktree_path), "-b", branch_name, default_branch],
            cwd=repo_dir,
        )

        if setup_command:
            try:
                result = subprocess.run(
                    shlex.split(setup_command),
                    cwd=worktree_path,
                    capture_output=True,
                    text=True,
                )
            except FileNotFoundError as exc:
                raise WorktreeError(
                    f"setup_command executable not found: {setup_command}"
                ) from exc
            if result.returncode != 0:
                raise WorktreeError(
                    f"setup_command failed (exit {result.returncode}): "
                    f"{result.stderr.strip()}"
                )

        logger.info(
            "worktree created: path=%s branch=%s",
            worktree_path,
            branch_name,
        )
        return worktree_path.resolve()

    def health_check(self, worktree_path: str | os.PathLike[str]) -> dict[str, Any]:
        """Check the health of a worktree.

        Checks:
        - Directory exists.
        - ``git status --porcelain`` returns nothing (clean working tree).
        - No stale ``.git/index.lock`` file.

        Args:
            worktree_path: Path to the worktree directory.

        Returns:
            Dict with keys:
            - ``"healthy"`` (bool): True if all checks pass.
            - ``"exists"`` (bool): Whether the directory exists.
            - ``"clean"`` (bool): Whether the working tree is clean.
            - ``"no_lock"`` (bool): Whether there is no stale lock file.
            - ``"error"`` (str | None): Error message if unhealthy.
        """
        worktree_path = Path(worktree_path)
        result: dict[str, Any] = {
            "healthy": False,
            "exists": False,
            "clean": False,
            "no_lock": False,
            "error": None,
        }

        if not worktree_path.is_dir():
            result["error"] = f"worktree directory does not exist: {worktree_path}"
            return result
        result["exists"] = True

        # Check for stale index lock.
        lock_file = worktree_path / ".git" / "index.lock"
        if lock_file.exists():
            result["error"] = f"stale lock file found: {lock_file}"
            result["no_lock"] = False
            return result
        result["no_lock"] = True

        # Check working tree is clean.
        status_result = self._run_git(
            ["status", "--porcelain"],
            cwd=worktree_path,
            check=False,
        )
        if status_result.returncode != 0:
            result["error"] = (
                f"git status failed: {status_result.stderr.strip()}"
            )
            return result

        if status_result.stdout.strip():
            result["error"] = "working tree is dirty"
            result["clean"] = False
        else:
            result["clean"] = True

        result["healthy"] = result["exists"] and result["clean"] and result["no_lock"]
        return result

    def cleanup_worktree(
        self,
        worktree_path: str | os.PathLike[str],
        repo_dir: str | os.PathLike[str] | None = None,
        branch: str | None = None,
    ) -> None:
        """Remove a worktree and optionally delete its branch.

        Steps:
        1. ``git worktree remove --force <path>``.
        2. ``git worktree prune`` to update the worktree list.
        3. If *branch* is provided, ``git branch -d <branch>`` (force-deletes
           with ``-D`` if ``-d`` fails).

        Args:
            worktree_path: Path to the worktree to remove.
            repo_dir:      Repository root for running prune/branch commands.
                           If ``None``, uses the worktree's own ``.git`` parent;
                           falls back to the worktree path itself.
            branch:        Branch name to delete after removing the worktree.

        Raises:
            WorktreeError: If ``git worktree remove`` fails.
        """
        worktree_path = Path(worktree_path)

        # Determine a valid git directory to run prune from.
        if repo_dir is not None:
            git_dir = Path(repo_dir)
        else:
            # Try to find the main repo from the worktree's .git file.
            git_file = worktree_path / ".git"
            if git_file.is_file():
                # .git is a file in worktrees: "gitdir: /path/to/main/.git/worktrees/..."
                try:
                    content = git_file.read_text()
                    match = re.search(r"gitdir:\s*(.+)", content)
                    if match:
                        gitdir_path = Path(match.group(1).strip())
                        # Navigate up: .git/worktrees/<name> -> .git -> repo root
                        git_dir = gitdir_path.parent.parent.parent
                    else:
                        git_dir = worktree_path
                except OSError:
                    git_dir = worktree_path
            else:
                git_dir = worktree_path

        # Remove the worktree (force in case of dirty state).
        self._run_git(
            ["worktree", "remove", "--force", str(worktree_path)],
            cwd=git_dir,
        )

        # Prune stale worktree refs.
        self._run_git(["worktree", "prune"], cwd=git_dir, check=False)

        # Optionally delete the branch.
        if branch:
            result = self._run_git(
                ["branch", "-d", branch],
                cwd=git_dir,
                check=False,
            )
            if result.returncode != 0:
                # Force-delete if regular delete fails (unmerged branch).
                self._run_git(
                    ["branch", "-D", branch],
                    cwd=git_dir,
                    check=False,
                )

        logger.info("worktree removed: path=%s branch=%s", worktree_path, branch)

    def detect_orphans(
        self,
        conn: sqlite3.Connection,
        base_path: str | os.PathLike[str],
    ) -> list[str]:
        """Find tasks in 'running' state whose runner process is dead.

        A task is considered orphaned when:
        - Its ``status`` is ``'running'``.
        - Its ``heartbeat_at`` is more than ``HEARTBEAT_TIMEOUT`` seconds ago,
          OR its ``runner_pid`` refers to a process that is no longer alive.

        Orphaned tasks are updated in SQLite:
        - ``tasks.status`` -> ``'failed'``
        - ``worktrees.status`` -> ``'orphaned'`` (if a worktree row exists)

        Args:
            conn:      Open SQLite connection (writable).
            base_path: Base path for worktrees (unused currently, reserved for
                       future filesystem-level orphan scans).

        Returns:
            List of orphaned task IDs that were marked.
        """
        rows = conn.execute(
            """
            SELECT id, runner_pid, heartbeat_at
            FROM tasks
            WHERE status = 'running'
            """,
        ).fetchall()

        orphaned_ids: list[str] = []
        for row in rows:
            task_id: str = row["id"]
            pid: int | None = row["runner_pid"]
            heartbeat_at: str | None = row["heartbeat_at"]

            is_orphan = False

            # Check heartbeat staleness.
            if heartbeat_at is not None:
                stale_result = conn.execute(
                    """
                    SELECT (CAST(strftime('%s', 'now') AS INTEGER)
                            - CAST(strftime('%s', ?) AS INTEGER)) > ?
                    """,
                    (heartbeat_at, self.HEARTBEAT_TIMEOUT),
                ).fetchone()
                if stale_result and stale_result[0]:
                    is_orphan = True
            else:
                # No heartbeat recorded — treat as orphan immediately.
                is_orphan = True

            # Additionally check PID liveness (if heartbeat alone isn't conclusive).
            if not is_orphan and pid is not None:
                is_orphan = not _pid_alive(pid)

            if is_orphan:
                conn.execute(
                    "UPDATE tasks SET status = 'failed', "
                    "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (task_id,),
                )
                conn.execute(
                    "UPDATE worktrees SET status = 'orphaned' WHERE task_id = ?",
                    (task_id,),
                )
                orphaned_ids.append(task_id)
                logger.warning(
                    "orphan detected: task=%s pid=%s heartbeat=%s",
                    task_id,
                    pid,
                    heartbeat_at,
                )

        if orphaned_ids:
            conn.commit()

        return orphaned_ids

    def cleanup_orphans(
        self,
        conn: sqlite3.Connection,
        base_path: str | os.PathLike[str],
        repo_dir: str | os.PathLike[str] | None = None,
    ) -> list[str]:
        """Remove all worktrees with status 'orphaned'.

        Queries the ``worktrees`` table for rows with ``status = 'orphaned'``
        and calls ``cleanup_worktree`` on each.  Any filesystem errors are
        logged but do not abort subsequent cleanups.

        Args:
            conn:      Open SQLite connection (writable).
            base_path: Base path (unused; reserved for future use).
            repo_dir:  Repository root for running git commands.  If ``None``,
                       the cleanup attempts to infer it from the ``.git`` file
                       inside each orphaned worktree.

        Returns:
            List of worktree paths that were successfully removed.
        """
        rows = conn.execute(
            "SELECT task_id, path, branch FROM worktrees WHERE status = 'orphaned'"
        ).fetchall()

        removed: list[str] = []
        for row in rows:
            path: str = row["path"]
            branch: str = row["branch"]
            task_id: str = row["task_id"]
            try:
                self.cleanup_worktree(path, repo_dir=repo_dir, branch=branch)
                conn.execute(
                    "DELETE FROM worktrees WHERE task_id = ?", (task_id,)
                )
                removed.append(path)
            except WorktreeError as exc:
                logger.warning(
                    "cleanup_orphans: failed to remove worktree %s: %s", path, exc
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "cleanup_orphans: unexpected error for worktree %s: %s", path, exc
                )

        if removed:
            conn.commit()

        return removed


# ---------------------------------------------------------------------------
# Process liveness helper
# ---------------------------------------------------------------------------


def _pid_alive(pid: int) -> bool:
    """Return True if a process with *pid* is currently running.

    Uses ``os.kill(pid, 0)`` which does not send a signal but checks
    whether the process exists.  Works on macOS and Linux.
    """
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but we don't have permission to signal it.
        return True


# ---------------------------------------------------------------------------
# RateLimitError — sentinel for exponential backoff
# ---------------------------------------------------------------------------


class RateLimitError(Exception):
    """Raised (or detected) when the Agent SDK reports an API rate limit."""


# ---------------------------------------------------------------------------
# PipelineExecutor
# ---------------------------------------------------------------------------


class PipelineExecutor:
    """Orchestrates full pipeline execution: worktree creation, stage iteration,
    heartbeat maintenance, rate-limit retry, and graceful shutdown.

    This class is the top-level coordinator that:

    - Creates a git worktree for the task via ``WorktreeManager``.
    - Loads and validates the pipeline YAML.
    - Resolves layered configuration (stage > pipeline > project > user > built-in).
    - Iterates stages sequentially, calling ``PegasusEngine.run_stage`` for each.
    - Handles ``requires_approval`` gates (writes ``paused`` to SQLite and waits).
    - Maintains a heartbeat (``tasks.heartbeat_at``) every *heartbeat_interval*
      seconds while the pipeline is running.
    - Retries stages on rate-limit errors with exponential backoff.
    - Handles ``SIGTERM`` / ``SIGINT`` gracefully: marks task as ``paused`` and
      interrupts the engine.
    - Fires OS-native desktop notifications on stage/pipeline events.

    Args:
        db_path:            Path to the Pegasus SQLite database.
        agent_runner:       An ``AgentRunnerProtocol``-compliant runner.
        project_dir:        Root directory of the project (used for config + pipeline
                            YAML lookup and worktree base-path resolution).
        heartbeat_interval: Seconds between heartbeat writes (default 5; use 0.1
                            in tests).
        on_approval_needed: Optional async callback invoked when a stage requires
                            approval before it can proceed.  Receives
                            ``(task_id, stage_id)`` and must return ``True`` to
                            approve or ``False`` to abort the pipeline.
    """

    #: Default base-2 exponent cap for backoff: 2^5 = 32s
    _MAX_BACKOFF_EXP: int = 5

    def __init__(
        self,
        db_path: str | os.PathLike[str],
        agent_runner: AgentRunnerProtocol,
        project_dir: str | os.PathLike[str],
        *,
        heartbeat_interval: float = 5.0,
        on_approval_needed: Callable[[str, str], Any] | None = None,
    ) -> None:
        self.db_path = str(db_path)
        self.agent_runner = agent_runner
        self.project_dir = Path(project_dir)
        self.heartbeat_interval = heartbeat_interval
        self._on_approval_needed = on_approval_needed

        self._worktree_manager = WorktreeManager()
        self._shutdown_requested: bool = False
        self._current_engine: PegasusEngine | None = None
        self._log_file: Any | None = None

    def _open_log(self, task_id: str) -> Path:
        """Open an append-only log file at ``.pegasus/logs/<task-id>.log``."""
        log_dir = self.project_dir / ".pegasus" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / f"{task_id}.log"
        self._log_file = open(log_path, "a", encoding="utf-8")  # noqa: SIM115
        return log_path

    def _log(self, line: str) -> None:
        """Write a timestamped line to the task log file."""
        if self._log_file:
            from datetime import datetime
            ts = datetime.now().strftime("%H:%M:%S")
            self._log_file.write(f"[{ts}] {line}\n")
            self._log_file.flush()

    def _close_log(self) -> None:
        """Close the log file handle."""
        if self._log_file:
            self._log_file.close()
            self._log_file = None

    # ------------------------------------------------------------------
    # Template resolution
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_prompt(
        prompt: str,
        *,
        project_config: Any,
        description: str,
        stage_outputs: dict[str, str] | None = None,
    ) -> str:
        """Resolve ``{{…}}`` template variables in a stage prompt.

        Supported namespaces:
        - ``{{project.language}}``  — project language from config
        - ``{{project.test_command}}`` / ``{{project.lint_command}}`` etc.
        - ``{{task.description}}``  — the task's human description
        - ``{{stages.<id>.output}}`` — output of a previously completed stage
        """
        outputs = stage_outputs or {}

        def _replace(match: re.Match[str]) -> str:
            expr = match.group(1).strip()
            parts = expr.split(".", 1)
            if len(parts) != 2:
                return match.group(0)  # leave unrecognised as-is
            namespace, key = parts

            if namespace == "project":
                proj = project_config.project
                val = getattr(proj, key, None)
                return str(val) if val is not None else match.group(0)
            elif namespace == "task":
                if key == "description":
                    return description
                return match.group(0)
            elif namespace == "stages":
                # e.g. {{stages.plan.output}}
                sub_parts = key.split(".", 1)
                if len(sub_parts) == 2:
                    stage_id, attr = sub_parts
                    if attr == "output" and stage_id in outputs:
                        return outputs[stage_id]
                return match.group(0)
            return match.group(0)

        return re.sub(r"\{\{(.+?)\}\}", _replace, prompt)

    # ------------------------------------------------------------------
    # Approval gate polling
    # ------------------------------------------------------------------

    async def _poll_for_approval(
        self,
        task_id: str,
        poll_interval: float = 2.0,
    ) -> bool:
        """Poll SQLite until the task status changes from ``'paused'``.

        The TUI sets status to ``'queued'`` (approve) or ``'failed'`` (reject).

        Returns:
            ``True`` if approved (status changed to ``'queued'``),
            ``False`` if rejected (status changed to ``'failed'``).
        """
        while not self._shutdown_requested:
            await asyncio.sleep(poll_interval)
            conn = make_connection(self.db_path, read_only=True)
            try:
                row = conn.execute(
                    "SELECT status FROM tasks WHERE id = ?", (task_id,)
                ).fetchone()
            finally:
                conn.close()
            if row is None:
                return False
            status = row["status"]
            if status == "queued":
                return True
            if status == "failed":
                return False
            # Still paused — keep polling.
        return False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _get_conn(self) -> sqlite3.Connection:
        conn = make_connection(self.db_path, read_only=False)
        init_db(conn)
        return conn

    def _create_task_record(
        self,
        conn: sqlite3.Connection,
        task_id: str,
        pipeline_name: str,
        description: str,
        worktree_path: str,
        branch: str,
    ) -> None:
        """Insert or update a task row in 'queued' state.

        Uses INSERT OR REPLACE so the runner can pick up tasks already
        inserted by the CLI's ``run`` command (which pre-creates the row).
        """
        conn.execute(
            """
            INSERT OR REPLACE INTO tasks
                (id, pipeline, description, status, worktree_path, branch,
                 runner_pid, heartbeat_at)
            VALUES
                (?, ?, ?, 'queued', ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (task_id, pipeline_name, description, worktree_path, branch, os.getpid()),
        )
        conn.commit()

    def _update_heartbeat(self, conn: sqlite3.Connection, task_id: str) -> None:
        """Touch ``heartbeat_at`` for *task_id*."""
        conn.execute(
            "UPDATE tasks SET heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?",
            (task_id,),
        )
        conn.commit()

    def _mark_task_status(
        self,
        conn: sqlite3.Connection,
        task_id: str,
        status: str,
        error: str | None = None,
    ) -> None:
        """Directly set task status (without TOCTOU guard — for terminal states)."""
        if error is not None:
            conn.execute(
                "UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP, "
                "context = ? WHERE id = ?",
                (status, error, task_id),
            )
        else:
            conn.execute(
                "UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP "
                "WHERE id = ?",
                (status, task_id),
            )
        conn.commit()

    # ------------------------------------------------------------------
    # Heartbeat loop
    # ------------------------------------------------------------------

    async def _heartbeat_loop(
        self, conn: sqlite3.Connection, task_id: str
    ) -> None:
        """Async loop: update ``heartbeat_at`` every *heartbeat_interval* seconds.

        Runs until cancelled (e.g. when the pipeline finishes or fails).
        """
        try:
            while True:
                await asyncio.sleep(self.heartbeat_interval)
                try:
                    self._update_heartbeat(conn, task_id)
                    logger.debug("heartbeat updated for task=%s", task_id)
                except Exception:  # noqa: BLE001
                    logger.warning(
                        "heartbeat update failed for task=%s", task_id, exc_info=True
                    )
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------
    # Desktop notifications
    # ------------------------------------------------------------------

    def _send_notification(self, title: str, message: str) -> None:
        """Fire an OS-native desktop notification.

        - **macOS**: uses ``osascript`` (bundled in macOS 10.10+).
        - **Linux**: uses ``notify-send`` (libnotify-bin package).
        - Other platforms: silently skipped.

        Errors from the notification command are logged at WARNING level but
        never raise — notifications are best-effort.

        Args:
            title:   Notification title / app name.
            message: Body text of the notification.
        """
        try:
            system = platform.system()
            if system == "Darwin":
                script = (
                    f'display notification "{message}" with title "{title}"'
                )
                subprocess.run(
                    ["osascript", "-e", script],
                    capture_output=True,
                    timeout=5,
                )
            elif system == "Linux":
                subprocess.run(
                    ["notify-send", title, message],
                    capture_output=True,
                    timeout=5,
                )
            # Windows and other platforms: silently skip
        except Exception:  # noqa: BLE001
            logger.warning(
                "desktop notification failed: title=%r message=%r",
                title,
                message,
                exc_info=True,
            )

    # ------------------------------------------------------------------
    # Signal handling
    # ------------------------------------------------------------------

    def _install_signal_handlers(self, task_id: str) -> None:
        """Register SIGTERM / SIGINT handlers for graceful shutdown."""

        def _handle_signal(signum: int, frame: Any) -> None:
            logger.warning(
                "signal %s received — requesting graceful shutdown for task=%s",
                signal.Signals(signum).name,
                task_id,
            )
            self._shutdown_requested = True
            # Interrupt the engine if it is currently running a stage.
            if self._current_engine is not None:
                try:
                    loop = asyncio.get_event_loop()
                    loop.create_task(self._current_engine.interrupt())
                except Exception:  # noqa: BLE001
                    pass

        signal.signal(signal.SIGTERM, _handle_signal)
        signal.signal(signal.SIGINT, _handle_signal)

    # ------------------------------------------------------------------
    # Rate-limit detection
    # ------------------------------------------------------------------

    @staticmethod
    def _is_rate_limit_error(error_msg: str) -> bool:
        """Return True if *error_msg* looks like an API rate limit response."""
        lower = error_msg.lower()
        return any(
            phrase in lower
            for phrase in (
                "rate limit",
                "ratelimit",
                "too many requests",
                "429",
                "overloaded",
            )
        )

    # ------------------------------------------------------------------
    # Core execution
    # ------------------------------------------------------------------

    async def run_task(
        self,
        task_id: str,
        pipeline_name: str,
        description: str,
    ) -> bool:
        """Execute a full pipeline task from worktree creation to completion.

        Full lifecycle:

        1. Load pipeline YAML and project config.
        2. Create a git worktree via ``WorktreeManager``.
        3. Insert a ``tasks`` row in ``'queued'`` state.
        4. Start the heartbeat loop.
        5. For each stage:
           a. Resolve flags (layered config + permission ceiling).
           b. If ``requires_approval``, pause and wait for approval.
           c. Call ``PegasusEngine.run_stage`` with exponential-backoff retry
              on rate-limit errors.
           d. If the stage fails for a non-rate-limit reason, mark task
              ``'failed'`` and return ``False``.
        6. On completion: mark task ``'completed'``, fire desktop notification.
        7. On any unhandled exception: mark task ``'failed'``.

        Args:
            task_id:       Unique task identifier (e.g. UUID string).
            pipeline_name: Name of the pipeline YAML file (without ``.yaml``
                           extension) under ``.pegasus/pipelines/``.
            description:   Human-readable description of the task (used for
                           branch naming and SQLite).

        Returns:
            ``True`` if all stages completed successfully, ``False`` otherwise.
        """
        # ------------------------------------------------------------------
        # 1. Load pipeline + config
        # ------------------------------------------------------------------
        pipeline_yaml_path = (
            self.project_dir / ".pegasus" / "pipelines" / f"{pipeline_name}.yaml"
        )
        pipeline = load_pipeline_config(pipeline_yaml_path)
        project_config = load_config(self.project_dir)

        setup_command: str | None = project_config.project.setup_command
        base_path = Path(project_config.worktrees.base_path).expanduser()
        retry_max: int = project_config.concurrency.retry_max
        retry_base_delay: float = project_config.concurrency.retry_base_delay

        # ------------------------------------------------------------------
        # 2. Create worktree
        # ------------------------------------------------------------------
        worktree_path = self._worktree_manager.create_worktree(
            repo_dir=self.project_dir,
            task_id=task_id,
            description=description,
            base_path=base_path,
            setup_command=setup_command,
        )
        branch_name = f"pegasus/{task_id}-{self._worktree_manager._slug(description)}"

        # ------------------------------------------------------------------
        # 3. Insert task record
        # ------------------------------------------------------------------
        conn = self._get_conn()
        try:
            self._create_task_record(
                conn,
                task_id=task_id,
                pipeline_name=pipeline_name,
                description=description,
                worktree_path=str(worktree_path),
                branch=branch_name,
            )

            # Record worktree in worktrees table
            conn.execute(
                """
                INSERT OR IGNORE INTO worktrees (task_id, path, branch, status)
                VALUES (?, ?, ?, 'active')
                """,
                (task_id, str(worktree_path), branch_name),
            )
            conn.commit()
        except Exception:
            conn.close()
            raise

        # ------------------------------------------------------------------
        # 4. Signal handling + heartbeat
        # ------------------------------------------------------------------
        self._install_signal_handlers(task_id)

        heartbeat_task = asyncio.ensure_future(
            self._heartbeat_loop(conn, task_id)
        )

        # ------------------------------------------------------------------
        # 5. Open log + iterate stages
        # ------------------------------------------------------------------
        log_path = self._open_log(task_id)
        self._log(f"Pipeline: {pipeline_name} | Task: {task_id}")
        self._log(f"Description: {description}")
        self._log(f"Worktree: {worktree_path}")
        self._log(f"Log: {log_path}")
        self._log("---")

        def _on_message(msg: AgentMessage) -> None:
            if not msg.content.strip():
                return
            # Truncate very long messages to keep logs readable
            content = msg.content[:2000] + ("..." if len(msg.content) > 2000 else "")
            self._log(f"[agent] {content}")

        def _on_tool_use(msg: ToolUseMessage) -> None:
            self._log(f"[tool] {msg.tool_name}({json.dumps(msg.tool_input)[:200]})")

        # Track stage outputs for {{stages.X.output}} template resolution
        stage_outputs: dict[str, str] = {}
        _last_result_output: list[str] = [""]  # mutable container for closure

        def _on_result(msg: ResultMessage) -> None:
            self._log(f"[result] cost=${msg.total_cost_usd:.4f} session={msg.session_id}")
            _last_result_output[0] = msg.output or ""

        def _on_error(msg: ErrorMessage) -> None:
            self._log(f"[ERROR] {msg.error}")

        engine = PegasusEngine(
            self.agent_runner,
            self.db_path,
            on_message=_on_message,
            on_tool_use=_on_tool_use,
            on_result=_on_result,
            on_error=_on_error,
        )
        self._current_engine = engine

        try:
            for stage_index, stage in enumerate(pipeline.stages):
                if self._shutdown_requested:
                    self._mark_task_status(conn, task_id, "paused")
                    self._send_notification(
                        "Pegasus",
                        f"Task paused: {description} (SIGTERM received)",
                    )
                    return False

                # --- Log stage start ---
                self._log(f"--- Stage {stage_index + 1}/{len(pipeline.stages)}: {stage.name} ({stage.id}) ---")

                # --- Resolve effective flags ---
                resolved_flags, requires_approval = resolve_stage_flags(
                    stage,
                    pipeline_defaults=pipeline.defaults,
                    project_config=project_config,
                )

                # --- Resolve template variables in the prompt ---
                resolved_prompt = self._resolve_prompt(
                    stage.prompt,
                    project_config=project_config,
                    description=description,
                    stage_outputs=stage_outputs,
                )

                # --- Rate-limit retry loop ---
                stage_success = False
                attempt = 0
                while attempt <= retry_max:
                    if self._shutdown_requested:
                        break

                    # Pass session_id for session-mode continuity (stages > 0).
                    resume_session = engine.session_id if (
                        pipeline.execution.mode == "session" and stage_index > 0
                    ) else None

                    stage_success = await engine.run_stage(
                        task_id=task_id,
                        stage_id=stage.id,
                        stage_index=stage_index,
                        prompt=resolved_prompt,
                        cwd=str(worktree_path),
                        claude_flags=resolved_flags.model_dump(exclude_none=True),
                        session_id=resume_session,
                    )

                    if stage_success:
                        # Capture output for {{stages.X.output}} in later stages.
                        stage_outputs[stage.id] = _last_result_output[0]
                        self._send_notification(
                            "Pegasus",
                            f"Stage '{stage.name}' complete for: {description}",
                        )
                        break

                    # Check whether the failure was a rate-limit.
                    # Inspect the most recent stage_run error.
                    stage_runs_conn = self._get_conn()
                    last_run = stage_runs_conn.execute(
                        """
                        SELECT error FROM stage_runs
                        WHERE task_id = ? AND stage_id = ?
                        ORDER BY id DESC LIMIT 1
                        """,
                        (task_id, stage.id),
                    ).fetchone()
                    stage_runs_conn.close()

                    error_text = (last_run["error"] or "") if last_run else ""
                    if self._is_rate_limit_error(error_text) and attempt < retry_max:
                        delay = retry_base_delay * (2**min(attempt, self._MAX_BACKOFF_EXP))
                        logger.warning(
                            "task=%s stage=%s rate-limit hit — retry %d/%d in %.1fs",
                            task_id,
                            stage.id,
                            attempt + 1,
                            retry_max,
                            delay,
                        )
                        await asyncio.sleep(delay)
                        attempt += 1
                        # Reset task status back to running for retry
                        transition_task_state(conn, task_id, "failed", "running")
                        continue

                    # Non-rate-limit failure (or retries exhausted).
                    if not stage_success:
                        self._send_notification(
                            "Pegasus — Pipeline Failed",
                            f"Stage '{stage.name}' failed for: {description}",
                        )
                        return False

                if self._shutdown_requested:
                    self._mark_task_status(conn, task_id, "paused")
                    self._send_notification(
                        "Pegasus",
                        f"Task paused: {description}",
                    )
                    return False

                if not stage_success:
                    return False

                # --- Post-stage approval gate ---
                # Pause after the stage completes so the user can review
                # the output before the next stage begins.
                if requires_approval:
                    self._mark_task_status(conn, task_id, "paused")
                    self._log(f"Stage '{stage.name}' completed — approval required before next stage.")
                    self._send_notification(
                        "Pegasus — Approval Required",
                        f"Stage '{stage.name}' done. Approve to continue: {description}",
                    )
                    if self._on_approval_needed is not None:
                        approved = await self._on_approval_needed(task_id, stage.id)
                    else:
                        approved = await self._poll_for_approval(task_id)
                    if not approved:
                        logger.info(
                            "task=%s stage=%s approval rejected — aborting",
                            task_id,
                            stage.id,
                        )
                        self._mark_task_status(conn, task_id, "failed")
                        return False
                    self._mark_task_status(conn, task_id, "running")
                    self._log(f"Stage '{stage.name}' approved — continuing to next stage.")

            # All stages completed successfully.
            self._mark_task_status(conn, task_id, "completed")
            self._send_notification(
                "Pegasus — Pipeline Complete",
                f"All stages finished for: {description}",
            )
            return True

        except Exception as exc:
            logger.exception("task=%s unhandled exception in run_task", task_id)
            try:
                self._mark_task_status(conn, task_id, "failed", error=str(exc))
            except Exception:  # noqa: BLE001
                pass
            self._send_notification(
                "Pegasus — Pipeline Failed",
                f"Unexpected error for: {description}",
            )
            return False

        finally:
            self._log("--- Pipeline finished ---")
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)
            conn.close()
            self._current_engine = None
            self._close_log()

    async def resume_task(self, task_id: str) -> bool:
        """Restart a failed task from the last failed stage.

        Looks up the task and its stage_runs in SQLite, finds the first
        stage that did not complete, re-loads the pipeline, and resumes
        execution from that stage onwards.

        Args:
            task_id: The ``id`` of the task to resume (must be in ``'failed'``
                     or ``'paused'`` state).

        Returns:
            ``True`` if the task completed, ``False`` if it failed again.

        Raises:
            ValueError: If the task does not exist or is not in a resumable
                        state (``'failed'`` or ``'paused'``).
        """
        conn = self._get_conn()
        try:
            task_row = conn.execute(
                "SELECT * FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
        finally:
            conn.close()

        if task_row is None:
            raise ValueError(f"Task '{task_id}' not found in database")

        status = task_row["status"]
        if status not in ("failed", "paused"):
            raise ValueError(
                f"Task '{task_id}' cannot be resumed from status '{status}'. "
                "Only 'failed' or 'paused' tasks can be resumed."
            )

        pipeline_name: str = task_row["pipeline"]
        description: str = task_row["description"] or ""
        worktree_path_str: str | None = task_row["worktree_path"]

        if worktree_path_str is None:
            raise ValueError(f"Task '{task_id}' has no worktree_path — cannot resume")

        worktree_path = Path(worktree_path_str)
        if not worktree_path.is_dir():
            raise ValueError(
                f"Worktree directory does not exist: {worktree_path}. "
                "Run cleanup and re-create the task."
            )

        # ------------------------------------------------------------------
        # Find the first incomplete stage
        # ------------------------------------------------------------------
        pipeline_yaml_path = (
            self.project_dir / ".pegasus" / "pipelines" / f"{pipeline_name}.yaml"
        )
        pipeline = load_pipeline_config(pipeline_yaml_path)
        project_config = load_config(self.project_dir)
        retry_max: int = project_config.concurrency.retry_max
        retry_base_delay: float = project_config.concurrency.retry_base_delay

        conn = self._get_conn()
        try:
            completed_stages = {
                row["stage_id"]
                for row in conn.execute(
                    "SELECT stage_id FROM stage_runs WHERE task_id = ? AND status = 'completed'",
                    (task_id,),
                ).fetchall()
            }

            # Restore task to running state
            conn.execute(
                "UPDATE tasks SET status = 'running', "
                "runner_pid = ?, heartbeat_at = CURRENT_TIMESTAMP, "
                "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (os.getpid(), task_id),
            )
            conn.commit()
        except Exception:
            conn.close()
            raise

        # ------------------------------------------------------------------
        # Signal handling + heartbeat
        # ------------------------------------------------------------------
        self._install_signal_handlers(task_id)
        heartbeat_task = asyncio.ensure_future(
            self._heartbeat_loop(conn, task_id)
        )

        engine = PegasusEngine(self.agent_runner, self.db_path)
        self._current_engine = engine

        try:
            for stage_index, stage in enumerate(pipeline.stages):
                if stage.id in completed_stages:
                    logger.info(
                        "task=%s stage=%s already completed — skipping",
                        task_id,
                        stage.id,
                    )
                    continue

                if self._shutdown_requested:
                    self._mark_task_status(conn, task_id, "paused")
                    return False

                resolved_flags, requires_approval = resolve_stage_flags(
                    stage,
                    pipeline_defaults=pipeline.defaults,
                    project_config=project_config,
                )

                # Resolve template variables
                resolved_prompt = self._resolve_prompt(
                    stage.prompt,
                    project_config=project_config,
                    description=description,
                )

                stage_success = False
                attempt = 0
                while attempt <= retry_max:
                    if self._shutdown_requested:
                        break

                    resume_session = engine.session_id if (
                        pipeline.execution.mode == "session" and stage_index > 0
                    ) else None

                    stage_success = await engine.run_stage(
                        task_id=task_id,
                        stage_id=stage.id,
                        stage_index=stage_index,
                        prompt=resolved_prompt,
                        cwd=str(worktree_path),
                        claude_flags=resolved_flags.model_dump(exclude_none=True),
                        session_id=resume_session,
                    )

                    if stage_success:
                        self._send_notification(
                            "Pegasus",
                            f"Stage '{stage.name}' complete for: {description}",
                        )
                        break

                    stage_runs_conn = self._get_conn()
                    last_run = stage_runs_conn.execute(
                        """
                        SELECT error FROM stage_runs
                        WHERE task_id = ? AND stage_id = ?
                        ORDER BY id DESC LIMIT 1
                        """,
                        (task_id, stage.id),
                    ).fetchone()
                    stage_runs_conn.close()

                    error_text = (last_run["error"] or "") if last_run else ""
                    if self._is_rate_limit_error(error_text) and attempt < retry_max:
                        delay = retry_base_delay * (2**min(attempt, self._MAX_BACKOFF_EXP))
                        await asyncio.sleep(delay)
                        attempt += 1
                        transition_task_state(conn, task_id, "failed", "running")
                        continue

                    if not stage_success:
                        self._send_notification(
                            "Pegasus — Pipeline Failed",
                            f"Stage '{stage.name}' failed for: {description}",
                        )
                        return False

                if self._shutdown_requested:
                    self._mark_task_status(conn, task_id, "paused")
                    return False

                if not stage_success:
                    return False

                # Post-stage approval gate
                if requires_approval:
                    self._mark_task_status(conn, task_id, "paused")
                    self._send_notification(
                        "Pegasus — Approval Required",
                        f"Stage '{stage.name}' done. Approve to continue: {description}",
                    )
                    if self._on_approval_needed is not None:
                        approved = await self._on_approval_needed(task_id, stage.id)
                    else:
                        approved = await self._poll_for_approval(task_id)
                    if not approved:
                        self._mark_task_status(conn, task_id, "failed")
                        return False
                    self._mark_task_status(conn, task_id, "running")

            self._mark_task_status(conn, task_id, "completed")
            self._send_notification(
                "Pegasus — Pipeline Complete",
                f"All stages finished for: {description}",
            )
            return True

        except Exception as exc:
            logger.exception("task=%s unhandled exception in resume_task", task_id)
            try:
                self._mark_task_status(conn, task_id, "failed", error=str(exc))
            except Exception:  # noqa: BLE001
                pass
            return False

        finally:
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)
            conn.close()
            self._current_engine = None
