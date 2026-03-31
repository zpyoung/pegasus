"""Pegasus CLI — Click commands for project initialization, task management, and pipeline validation.

This module defines the top-level ``cli`` Click group and all sub-commands:

- ``init``     — Scaffold ``.pegasus/`` with auto-detected settings and starter templates
- ``run``      — Create a task and spawn the pipeline runner as a subprocess
- ``status``   — Display task progress read directly from SQLite (read-only)
- ``validate`` — Validate all pipeline YAML files and report errors
- ``resume``   — Restart a failed task from its failed stage
- ``tui``      — Launch the interactive Textual dashboard

**CRITICAL DESIGN CONSTRAINT**: This module NEVER imports runner.py.  All state
is read from SQLite via ``models.make_connection(read_only=True)``.  The runner is
invoked by spawning ``python3 -m pegasus._run_task <task-id>`` as a detached
subprocess.
"""

from __future__ import annotations

import os
import secrets
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any

import click
import yaml
from rich.console import Console
from rich.table import Table
from rich.text import Text

from pegasus.models import (
    init_db,
    make_connection,
    validate_all_pipelines,
    validate_pipeline,
)

console = Console()

# ---------------------------------------------------------------------------
# Language auto-detection helpers
# ---------------------------------------------------------------------------

_LANGUAGE_MARKERS: list[tuple[str, str]] = [
    ("pyproject.toml", "python"),
    ("setup.py", "python"),
    ("setup.cfg", "python"),
    ("requirements.txt", "python"),
    ("package.json", "node"),
    ("go.mod", "go"),
    ("Cargo.toml", "rust"),
    ("pom.xml", "java"),
    ("build.gradle", "java"),
    ("Gemfile", "ruby"),
    ("composer.json", "php"),
]

_TEST_COMMANDS: dict[str, str] = {
    "python": "pytest",
    "node": "npm test",
    "go": "go test ./...",
    "rust": "cargo test",
    "java": "mvn test",
    "ruby": "bundle exec rspec",
    "php": "composer test",
}

_LINT_COMMANDS: dict[str, str] = {
    "python": "ruff check .",
    "node": "eslint .",
    "go": "golangci-lint run",
    "rust": "cargo clippy",
    "java": "checkstyle",
    "ruby": "rubocop",
    "php": "phpcs",
}


def _detect_language(project_dir: Path) -> str | None:
    """Auto-detect the project language from known marker files."""
    for marker, lang in _LANGUAGE_MARKERS:
        if (project_dir / marker).exists():
            return lang
    return None


def _detect_default_branch(project_dir: Path) -> str:
    """Auto-detect the default git branch. Falls back to 'main'."""
    try:
        result = subprocess.run(
            ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            capture_output=True,
            text=True,
            cwd=str(project_dir),
            timeout=5,
        )
        if result.returncode == 0:
            branch = result.stdout.strip()
            if "/" in branch:
                branch = branch.split("/", 1)[1]
            return branch or "main"
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    # Fallback: check HEAD ref
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            cwd=str(project_dir),
            timeout=5,
        )
        if result.returncode == 0:
            branch = result.stdout.strip()
            if branch and branch != "HEAD":
                return branch
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    return "main"


# ---------------------------------------------------------------------------
# Starter pipeline templates
# ---------------------------------------------------------------------------

_BUG_FIX_TEMPLATE = """\
name: Bug Fix
description: Analyze, patch, and verify a reported bug

execution:
  mode: session

defaults:
  model: claude-sonnet-4-20250514
  max_turns: 10
  permission_mode: plan

stages:
  - id: analyze
    name: Root Cause Analysis
    prompt: |
      Analyze this bug in a {{project.language}} project:
      {{task.description}}
      Identify the root cause and list all affected files.
    claude_flags:
      model: claude-sonnet-4-20250514
      permission_mode: plan
      max_turns: 5

  - id: implement
    name: Apply Fix
    prompt: |
      Implement the fix for the bug you analyzed.
      Be minimal and targeted — only change what is necessary.
    claude_flags:
      model: claude-sonnet-4-20250514
      permission_mode: acceptEdits
      max_turns: 10
    requires_approval: true

  - id: verify
    name: Verify Fix
    prompt: |
      Verify the fix is correct by reviewing the changes.
      Check for any regressions or unintended side effects.
    claude_flags:
      permission_mode: plan
      max_turns: 5
"""

