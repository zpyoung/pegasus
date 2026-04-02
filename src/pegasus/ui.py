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

import importlib.resources
import json
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
    is_merge_in_progress,
    load_pipeline_config,
    make_connection,
    resolve_pipeline_inputs,
    transition_merge_status,
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
    """Auto-detect the default git branch. Falls back to 'main' or 'master'."""
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
            if branch:
                return branch
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

    # Last resort: check if "master" exists, otherwise assume "main".
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "refs/heads/master"],
            capture_output=True,
            text=True,
            cwd=str(project_dir),
            timeout=5,
        )
        if result.returncode == 0:
            return "master"
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    return "main"


# ---------------------------------------------------------------------------
# Starter pipeline templates (loaded from package data)
# ---------------------------------------------------------------------------


def _load_template(filename: str) -> str:
    """Load a starter pipeline template from package data."""
    return (
        importlib.resources.files("pegasus")
        .joinpath("templates", filename)
        .read_text(encoding="utf-8")
    )


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
        "merged": "green",
        "merging": "cyan",
        "conflict": "red",
        "unmerged": "dim",
    }
    color = colors.get(status, "white")
    return Text(status, style=f"bold {color}")


def _remove_worktree(worktree_path: str, branch: str | None, repo_dir: Path) -> str | None:
    """Remove a git worktree and its branch.

    Returns an error message string on failure, or None on success.
    Handles missing paths and timeouts gracefully.
    """
    errors: list[str] = []

    # Remove the worktree (--force handles dirty trees)
    if Path(worktree_path).exists():
        try:
            result = subprocess.run(
                ["git", "worktree", "remove", "--force", worktree_path],
                capture_output=True,
                text=True,
                cwd=str(repo_dir),
                timeout=30,
            )
            if result.returncode != 0:
                errors.append(f"worktree remove: {result.stderr.strip()}")
        except subprocess.TimeoutExpired:
            errors.append("worktree remove: timed out")
        except (FileNotFoundError, OSError) as exc:
            errors.append(f"worktree remove: {exc}")

    # Prune stale worktree entries
    try:
        subprocess.run(
            ["git", "worktree", "prune"],
            capture_output=True,
            text=True,
            cwd=str(repo_dir),
            timeout=10,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass  # best-effort

    # Delete the branch
    if branch:
        try:
            result = subprocess.run(
                ["git", "branch", "-d", branch],
                capture_output=True,
                text=True,
                cwd=str(repo_dir),
                timeout=10,
            )
            if result.returncode != 0:
                # Force delete if soft delete fails
                result = subprocess.run(
                    ["git", "branch", "-D", branch],
                    capture_output=True,
                    text=True,
                    cwd=str(repo_dir),
                    timeout=10,
                )
                if result.returncode != 0:
                    errors.append(f"branch delete: {result.stderr.strip()}")
        except subprocess.TimeoutExpired:
            errors.append("branch delete: timed out")
        except (FileNotFoundError, OSError) as exc:
            errors.append(f"branch delete: {exc}")

    return "; ".join(errors) if errors else None


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
    for name in ["bug-fix.yaml", "feature.yaml"]:
        pipeline_path = pipelines_dir / name
        if not pipeline_path.exists():
            pipeline_path.write_text(_load_template(name), encoding="utf-8")
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
@click.option("--desc", default="", show_default=False, help="Task description ({{task.description}}).")
@click.option(
    "--input",
    "raw_inputs",
    multiple=True,
    metavar="KEY=VALUE",
    help="Pipeline input as KEY=VALUE. Repeatable. Use for {{inputs.X}} template variables.",
)
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
    raw_inputs: tuple[str, ...],
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
    pipeline_path = pipeline_yaml if pipeline_yaml.exists() else (pipeline_yml if pipeline_yml.exists() else None)
    if pipeline_path is None:
        console.print(f"[red]Error:[/red] Pipeline '{pipeline}' not found.")
        console.print(f"  Looked for: {pipeline_yaml}")
        console.print(f"  and:        {pipeline_yml}")
        sys.exit(1)

    # Parse --input KEY=VALUE pairs
    provided_inputs: dict[str, str] = {}
    for raw in raw_inputs:
        if "=" not in raw:
            console.print(f"[red]Error:[/red] --input '{raw}' is not in KEY=VALUE format.")
            sys.exit(1)
        k, v = raw.split("=", 1)
        k = k.strip()
        if not k:
            console.print(f"[red]Error:[/red] --input '{raw}' has an empty key.")
            sys.exit(1)
        provided_inputs[k] = v

    # Validate inputs against the pipeline's declared input fields
    pipeline_config = load_pipeline_config(pipeline_path)
    resolved_inputs: dict[str, Any] = {}
    if pipeline_config.inputs:
        resolved_inputs, input_errors = resolve_pipeline_inputs(
            pipeline_config.inputs, provided_inputs
        )
        if input_errors:
            for err in input_errors:
                console.print(f"[red]Input error:[/red] {err}")
            sys.exit(1)
    elif provided_inputs:
        # Pipeline has no declared inputs but user passed --input flags
        console.print(
            "[yellow]Warning:[/yellow] Pipeline has no declared inputs; "
            "--input flags are ignored."
        )

    # Generate a short task ID (6 hex chars)
    task_id = secrets.token_hex(3)
    inputs_json = json.dumps(resolved_inputs) if resolved_inputs else None

    if dry_run:
        console.print("[bold yellow]Dry run — no API calls will be made.[/bold yellow]")
        console.print(f"  Task ID:   {task_id}")
        console.print(f"  Pipeline:  {pipeline}")
        console.print(f"  Desc:      {desc}")
        if resolved_inputs:
            console.print(f"  Inputs:    {resolved_inputs}")
        console.print(f"  DB:        {db_path}")
        console.print()
        console.print("Runner would be spawned as:")
        console.print(f"  python3 -m pegasus._run_task {task_id}")
        return

    # Insert task row into SQLite
    conn = make_connection(db_path)
    try:
        conn.execute(
            """INSERT INTO tasks (id, pipeline, description, status, inputs_json)
               VALUES (?, ?, ?, 'queued', ?)""",
            (task_id, pipeline, desc, inputs_json),
        )
        conn.commit()
    finally:
        conn.close()

    console.print(f"[green]Task created:[/green] [bold]{task_id}[/bold]")
    console.print(f"  Pipeline:    {pipeline}")
    console.print(f"  Description: {desc}")
    if resolved_inputs:
        console.print(f"  Inputs:      {resolved_inputs}")

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
        """SELECT id, pipeline, description, status, merge_status,
                  created_at, total_cost
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
    table.add_column("Merge", no_wrap=True)
    table.add_column("Created", no_wrap=True)
    table.add_column("Cost (USD)", justify="right")

    for row in rows:
        desc = (row["description"] or "")[:60]
        cost = f"${row['total_cost']:.4f}" if row["total_cost"] else "$0.0000"
        merge = row["merge_status"] or ""
        merge_cell = _status_icon(merge) if merge else Text("")
        table.add_row(
            row["id"],
            row["pipeline"],
            desc,
            _status_icon(row["status"]),
            merge_cell,
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
# pegasus clean
# ---------------------------------------------------------------------------


@cli.command("clean")
@click.argument("task_id", required=False)
@click.option(
    "--project-dir",
    default=".",
    show_default=True,
    help="Project root directory.",
    type=click.Path(exists=True, file_okay=False, dir_okay=True, path_type=Path),
)
@click.option("--dry-run", is_flag=True, default=False, help="Show what would be cleaned without making changes.")
@click.option("--force", is_flag=True, default=False, help="Skip confirmation prompt.")
def clean(task_id: str | None, project_dir: Path, dry_run: bool, force: bool) -> None:
    """Remove artifacts for completed and failed tasks."""
    project_dir = project_dir.resolve()
    db_path = _get_db_path(project_dir)

    if not db_path.exists():
        console.print("[red]Error:[/red] No Pegasus database found. Run [bold]pegasus init[/bold] first.")
        sys.exit(1)

    conn = make_connection(db_path)
    try:
        if task_id is not None:
            # Clean a specific task
            row = conn.execute(
                "SELECT id, pipeline, description, status, worktree_path, branch FROM tasks WHERE id = ?",
                (task_id,),
            ).fetchone()

            if row is None:
                console.print(f"[red]Error:[/red] Task '{task_id}' not found.")
                sys.exit(1)

            cleanable_states = {"completed", "failed"}
            if row["status"] not in cleanable_states:
                console.print(
                    f"[red]Error:[/red] Task '{task_id}' is in state '{row['status']}' and cannot be cleaned."
                )
                console.print(f"  Only tasks in states {cleanable_states} can be cleaned.")
                sys.exit(1)

            tasks_to_clean = [row]
        else:
            # Find all cleanable tasks
            tasks_to_clean = conn.execute(
                "SELECT id, pipeline, description, status, worktree_path, branch FROM tasks WHERE status IN ('completed', 'failed')"
            ).fetchall()

        if not tasks_to_clean:
            console.print("[yellow]No cleanable tasks found.[/yellow] Only completed and failed tasks can be cleaned.")
            return

        # Show what will be cleaned
        table = Table(title="Tasks to clean", show_lines=True)
        table.add_column("ID", style="bold cyan", no_wrap=True)
        table.add_column("Pipeline", style="magenta")
        table.add_column("Status", no_wrap=True)
        table.add_column("Description")

        for t in tasks_to_clean:
            desc = (t["description"] or "")[:60]
            table.add_row(t["id"], t["pipeline"], _status_icon(t["status"]), desc)

        console.print(table)

        if dry_run:
            console.print()
            console.print(f"[bold yellow]Dry run:[/bold yellow] {len(tasks_to_clean)} task(s) would be cleaned.")
            return

        if not force:
            if not click.confirm(f"Remove {len(tasks_to_clean)} task(s) and their artifacts?"):
                console.print("[yellow]Aborted.[/yellow]")
                return

        # Clean each task
        cleaned = 0
        errors_list: list[str] = []
        logs_dir = project_dir / ".pegasus" / "logs"

        for t in tasks_to_clean:
            tid = t["id"]

            # Remove worktree if present
            wt_path = t["worktree_path"]
            branch = t["branch"]
            if wt_path:
                err = _remove_worktree(wt_path, branch, project_dir)
                if err:
                    errors_list.append(f"  {tid}: {err}")

            # Delete log files
            for suffix in [".log", ".stderr.log"]:
                log_file = logs_dir / f"{tid}{suffix}"
                if log_file.exists():
                    try:
                        log_file.unlink()
                    except OSError:
                        pass

            # Delete DB rows in FK-safe order: worktrees -> stage_runs -> tasks
            conn.execute("DELETE FROM worktrees WHERE task_id = ?", (tid,))
            conn.execute("DELETE FROM stage_runs WHERE task_id = ?", (tid,))
            conn.execute("DELETE FROM tasks WHERE id = ?", (tid,))
            cleaned += 1

        conn.commit()

        console.print()
        console.print(f"[bold green]Cleaned {cleaned} task(s).[/bold green]")
        if errors_list:
            console.print("[yellow]Warnings:[/yellow]")
            for e in errors_list:
                console.print(e)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# pegasus merge
# ---------------------------------------------------------------------------


@cli.command("merge")
@click.argument("task_id")
@click.option(
    "--project-dir",
    default=".",
    show_default=True,
    help="Project root directory.",
    type=click.Path(exists=True, file_okay=False, dir_okay=True, path_type=Path),
)
def merge(task_id: str, project_dir: Path) -> None:
    """Merge a completed task's worktree branch into the default branch."""
    project_dir = project_dir.resolve()
    db_path = _get_db_path(project_dir)

    if not db_path.exists():
        console.print("[red]Error:[/red] No Pegasus database found. Run [bold]pegasus init[/bold] first.")
        sys.exit(1)

    conn = make_connection(db_path)
    try:
        # 1. Validate task eligibility
        row = conn.execute(
            "SELECT id, status, merge_status, worktree_path, branch, description "
            "FROM tasks WHERE id = ?",
            (task_id,),
        ).fetchone()

        if row is None:
            console.print(f"[red]Error:[/red] Task '{task_id}' not found.")
            sys.exit(1)

        if row["status"] != "completed":
            console.print(
                f"[red]Error:[/red] Task '{task_id}' is in state '{row['status']}'. "
                "Only completed tasks can be merged."
            )
            sys.exit(1)

        merge_status = row["merge_status"]
        if merge_status == "merging":
            console.print(f"[red]Error:[/red] Task '{task_id}' is already being merged.")
            sys.exit(1)
        if merge_status == "merged":
            console.print(f"[red]Error:[/red] Task '{task_id}' has already been merged.")
            sys.exit(1)

        if not row["worktree_path"] or not row["branch"]:
            console.print(f"[red]Error:[/red] Task '{task_id}' has no worktree/branch info.")
            sys.exit(1)

        # 2. Check single-merge lock
        merging_id = is_merge_in_progress(conn)
        if merging_id:
            console.print(
                f"[red]Error:[/red] Another merge is in progress (task {merging_id}). "
                "Wait for it to complete."
            )
            sys.exit(1)

        # 3. Check main repo is clean
        try:
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True,
                text=True,
                cwd=str(project_dir),
                timeout=10,
            )
            if result.stdout.strip():
                console.print(
                    "[red]Error:[/red] Main repo working tree is dirty. "
                    "Commit or stash your changes first."
                )
                sys.exit(1)
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
            console.print(f"[red]Error:[/red] Could not check git status: {exc}")
            sys.exit(1)

        # 4. Atomically set merge_status='merging'
        if not transition_merge_status(conn, task_id, merge_status, "merging"):
            console.print("[red]Error:[/red] Failed to acquire merge lock (status changed concurrently).")
            sys.exit(1)

    finally:
        conn.close()

    # 5. Spawn merge subprocess
    console.print(f"[green]Merging task[/green] [bold]{task_id}[/bold]")
    console.print(f"  Description: {row['description'] or '(none)'}")
    console.print(f"  Branch:      {row['branch']}")

    runner_cmd = [sys.executable, "-m", "pegasus._run_task", task_id, "--merge"]
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
        console.print(f"  Merge PID:   {proc.pid}")
    except Exception as exc:
        console.print(f"[red]Error spawning merger:[/red] {exc}")
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
    from textual.containers import Horizontal, Vertical, VerticalScroll
    from textual.widget import Widget
    from textual.widgets import Footer, Header, Input, Label, Static, Button, Select, TextArea
    from textual import events
    from rich.text import Text as _RichText

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
            pending_question: str | None = None,
            merge_status: str | None = None,
        ) -> None:
            """Refresh the card's displayed content."""
            status_colors: dict[str, str] = {
                "queued": "yellow",
                "running": "cyan",
                "paused": "magenta",
                "completed": "green",
                "failed": "red",
            }
            merge_colors: dict[str, str] = {
                "merged": "green",
                "merging": "cyan",
                "conflict": "red",
                "unmerged": "dim",
            }
            color = status_colors.get(status, "white")
            merge_badge = ""
            if merge_status:
                mc = merge_colors.get(merge_status, "white")
                merge_badge = f" [{mc}]{merge_status}[/{mc}]"
            header_text = (
                f"[bold {color}]{task_id}[/bold {color}] [{color}]{status}[/{color}]{merge_badge}\n"
                f"[dim]{pipeline}[/dim]\n"
                f"{description[:40]}"
            )
            self.query_one("#card-header", Static).update(header_text)
            self.query_one("#card-stages", Static).update(_build_stage_lines(stages))
            if pending_question:
                activity_text = f"[bold yellow]?[/bold yellow] {pending_question[:50]}"
            elif activity:
                activity_text = f"[dim]> {activity[:50]}[/dim]"
            else:
                activity_text = ""
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

    class QuestionBar(Widget):
        """Bottom bar shown when an agent question is pending on the focused task.

        When a stage has ``question:`` set, the pipeline pauses and this bar
        appears with the question text and a text input for the user's answer.
        Pressing Enter (or Escape to cancel) submits or discards the answer.
        """

        DEFAULT_CSS = """
        QuestionBar {
            dock: bottom;
            height: 4;
            border: solid $warning;
            background: $surface;
            padding: 0 1;
            display: none;
        }
        QuestionBar.visible-question {
            display: block;
        }
        #question-text {
            height: 1;
        }
        #question-input {
            height: 1;
        }
        """

        def compose(self) -> ComposeResult:
            yield Static("", id="question-text")
            yield Input(
                placeholder="Type your answer and press Enter…",
                id="question-input",
                disabled=True,
            )

        def show_question(self, question: str) -> None:
            """Display *question* and focus the answer input."""
            self.query_one("#question-text", Static).update(
                f"[bold yellow]?[/bold yellow] {question}"
            )
            inp = self.query_one("#question-input", Input)
            inp.value = ""
            inp.disabled = False
            self.add_class("visible-question")
            inp.focus()

        def hide_question(self) -> None:
            """Hide the bar and clear the input."""
            self.remove_class("visible-question")
            inp = self.query_one("#question-input", Input)
            inp.value = ""
            inp.disabled = True

        def on_input_submitted(self, event: Input.Submitted) -> None:
            """Submit the answer when the user presses Enter."""
            answer = event.value.strip()
            if answer:
                self.app._submit_question_answer(answer)  # type: ignore[attr-defined]

        def on_key(self, event: events.Key) -> None:
            """Escape cancels the question (rejects the task)."""
            if event.key == "escape":
                self.app._cancel_question()  # type: ignore[attr-defined]
                event.prevent_default()

    class TaskCreateModal(Widget):
        """Modal widget for creating new tasks with pipeline selection and description input."""

        DEFAULT_CSS = """
        TaskCreateModal {
            width: 100%;
            height: 100%;
            layer: overlay;
            background: rgba(0, 0, 0, 0.8);
            display: none;
        }
        TaskCreateModal.visible-create {
            display: block;
        }
        #create-dialog {
            width: 100%;
            height: auto;
            background: $surface;
            border: thick $primary;
            margin: 4 8;
            padding: 1;
        }
        #create-form {
            height: auto;
        }
        #pipeline-select {
            margin: 1 0;
        }
        #description-input {
            margin: 1 0;
            height: 8;
        }
        #button-row {
            dock: bottom;
            height: 3;
            margin: 1 0;
        }
        """

        def compose(self) -> ComposeResult:
            with Vertical(id="create-dialog"):
                yield Static("Create New Task", id="dialog-title")
                with Vertical(id="create-form"):
                    yield Static("Pipeline:")
                    yield Select(id="pipeline-select", options=[("", "Select a pipeline...")], allow_blank=True)
                    yield Static("Description:")
                    yield TextArea(id="description-input", placeholder="Describe the task...")
                with Horizontal(id="button-row"):
                    yield Button("Create", variant="primary", id="create-btn")
                    yield Button("Cancel", variant="default", id="cancel-btn")

        def on_button_pressed(self, event: Button.Pressed) -> None:
            """Handle create/cancel button presses."""
            if event.button.id == "cancel-btn":
                self.app.action_dismiss_modal()
            elif event.button.id == "create-btn":
                self._submit_form()

        def on_key(self, event: events.Key) -> None:
            """Handle escape key to close modal and ctrl+enter to submit."""
            if event.key == "escape" and self.has_class("visible-create"):
                self.app.action_dismiss_modal()
                event.prevent_default()
            elif event.key == "enter" and event.ctrl:
                # Ctrl+Enter submits form
                self._submit_form()
                event.prevent_default()

        def _submit_form(self) -> None:
            """Validate form and create task."""
            # Get form values
            select_widget = self.query_one("#pipeline-select", Select)
            description_widget = self.query_one("#description-input", TextArea)

            pipeline = select_widget.value
            description = description_widget.text.strip()

            # Validation
            if not pipeline:
                self.app.notify("Please select a pipeline", severity="error", timeout=3)
                select_widget.focus()
                return

            if not description:
                self.app.notify("Please enter a task description", severity="error", timeout=3)
                description_widget.focus()
                return

            # Create task (delegate to app)
            self.app._create_task_impl(pipeline, description)

    class TaskDetailView(Widget):
        """Full-screen detail panel for a single task.

        Shows task metadata, all stage runs with timing/cost/error, and the
        complete (scrollable) task log.  Hidden by default; shown by adding
        the ``visible-detail`` CSS class.
        """

        DEFAULT_CSS = """
        TaskDetailView {
            height: 1fr;
            display: none;
        }
        TaskDetailView.visible-detail {
            display: block;
        }
        #detail-header {
            height: auto;
            padding: 1;
            background: $surface;
            border-bottom: solid $primary;
        }
        #detail-stages-scroll {
            height: auto;
            max-height: 12;
            border-bottom: solid $surface;
        }
        #detail-stages {
            height: auto;
            padding: 0 1;
        }
        #detail-log-scroll {
            height: 1fr;
        }
        #detail-log {
            height: auto;
            padding: 0 1;
        }
        """

        def compose(self) -> ComposeResult:
            yield Static("", id="detail-header")
            with VerticalScroll(id="detail-stages-scroll"):
                yield Static("", id="detail-stages")
            with VerticalScroll(id="detail-log-scroll"):
                yield Static("", id="detail-log")

        def update_header_stages(self, task_row: Any, stage_rows: list) -> None:
            """Redraw task header and stage table from fresh SQLite rows."""
            status_colors: dict[str, str] = {
                "queued": "yellow",
                "running": "cyan",
                "paused": "magenta",
                "completed": "green",
                "failed": "red",
            }
            color = status_colors.get(task_row["status"], "white")
            cost_str = (
                f"${task_row['total_cost']:.4f}" if task_row["total_cost"] else "$0.0000"
            )
            header = (
                f"[bold {color}]{task_row['id']}[/bold {color}]  "
                f"[{color}]{task_row['status']}[/{color}]\n"
                f"[bold]Pipeline:[/bold]  {task_row['pipeline']}\n"
                f"[bold]Task:[/bold]      {task_row['description'] or '(no description)'}\n"
                f"[bold]Cost:[/bold]      {cost_str}   "
                f"[dim]created {task_row['created_at'] or ''}[/dim]"
            )
            self.query_one("#detail-header", Static).update(header)

            stage_icons: dict[str, str] = {
                "completed": "[bold green]✔[/bold green]",
                "running": "[bold cyan]⟳[/bold cyan]",
                "failed": "[bold red]✘[/bold red]",
                "pending": "[dim]·[/dim]",
                "skipped": "[dim]⊘[/dim]",
            }
            lines: list[str] = []
            for s in stage_rows:
                icon = stage_icons.get(s["status"], "[dim]?[/dim]")
                timing = ""
                if s["started_at"] and s["finished_at"]:
                    timing = f"  [dim]{s['started_at']} → {s['finished_at']}[/dim]"
                elif s["started_at"]:
                    timing = f"  [dim]started {s['started_at']}[/dim]"
                cost_s = f"  [dim]${s['cost']:.4f}[/dim]" if s["cost"] else ""
                error_s = (
                    f"\n    [bold red]{s['error']}[/bold red]" if s["error"] else ""
                )
                lines.append(f"  {icon} {s['stage_id']}{timing}{cost_s}{error_s}")
            stages_text = "\n".join(lines) if lines else "[dim]No stages yet.[/dim]"
            self.query_one("#detail-stages", Static).update(stages_text)

        def update_log(self, log_content: str, scroll_bottom: bool = False) -> None:
            """Replace the log panel content.  Uses rich.text.Text to avoid
            treating log timestamps like ``[2024-01-01]`` as Rich markup."""
            renderable = _RichText(log_content) if log_content else "[dim](no log file yet)[/dim]"
            self.query_one("#detail-log", Static).update(renderable)
            if scroll_bottom:
                self.query_one("#detail-log-scroll", VerticalScroll).scroll_end(animate=False)

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
        PegasusDashboard.detail-mode #task-area {
            display: none;
        }
        PegasusDashboard.detail-mode #log-panel {
            display: none;
        }
        """

        BINDINGS = [
            Binding("d", "toggle_view", "Dashboard", show=True),
            Binding("enter", "open_detail", "Detail", show=True),
            Binding("tab", "focus_next_task", "Next task", show=True, priority=True),
            Binding("shift+tab", "focus_prev_task", "Prev task", show=False, priority=True),
            Binding("n", "create_task", "New task", show=True),
            Binding("m", "merge_task", "Merge", show=True),
            Binding("a", "approve_task", "Approve", show=True),
            Binding("r", "reject_task", "Reject", show=True),
            Binding("c", "clean_task", "Clean", show=True),
            Binding("l", "toggle_logs", "Logs", show=True),
            Binding("escape", "dismiss_modal", "Close", show=False, priority=True),
            Binding("q", "quit_app", "Quit", show=True),
        ]

        _task_data: list = []
        _focused_idx: int = 0
        _logs_visible: bool = False
        _create_visible: bool = False
        _answering_question_id: int | None = None
        _answering_task_id: str | None = None
        _detail_mode: bool = False
        _detail_task_id: str | None = None
        _detail_log_len: int = 0

        def __init__(self, db_path: Path, **kwargs: object) -> None:
            super().__init__(**kwargs)
            self._db_path = db_path
            self._conn: _sqlite3.Connection | None = None

        def on_mount(self) -> None:
            """Run schema migrations, open read-only connection, start polling."""
            try:
                wr_conn = make_connection(self._db_path)
                try:
                    init_db(wr_conn)
                finally:
                    wr_conn.close()
            except Exception:
                pass
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
            yield TaskDetailView(id="detail-view")
            yield LogPanel(id="log-panel")
            yield QuestionBar(id="question-bar")
            yield TaskCreateModal(id="create-modal")
            yield Footer()

        def poll_db(self) -> None:
            """Query SQLite for current tasks/stage_runs; refresh widgets."""
            if self._conn is None:
                return
            try:
                tasks = self._conn.execute(
                    """SELECT id, pipeline, description, status, merge_status
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

                    # Check for a pending agent question on paused tasks.
                    pending_question: str | None = None
                    pending_question_id: int | None = None
                    if t["status"] == "paused":
                        q_row = self._conn.execute(
                            """SELECT id, question FROM agent_questions
                               WHERE task_id = ? AND status = 'pending'
                               ORDER BY id DESC LIMIT 1""",
                            (t["id"],),
                        ).fetchone()
                        if q_row:
                            pending_question_id = q_row["id"]
                            pending_question = q_row["question"]

                    result.append(
                        {
                            "id": t["id"],
                            "pipeline": t["pipeline"],
                            "description": t["description"] or "",
                            "status": t["status"],
                            "merge_status": t["merge_status"],
                            "stages": list(stages),
                            "activity": activity,
                            "pending_question": pending_question,
                            "pending_question_id": pending_question_id,
                        }
                    )
                self._task_data = result
                if self._detail_mode:
                    self._refresh_detail()
                else:
                    self._refresh_cards()
                    if self._logs_visible:
                        self._refresh_logs()
            except Exception as exc:
                if not getattr(self, "_poll_error_shown", False):
                    self._poll_error_shown = True
                    self.notify(f"DB poll error: {exc}", severity="error", timeout=5)

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
                    pending_question=task.get("pending_question"),
                    merge_status=task.get("merge_status"),
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
            idx = self._focused_task_index()
            task_id = tasks[idx]["id"]
            log_dir = self._db_path.parent / "logs"
            log_panel = self.query_one("#log-panel", LogPanel)
            log_panel.show_logs(task_id, log_dir)

        def _focused_task_index(self) -> int:
            """Return the _task_data index of the currently focused TaskCard.

            Checks the real Textual focus state first (handles click-to-focus),
            falls back to _focused_idx (handles Tab cycling).
            """
            focused_widget = self.screen.focused
            if isinstance(focused_widget, TaskCard):
                cards = list(self.query(TaskCard))
                try:
                    idx = cards.index(focused_widget)
                    if idx < len(self._task_data):
                        self._focused_idx = idx
                        return idx
                except ValueError:
                    pass
            return min(self._focused_idx, max(0, len(self._task_data) - 1))

        # ------------------------------------------------------------------
        # Key-action handlers
        # ------------------------------------------------------------------

        def action_toggle_view(self) -> None:
            """D -- return to dashboard from detail view, or hint about Enter key."""
            if self._detail_mode:
                self._close_detail()
            else:
                self.notify("Press Enter on a task card to open the detail view.", timeout=2)

        def action_open_detail(self) -> None:
            """Enter -- open the full detail view for the currently focused task."""
            if self._detail_mode or self._create_visible or not self._task_data:
                return
            idx = min(self._focused_idx, len(self._task_data) - 1)
            task = self._task_data[idx]
            self._detail_task_id = task["id"]
            self._detail_log_len = 0
            self._detail_mode = True
            self.add_class("detail-mode")
            detail = self.query_one("#detail-view", TaskDetailView)
            detail.add_class("visible-detail")
            self._refresh_detail()

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

        def action_merge_task(self) -> None:
            """M -- merge the focused completed task's branch into default branch."""
            if not self._task_data:
                return
            idx = self._focused_task_index()
            task = self._task_data[idx]

            # Validate eligibility
            if task["status"] != "completed":
                self.notify(
                    f"Task {task['id']} is not completed (status: {task['status']})",
                    timeout=3,
                )
                return

            ms = task.get("merge_status")
            if ms == "merging":
                self.notify(f"Task {task['id']} is already being merged", timeout=3)
                return
            if ms == "merged":
                self.notify(f"Task {task['id']} has already been merged", timeout=3)
                return

            try:
                conn = make_connection(self._db_path)
                try:
                    # Single-merge lock
                    merging_id = is_merge_in_progress(conn)
                    if merging_id:
                        self.notify(
                            f"Another merge is in progress (task {merging_id})",
                            severity="error",
                            timeout=4,
                        )
                        return

                    # Check main repo is clean
                    result = subprocess.run(
                        ["git", "status", "--porcelain"],
                        capture_output=True,
                        text=True,
                        cwd=str(self._db_path.parent.parent),
                        timeout=10,
                    )
                    if result.stdout.strip():
                        self.notify(
                            "Main repo working tree is dirty",
                            severity="error",
                            timeout=4,
                        )
                        return

                    # Set merge_status='merging'
                    if not transition_merge_status(conn, task["id"], ms, "merging"):
                        self.notify("Failed to acquire merge lock", severity="error", timeout=4)
                        return
                finally:
                    conn.close()

                # Spawn merge subprocess
                project_dir = self._db_path.parent.parent
                runner_cmd = [sys.executable, "-m", "pegasus._run_task", task["id"], "--merge"]
                env = dict(os.environ)
                env["PEGASUS_PROJECT_DIR"] = str(project_dir)

                proc = subprocess.Popen(
                    runner_cmd,
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                self.notify(f"Merge started for {task['id']} (PID: {proc.pid})", timeout=3)

            except Exception as exc:
                self.notify(f"Merge failed: {exc}", severity="error", timeout=4)

        def action_approve_task(self) -> None:
            """A -- approve the focused paused task.

            If the task has a pending agent question, opens the QuestionBar so
            the user can type an answer.  Otherwise approves directly by writing
            ``status='queued'`` to SQLite.
            """
            if not self._task_data:
                return
            idx = self._focused_task_index()
            task = self._task_data[idx]
            if task["status"] != "paused":
                self.notify(
                    f"Task {task['id']} is not paused (status: {task['status']})", timeout=3
                )
                return
            # If there is a pending question, show the question input bar.
            q_id = task.get("pending_question_id")
            q_text = task.get("pending_question")
            if q_id is not None and q_text:
                self._answering_question_id = q_id
                self._answering_task_id = task["id"]
                question_bar = self.query_one("#question-bar", QuestionBar)
                question_bar.show_question(q_text)
                return
            # No pending question — plain approval.
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

        def _submit_question_answer(self, answer: str) -> None:
            """Write *answer* to the pending agent_questions row and resume the task."""
            if self._answering_question_id is None or self._answering_task_id is None:
                return
            try:
                conn = make_connection(self._db_path)
                try:
                    conn.execute(
                        "UPDATE agent_questions "
                        "SET status = 'answered', answer = ?, "
                        "answered_at = CURRENT_TIMESTAMP "
                        "WHERE id = ?",
                        (answer, self._answering_question_id),
                    )
                    conn.execute(
                        "UPDATE tasks SET status = 'queued', "
                        "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                        (self._answering_task_id,),
                    )
                    conn.commit()
                finally:
                    conn.close()
                self.notify(
                    f"Answer submitted for task {self._answering_task_id}", timeout=2
                )
            except Exception as exc:
                self.notify(f"Submit failed: {exc}", severity="error", timeout=4)
            finally:
                question_bar = self.query_one("#question-bar", QuestionBar)
                question_bar.hide_question()
                self._answering_question_id = None
                self._answering_task_id = None

        def _cancel_question(self) -> None:
            """Dismiss the QuestionBar without answering (does not reject the task)."""
            question_bar = self.query_one("#question-bar", QuestionBar)
            question_bar.hide_question()
            self._answering_question_id = None
            self._answering_task_id = None

        def action_reject_task(self) -> None:
            """R -- reject/mark the focused task as failed."""
            if not self._task_data:
                return
            idx = self._focused_task_index()
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

        def action_clean_task(self) -> None:
            """C -- remove artifacts for the focused completed/failed task."""
            if not self._task_data:
                return
            idx = min(self._focused_idx, len(self._task_data) - 1)
            task = self._task_data[idx]
            if task["status"] not in ("completed", "failed"):
                self.notify(
                    f"Task {task['id']} cannot be cleaned (status: {task['status']})", timeout=3
                )
                return
            try:
                conn = make_connection(self._db_path)
                try:
                    row = conn.execute(
                        "SELECT worktree_path, branch FROM tasks WHERE id = ?",
                        (task["id"],),
                    ).fetchone()
                    if row is None:
                        self.notify(
                            f"Task {task['id']} not found in database.",
                            severity="error",
                            timeout=4,
                        )
                        return

                    project_dir = self._db_path.parent.parent
                    logs_dir = self._db_path.parent / "logs"

                    # Remove worktree if present
                    wt_path = row["worktree_path"]
                    branch = row["branch"]
                    warnings: list[str] = []
                    if wt_path:
                        err = _remove_worktree(wt_path, branch, project_dir)
                        if err:
                            warnings.append(err)

                    # Delete log files
                    for suffix in (".log", ".stderr.log"):
                        log_file = logs_dir / f"{task['id']}{suffix}"
                        if log_file.exists():
                            try:
                                log_file.unlink()
                            except OSError:
                                pass

                    # Delete DB rows in FK-safe order: worktrees -> stage_runs -> tasks
                    conn.execute("DELETE FROM worktrees WHERE task_id = ?", (task["id"],))
                    conn.execute("DELETE FROM stage_runs WHERE task_id = ?", (task["id"],))
                    conn.execute("DELETE FROM tasks WHERE id = ?", (task["id"],))
                    conn.commit()
                finally:
                    conn.close()

                if warnings:
                    self.notify(
                        f"Cleaned task {task['id']} (warnings: {'; '.join(warnings)})",
                        severity="warning",
                        timeout=5,
                    )
                else:
                    self.notify(f"Cleaned task {task['id']}", timeout=2)
            except Exception as exc:
                self.notify(f"Clean failed: {exc}", severity="error", timeout=4)

        def action_toggle_logs(self) -> None:
            """L -- show/hide the log panel (no-op in detail mode)."""
            if self._detail_mode:
                return
            self._logs_visible = not self._logs_visible
            log_panel = self.query_one("#log-panel", LogPanel)
            if self._logs_visible:
                log_panel.add_class("visible-log")
                self._refresh_logs()
            else:
                log_panel.remove_class("visible-log")

        def action_create_task(self) -> None:
            """N -- show the task creation modal."""
            modal = self.query_one("#create-modal", TaskCreateModal)

            # Populate pipeline options
            pipelines = self._discover_pipelines()
            if not pipelines:
                self.notify("No pipelines found in .pegasus/pipelines/", severity="error", timeout=4)
                return

            select_widget = modal.query_one("#pipeline-select", Select)
            select_widget.set_options([(display, name) for name, display in pipelines])

            # Clear previous form data
            modal.query_one("#description-input", TextArea).text = ""

            # Show modal and focus first input
            modal.add_class("visible-create")
            self._create_visible = True
            select_widget.focus()

        def action_dismiss_modal(self) -> None:
            """Escape -- close the detail view, question bar, or modal."""
            if self._detail_mode:
                self._close_detail()
            elif self._answering_question_id is not None:
                self._cancel_question()
            elif self._create_visible:
                modal = self.query_one("#create-modal", TaskCreateModal)
                modal.remove_class("visible-create")
                self._create_visible = False
                # Return focus to task area
                cards = list(self.query(TaskCard))
                if cards:
                    cards[self._focused_idx].focus()

        def _close_detail(self) -> None:
            """Return from detail view to the dashboard view."""
            self._detail_mode = False
            self._detail_task_id = None
            self._detail_log_len = 0
            self.remove_class("detail-mode")
            self.query_one("#detail-view", TaskDetailView).remove_class("visible-detail")
            self._refresh_cards()

        def _refresh_detail(self) -> None:
            """Query the focused task's full data and update TaskDetailView."""
            if not self._detail_mode or not self._detail_task_id or self._conn is None:
                return
            try:
                task_row = self._conn.execute(
                    """SELECT id, pipeline, description, status, total_cost,
                              created_at, updated_at
                       FROM tasks WHERE id = ?""",
                    (self._detail_task_id,),
                ).fetchone()
                if task_row is None:
                    return
                stage_rows = self._conn.execute(
                    """SELECT stage_id, stage_index, status,
                              started_at, finished_at, cost, error
                       FROM stage_runs
                       WHERE task_id = ?
                       ORDER BY stage_index ASC""",
                    (self._detail_task_id,),
                ).fetchall()

                # Read full log file
                log_dir = self._db_path.parent / "logs"
                log_path = log_dir / f"{self._detail_task_id}.log"
                log_content = ""
                if log_path.exists():
                    try:
                        log_content = log_path.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        log_content = "(log unreadable)"

                detail = self.query_one("#detail-view", TaskDetailView)
                detail.update_header_stages(task_row, list(stage_rows))

                # Only update log widget when content actually changed (avoid scroll reset)
                if len(log_content) != self._detail_log_len:
                    scroll_bottom = len(log_content) > self._detail_log_len
                    self._detail_log_len = len(log_content)
                    detail.update_log(log_content, scroll_bottom=scroll_bottom)
            except Exception:
                pass

        def _discover_pipelines(self) -> list[tuple[str, str]]:
            """Discover available pipeline files and return (name, display_name) tuples."""
            project_dir = self._db_path.parent.parent  # Navigate from .pegasus/pegasus.db to project root
            pipelines_dir = project_dir / ".pegasus" / "pipelines"

            if not pipelines_dir.exists():
                return []

            pipelines = []
            for pattern in ["*.yaml", "*.yml"]:
                for path in pipelines_dir.glob(pattern):
                    name = path.stem
                    # Try to read display name from YAML
                    try:
                        with path.open() as f:
                            data = yaml.safe_load(f)
                        display_name = data.get("name", name)
                        pipelines.append((name, f"{display_name} ({name})"))
                    except Exception:
                        pipelines.append((name, name))

            return sorted(pipelines)

        def _create_task_impl(self, pipeline: str, description: str) -> None:
            """Create task in database and spawn subprocess - follows CLI pattern exactly."""
            # Generate task ID (same as CLI)
            task_id = secrets.token_hex(3)

            # Verify pipeline exists (same validation as CLI)
            project_dir = self._db_path.parent.parent
            pipeline_yaml = project_dir / ".pegasus" / "pipelines" / f"{pipeline}.yaml"
            pipeline_yml = project_dir / ".pegasus" / "pipelines" / f"{pipeline}.yml"

            if not pipeline_yaml.exists() and not pipeline_yml.exists():
                self.notify(f"Pipeline '{pipeline}' not found", severity="error", timeout=4)
                return

            try:
                # Insert task into database (same as CLI lines 466-474)
                conn = make_connection(self._db_path)
                try:
                    conn.execute(
                        """INSERT INTO tasks (id, pipeline, description, status)
                           VALUES (?, ?, ?, 'queued')""",
                        (task_id, pipeline, description),
                    )
                    conn.commit()
                finally:
                    conn.close()

                # Spawn subprocess (same as CLI lines 482-495)
                runner_cmd = [sys.executable, "-m", "pegasus._run_task", task_id]
                env = dict(os.environ)
                env["PEGASUS_PROJECT_DIR"] = str(project_dir)

                proc = subprocess.Popen(
                    runner_cmd,
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )

                # Success feedback
                self.notify(f"Task {task_id} created successfully (PID: {proc.pid})", timeout=4)

                # Hide modal and return focus
                self.action_dismiss_modal()

            except Exception as exc:
                self.notify(f"Task creation failed: {exc}", severity="error", timeout=5)

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
