"""CLI integration tests for pegasus.ui Click commands.

Uses Click's CliRunner for CLI testing and tmp_path for all file operations.
The runner subprocess is NOT actually spawned in these tests — subprocess.Popen
is monkeypatched to avoid side effects.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import yaml
from click.testing import CliRunner

from pegasus.models import init_db, make_connection
from pegasus.ui import cli, _detect_language, _detect_default_branch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_project(tmp_path: Path) -> Path:
    """Create a minimal project dir with .pegasus/ scaffolded."""
    pegasus_dir = tmp_path / ".pegasus"
    pipelines_dir = pegasus_dir / "pipelines"
    logs_dir = pegasus_dir / "logs"
    pegasus_dir.mkdir(parents=True)
    pipelines_dir.mkdir()
    logs_dir.mkdir()

    db_path = pegasus_dir / "pegasus.db"
    conn = make_connection(db_path)
    init_db(conn)
    conn.close()

    return tmp_path


def _make_pipeline(pipelines_dir: Path, name: str = "bug-fix") -> Path:
    """Create a minimal valid pipeline YAML file."""
    content = """\
name: Bug Fix
description: Test pipeline

execution:
  mode: session

defaults:
  model: claude-sonnet-4-20250514
  max_turns: 5
  permission_mode: plan

stages:
  - id: analyze
    name: Analysis
    prompt: Analyze the bug.
    claude_flags:
      permission_mode: plan
      max_turns: 3
"""
    path = pipelines_dir / f"{name}.yaml"
    path.write_text(content, encoding="utf-8")
    return path


def _insert_task(
    db_path: Path,
    task_id: str,
    pipeline: str = "bug-fix",
    description: str = "Test task",
    status: str = "queued",
    worktree_path: str | None = None,
    branch: str | None = None,
) -> None:
    conn = make_connection(db_path)
    try:
        conn.execute(
            "INSERT INTO tasks (id, pipeline, description, status, worktree_path, branch) VALUES (?, ?, ?, ?, ?, ?)",
            (task_id, pipeline, description, status, worktree_path, branch),
        )
        conn.commit()
    finally:
        conn.close()


def _insert_stage_run(
    db_path: Path,
    task_id: str,
    stage_id: str,
    stage_index: int,
    status: str = "pending",
    error: str | None = None,
    cost: float = 0.0,
) -> None:
    conn = make_connection(db_path)
    try:
        conn.execute(
            """INSERT INTO stage_runs (task_id, stage_id, stage_index, status, error, cost)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (task_id, stage_id, stage_index, status, error, cost),
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Tests: _detect_language
# ---------------------------------------------------------------------------


class TestDetectLanguage:
    def test_detects_python_from_pyproject_toml(self, tmp_path: Path) -> None:
        (tmp_path / "pyproject.toml").touch()
        assert _detect_language(tmp_path) == "python"

    def test_detects_python_from_setup_py(self, tmp_path: Path) -> None:
        (tmp_path / "setup.py").touch()
        assert _detect_language(tmp_path) == "python"

    def test_detects_node_from_package_json(self, tmp_path: Path) -> None:
        (tmp_path / "package.json").touch()
        assert _detect_language(tmp_path) == "node"

    def test_detects_go_from_go_mod(self, tmp_path: Path) -> None:
        (tmp_path / "go.mod").touch()
        assert _detect_language(tmp_path) == "go"

    def test_detects_rust_from_cargo_toml(self, tmp_path: Path) -> None:
        (tmp_path / "Cargo.toml").touch()
        assert _detect_language(tmp_path) == "rust"

    def test_returns_none_when_no_markers(self, tmp_path: Path) -> None:
        assert _detect_language(tmp_path) is None

    def test_pyproject_takes_precedence_over_package_json(self, tmp_path: Path) -> None:
        # pyproject.toml is listed first so it takes precedence
        (tmp_path / "pyproject.toml").touch()
        (tmp_path / "package.json").touch()
        assert _detect_language(tmp_path) == "python"


# ---------------------------------------------------------------------------
# Tests: pegasus init
# ---------------------------------------------------------------------------