_FEATURE_TEMPLATE = """\
name: Feature
description: Plan, implement, and test a new feature

execution:
  mode: session

defaults:
  model: claude-sonnet-4-20250514
  max_turns: 10
  permission_mode: plan

stages:
  - id: plan
    name: Feature Planning
    prompt: |
      Plan the implementation for this feature in a {{project.language}} project:
      {{task.description}}
      List all files to create/modify and the exact changes needed.
    claude_flags:
      model: claude-sonnet-4-20250514
      permission_mode: plan
      max_turns: 5
    requires_approval: true

  - id: implement
    name: Implement Feature
    prompt: |
      Implement the feature according to the approved plan.
      Follow the existing code style and patterns.
    claude_flags:
      model: claude-sonnet-4-20250514
      permission_mode: acceptEdits
      max_turns: 15
    requires_approval: true

  - id: review
    name: Code Review
    prompt: |
      Review the implemented code for correctness, style, and potential issues.
      Suggest any improvements.
    claude_flags:
      permission_mode: plan
      max_turns: 5
"""


# ---------------------------------------------------------------------------
# SQLite helpers for read-only status queries
# ---------------------------------------------------------------------------


def _get_db_path(project_dir: Path) -> Path:
    """Return path to pegasus.db for the given project directory."""
    return project_dir / ".pegasus" / "pegasus.db"


def _open_db_ro(project_dir: Path) -> sqlite3.Connection | None:
    """Open the pegasus.db in read-only mode. Returns None if not found."""
    db_path = _get_db_path(project_dir)
    if not db_path.exists():
        return None
    return make_connection(db_path, read_only=True)


def _status_icon(status: str) -> Text:
    """Return a Rich Text status badge with color."""
    colors = {
        "queued": "yellow",
        "running": "cyan",
        "paused": "magenta",
        "completed": "green",
        "failed": "red",
    }
    color = colors.get(status, "white")
    return Text(status, style=f"bold {color}")


# ---------------------------------------------------------------------------
# CLI group
# ---------------------------------------------------------------------------


@click.group()
@click.version_option(package_name="pegasus")
def cli() -> None:
    """Pegasus — YAML-defined AI coding pipelines powered by Claude."""


# ---------------------------------------------------------------------------
# pegasus init
# ---------------------------------------------------------------------------


