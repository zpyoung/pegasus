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
import re
import shlex
import sqlite3
import subprocess
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from pathlib import Path
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