class TestInitCommand:
    def test_init_creates_pegasus_dir(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        assert result.exit_code == 0, result.output
        assert (tmp_path / ".pegasus").is_dir()
        assert (tmp_path / ".pegasus" / "pipelines").is_dir()
        assert (tmp_path / ".pegasus" / "logs").is_dir()

    def test_init_creates_config_yaml(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        assert result.exit_code == 0, result.output
        config_path = tmp_path / ".pegasus" / "config.yaml"
        assert config_path.exists()
        config = yaml.safe_load(config_path.read_text())
        assert config["pegasus"]["version"] == "0.1.0"
        assert "project" in config
        assert "git" in config
        assert "defaults" in config

    def test_init_creates_pipeline_templates(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        assert result.exit_code == 0, result.output
        assert (tmp_path / ".pegasus" / "pipelines" / "bug-fix.yaml").exists()
        assert (tmp_path / ".pegasus" / "pipelines" / "feature.yaml").exists()

    def test_init_creates_sqlite_db(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        assert result.exit_code == 0, result.output
        assert (tmp_path / ".pegasus" / "pegasus.db").exists()

    def test_init_updates_gitignore(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        assert result.exit_code == 0, result.output
        gitignore = (tmp_path / ".gitignore").read_text()
        assert ".pegasus/pegasus.db" in gitignore
        assert ".pegasus/logs/" in gitignore

    def test_init_does_not_overwrite_existing_config(self, tmp_path: Path) -> None:
        pegasus_dir = tmp_path / ".pegasus"
        pegasus_dir.mkdir()
        config_path = pegasus_dir / "config.yaml"
        config_path.write_text("pegasus:\n  version: custom\n", encoding="utf-8")
        runner = CliRunner()
        runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        # Config should remain unchanged
        assert "custom" in config_path.read_text()

    def test_init_detects_python_language(self, tmp_path: Path) -> None:
        (tmp_path / "pyproject.toml").touch()
        runner = CliRunner()
        result = runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        assert result.exit_code == 0, result.output
        config = yaml.safe_load((tmp_path / ".pegasus" / "config.yaml").read_text())
        assert config["project"]["language"] == "python"

    def test_init_accepts_language_override(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(
            cli, ["init", "--project-dir", str(tmp_path), "--language", "rust"]
        )
        assert result.exit_code == 0, result.output
        config = yaml.safe_load((tmp_path / ".pegasus" / "config.yaml").read_text())
        assert config["project"]["language"] == "rust"

    def test_init_accepts_test_command_override(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(
            cli,
            ["init", "--project-dir", str(tmp_path), "--test-command", "python3 -m pytest -x"],
        )
        assert result.exit_code == 0, result.output
        config = yaml.safe_load((tmp_path / ".pegasus" / "config.yaml").read_text())
        assert config["project"]["test_command"] == "python3 -m pytest -x"

    def test_init_output_contains_success_message(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        assert result.exit_code == 0
        assert "Pegasus initialised successfully" in result.output

    def test_init_idempotent(self, tmp_path: Path) -> None:
        """Running init twice should not fail."""
        runner = CliRunner()
        r1 = runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        r2 = runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        assert r1.exit_code == 0, r1.output
        assert r2.exit_code == 0, r2.output

    def test_init_validates_pipeline_templates(self, tmp_path: Path) -> None:
        """The generated pipeline templates should be valid YAML."""
        runner = CliRunner()
        runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        for name in ["bug-fix.yaml", "feature.yaml"]:
            path = tmp_path / ".pegasus" / "pipelines" / name
            content = yaml.safe_load(path.read_text())
            assert "name" in content
            assert "stages" in content
            assert len(content["stages"]) >= 2

    def test_init_appends_to_existing_gitignore(self, tmp_path: Path) -> None:
        gitignore = tmp_path / ".gitignore"
        gitignore.write_text("*.pyc\n__pycache__/\n", encoding="utf-8")
        runner = CliRunner()
        runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        content = gitignore.read_text()
        assert "*.pyc" in content
        assert ".pegasus/pegasus.db" in content

    def test_init_does_not_duplicate_gitignore_entries(self, tmp_path: Path) -> None:
        runner = CliRunner()
        runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        content = (tmp_path / ".gitignore").read_text()
        # The sentinel comment should appear exactly once (prevents block duplication)
        assert content.count("# Pegasus runtime files") == 1
        # And the exact entry should appear exactly once as a complete line
        lines = content.splitlines()
        assert lines.count(".pegasus/pegasus.db") == 1


# ---------------------------------------------------------------------------
# Tests: pegasus validate
# ---------------------------------------------------------------------------


class TestValidateCommand:
    def test_validate_no_pipelines_dir(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["validate", "--project-dir", str(tmp_path)])
        assert result.exit_code != 0
        assert "No pipelines directory found" in result.output

    def test_validate_empty_pipelines_dir(self, tmp_path: Path) -> None:
        (tmp_path / ".pegasus" / "pipelines").mkdir(parents=True)
        runner = CliRunner()
        result = runner.invoke(cli, ["validate", "--project-dir", str(tmp_path)])
        # Empty dir → no files found
        assert "No pipeline files found" in result.output

    def test_validate_valid_pipeline_passes(self, tmp_path: Path) -> None:
        pipelines_dir = tmp_path / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        _make_pipeline(pipelines_dir, "bug-fix")
        runner = CliRunner()
        result = runner.invoke(cli, ["validate", "--project-dir", str(tmp_path)])
        assert result.exit_code == 0, result.output
        assert "PASS" in result.output
        assert "valid" in result.output

    def test_validate_invalid_pipeline_fails(self, tmp_path: Path) -> None:
        pipelines_dir = tmp_path / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        # Invalid: missing required 'stages' key
        (pipelines_dir / "bad.yaml").write_text("name: Bad\n", encoding="utf-8")
        runner = CliRunner()
        result = runner.invoke(cli, ["validate", "--project-dir", str(tmp_path)])
        assert result.exit_code != 0
        assert "FAIL" in result.output

    def test_validate_reports_unknown_flag(self, tmp_path: Path) -> None:
        pipelines_dir = tmp_path / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        content = """\
name: Bad Flags
stages:
  - id: analyze
    name: Analysis
    prompt: Test
    claude_flags:
      unknown_flag: value
"""
        (pipelines_dir / "bad-flags.yaml").write_text(content, encoding="utf-8")
        runner = CliRunner()
        result = runner.invoke(cli, ["validate", "--project-dir", str(tmp_path)])
        assert result.exit_code != 0
        assert "Unknown claude_flag" in result.output or "FAIL" in result.output

    def test_validate_specific_pipeline(self, tmp_path: Path) -> None:
        pipelines_dir = tmp_path / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        _make_pipeline(pipelines_dir, "my-pipeline")
        runner = CliRunner()
        result = runner.invoke(
            cli,
            ["validate", "--project-dir", str(tmp_path), "--pipeline", "my-pipeline"],
        )
        assert result.exit_code == 0, result.output
        assert "PASS" in result.output

    def test_validate_specific_pipeline_not_found(self, tmp_path: Path) -> None:
        pipelines_dir = tmp_path / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        runner = CliRunner()
        result = runner.invoke(
            cli,
            ["validate", "--project-dir", str(tmp_path), "--pipeline", "nonexistent"],
        )
        assert result.exit_code != 0
        assert "not found" in result.output

    def test_validate_multiple_pipelines(self, tmp_path: Path) -> None:
        pipelines_dir = tmp_path / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        _make_pipeline(pipelines_dir, "pipe-a")
        _make_pipeline(pipelines_dir, "pipe-b")
        runner = CliRunner()
        result = runner.invoke(cli, ["validate", "--project-dir", str(tmp_path)])
        assert result.exit_code == 0, result.output
        assert "2 pipeline(s) are valid" in result.output

    def test_validate_error_count_in_output(self, tmp_path: Path) -> None:
        pipelines_dir = tmp_path / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        _make_pipeline(pipelines_dir, "good")
        (pipelines_dir / "bad.yaml").write_text("name: Bad\n", encoding="utf-8")
        runner = CliRunner()
        result = runner.invoke(cli, ["validate", "--project-dir", str(tmp_path)])
        assert result.exit_code != 0
        assert "PASS" in result.output
        assert "FAIL" in result.output


# ---------------------------------------------------------------------------
# Tests: pegasus status
# ---------------------------------------------------------------------------


class TestStatusCommand:
    def test_status_no_db(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["status", "--project-dir", str(tmp_path)])
        assert result.exit_code != 0
        assert "No Pegasus database found" in result.output

    def test_status_empty_db(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        runner = CliRunner()
        result = runner.invoke(cli, ["status", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "No tasks found" in result.output

    def test_status_lists_tasks(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "abc123", pipeline="bug-fix", description="Fix login")
        runner = CliRunner()
        result = runner.invoke(cli, ["status", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "abc123" in result.output
        assert "bug-fix" in result.output
        # Rich table may wrap "Fix login" across two lines with the Merge column
        assert "Fix" in result.output
        assert "login" in result.output

    def test_status_shows_task_status(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "abc123", status="running")
        runner = CliRunner()
        result = runner.invoke(cli, ["status", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "running" in result.output

    def test_status_single_task_detail(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "abc123", pipeline="bug-fix", description="Detailed task")
        runner = CliRunner()
        result = runner.invoke(cli, ["status", "abc123", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "abc123" in result.output
        assert "Detailed task" in result.output
        assert "bug-fix" in result.output

    def test_status_single_task_not_found(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        runner = CliRunner()
        result = runner.invoke(cli, ["status", "zzzzzz", "--project-dir", str(project)])
        assert result.exit_code != 0
        assert "not found" in result.output

    def test_status_shows_stage_runs(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "abc123", status="running")
        _insert_stage_run(db_path, "abc123", "analyze", 0, status="completed", cost=0.01)
        _insert_stage_run(db_path, "abc123", "implement", 1, status="running")
        runner = CliRunner()
        result = runner.invoke(cli, ["status", "abc123", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "analyze" in result.output
        assert "implement" in result.output

    def test_status_multiple_tasks(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        for i, (tid, status) in enumerate(
            [("aaa111", "completed"), ("bbb222", "failed"), ("ccc333", "running")]
        ):
            _insert_task(db_path, tid, status=status)
        runner = CliRunner()
        result = runner.invoke(cli, ["status", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "aaa111" in result.output
        assert "bbb222" in result.output
        assert "ccc333" in result.output

    def test_status_shows_cost(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "costtest")
        # Update cost directly
        conn = make_connection(db_path)
        conn.execute("UPDATE tasks SET total_cost = 0.1234 WHERE id = 'costtest'")
        conn.commit()
        conn.close()
        runner = CliRunner()
        result = runner.invoke(cli, ["status", "costtest", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "0.1234" in result.output


# ---------------------------------------------------------------------------
# Tests: pegasus run
# ---------------------------------------------------------------------------


class TestRunCommand:
    def test_run_requires_init(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(
            cli,
            ["run", "--pipeline", "bug-fix", "--desc", "Test", "--project-dir", str(tmp_path)],
        )
        assert result.exit_code != 0
        assert "not initialised" in result.output or "init" in result.output.lower()

    def test_run_fails_on_missing_pipeline(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        runner = CliRunner()
        result = runner.invoke(
            cli,
            [
                "run",
                "--pipeline",
                "nonexistent",
                "--desc",
                "Test",
                "--project-dir",
                str(project),
            ],
        )
        assert result.exit_code != 0
        assert "not found" in result.output

    def test_run_creates_task_in_db(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        pipelines_dir = project / ".pegasus" / "pipelines"
        _make_pipeline(pipelines_dir, "bug-fix")
        mock_proc = MagicMock()
        mock_proc.pid = 99999
        with patch("pegasus.ui.subprocess.Popen", return_value=mock_proc):
            runner = CliRunner()
            result = runner.invoke(
                cli,
                [
                    "run",
                    "--pipeline",
                    "bug-fix",
                    "--desc",
                    "Test description",
                    "--project-dir",
                    str(project),
                ],
            )
        assert result.exit_code == 0, result.output
        # Verify task was inserted into the DB
        db_path = project / ".pegasus" / "pegasus.db"
        conn = make_connection(db_path, read_only=True)
        rows = conn.execute("SELECT * FROM tasks WHERE pipeline = 'bug-fix'").fetchall()
        conn.close()
        assert len(rows) == 1
        assert rows[0]["description"] == "Test description"
        assert rows[0]["status"] == "queued"

    def test_run_spawns_subprocess(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        pipelines_dir = project / ".pegasus" / "pipelines"
        _make_pipeline(pipelines_dir, "bug-fix")
        mock_proc = MagicMock()
        mock_proc.pid = 12345
        with patch("pegasus.ui.subprocess.Popen", return_value=mock_proc) as mock_popen:
            runner = CliRunner()
            result = runner.invoke(
                cli,
                [
                    "run",
                    "--pipeline",
                    "bug-fix",
                    "--desc",
                    "Spawn test",
                    "--project-dir",
                    str(project),
                ],
            )
        assert result.exit_code == 0, result.output
        mock_popen.assert_called_once()
        call_args = mock_popen.call_args
        cmd = call_args[0][0]
        assert "_run_task" in " ".join(cmd)
        assert "12345" in result.output

    def test_run_dry_run_does_not_insert_task(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        pipelines_dir = project / ".pegasus" / "pipelines"
        _make_pipeline(pipelines_dir, "bug-fix")
        runner = CliRunner()
        result = runner.invoke(
            cli,
            [
                "run",
                "--pipeline",
                "bug-fix",
                "--desc",
                "Dry run test",
                "--dry-run",
                "--project-dir",
                str(project),
            ],
        )
        assert result.exit_code == 0, result.output
        assert "Dry run" in result.output
        # DB should be empty (no task inserted)
        db_path = project / ".pegasus" / "pegasus.db"
        conn = make_connection(db_path, read_only=True)
        rows = conn.execute("SELECT * FROM tasks").fetchall()
        conn.close()
        assert len(rows) == 0

    def test_run_prints_task_id(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        pipelines_dir = project / ".pegasus" / "pipelines"
        _make_pipeline(pipelines_dir, "bug-fix")
        mock_proc = MagicMock()
        mock_proc.pid = 1111
        with patch("pegasus.ui.subprocess.Popen", return_value=mock_proc):
            runner = CliRunner()
            result = runner.invoke(
                cli,
                [
                    "run",
                    "--pipeline",
                    "bug-fix",
                    "--desc",
                    "Task ID test",
                    "--project-dir",
                    str(project),
                ],
            )
        assert result.exit_code == 0, result.output
        assert "Task created" in result.output


# ---------------------------------------------------------------------------
# Tests: pegasus resume
# ---------------------------------------------------------------------------


class TestResumeCommand:
    def test_resume_no_db(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["resume", "abc123", "--project-dir", str(tmp_path)])
        assert result.exit_code != 0
        assert "No Pegasus database found" in result.output

    def test_resume_task_not_found(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        runner = CliRunner()
        result = runner.invoke(cli, ["resume", "zzzzzz", "--project-dir", str(project)])
        assert result.exit_code != 0
        assert "not found" in result.output

    def test_resume_queued_task_fails(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "abc123", status="queued")
        runner = CliRunner()
        result = runner.invoke(cli, ["resume", "abc123", "--project-dir", str(project)])
        assert result.exit_code != 0
        assert "cannot be resumed" in result.output

    def test_resume_completed_task_fails(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "abc123", status="completed")
        runner = CliRunner()
        result = runner.invoke(cli, ["resume", "abc123", "--project-dir", str(project)])
        assert result.exit_code != 0
        assert "cannot be resumed" in result.output

    def test_resume_failed_task_spawns_subprocess(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "abc123", status="failed")
        mock_proc = MagicMock()
        mock_proc.pid = 55555
        with patch("pegasus.ui.subprocess.Popen", return_value=mock_proc) as mock_popen:
            runner = CliRunner()
            result = runner.invoke(cli, ["resume", "abc123", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        mock_popen.assert_called_once()
        call_args = mock_popen.call_args
        cmd = call_args[0][0]
        assert "--resume" in cmd
        assert "abc123" in cmd
        assert "55555" in result.output

    def test_resume_paused_task_spawns_subprocess(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "xyz789", status="paused")
        mock_proc = MagicMock()
        mock_proc.pid = 77777
        with patch("pegasus.ui.subprocess.Popen", return_value=mock_proc):
            runner = CliRunner()
            result = runner.invoke(cli, ["resume", "xyz789", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "Resuming task" in result.output

    def test_resume_passes_project_dir_env(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "abc123", status="failed")
        mock_proc = MagicMock()
        mock_proc.pid = 99999
        with patch("pegasus.ui.subprocess.Popen", return_value=mock_proc) as mock_popen:
            runner = CliRunner()
            runner.invoke(cli, ["resume", "abc123", "--project-dir", str(project)])
        env = mock_popen.call_args[1]["env"]
        assert env["PEGASUS_PROJECT_DIR"] == str(project)


# ---------------------------------------------------------------------------
# Tests: pegasus clean
# ---------------------------------------------------------------------------


class TestCleanCommand:
    def test_clean_no_db(self, tmp_path: Path) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["clean", "--project-dir", str(tmp_path)])
        assert result.exit_code != 0
        assert "No Pegasus database found" in result.output

    def test_clean_no_cleanable_tasks(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "running1", status="running")
        _insert_task(db_path, "queued1", status="queued")
        runner = CliRunner()
        result = runner.invoke(cli, ["clean", "--force", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "No cleanable tasks found" in result.output

    def test_clean_removes_failed_tasks(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "fail1", status="failed")
        _insert_stage_run(db_path, "fail1", "analyze", 0, status="completed")
        _insert_stage_run(db_path, "fail1", "implement", 1, status="failed", error="boom")
        with patch("pegasus.ui.subprocess.run"):
            runner = CliRunner()
            result = runner.invoke(cli, ["clean", "--force", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "Cleaned 1 task(s)" in result.output
        # Verify DB rows deleted
        conn = make_connection(db_path, read_only=True)
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM stage_runs").fetchone()[0] == 0
        conn.close()

    def test_clean_removes_completed_tasks(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "done1", status="completed")
        with patch("pegasus.ui.subprocess.run"):
            runner = CliRunner()
            result = runner.invoke(cli, ["clean", "--force", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "Cleaned 1 task(s)" in result.output
        conn = make_connection(db_path, read_only=True)
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
        conn.close()

    def test_clean_preserves_active_tasks(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "running1", status="running")
        _insert_task(db_path, "queued1", status="queued")
        _insert_task(db_path, "paused1", status="paused")
        _insert_task(db_path, "fail1", status="failed")
        with patch("pegasus.ui.subprocess.run"):
            runner = CliRunner()
            result = runner.invoke(cli, ["clean", "--force", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "Cleaned 1 task(s)" in result.output
        # Active tasks should remain
        conn = make_connection(db_path, read_only=True)
        remaining = conn.execute("SELECT id FROM tasks ORDER BY id").fetchall()
        remaining_ids = {r["id"] for r in remaining}
        assert remaining_ids == {"running1", "queued1", "paused1"}
        conn.close()

    def test_clean_removes_log_files(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        logs_dir = project / ".pegasus" / "logs"
        _insert_task(db_path, "logtest", status="failed")
        # Create log files
        (logs_dir / "logtest.log").write_text("some log output", encoding="utf-8")
        (logs_dir / "logtest.stderr.log").write_text("some stderr", encoding="utf-8")
        with patch("pegasus.ui.subprocess.run"):
            runner = CliRunner()
            result = runner.invoke(cli, ["clean", "--force", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert not (logs_dir / "logtest.log").exists()
        assert not (logs_dir / "logtest.stderr.log").exists()

    def test_clean_dry_run(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "dry1", status="failed")
        _insert_stage_run(db_path, "dry1", "analyze", 0, status="failed")
        runner = CliRunner()
        result = runner.invoke(cli, ["clean", "--dry-run", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "Dry run" in result.output
        # DB should be unchanged
        conn = make_connection(db_path, read_only=True)
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM stage_runs").fetchone()[0] == 1
        conn.close()

    def test_clean_specific_task(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "fail1", status="failed")
        _insert_task(db_path, "fail2", status="failed")
        with patch("pegasus.ui.subprocess.run"):
            runner = CliRunner()
            result = runner.invoke(cli, ["clean", "fail1", "--force", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "Cleaned 1 task(s)" in result.output
        # Only fail1 should be removed, fail2 should remain
        conn = make_connection(db_path, read_only=True)
        remaining = conn.execute("SELECT id FROM tasks").fetchall()
        remaining_ids = {r["id"] for r in remaining}
        assert remaining_ids == {"fail2"}
        conn.close()

    def test_clean_specific_task_not_cleanable(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "running1", status="running")
        runner = CliRunner()
        result = runner.invoke(cli, ["clean", "running1", "--force", "--project-dir", str(project)])
        assert result.exit_code != 0
        assert "cannot be cleaned" in result.output

    def test_clean_worktree_db_rows_deleted(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        _insert_task(db_path, "wt1", status="completed", worktree_path="/tmp/fake-wt", branch="pegasus/wt1")
        # Insert a worktree row
        conn = make_connection(db_path)
        conn.execute(
            "INSERT INTO worktrees (task_id, path, branch) VALUES (?, ?, ?)",
            ("wt1", "/tmp/fake-wt", "pegasus/wt1"),
        )
        conn.commit()
        conn.close()
        with patch("pegasus.ui.subprocess.run"):
            runner = CliRunner()
            result = runner.invoke(cli, ["clean", "--force", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        conn = make_connection(db_path, read_only=True)
        assert conn.execute("SELECT COUNT(*) FROM worktrees").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
        conn.close()

    def test_clean_handles_missing_worktree(self, tmp_path: Path) -> None:
        project = _make_project(tmp_path)
        db_path = project / ".pegasus" / "pegasus.db"
        # worktree_path points to a directory that doesn't exist
        _insert_task(
            db_path, "gone1", status="failed",
            worktree_path="/tmp/nonexistent-worktree-12345",
            branch="pegasus/gone1",
        )
        with patch("pegasus.ui.subprocess.run"):
            runner = CliRunner()
            result = runner.invoke(cli, ["clean", "--force", "--project-dir", str(project)])
        assert result.exit_code == 0, result.output
        assert "Cleaned 1 task(s)" in result.output
        conn = make_connection(db_path, read_only=True)
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
        conn.close()


# ---------------------------------------------------------------------------
# Tests: _run_task module
# ---------------------------------------------------------------------------


class TestRunTaskModule:
    def test_module_importable(self) -> None:
        import pegasus._run_task  # noqa: F401 — import check

    def test_main_without_args_exits_nonzero(self) -> None:
        import pegasus._run_task as rt

        orig_argv = __import__("sys").argv
        try:
            __import__("sys").argv = ["pegasus._run_task"]
            with pytest.raises(SystemExit) as exc_info:
                rt.main()
            assert exc_info.value.code != 0
        finally:
            __import__("sys").argv = orig_argv


# ---------------------------------------------------------------------------
# Tests: Textual TUI dashboard (PegasusDashboard)
# ---------------------------------------------------------------------------


def _make_tui_project(tmp_path: Path) -> tuple[Path, Path]:
    """Create a minimal project with an initialised pegasus.db.

    Returns (project_dir, db_path).
    """
    project = _make_project(tmp_path)
    db_path = project / ".pegasus" / "pegasus.db"
    return project, db_path


class TestBuildStageLines:
    """Unit tests for _build_stage_lines helper."""

    def test_empty_stages_returns_placeholder(self) -> None:
        from pegasus.ui import _build_stage_lines

        result = _build_stage_lines([])
        assert "No stages" in result

    def test_stages_include_stage_ids(self) -> None:
        from pegasus.ui import _build_stage_lines

        # Simulate sqlite3.Row-like objects with dict interface
        class FakeRow(dict):
            def __getitem__(self, key):  # type: ignore[override]
                return super().__getitem__(key)

        stages = [
            FakeRow({"stage_id": "analyze", "status": "completed"}),
            FakeRow({"stage_id": "implement", "status": "running"}),
            FakeRow({"stage_id": "verify", "status": "pending"}),
        ]
        result = _build_stage_lines(stages)
        assert "analyze" in result
        assert "implement" in result
        assert "verify" in result

    def test_unknown_status_shows_question_mark(self) -> None:
        from pegasus.ui import _build_stage_lines

        class FakeRow(dict):
            def __getitem__(self, key):  # type: ignore[override]
                return super().__getitem__(key)

        stages = [FakeRow({"stage_id": "weird", "status": "unknown_status"})]
        result = _build_stage_lines(stages)
        assert "weird" in result
        assert "?" in result


class TestPegasusDashboardApp:
    """Textual Pilot tests for PegasusDashboard."""

    @pytest.mark.asyncio
    async def test_app_launches_and_renders_header(self, tmp_path: Path) -> None:
        """App should start without errors and show the Pegasus header."""
        _, db_path = _make_tui_project(tmp_path)
        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.1)
            assert app.TITLE == "Pegasus Dashboard"

    @pytest.mark.asyncio
    async def test_app_shows_no_tasks_placeholder(self, tmp_path: Path) -> None:
        """Empty DB should show 'No active tasks' placeholder."""
        _, db_path = _make_tui_project(tmp_path)
        from textual.widgets import Label

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.3)  # Let poll_db fire
            labels = list(app.query(Label))
            label_texts = [str(lbl.render()) for lbl in labels]
            combined = " ".join(label_texts)
            assert "No active tasks" in combined

    @pytest.mark.asyncio
    async def test_poll_db_populates_task_cards(self, tmp_path: Path) -> None:
        """After inserting a task in SQLite, poll_db should create a TaskCard."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "abc123", pipeline="bug-fix", description="Fix login bug")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)  # Wait for at least 2 poll cycles
            # _task_data should have been populated
            assert len(app._task_data) == 1
            assert app._task_data[0]["id"] == "abc123"

    @pytest.mark.asyncio
    async def test_poll_db_reflects_multiple_tasks(self, tmp_path: Path) -> None:
        """Multiple tasks should all appear in _task_data."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "task01", pipeline="bug-fix", status="running")
        _insert_task(db_path, "task02", pipeline="feature", status="queued")
        _insert_task(db_path, "task03", pipeline="bug-fix", status="completed")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            ids = {t["id"] for t in app._task_data}
            assert "task01" in ids
            assert "task02" in ids
            assert "task03" in ids

    @pytest.mark.asyncio
    async def test_poll_db_includes_stage_runs(self, tmp_path: Path) -> None:
        """Stage runs for a task should appear in the task's stages list."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "stagetest", pipeline="bug-fix", status="running")
        _insert_stage_run(db_path, "stagetest", "analyze", 0, status="completed")
        _insert_stage_run(db_path, "stagetest", "implement", 1, status="running")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            assert len(app._task_data) == 1
            stages = app._task_data[0]["stages"]
            stage_ids = [s["stage_id"] for s in stages]
            assert "analyze" in stage_ids
            assert "implement" in stage_ids

    @pytest.mark.asyncio
    async def test_running_stage_shown_as_activity(self, tmp_path: Path) -> None:
        """The running stage_id should populate the activity field."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "acttest", pipeline="bug-fix", status="running")
        _insert_stage_run(db_path, "acttest", "analyze", 0, status="completed")
        _insert_stage_run(db_path, "acttest", "implement", 1, status="running")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            assert app._task_data[0]["activity"] == "implement"

    @pytest.mark.asyncio
    async def test_quit_binding(self, tmp_path: Path) -> None:
        """Pressing Q should quit the app."""
        _, db_path = _make_tui_project(tmp_path)
        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.1)
            await pilot.press("q")
        # App exited without exception — test passes

    @pytest.mark.asyncio
    async def test_toggle_logs_binding(self, tmp_path: Path) -> None:
        """Pressing L should toggle _logs_visible."""
        _, db_path = _make_tui_project(tmp_path)
        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.1)
            assert app._logs_visible is False
            await pilot.press("l")
            await pilot.pause(0.05)
            assert app._logs_visible is True
            await pilot.press("l")
            await pilot.pause(0.05)
            assert app._logs_visible is False

    @pytest.mark.asyncio
    async def test_tab_cycles_focus_idx(self, tmp_path: Path) -> None:
        """Tab should increment the focused task index (wrapping around)."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "t1", pipeline="bug-fix", status="running")
        _insert_task(db_path, "t2", pipeline="feature", status="queued")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)  # Cards must be mounted before tab
            initial_idx = app._focused_idx
            await pilot.press("tab")
            await pilot.pause(0.05)
            assert app._focused_idx == (initial_idx + 1) % len(app._task_data)

    @pytest.mark.asyncio
    async def test_approve_paused_task_writes_db(self, tmp_path: Path) -> None:
        """Pressing A on a paused task should transition it to queued in SQLite."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "pausedtask", pipeline="bug-fix", status="paused")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)  # Let poll populate _task_data
            await pilot.press("a")
            await pilot.pause(0.1)

        # Verify SQLite was updated
        conn = make_connection(db_path, read_only=True)
        row = conn.execute("SELECT status FROM tasks WHERE id = 'pausedtask'").fetchone()
        conn.close()
        assert row["status"] == "queued"

    @pytest.mark.asyncio
    async def test_reject_paused_task_writes_db(self, tmp_path: Path) -> None:
        """Pressing R on a paused task should set it to failed in SQLite."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "rejecttask", pipeline="bug-fix", status="paused")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("r")
            await pilot.pause(0.1)

        conn = make_connection(db_path, read_only=True)
        row = conn.execute("SELECT status FROM tasks WHERE id = 'rejecttask'").fetchone()
        conn.close()
        assert row["status"] == "failed"

    @pytest.mark.asyncio
    async def test_approve_non_paused_task_shows_notification(self, tmp_path: Path) -> None:
        """Pressing A on a running task should NOT change its status."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "runningtask", pipeline="bug-fix", status="running")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("a")
            await pilot.pause(0.1)

        conn = make_connection(db_path, read_only=True)
        row = conn.execute("SELECT status FROM tasks WHERE id = 'runningtask'").fetchone()
        conn.close()
        # Status should remain unchanged
        assert row["status"] == "running"

    @pytest.mark.asyncio
    async def test_approve_targets_selected_task_not_first(self, tmp_path: Path) -> None:
        """Pressing A after tabbing to the second task should approve only that task."""
        _, db_path = _make_tui_project(tmp_path)
        # Insert two tasks; ORDER BY created_at DESC puts task-first at index 0.
        conn = make_connection(db_path)
        conn.execute(
            "INSERT INTO tasks (id, pipeline, description, status, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            ("task-first", "bug-fix", "First", "running", "2026-01-02T00:00:00"),
        )
        conn.execute(
            "INSERT INTO tasks (id, pipeline, description, status, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            ("task-second", "bug-fix", "Second", "paused", "2026-01-01T00:00:00"),
        )
        conn.commit()
        conn.close()

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            # Tab once to move focus from task-first (idx 0) to task-second (idx 1)
            await pilot.press("tab")
            await pilot.pause(0.05)
            await pilot.press("a")
            await pilot.pause(0.1)

        conn = make_connection(db_path, read_only=True)
        first = conn.execute("SELECT status FROM tasks WHERE id = 'task-first'").fetchone()
        second = conn.execute("SELECT status FROM tasks WHERE id = 'task-second'").fetchone()
        conn.close()
        assert first["status"] == "running", "First task should be unchanged"
        assert second["status"] == "queued", "Second (focused) task should be approved"

    @pytest.mark.asyncio
    async def test_reject_targets_selected_task_not_first(self, tmp_path: Path) -> None:
        """Pressing R after tabbing to the second task should reject only that task."""
        _, db_path = _make_tui_project(tmp_path)
        conn = make_connection(db_path)
        conn.execute(
            "INSERT INTO tasks (id, pipeline, description, status, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            ("task-first", "bug-fix", "First", "running", "2026-01-02T00:00:00"),
        )
        conn.execute(
            "INSERT INTO tasks (id, pipeline, description, status, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            ("task-second", "bug-fix", "Second", "paused", "2026-01-01T00:00:00"),
        )
        conn.commit()
        conn.close()

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("tab")
            await pilot.pause(0.05)
            await pilot.press("r")
            await pilot.pause(0.1)

        conn = make_connection(db_path, read_only=True)
        first = conn.execute("SELECT status FROM tasks WHERE id = 'task-first'").fetchone()
        second = conn.execute("SELECT status FROM tasks WHERE id = 'task-second'").fetchone()
        conn.close()
        assert first["status"] == "running", "First task should be unchanged"
        assert second["status"] == "failed", "Second (focused) task should be rejected"

    @pytest.mark.asyncio
    async def test_log_panel_reads_log_file(self, tmp_path: Path) -> None:
        """LogPanel.show_logs should read lines from the task's .log file."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "logtask", pipeline="bug-fix", status="running")

        # Create a log file
        log_dir = db_path.parent / "logs"
        log_dir.mkdir(exist_ok=True)
        log_file = log_dir / "logtask.log"
        log_file.write_text("Line 1\nLine 2\nLine 3\n", encoding="utf-8")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("l")  # Toggle logs visible
            await pilot.pause(0.2)
            from textual.widgets import Static

            log_content = app.query_one("#log-content", Static)
            content_str = str(log_content.render())
            assert "Line" in content_str or "log" in content_str.lower()

    @pytest.mark.asyncio
    async def test_no_db_handled_gracefully(self, tmp_path: Path) -> None:
        """App should not crash when DB path doesn't exist — conn is None."""
        missing_db = tmp_path / "nonexistent.db"
        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=missing_db)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.3)
            # App should still be running, just with empty task data
            assert app._task_data == []

    @pytest.mark.asyncio
    async def test_clean_completed_task_removes_db_records(self, tmp_path: Path) -> None:
        """Pressing C on a completed task should remove it and its stage_runs from SQLite."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "donetask", pipeline="bug-fix", status="completed")
        _insert_stage_run(db_path, "donetask", "analyze", 0, status="completed")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)  # Let poll populate _task_data
            await pilot.press("c")
            await pilot.pause(0.2)

        conn = make_connection(db_path, read_only=True)
        task_count = conn.execute("SELECT COUNT(*) FROM tasks WHERE id = 'donetask'").fetchone()[0]
        stage_count = conn.execute(
            "SELECT COUNT(*) FROM stage_runs WHERE task_id = 'donetask'"
        ).fetchone()[0]
        conn.close()
        assert task_count == 0
        assert stage_count == 0

    @pytest.mark.asyncio
    async def test_clean_failed_task_removes_db_records(self, tmp_path: Path) -> None:
        """Pressing C on a failed task should remove it from SQLite."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "failtask", pipeline="bug-fix", status="failed")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("c")
            await pilot.pause(0.2)

        conn = make_connection(db_path, read_only=True)
        row = conn.execute("SELECT id FROM tasks WHERE id = 'failtask'").fetchone()
        conn.close()
        assert row is None

    @pytest.mark.asyncio
    async def test_clean_non_cleanable_task_does_not_modify_db(self, tmp_path: Path) -> None:
        """Pressing C on a running task should NOT remove or alter it."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "activetask", pipeline="bug-fix", status="running")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("c")
            await pilot.pause(0.1)

        conn = make_connection(db_path, read_only=True)
        row = conn.execute("SELECT status FROM tasks WHERE id = 'activetask'").fetchone()
        conn.close()
        assert row is not None
        assert row["status"] == "running"

    @pytest.mark.asyncio
    async def test_clean_task_removes_log_files(self, tmp_path: Path) -> None:
        """Pressing C on a completed task should delete its .log and .stderr.log files."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "logtask2", pipeline="bug-fix", status="completed")

        logs_dir = db_path.parent / "logs"
        log_file = logs_dir / "logtask2.log"
        stderr_file = logs_dir / "logtask2.stderr.log"
        log_file.write_text("some output\n", encoding="utf-8")
        stderr_file.write_text("some stderr\n", encoding="utf-8")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("c")
            await pilot.pause(0.2)

        assert not log_file.exists()
        assert not stderr_file.exists()

    @pytest.mark.asyncio
    async def test_clean_queued_task_does_not_modify_db(self, tmp_path: Path) -> None:
        """Pressing C on a queued task should NOT remove it."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "queuedtask", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("c")
            await pilot.pause(0.1)

        conn = make_connection(db_path, read_only=True)
        row = conn.execute("SELECT status FROM tasks WHERE id = 'queuedtask'").fetchone()
        conn.close()
        assert row is not None
        assert row["status"] == "queued"


class TestTuiCommand:
    """CLI-level tests for the pegasus tui command."""

    def test_tui_no_db_exits_with_error(self, tmp_path: Path) -> None:
        """pegasus tui without init should print an error and exit non-zero."""
        runner = CliRunner()
        result = runner.invoke(cli, ["tui", "--project-dir", str(tmp_path)])
        assert result.exit_code != 0
        assert "No Pegasus database found" in result.output

    def test_tui_command_registered(self) -> None:
        """The 'tui' command must exist in the CLI group."""
        assert "tui" in cli.commands  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Tests: TaskDetailView widget and PegasusDashboard detail mode
# ---------------------------------------------------------------------------


class _FakeRow(dict):
    """sqlite3.Row-like dict for test fixtures."""

    def __getitem__(self, key: str) -> Any:  # type: ignore[override]
        return super().__getitem__(key)


def _make_fake_task_row(
    task_id: str = "abc123",
    pipeline: str = "bug-fix",
    description: str = "Test task",
    status: str = "queued",
    total_cost: float | None = None,
    created_at: str = "2024-01-01 00:00:00",
    updated_at: str | None = None,
) -> _FakeRow:
    return _FakeRow(
        {
            "id": task_id,
            "pipeline": pipeline,
            "description": description,
            "status": status,
            "total_cost": total_cost,
            "created_at": created_at,
            "updated_at": updated_at,
        }
    )


def _make_fake_stage_row(
    stage_id: str = "analyze",
    stage_index: int = 0,
    status: str = "pending",
    started_at: str | None = None,
    finished_at: str | None = None,
    cost: float = 0.0,
    error: str | None = None,
) -> _FakeRow:
    return _FakeRow(
        {
            "stage_id": stage_id,
            "stage_index": stage_index,
            "status": status,
            "started_at": started_at,
            "finished_at": finished_at,
            "cost": cost,
            "error": error,
        }
    )


class TestTaskDetailView:
    """Unit and integration tests for TaskDetailView widget and detail mode."""

    # ------------------------------------------------------------------
    # Unit tests: TaskDetailView widget in isolation
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_taskdetailview_renders_task_id(self, tmp_path: Path) -> None:
        """update_header_stages should show the task ID in #detail-header."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "unitask1", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app
        from textual.widgets import Static

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.1)
            # Locate the TaskDetailView and make it visible so we can update it
            detail = app.query_one("#detail-view")
            detail.add_class("visible-detail")
            task_row = _make_fake_task_row(task_id="unitask1")
            detail.update_header_stages(task_row, [])
            await pilot.pause(0.1)
            header_text = str(app.query_one("#detail-header", Static).render())
            assert "unitask1" in header_text

    @pytest.mark.asyncio
    async def test_taskdetailview_renders_stages(self, tmp_path: Path) -> None:
        """update_header_stages with stage rows should show stage IDs in #detail-stages."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "stunit", pipeline="bug-fix", status="running")

        from pegasus.ui import _get_textual_app
        from textual.widgets import Static

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.1)
            detail = app.query_one("#detail-view")
            detail.add_class("visible-detail")
            task_row = _make_fake_task_row(task_id="stunit")
            stage_rows = [
                _make_fake_stage_row("analyze", 0, "completed"),
                _make_fake_stage_row("implement", 1, "running"),
            ]
            detail.update_header_stages(task_row, stage_rows)
            await pilot.pause(0.1)
            stages_text = str(app.query_one("#detail-stages", Static).render())
            assert "analyze" in stages_text
            assert "implement" in stages_text

    @pytest.mark.asyncio
    async def test_taskdetailview_stage_icons_by_status(self, tmp_path: Path) -> None:
        """Each stage status should produce the correct icon character."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "icontest", pipeline="bug-fix", status="running")

        from pegasus.ui import _get_textual_app
        from textual.widgets import Static

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.1)
            detail = app.query_one("#detail-view")
            detail.add_class("visible-detail")
            task_row = _make_fake_task_row(task_id="icontest")

            for status, expected_char in [
                ("completed", "✔"),
                ("running", "⟳"),
                ("failed", "✘"),
                ("pending", "·"),
            ]:
                stage_rows = [_make_fake_stage_row("s1", 0, status)]
                detail.update_header_stages(task_row, stage_rows)
                await pilot.pause(0.05)
                stages_text = str(app.query_one("#detail-stages", Static).render())
                assert expected_char in stages_text, (
                    f"Expected '{expected_char}' for status '{status}', got: {stages_text!r}"
                )

    @pytest.mark.asyncio
    async def test_taskdetailview_stage_shows_error(self, tmp_path: Path) -> None:
        """When a stage has an error, it should appear in #detail-stages."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "errtest", pipeline="bug-fix", status="failed")

        from pegasus.ui import _get_textual_app
        from textual.widgets import Static

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.1)
            detail = app.query_one("#detail-view")
            detail.add_class("visible-detail")
            task_row = _make_fake_task_row(task_id="errtest", status="failed")
            stage_rows = [
                _make_fake_stage_row("analyze", 0, "failed", error="Something went wrong")
            ]
            detail.update_header_stages(task_row, stage_rows)
            await pilot.pause(0.1)
            stages_text = str(app.query_one("#detail-stages", Static).render())
            assert "Something went wrong" in stages_text

    @pytest.mark.asyncio
    async def test_taskdetailview_update_log_with_content(self, tmp_path: Path) -> None:
        """update_log('content') should set #detail-log Static to that content."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "logunit", pipeline="bug-fix", status="running")

        from pegasus.ui import _get_textual_app
        from textual.widgets import Static

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.1)
            detail = app.query_one("#detail-view")
            detail.add_class("visible-detail")
            detail.update_log("hello from the log")
            await pilot.pause(0.1)
            log_text = str(app.query_one("#detail-log", Static).render())
            assert "hello from the log" in log_text

    @pytest.mark.asyncio
    async def test_taskdetailview_update_log_empty_shows_placeholder(
        self, tmp_path: Path
    ) -> None:
        """update_log('') should show a placeholder message in #detail-log."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "logph", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app
        from textual.widgets import Static

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.1)
            detail = app.query_one("#detail-view")
            detail.add_class("visible-detail")
            detail.update_log("")
            await pilot.pause(0.1)
            log_text = str(app.query_one("#detail-log", Static).render())
            assert "no log" in log_text.lower() or "yet" in log_text.lower()

    # ------------------------------------------------------------------
    # Integration tests: Enter key / detail mode
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_enter_opens_detail_mode(self, tmp_path: Path) -> None:
        """Pressing Enter on a task card should set _detail_mode to True."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "dtask1", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            assert app._detail_mode is False
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert app._detail_mode is True

    @pytest.mark.asyncio
    async def test_enter_sets_detail_task_id(self, tmp_path: Path) -> None:
        """Pressing Enter should set _detail_task_id to the focused task's ID."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "mytask", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert app._detail_task_id == "mytask"

    @pytest.mark.asyncio
    async def test_detail_view_shows_visible_detail_class(self, tmp_path: Path) -> None:
        """After pressing Enter, TaskDetailView should have the 'visible-detail' class."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "vdtask", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.1)
            detail = app.query_one("#detail-view")
            assert detail.has_class("visible-detail")

    @pytest.mark.asyncio
    async def test_detail_mode_hides_task_area(self, tmp_path: Path) -> None:
        """After pressing Enter, the app should have the 'detail-mode' CSS class."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "dmtask", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert app.has_class("detail-mode")

    @pytest.mark.asyncio
    async def test_escape_closes_detail_mode(self, tmp_path: Path) -> None:
        """Pressing Escape while in detail mode should set _detail_mode to False."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "esctask", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert app._detail_mode is True
            await pilot.press("escape")
            await pilot.pause(0.1)
            assert app._detail_mode is False

    @pytest.mark.asyncio
    async def test_d_key_closes_detail_mode(self, tmp_path: Path) -> None:
        """Pressing D while in detail mode should set _detail_mode to False."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "dtoggle", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert app._detail_mode is True
            await pilot.press("d")
            await pilot.pause(0.1)
            assert app._detail_mode is False

    @pytest.mark.asyncio
    async def test_escape_from_detail_returns_to_dashboard(self, tmp_path: Path) -> None:
        """Pressing Escape from detail should remove the 'detail-mode' class from app."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "escback", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert app.has_class("detail-mode")
            await pilot.press("escape")
            await pilot.pause(0.1)
            assert not app.has_class("detail-mode")

    @pytest.mark.asyncio
    async def test_detail_view_shows_task_header_content(self, tmp_path: Path) -> None:
        """After opening detail mode the task ID should appear in #detail-header."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "hdrtask", pipeline="bug-fix", description="header test", status="queued")

        from pegasus.ui import _get_textual_app
        from textual.widgets import Static

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.4)  # Allow _refresh_detail to fire
            header_text = str(app.query_one("#detail-header", Static).render())
            assert "hdrtask" in header_text

    @pytest.mark.asyncio
    async def test_detail_view_shows_stage_content(self, tmp_path: Path) -> None:
        """After opening detail, stage IDs should appear in #detail-stages."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "sgdetail", pipeline="bug-fix", status="running")
        _insert_stage_run(db_path, "sgdetail", "analyze-stage", 0, status="completed")

        from pegasus.ui import _get_textual_app
        from textual.widgets import Static

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.4)
            stages_text = str(app.query_one("#detail-stages", Static).render())
            assert "analyze-stage" in stages_text

    @pytest.mark.asyncio
    async def test_detail_view_shows_log_content(self, tmp_path: Path) -> None:
        """After opening detail mode, the task log file content should appear in #detail-log."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "logtsk", pipeline="bug-fix", status="running")

        log_dir = db_path.parent / "logs"
        log_dir.mkdir(exist_ok=True)
        (log_dir / "logtsk.log").write_text("unique-log-marker-xyz\n", encoding="utf-8")

        from pegasus.ui import _get_textual_app
        from textual.widgets import Static

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.4)
            log_text = str(app.query_one("#detail-log", Static).render())
            assert "unique-log-marker-xyz" in log_text

    @pytest.mark.asyncio
    async def test_enter_noop_with_no_tasks(self, tmp_path: Path) -> None:
        """Pressing Enter with an empty DB should not enter detail mode."""
        _, db_path = _make_tui_project(tmp_path)

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.3)
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert app._detail_mode is False

    @pytest.mark.asyncio
    async def test_enter_noop_when_already_in_detail(self, tmp_path: Path) -> None:
        """Pressing Enter again while already in detail mode should not crash."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "dup1", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert app._detail_mode is True
            # Press enter again — should remain in detail mode without error
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert app._detail_mode is True

    @pytest.mark.asyncio
    async def test_l_noop_in_detail_mode(self, tmp_path: Path) -> None:
        """Pressing L while in detail mode should NOT change _logs_visible."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "lnoop", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert app._detail_mode is True
            assert app._logs_visible is False
            await pilot.press("l")
            await pilot.pause(0.1)
            assert app._logs_visible is False

    @pytest.mark.asyncio
    async def test_log_updates_when_file_grows(self, tmp_path: Path) -> None:
        """When the log file grows, _detail_log_len should increase on next poll."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "growlog", pipeline="bug-fix", status="running")

        log_dir = db_path.parent / "logs"
        log_dir.mkdir(exist_ok=True)
        log_file = log_dir / "growlog.log"
        log_file.write_text("initial content\n", encoding="utf-8")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.4)
            initial_log_len = app._detail_log_len
            assert initial_log_len > 0
            # Append more content to the log
            log_file.write_text("initial content\nextra line appended\n", encoding="utf-8")
            await pilot.pause(0.4)  # Wait for poll_db to pick up the change
            assert app._detail_log_len > initial_log_len

    @pytest.mark.asyncio
    async def test_close_detail_resets_log_len(self, tmp_path: Path) -> None:
        """_close_detail() should reset _detail_log_len to 0."""
        _, db_path = _make_tui_project(tmp_path)
        _insert_task(db_path, "clrlog", pipeline="bug-fix", status="queued")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert app._detail_mode is True
            # Artificially bump _detail_log_len as if a log was read
            app._detail_log_len = 100
            app._close_detail()
            await pilot.pause(0.1)
            assert app._detail_log_len == 0


# ---------------------------------------------------------------------------
# TUI — Multi-question answer flow
# ---------------------------------------------------------------------------


def _insert_agent_question(
    db_path: Path,
    task_id: str,
    stage_id: str,
    stage_index: int,
    question: str,
    status: str = "pending",
) -> int:
    """Insert an agent_questions row and return its rowid."""
    conn = make_connection(db_path)
    cursor = conn.execute(
        "INSERT INTO agent_questions "
        "(task_id, stage_id, stage_index, question, status) "
        "VALUES (?, ?, ?, ?, ?)",
        (task_id, stage_id, stage_index, question, status),
    )
    conn.commit()
    rowid = cursor.lastrowid
    conn.close()
    return rowid  # type: ignore[return-value]


class TestMultiQuestionAnswerFlow:
    """Tests for answering multiple agent questions before a task resumes.

    These tests invoke ``_submit_question_answer`` directly on the app
    instance to avoid flaky UI-level timing issues with the QuestionBar
    input widget.
    """

    @pytest.mark.asyncio
    async def test_answer_with_remaining_keeps_task_paused(self, tmp_path: Path) -> None:
        """When more pending questions remain, answering one keeps the task paused."""
        _, db_path = _make_tui_project(tmp_path)
        task_id = "mq-1"
        _insert_task(db_path, task_id, status="paused")
        q1_id = _insert_agent_question(db_path, task_id, "plan", 0, "Q1?")
        _insert_agent_question(db_path, task_id, "plan", 0, "Q2?")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            # Simulate answering Q1 by directly calling the callback.
            app._answering_question_id = q1_id
            app._answering_task_id = task_id
            app._on_question_dismissed("Answer 1")
            await pilot.pause(0.1)

        # Task should still be paused (Q2 is still pending).
        conn = make_connection(db_path, read_only=True)
        task_row = conn.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
        questions = conn.execute(
            "SELECT status FROM agent_questions WHERE task_id = ? ORDER BY id",
            (task_id,),
        ).fetchall()
        conn.close()

        assert task_row["status"] == "paused"
        assert questions[0]["status"] == "answered"
        assert questions[1]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_answer_last_question_sets_task_queued(self, tmp_path: Path) -> None:
        """When the last pending question is answered, the task transitions to queued."""
        _, db_path = _make_tui_project(tmp_path)
        task_id = "mq-2"
        _insert_task(db_path, task_id, status="paused")
        q_id = _insert_agent_question(db_path, task_id, "plan", 0, "Only question?")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            app._answering_question_id = q_id
            app._answering_task_id = task_id
            app._on_question_dismissed("Yes")
            await pilot.pause(0.1)

        conn = make_connection(db_path, read_only=True)
        task_row = conn.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
        q_row = conn.execute(
            "SELECT status, answer FROM agent_questions WHERE task_id = ?", (task_id,),
        ).fetchone()
        conn.close()

        assert task_row["status"] == "queued"
        assert q_row["status"] == "answered"
        assert q_row["answer"] == "Yes"

    @pytest.mark.asyncio
    async def test_approve_shows_question_screen_for_pending_question(
        self, tmp_path: Path,
    ) -> None:
        """Pressing 'a' on a paused task with a pending question should
        push a QuestionScreen instead of directly approving."""
        _, db_path = _make_tui_project(tmp_path)
        task_id = "mq-3"
        _insert_task(db_path, task_id, status="paused")
        _insert_agent_question(db_path, task_id, "plan", 0, "What framework?")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("a")
            await pilot.pause(0.2)
            # A QuestionScreen should be the active screen.
            assert app.screen.__class__.__name__ == "QuestionScreen", (
                "QuestionScreen should be pushed after pressing 'a' with pending question"
            )

        # Task should still be paused — not approved.
        conn = make_connection(db_path, read_only=True)
        row = conn.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
        conn.close()
        assert row["status"] == "paused"


# ---------------------------------------------------------------------------
# TUI — QuestionBar choice widget modes
# ---------------------------------------------------------------------------


def _insert_agent_question_with_meta(
    db_path: Path,
    task_id: str,
    stage_id: str,
    stage_index: int,
    question: str,
    meta: dict | None = None,
    status: str = "pending",
) -> int:
    """Insert an agent_questions row with optional JSON meta."""
    import json
    conn = make_connection(db_path)
    meta_json = json.dumps(meta) if meta else None
    cursor = conn.execute(
        "INSERT INTO agent_questions "
        "(task_id, stage_id, stage_index, question, question_meta, status) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (task_id, stage_id, stage_index, question, meta_json, status),
    )
    conn.commit()
    rowid = cursor.lastrowid
    conn.close()
    return rowid  # type: ignore[return-value]


class TestQuestionScreenChoiceWidgets:
    """Tests for QuestionScreen rendering different widget types based on meta."""

    @pytest.mark.asyncio
    async def test_free_text_question_shows_input(self, tmp_path: Path) -> None:
        """No meta → QuestionScreen mounts an Input widget."""
        _, db_path = _make_tui_project(tmp_path)
        task_id = "qw-text"
        _insert_task(db_path, task_id, status="paused")
        _insert_agent_question(db_path, task_id, "plan", 0, "Free text question?")

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("a")
            await pilot.pause(0.3)
            # Should have an Input widget on the QuestionScreen.
            inputs = app.screen.query("#question-input")
            assert len(inputs) == 1, "Free-text question should show an Input widget"

    @pytest.mark.asyncio
    async def test_free_text_input_accepts_typing_and_submits(self, tmp_path: Path) -> None:
        """Typing into the QuestionScreen Input should accumulate text,
        and pressing Enter should store the answer in the database."""
        _, db_path = _make_tui_project(tmp_path)
        task_id = "qw-type"
        _insert_task(db_path, task_id, status="paused")
        q_id = _insert_agent_question(db_path, task_id, "plan", 0, "What language?")

        from pegasus.ui import _get_textual_app
        from textual.widgets import Input

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("a")  # Open QuestionScreen
            await pilot.pause(0.3)

            # Type characters into the focused Input.
            await pilot.press("P", "y", "t", "h", "o", "n")
            await pilot.pause(0.1)
            inp = app.screen.query_one("#question-input", Input)
            assert inp.value == "Python", f"Input should contain 'Python', got {inp.value!r}"

            # Submit with Enter.
            await pilot.press("enter")
            await pilot.pause(0.2)

        # Verify answer was stored in the database.
        conn = make_connection(db_path, read_only=True)
        q_row = conn.execute(
            "SELECT answer, status FROM agent_questions WHERE id = ?", (q_id,),
        ).fetchone()
        conn.close()
        assert q_row["status"] == "answered"
        assert q_row["answer"] == "Python"

    @pytest.mark.asyncio
    async def test_single_select_question_shows_select(self, tmp_path: Path) -> None:
        """single_select meta → QuestionScreen mounts a Select widget."""
        _, db_path = _make_tui_project(tmp_path)
        task_id = "qw-single"
        _insert_task(db_path, task_id, status="paused")
        meta = {
            "type": "single_select",
            "options": [
                {"label": "PostgreSQL", "description": "Relational DB"},
                {"label": "MongoDB", "description": "Document DB"},
            ],
        }
        _insert_agent_question_with_meta(
            db_path, task_id, "plan", 0, "Which DB?", meta=meta,
        )

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("a")
            await pilot.pause(0.3)
            selects = app.screen.query("#question-select")
            assert len(selects) == 1, "Single-select question should show a Select widget"
            # No Input widget should exist for single-select.
            inputs = app.screen.query("#question-input")
            assert len(inputs) == 0, "Input should not exist for single-select"

    @pytest.mark.asyncio
    async def test_multi_select_question_shows_selection_list(
        self, tmp_path: Path,
    ) -> None:
        """multi_select meta → QuestionScreen mounts a SelectionList + Submit button."""
        _, db_path = _make_tui_project(tmp_path)
        task_id = "qw-multi"
        _insert_task(db_path, task_id, status="paused")
        meta = {
            "type": "multi_select",
            "options": [
                {"label": "Unit tests", "description": ""},
                {"label": "Integration tests", "description": ""},
                {"label": "E2E tests", "description": ""},
            ],
        }
        _insert_agent_question_with_meta(
            db_path, task_id, "plan", 0, "Which test types?", meta=meta,
        )

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            await pilot.press("a")
            await pilot.pause(0.3)
            sel_lists = app.screen.query("#question-selection-list")
            assert len(sel_lists) == 1, "Multi-select should show a SelectionList"
            submit_btns = app.screen.query("#question-submit-btn")
            assert len(submit_btns) == 1, "Multi-select should show a Submit button"

    @pytest.mark.asyncio
    async def test_single_select_submit_stores_label(self, tmp_path: Path) -> None:
        """Selecting an option in single-select auto-submits the label as answer."""
        _, db_path = _make_tui_project(tmp_path)
        task_id = "qw-ss-submit"
        _insert_task(db_path, task_id, status="paused")
        meta = {
            "type": "single_select",
            "options": [
                {"label": "Option A", "description": ""},
                {"label": "Option B", "description": ""},
            ],
        }
        q_id = _insert_agent_question_with_meta(
            db_path, task_id, "plan", 0, "Pick one?", meta=meta,
        )

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            # Directly call _on_question_dismissed to simulate selection.
            app._answering_question_id = q_id
            app._answering_task_id = task_id
            app._on_question_dismissed("Option A")
            await pilot.pause(0.1)

        conn = make_connection(db_path, read_only=True)
        q_row = conn.execute(
            "SELECT answer, status FROM agent_questions WHERE id = ?", (q_id,),
        ).fetchone()
        conn.close()
        assert q_row["status"] == "answered"
        assert q_row["answer"] == "Option A"

    @pytest.mark.asyncio
    async def test_multi_select_submit_stores_joined_labels(
        self, tmp_path: Path,
    ) -> None:
        """Multi-select answer is comma-joined labels."""
        _, db_path = _make_tui_project(tmp_path)
        task_id = "qw-ms-submit"
        _insert_task(db_path, task_id, status="paused")
        meta = {
            "type": "multi_select",
            "options": [
                {"label": "Unit", "description": ""},
                {"label": "E2E", "description": ""},
            ],
        }
        q_id = _insert_agent_question_with_meta(
            db_path, task_id, "plan", 0, "Types?", meta=meta,
        )

        from pegasus.ui import _get_textual_app

        PegasusDashboard = _get_textual_app()
        app = PegasusDashboard(db_path=db_path)
        async with app.run_test(size=(120, 30)) as pilot:
            await pilot.pause(0.4)
            app._answering_question_id = q_id
            app._answering_task_id = task_id
            app._on_question_dismissed("Unit, E2E")
            await pilot.pause(0.1)

        conn = make_connection(db_path, read_only=True)
        q_row = conn.execute(
            "SELECT answer FROM agent_questions WHERE id = ?", (q_id,),
        ).fetchone()
        conn.close()
        assert q_row["answer"] == "Unit, E2E"