@cli.command("init")
@click.option(
    "--project-dir",
    default=".",
    show_default=True,
    help="Project root directory to initialise.",
    type=click.Path(exists=True, file_okay=False, dir_okay=True, path_type=Path),
)
@click.option("--language", default=None, help="Override auto-detected language.")
@click.option("--test-command", default=None, help="Override auto-detected test command.")
@click.option("--lint-command", default=None, help="Override auto-detected lint command.")
@click.option("--default-branch", default=None, help="Override auto-detected default branch.")
def init(
    project_dir: Path,
    language: str | None,
    test_command: str | None,
    lint_command: str | None,
    default_branch: str | None,
) -> None:
    """Scaffold .pegasus/ with auto-detected settings and starter templates."""
    project_dir = project_dir.resolve()

    # --- Auto-detect settings ---
    detected_language = language or _detect_language(project_dir)
    detected_default_branch = default_branch or _detect_default_branch(project_dir)
    detected_test = test_command or (
        _TEST_COMMANDS.get(detected_language, "") if detected_language else ""
    )
    detected_lint = lint_command or (
        _LINT_COMMANDS.get(detected_language, "") if detected_language else ""
    )

    # --- Create .pegasus/ directory structure ---
    pegasus_dir = project_dir / ".pegasus"
    pipelines_dir = pegasus_dir / "pipelines"
    logs_dir = pegasus_dir / "logs"

    pegasus_dir.mkdir(exist_ok=True)
    pipelines_dir.mkdir(exist_ok=True)
    logs_dir.mkdir(exist_ok=True)

    # --- Write config.yaml ---
    config_path = pegasus_dir / "config.yaml"
    if not config_path.exists():
        config_data: dict[str, Any] = {
            "pegasus": {"version": "0.1.0"},
            "project": {
                "language": detected_language or "unknown",
                "test_command": detected_test or "",
                "lint_command": detected_lint or "",
                "setup_command": "",
            },
            "git": {
                "default_branch": detected_default_branch,
                "branch_prefix": "pegasus/",
                "auto_cleanup": True,
            },
            "defaults": {
                "model": "claude-sonnet-4-20250514",
                "max_turns": 10,
                "permission_mode": "plan",
                "max_permission": "acceptEdits",
            },
            "concurrency": {
                "max_tasks": 3,
                "retry_max": 5,
                "retry_base_delay": 1.0,
            },
            "notifications": {
                "on_stage_complete": "desktop",
                "on_approval_needed": "desktop",
                "on_pipeline_complete": "desktop",
                "on_pipeline_failed": "desktop",
            },
            "worktrees": {
                "base_path": "~/.pegasus/worktrees",
            },
        }
        with config_path.open("w", encoding="utf-8") as f:
            yaml.dump(config_data, f, default_flow_style=False, sort_keys=False)
        console.print(f"[green]Created[/green] {config_path.relative_to(project_dir)}")
    else:
        console.print(f"[yellow]Exists[/yellow]  {config_path.relative_to(project_dir)}")

    # --- Write starter pipeline templates ---
    for name, content in [("bug-fix.yaml", _BUG_FIX_TEMPLATE), ("feature.yaml", _FEATURE_TEMPLATE)]:
        pipeline_path = pipelines_dir / name
        if not pipeline_path.exists():
            pipeline_path.write_text(content, encoding="utf-8")
            console.print(f"[green]Created[/green] {pipeline_path.relative_to(project_dir)}")
        else:
            console.print(f"[yellow]Exists[/yellow]  {pipeline_path.relative_to(project_dir)}")

    # --- Update .gitignore ---
    gitignore_path = project_dir / ".gitignore"

    # Unique sentinel that marks our block so we never add it twice
    _PEGASUS_GITIGNORE_SENTINEL = "# Pegasus runtime files"
    _PEGASUS_GITIGNORE_BLOCK = (
        "\n# Pegasus runtime files\n"
        ".pegasus/pegasus.db\n"
        ".pegasus/pegasus.db-wal\n"
        ".pegasus/pegasus.db-shm\n"
        ".pegasus/logs/\n"
    )

    existing_content = ""
    if gitignore_path.exists():
        existing_content = gitignore_path.read_text(encoding="utf-8")

    if _PEGASUS_GITIGNORE_SENTINEL not in existing_content:
        with gitignore_path.open("a", encoding="utf-8") as f:
            f.write(_PEGASUS_GITIGNORE_BLOCK)
        console.print("[green]Updated[/green] .gitignore (added Pegasus entries)")

    # --- Initialise SQLite database ---
    db_path = pegasus_dir / "pegasus.db"
    conn = make_connection(db_path)
    try:
        init_db(conn)
    finally:
        conn.close()
    console.print(f"[green]Initialised[/green] SQLite database at {db_path.relative_to(project_dir)}")

    # --- Summary ---
    console.print()
    console.print("[bold green]Pegasus initialised successfully![/bold green]")
    console.print()
    if detected_language:
        console.print(f"  Language:       {detected_language}")
    if detected_test:
        console.print(f"  Test command:   {detected_test}")
    if detected_lint:
        console.print(f"  Lint command:   {detected_lint}")
    console.print(f"  Default branch: {detected_default_branch}")
    console.print()
    console.print("Next steps:")
    console.print("  1. Review [bold].pegasus/config.yaml[/bold] and adjust settings")
    console.print("  2. Review pipeline templates in [bold].pegasus/pipelines/[/bold]")
    console.print("  3. Run [bold]pegasus validate[/bold] to check your pipelines")
    console.print("  4. Run [bold]pegasus run --pipeline bug-fix --desc \"Fix the login bug\"[/bold]")


# ---------------------------------------------------------------------------
# pegasus run
# ---------------------------------------------------------------------------


@cli.command("run")
@click.option("--pipeline", required=True, help="Pipeline name (without .yaml extension).")
@click.option("--desc", required=True, help="Task description.")
@click.option(
    "--project-dir",
    default=".",
    show_default=True,
    help="Project root directory.",
    type=click.Path(exists=True, file_okay=False, dir_okay=True, path_type=Path),
)
@click.option("--dry-run", is_flag=True, default=False, help="Show resolved config without running.")
def run(
    pipeline: str,
    desc: str,
    project_dir: Path,
    dry_run: bool,
) -> None:
    """Create a task and spawn the pipeline runner as a subprocess."""
    project_dir = project_dir.resolve()
    db_path = _get_db_path(project_dir)

    if not db_path.exists():
        console.print("[red]Error:[/red] Pegasus not initialised. Run [bold]pegasus init[/bold] first.")
        sys.exit(1)

    # Verify the pipeline file exists
    pipeline_yaml = project_dir / ".pegasus" / "pipelines" / f"{pipeline}.yaml"
    pipeline_yml = project_dir / ".pegasus" / "pipelines" / f"{pipeline}.yml"
    if not pipeline_yaml.exists() and not pipeline_yml.exists():
        console.print(f"[red]Error:[/red] Pipeline '{pipeline}' not found.")
        console.print(f"  Looked for: {pipeline_yaml}")
        console.print(f"  and:        {pipeline_yml}")
        sys.exit(1)

    # Generate a short task ID (6 hex chars)
    task_id = secrets.token_hex(3)

    if dry_run:
        console.print("[bold yellow]Dry run — no API calls will be made.[/bold yellow]")
        console.print(f"  Task ID:   {task_id}")
        console.print(f"  Pipeline:  {pipeline}")
        console.print(f"  Desc:      {desc}")
        console.print(f"  DB:        {db_path}")
        console.print()
        console.print("Runner would be spawned as:")
        console.print(f"  python3 -m pegasus._run_task {task_id}")
        return

    # Insert task row into SQLite
    conn = make_connection(db_path)
    try:
        conn.execute(
            """INSERT INTO tasks (id, pipeline, description, status)
               VALUES (?, ?, ?, 'queued')""",
            (task_id, pipeline, desc),
        )
        conn.commit()
    finally:
        conn.close()

    console.print(f"[green]Task created:[/green] [bold]{task_id}[/bold]")
    console.print(f"  Pipeline:    {pipeline}")
    console.print(f"  Description: {desc}")

    # Spawn the runner as a detached subprocess
    runner_cmd = [sys.executable, "-m", "pegasus._run_task", task_id]
    env = dict(os.environ)
    env["PEGASUS_PROJECT_DIR"] = str(project_dir)

    try:
        proc = subprocess.Popen(
            runner_cmd,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,  # detach from parent process group
        )
        console.print(f"  Runner PID:  {proc.pid}")
    except Exception as exc:
        console.print(f"[red]Error spawning runner:[/red] {exc}")
        sys.exit(1)

    console.print()
    console.print(f"Monitor progress: [bold]pegasus status {task_id}[/bold]")


