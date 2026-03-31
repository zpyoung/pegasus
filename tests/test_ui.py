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
) -> None:
    conn = make_connection(db_path)
    try:
        conn.execute(
            "INSERT INTO tasks (id, pipeline, description, status) VALUES (?, ?, ?, ?)",
            (task_id, pipeline, description, status),
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
        assert "Fix login" in result.output

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