# ---------------------------------------------------------------------------
# pegasus status
# ---------------------------------------------------------------------------


@cli.command("status")
@click.argument("task_id", required=False)
@click.option(
    "--project-dir",
    default=".",
    show_default=True,
    help="Project root directory.",
    type=click.Path(exists=True, file_okay=False, dir_okay=True, path_type=Path),
)
def status(task_id: str | None, project_dir: Path) -> None:
    """Show task status. Without TASK_ID, lists all tasks."""
    project_dir = project_dir.resolve()
    conn = _open_db_ro(project_dir)

    if conn is None:
        console.print("[red]Error:[/red] No Pegasus database found. Run [bold]pegasus init[/bold] first.")
        sys.exit(1)

    try:
        if task_id is None:
            _status_all(conn)
        else:
            _status_one(conn, task_id)
    finally:
        conn.close()


def _status_all(conn: sqlite3.Connection) -> None:
    """List all tasks as a Rich table."""
    rows = conn.execute(
        """SELECT id, pipeline, description, status, created_at, total_cost
           FROM tasks
           ORDER BY created_at DESC"""
    ).fetchall()

    if not rows:
        console.print("[yellow]No tasks found.[/yellow] Run [bold]pegasus run[/bold] to start one.")
        return

    table = Table(title="Pegasus Tasks", show_lines=True)
    table.add_column("ID", style="bold cyan", no_wrap=True)
    table.add_column("Pipeline", style="magenta")
    table.add_column("Description")
    table.add_column("Status", no_wrap=True)
    table.add_column("Created", no_wrap=True)
    table.add_column("Cost (USD)", justify="right")

    for row in rows:
        desc = (row["description"] or "")[:60]
        cost = f"${row['total_cost']:.4f}" if row["total_cost"] else "$0.0000"
        table.add_row(
            row["id"],
            row["pipeline"],
            desc,
            _status_icon(row["status"]),
            row["created_at"] or "",
            cost,
        )

    console.print(table)


def _status_one(conn: sqlite3.Connection, task_id: str) -> None:
    """Show detailed status for a single task."""
    row = conn.execute(
        """SELECT id, pipeline, description, status, created_at, updated_at,
                  session_id, branch, worktree_path, base_branch, merge_status,
                  total_cost, runner_pid, heartbeat_at
           FROM tasks WHERE id = ?""",
        (task_id,),
    ).fetchone()

    if row is None:
        console.print(f"[red]Error:[/red] Task '{task_id}' not found.")
        sys.exit(1)

    # Task header
    console.print()
    console.print(f"[bold]Task[/bold] {row['id']}  ", end="")
    console.print(_status_icon(row["status"]))
    console.print()
    console.print(f"  Pipeline:     {row['pipeline']}")
    console.print(f"  Description:  {row['description'] or '(none)'}")
    console.print(f"  Created:      {row['created_at']}")
    console.print(f"  Updated:      {row['updated_at']}")
    if row["branch"]:
        console.print(f"  Branch:       {row['branch']}")
    if row["worktree_path"]:
        console.print(f"  Worktree:     {row['worktree_path']}")
    if row["base_branch"]:
        console.print(f"  Base branch:  {row['base_branch']}")
    if row["merge_status"]:
        console.print(f"  Merge status: {row['merge_status']}")
    cost = f"${row['total_cost']:.4f}" if row["total_cost"] else "$0.0000"
    console.print(f"  Total cost:   {cost}")
    if row["runner_pid"]:
        console.print(f"  Runner PID:   {row['runner_pid']}")
    if row["heartbeat_at"]:
        console.print(f"  Last heartbeat: {row['heartbeat_at']}")

    # Stage runs
    stages = conn.execute(
        """SELECT stage_id, stage_index, status, started_at, finished_at, error, cost
           FROM stage_runs
           WHERE task_id = ?
           ORDER BY stage_index ASC""",
        (task_id,),
    ).fetchall()

    if stages:
        console.print()
        console.print("[bold]Stages:[/bold]")
        stage_table = Table(show_header=True, box=None, padding=(0, 2))
        stage_table.add_column("#", style="dim", width=3)
        stage_table.add_column("Stage ID", style="cyan")
        stage_table.add_column("Status", no_wrap=True)
        stage_table.add_column("Started")
        stage_table.add_column("Finished")
        stage_table.add_column("Cost", justify="right")
        stage_table.add_column("Error")

        for s in stages:
            error_str = (s["error"] or "")[:60]
            cost_str = f"${s['cost']:.4f}" if s["cost"] else ""
            stage_table.add_row(
                str(s["stage_index"]),
                s["stage_id"],
                _status_icon(s["status"]),
                s["started_at"] or "",
                s["finished_at"] or "",
                cost_str,
                error_str,
            )
        console.print(stage_table)


# ---------------------------------------------------------------------------
# pegasus validate
# ---------------------------------------------------------------------------


@cli.command("validate")
@click.option(
    "--project-dir",
    default=".",
    show_default=True,
    help="Project root directory.",
    type=click.Path(exists=True, file_okay=False, dir_okay=True, path_type=Path),
)
@click.option("--pipeline", default=None, help="Validate only a specific pipeline by name.")
@click.option("--verbose", is_flag=True, default=False, help="Show verbose details.")
def validate(project_dir: Path, pipeline: str | None, verbose: bool) -> None:
    """Validate all pipeline YAML files for errors."""
    project_dir = project_dir.resolve()
    pipelines_dir = project_dir / ".pegasus" / "pipelines"

    if not pipelines_dir.exists():
        console.print("[red]Error:[/red] No pipelines directory found.")
        console.print("  Run [bold]pegasus init[/bold] to scaffold the project.")
        sys.exit(1)

    if pipeline is not None:
        # Validate a single named pipeline
        candidates = [
            pipelines_dir / f"{pipeline}.yaml",
            pipelines_dir / f"{pipeline}.yml",
        ]
        pipeline_path: Path | None = next((p for p in candidates if p.exists()), None)
        if pipeline_path is None:
            console.print(f"[red]Error:[/red] Pipeline '{pipeline}' not found.")
            console.print(f"  Looked in: {pipelines_dir}")
            sys.exit(1)

        errors = validate_pipeline(pipeline_path, file_path=pipeline_path)
        all_errors: dict[Any, list[Any]] = {pipeline_path: errors}
    else:
        all_errors = validate_all_pipelines(project_dir)

    if not all_errors:
        console.print("[yellow]No pipeline files found.[/yellow]")
        return

    total_errors = sum(len(errs) for errs in all_errors.values())
    total_files = len(all_errors)
    files_with_errors = sum(1 for errs in all_errors.values() if errs)
    files_clean = total_files - files_with_errors

    for fpath, errors in sorted(all_errors.items()):
        rel = Path(fpath).relative_to(project_dir) if Path(fpath).is_absolute() else Path(fpath)
        if not errors:
            console.print(f"[green]PASS[/green]  {rel}")
            if verbose:
                console.print("      [dim]No issues found.[/dim]")
        else:
            console.print(f"[red]FAIL[/red]  {rel}  ({len(errors)} error(s))")
            for err in errors:
                loc = f"  [[dim]{err.location}[/dim]]" if err.location else ""
                console.print(f"      [red]•[/red] {err.message}{loc}")

    console.print()
    if total_errors == 0:
        console.print(f"[bold green]All {total_files} pipeline(s) are valid.[/bold green]")
    else:
        console.print(
            f"[bold red]{total_errors} error(s)[/bold red] found in "
            f"{files_with_errors}/{total_files} pipeline(s). "
            f"{files_clean} clean."
        )
        sys.exit(1)


# ---------------------------------------------------------------------------
# pegasus resume
# ---------------------------------------------------------------------------


@cli.command("resume")
@click.argument("task_id")
@click.option(
    "--project-dir",
    default=".",
    show_default=True,
    help="Project root directory.",
    type=click.Path(exists=True, file_okay=False, dir_okay=True, path_type=Path),
)
def resume(task_id: str, project_dir: Path) -> None:
    """Restart a failed or paused task from the failed stage."""
    project_dir = project_dir.resolve()
    db_path = _get_db_path(project_dir)

    if not db_path.exists():
        console.print("[red]Error:[/red] No Pegasus database found. Run [bold]pegasus init[/bold] first.")
        sys.exit(1)

    # Verify the task exists and is in a resumable state
    conn = make_connection(db_path)
    try:
        row = conn.execute(
            "SELECT id, pipeline, description, status FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        console.print(f"[red]Error:[/red] Task '{task_id}' not found.")
        sys.exit(1)

    resumable_states = {"failed", "paused"}
    if row["status"] not in resumable_states:
        console.print(
            f"[red]Error:[/red] Task '{task_id}' is in state '{row['status']}' and cannot be resumed."
        )
        console.print(f"  Only tasks in states {resumable_states} can be resumed.")
        sys.exit(1)

    console.print(f"[green]Resuming task[/green] [bold]{task_id}[/bold]")
    console.print(f"  Pipeline:    {row['pipeline']}")
    console.print(f"  Description: {row['description'] or '(none)'}")

    # Spawn the runner in resume mode
    runner_cmd = [sys.executable, "-m", "pegasus._run_task", task_id, "--resume"]
    env = dict(os.environ)
    env["PEGASUS_PROJECT_DIR"] = str(project_dir)

    try:
        proc = subprocess.Popen(
            runner_cmd,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        console.print(f"  Runner PID:  {proc.pid}")
    except Exception as exc:
        console.print(f"[red]Error spawning runner:[/red] {exc}")
        sys.exit(1)

    console.print()
    console.print(f"Monitor progress: [bold]pegasus status {task_id}[/bold]")


# ---------------------------------------------------------------------------
# TUI — Textual dashboard
# ---------------------------------------------------------------------------


def _build_stage_lines(stages: list) -> str:
    """Format stage rows into a multi-line string for display in a TaskCard."""
    if not stages:
        return "[dim]No stages yet.[/dim]"
    icons: dict[str, str] = {
        "completed": "[bold green]checkmark[/bold green]",
        "running": "[bold cyan]running[/bold cyan]",
        "failed": "[bold red]failed[/bold red]",
        "pending": "[dim]pending[/dim]",
        "skipped": "[dim]skipped[/dim]",
    }
    lines = []
    for s in stages:
        icon = icons.get(s["status"], "[dim]?[/dim]")
        lines.append(f"{icon} {s['stage_id']}")
    return "\n".join(lines)


def _get_textual_app() -> type:
    """Build and return the PegasusDashboard Textual App class.

    Imports are deferred so Textual is not loaded until the ``tui`` command
    is actually invoked.
    """
    import sqlite3 as _sqlite3

    from textual.app import App, ComposeResult
    from textual.binding import Binding
    from textual.containers import Horizontal
    from textual.widget import Widget
    from textual.widgets import Footer, Header, Label, Static

    class TaskCard(Widget):
        """Widget showing one task: header, stage list, current activity."""

        DEFAULT_CSS = """
        TaskCard {
            border: solid $primary;
            padding: 0 1;
            width: 1fr;
            height: auto;
            min-height: 10;
        }
        TaskCard:focus {
            border: double $accent;
        }
        """

        can_focus = True

        def compose(self) -> ComposeResult:
            yield Static("", id="card-header")
            yield Static("", id="card-stages")
            yield Static("", id="card-activity")

        def update_data(
            self,
            task_id: str,
            pipeline: str,
            description: str,
            status: str,
            stages: list,
            activity: str,
        ) -> None:
            """Refresh the card's displayed content."""
            status_colors: dict[str, str] = {
                "queued": "yellow",
                "running": "cyan",
                "paused": "magenta",
                "completed": "green",
                "failed": "red",
            }
            color = status_colors.get(status, "white")
            header_text = (
                f"[bold {color}]{task_id}[/bold {color}] [{color}]{status}[/{color}]\n"
                f"[dim]{pipeline}[/dim]\n"
                f"{description[:40]}"
            )
            self.query_one("#card-header", Static).update(header_text)
            self.query_one("#card-stages", Static).update(_build_stage_lines(stages))
            activity_text = f"[dim]> {activity[:50]}[/dim]" if activity else ""
            self.query_one("#card-activity", Static).update(activity_text)

    class LogPanel(Widget):
        """Widget that tails a task's log file (last 8 lines)."""

        DEFAULT_CSS = """
        LogPanel {
            height: 8;
            border: solid $surface;
            background: $surface;
            padding: 0 1;
            display: none;
        }
        LogPanel.visible-log {
            display: block;
        }
        """

        def compose(self) -> ComposeResult:
            yield Static("LOGS", id="log-header")
            yield Static("", id="log-content")

        def show_logs(self, task_id: str, log_dir: Path) -> None:
            """Update displayed log content from the task log file."""
            self.query_one("#log-header", Static).update(f"LOGS ({task_id})")
            log_path = log_dir / f"{task_id}.log"
            if not log_path.exists():
                self.query_one("#log-content", Static).update("[dim](no log file yet)[/dim]")
                return
            try:
                text = log_path.read_text(encoding="utf-8", errors="replace")
                lines = text.splitlines()
                tail = "\n".join(lines[-8:]) if lines else "(empty log)"
                self.query_one("#log-content", Static).update(tail)
            except OSError:
                self.query_one("#log-content", Static).update("[dim](log unreadable)[/dim]")

    class PegasusDashboard(App):
        """Textual TUI dashboard for Pegasus task monitoring.

        Polls SQLite at 100ms via set_interval using read-only (mode=ro)
        connections.  Never imports runner.py.
        """

        TITLE = "Pegasus Dashboard"
        SUB_TITLE = "Live task monitoring"

        DEFAULT_CSS = """
        PegasusDashboard {
            background: $background;
        }
        #task-area {
            height: 1fr;
        }
        #log-panel {
            dock: bottom;
        }
        """

        BINDINGS = [
            Binding("d", "toggle_view", "Dashboard", show=True),
            Binding("tab", "focus_next_task", "Next task", show=True, priority=True),
            Binding("shift+tab", "focus_prev_task", "Prev task", show=False, priority=True),
            Binding("a", "approve_task", "Approve", show=True),
            Binding("r", "reject_task", "Reject", show=True),
            Binding("l", "toggle_logs", "Logs", show=True),
            Binding("q", "quit_app", "Quit", show=True),
        ]

        _task_data: list = []
        _focused_idx: int = 0
        _logs_visible: bool = False

        def __init__(self, db_path: Path, **kwargs: object) -> None:
            super().__init__(**kwargs)
            self._db_path = db_path
            self._conn: _sqlite3.Connection | None = None

        def on_mount(self) -> None:
            """Open read-only SQLite connection and start 100ms polling."""
            try:
                self._conn = make_connection(self._db_path, read_only=True)
            except Exception:
                self._conn = None
            self.set_interval(0.1, self.poll_db)

        def on_unmount(self) -> None:
            """Close the SQLite connection on exit."""
            if self._conn is not None:
                try:
                    self._conn.close()
                except Exception:
                    pass
                self._conn = None

        def compose(self) -> ComposeResult:
            yield Header()
            yield Horizontal(id="task-area")
            yield LogPanel(id="log-panel")
            yield Footer()

        def poll_db(self) -> None:
            """Query SQLite for current tasks/stage_runs; refresh widgets."""
            if self._conn is None:
                return
            try:
                tasks = self._conn.execute(
                    """SELECT id, pipeline, description, status
                       FROM tasks
                       ORDER BY created_at DESC"""
                ).fetchall()

                result = []
                for t in tasks:
                    stages = self._conn.execute(
                        """SELECT stage_id, stage_index, status
                           FROM stage_runs
                           WHERE task_id = ?
                           ORDER BY stage_index ASC""",
                        (t["id"],),
                    ).fetchall()
                    running = [s for s in stages if s["status"] == "running"]
                    activity = running[0]["stage_id"] if running else ""
                    result.append(
                        {
                            "id": t["id"],
                            "pipeline": t["pipeline"],
                            "description": t["description"] or "",
                            "status": t["status"],
                            "stages": list(stages),
                            "activity": activity,
                        }
                    )
                self._task_data = result
                self._refresh_cards()
                if self._logs_visible:
                    self._refresh_logs()
            except Exception:
                pass

        # ------------------------------------------------------------------
        # Internal refresh helpers
        # ------------------------------------------------------------------

        def _refresh_cards(self) -> None:
            """Sync TaskCards in #task-area to match current _task_data."""
            area = self.query_one("#task-area", Horizontal)
            tasks = self._task_data
            current_cards = list(self.query(TaskCard))

            # Update existing / create new cards
            for i, task in enumerate(tasks):
                if i < len(current_cards):
                    card = current_cards[i]
                else:
                    card = TaskCard()
                    area.mount(card)
                card.update_data(
                    task_id=task["id"],
                    pipeline=task["pipeline"],
                    description=task["description"],
                    status=task["status"],
                    stages=task["stages"],
                    activity=task["activity"],
                )

            # Remove extra cards
            for card in current_cards[len(tasks) :]:
                card.remove()

            # Placeholder label when no tasks exist
            no_label_results = self.query("#no-tasks-label")
            no_label: Label | None = next(iter(no_label_results), None)
            if not tasks and no_label is None:
                area.mount(
                    Label(
                        "No active tasks.  Run [bold]pegasus run[/bold] to start one.",
                        id="no-tasks-label",
                    )
                )
            elif tasks and no_label is not None:
                no_label.remove()

        def _refresh_logs(self) -> None:
            """Tail the focused task's log file into the LogPanel."""
            tasks = self._task_data
            if not tasks:
                return
            idx = min(self._focused_idx, len(tasks) - 1)
            task_id = tasks[idx]["id"]
            log_dir = self._db_path.parent / "logs"
            log_panel = self.query_one("#log-panel", LogPanel)
            log_panel.show_logs(task_id, log_dir)

        # ------------------------------------------------------------------
        # Key-action handlers
        # ------------------------------------------------------------------

        def action_toggle_view(self) -> None:
            """D -- toggle between dashboard and focus view (focus deferred to v0.2)."""
            self.notify("Dashboard view active (focus view: v0.2)", timeout=2)

        def action_focus_next_task(self) -> None:
            """Tab -- cycle focus forward through task cards."""
            cards = list(self.query(TaskCard))
            if not cards:
                return
            self._focused_idx = (self._focused_idx + 1) % len(cards)
            cards[self._focused_idx].focus()
            if self._logs_visible:
                self._refresh_logs()

        def action_focus_prev_task(self) -> None:
            """Shift+Tab -- cycle focus backward through task cards."""
            cards = list(self.query(TaskCard))
            if not cards:
                return
            self._focused_idx = (self._focused_idx - 1) % len(cards)
            cards[self._focused_idx].focus()
            if self._logs_visible:
                self._refresh_logs()

        def action_approve_task(self) -> None:
            """A -- approve the focused paused task by writing queued to SQLite."""
            if not self._task_data:
                return
            idx = min(self._focused_idx, len(self._task_data) - 1)
            task = self._task_data[idx]
            if task["status"] != "paused":
                self.notify(
                    f"Task {task['id']} is not paused (status: {task['status']})", timeout=3
                )
                return
            try:
                conn = make_connection(self._db_path)
                try:
                    conn.execute(
                        "UPDATE tasks SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                        (task["id"],),
                    )
                    conn.commit()
                finally:
                    conn.close()
                self.notify(f"Approved task {task['id']}", timeout=2)
            except Exception as exc:
                self.notify(f"Approve failed: {exc}", severity="error", timeout=4)

        def action_reject_task(self) -> None:
            """R -- reject/mark the focused task as failed."""
            if not self._task_data:
                return
            idx = min(self._focused_idx, len(self._task_data) - 1)
            task = self._task_data[idx]
            if task["status"] not in ("paused", "running"):
                self.notify(
                    f"Task {task['id']} cannot be rejected (status: {task['status']})", timeout=3
                )
                return
            try:
                conn = make_connection(self._db_path)
                try:
                    conn.execute(
                        "UPDATE tasks SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                        (task["id"],),
                    )
                    conn.commit()
                finally:
                    conn.close()
                self.notify(f"Rejected task {task['id']}", timeout=2)
            except Exception as exc:
                self.notify(f"Reject failed: {exc}", severity="error", timeout=4)

        def action_toggle_logs(self) -> None:
            """L -- show/hide the log panel."""
            self._logs_visible = not self._logs_visible
            log_panel = self.query_one("#log-panel", LogPanel)
            if self._logs_visible:
                log_panel.add_class("visible-log")
                self._refresh_logs()
            else:
                log_panel.remove_class("visible-log")

        def action_quit_app(self) -> None:
            """Q -- quit TUI; tasks continue running as detached subprocesses."""
            self.exit()

    return PegasusDashboard


# ---------------------------------------------------------------------------
# pegasus tui
# ---------------------------------------------------------------------------


@cli.command("tui")
@click.option(
    "--project-dir",
    default=".",
    show_default=True,
    help="Project root directory.",
    type=click.Path(exists=True, file_okay=False, dir_okay=True, path_type=Path),
)
def tui(project_dir: Path) -> None:
    """Launch the interactive Textual terminal dashboard."""
    project_dir = project_dir.resolve()
    db_path = _get_db_path(project_dir)

    if not db_path.exists():
        console.print("[red]Error:[/red] No Pegasus database found. Run [bold]pegasus init[/bold] first.")
        sys.exit(1)

    PegasusDashboard = _get_textual_app()
    app = PegasusDashboard(db_path=db_path)
    app.run()
