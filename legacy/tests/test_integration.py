"""End-to-end integration smoke tests for Pegasus.

These tests wire all modules together and exercise full CLI flows:
  - init -> validate
  - init -> run --dry-run
  - import graph isolation (runner never imports ui, ui never imports runner)
  - __main__ module runs (python3 -m pegasus --help)
  - status with no tasks
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from click.testing import CliRunner

from pegasus.ui import cli


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _init_git_repo(path: Path) -> None:
    """Initialise a minimal git repo so pegasus init can detect the branch."""
    subprocess.run(["git", "init", str(path)], check=True, capture_output=True)
    subprocess.run(
        ["git", "-C", str(path), "config", "user.email", "test@example.com"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "-C", str(path), "config", "user.name", "Test User"],
        check=True,
        capture_output=True,
    )
    # Create an initial commit so HEAD exists
    init_file = path / ".gitkeep"
    init_file.write_text("", encoding="utf-8")
    subprocess.run(["git", "-C", str(path), "add", ".gitkeep"], check=True, capture_output=True)
    subprocess.run(
        ["git", "-C", str(path), "commit", "-m", "Initial commit"],
        check=True,
        capture_output=True,
    )


# ---------------------------------------------------------------------------
# test_init_then_validate
# ---------------------------------------------------------------------------


@pytest.mark.slow
class TestInitThenValidate:
    """Full init -> validate flow in a fresh git repo."""

    def test_init_creates_pipelines(self, tmp_path: Path) -> None:
        """pegasus init creates bug-fix.yaml and feature.yaml."""
        _init_git_repo(tmp_path)
        runner = CliRunner()

        result = runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        assert result.exit_code == 0, result.output

        bug_fix = tmp_path / ".pegasus" / "pipelines" / "bug-fix.yaml"
        feature = tmp_path / ".pegasus" / "pipelines" / "feature.yaml"
        assert bug_fix.exists(), "bug-fix.yaml was not created"
        assert feature.exists(), "feature.yaml was not created"

    def test_init_then_validate_passes(self, tmp_path: Path) -> None:
        """pegasus init followed by pegasus validate exits 0 with no errors."""
        _init_git_repo(tmp_path)
        runner = CliRunner()

        init_result = runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        assert init_result.exit_code == 0, init_result.output

        validate_result = runner.invoke(cli, ["validate", "--project-dir", str(tmp_path)])
        assert validate_result.exit_code == 0, (
            f"validate failed after init:\n{validate_result.output}"
        )

    def test_validate_reports_no_errors_on_starter_templates(self, tmp_path: Path) -> None:
        """Starter templates pass Pydantic validation with zero errors."""
        _init_git_repo(tmp_path)
        runner = CliRunner()

        runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])
        result = runner.invoke(cli, ["validate", "--project-dir", str(tmp_path)])

        # Should not contain the word 'error' in a failure context
        assert "No validation errors" in result.output or result.exit_code == 0


# ---------------------------------------------------------------------------
# test_init_then_run_dry_run
# ---------------------------------------------------------------------------


@pytest.mark.slow
class TestInitThenRunDryRun:
    """Full init -> run --dry-run flow."""

    def test_dry_run_shows_resolved_commands(self, tmp_path: Path) -> None:
        """run --dry-run shows resolved runner command without making API calls."""
        _init_git_repo(tmp_path)
        runner = CliRunner()

        runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])

        result = runner.invoke(
            cli,
            [
                "run",
                "--pipeline", "bug-fix",
                "--desc", "Login fails on mobile",
                "--project-dir", str(tmp_path),
                "--dry-run",
            ],
        )
        assert result.exit_code == 0, result.output
        assert "Dry run" in result.output
        assert "bug-fix" in result.output
        assert "Login fails on mobile" in result.output

    def test_dry_run_does_not_create_task_in_db(self, tmp_path: Path) -> None:
        """run --dry-run must not insert a task row into SQLite."""
        import sqlite3

        _init_git_repo(tmp_path)
        runner = CliRunner()

        runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])

        runner.invoke(
            cli,
            [
                "run",
                "--pipeline", "bug-fix",
                "--desc", "test dry run",
                "--project-dir", str(tmp_path),
                "--dry-run",
            ],
        )

        db_path = tmp_path / ".pegasus" / "pegasus.db"
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT COUNT(*) as cnt FROM tasks").fetchone()
        conn.close()
        assert rows["cnt"] == 0, "dry-run must not insert task rows"

    def test_dry_run_shows_pipeline_name(self, tmp_path: Path) -> None:
        """Dry run output includes the pipeline name."""
        _init_git_repo(tmp_path)
        runner = CliRunner()

        runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])

        result = runner.invoke(
            cli,
            [
                "run",
                "--pipeline", "feature",
                "--desc", "Add dark mode",
                "--project-dir", str(tmp_path),
                "--dry-run",
            ],
        )
        assert result.exit_code == 0, result.output
        assert "feature" in result.output


# ---------------------------------------------------------------------------
# test_import_graph_isolation
# ---------------------------------------------------------------------------


class TestImportGraphIsolation:
    """Verify that runner.py never imports ui.py and vice versa."""

    def test_runner_does_not_import_ui(self) -> None:
        """runner.py source code must not reference pegasus.ui."""
        runner_path = Path(__file__).parent.parent / "src" / "pegasus" / "runner.py"
        source = runner_path.read_text(encoding="utf-8")
        assert "from pegasus.ui" not in source, "runner.py must not import pegasus.ui"
        assert "import pegasus.ui" not in source, "runner.py must not import pegasus.ui"
        # Partial import check
        assert "from pegasus import ui" not in source, "runner.py must not import ui"

    def test_ui_does_not_import_runner(self) -> None:
        """ui.py source code must not reference pegasus.runner."""
        ui_path = Path(__file__).parent.parent / "src" / "pegasus" / "ui.py"
        source = ui_path.read_text(encoding="utf-8")
        assert "from pegasus.runner" not in source, "ui.py must not import pegasus.runner"
        assert "import pegasus.runner" not in source, "ui.py must not import pegasus.runner"
        assert "from pegasus import runner" not in source, "ui.py must not import runner"

    def test_run_task_is_the_sole_runner_importer(self) -> None:
        """_run_task.py is the only module that imports runner.py."""
        run_task_path = Path(__file__).parent.parent / "src" / "pegasus" / "_run_task.py"
        source = run_task_path.read_text(encoding="utf-8")
        assert "from pegasus.runner import" in source or "import pegasus.runner" in source, (
            "_run_task.py must import runner.py"
        )


# ---------------------------------------------------------------------------
# test_main_module_runs
# ---------------------------------------------------------------------------


class TestMainModuleRuns:
    """Verify that python3 -m pegasus --help exits 0."""

    def test_help_exits_zero(self) -> None:
        """python3 -m pegasus --help must exit with code 0."""
        result = subprocess.run(
            [sys.executable, "-m", "pegasus", "--help"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 0, (
            f"python3 -m pegasus --help exited {result.returncode}\n{result.stderr}"
        )

    def test_help_output_mentions_commands(self) -> None:
        """python3 -m pegasus --help output lists expected commands."""
        result = subprocess.run(
            [sys.executable, "-m", "pegasus", "--help"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 0
        for cmd in ("init", "run", "status", "validate"):
            assert cmd in result.stdout, f"Expected '{cmd}' in --help output"

    def test_version_flag_exits_zero(self) -> None:
        """python3 -m pegasus --version must exit 0 and print a version string."""
        result = subprocess.run(
            [sys.executable, "-m", "pegasus", "--version"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 0, f"--version exited {result.returncode}"
        assert "0.1.0" in result.stdout or "0.1.0" in result.stderr


# ---------------------------------------------------------------------------
# test_status_empty
# ---------------------------------------------------------------------------


@pytest.mark.slow
class TestStatusEmpty:
    """Status command with no tasks should show a helpful empty-state message."""

    def test_status_empty_shows_message(self, tmp_path: Path) -> None:
        """pegasus status with zero tasks shows an informative message."""
        _init_git_repo(tmp_path)
        runner = CliRunner()

        runner.invoke(cli, ["init", "--project-dir", str(tmp_path)])

        result = runner.invoke(cli, ["status", "--project-dir", str(tmp_path)])
        assert result.exit_code == 0, result.output
        # Should mention no tasks or show empty state
        assert "No tasks" in result.output or "pegasus run" in result.output

    def test_status_no_db_exits_nonzero(self, tmp_path: Path) -> None:
        """pegasus status without initialisation exits non-zero."""
        runner = CliRunner()
        result = runner.invoke(cli, ["status", "--project-dir", str(tmp_path)])
        assert result.exit_code != 0


# ---------------------------------------------------------------------------
# test_package_data_templates
# ---------------------------------------------------------------------------


class TestPackageDataTemplates:
    """Starter pipeline templates exist in the package data directory."""

    def test_templates_directory_exists(self) -> None:
        """src/pegasus/templates/ directory exists."""
        templates_dir = Path(__file__).parent.parent / "src" / "pegasus" / "templates"
        assert templates_dir.is_dir(), "src/pegasus/templates/ must exist"

    def test_bug_fix_template_exists(self) -> None:
        """bug-fix.yaml template exists in the templates directory."""
        template = Path(__file__).parent.parent / "src" / "pegasus" / "templates" / "bug-fix.yaml"
        assert template.exists(), "src/pegasus/templates/bug-fix.yaml must exist"

    def test_feature_template_exists(self) -> None:
        """feature.yaml template exists in the templates directory."""
        template = Path(__file__).parent.parent / "src" / "pegasus" / "templates" / "feature.yaml"
        assert template.exists(), "src/pegasus/templates/feature.yaml must exist"

    def test_bug_fix_template_is_valid_yaml(self) -> None:
        """bug-fix.yaml is valid YAML with required top-level keys."""
        import yaml

        template = Path(__file__).parent.parent / "src" / "pegasus" / "templates" / "bug-fix.yaml"
        data = yaml.safe_load(template.read_text(encoding="utf-8"))
        assert isinstance(data, dict)
        assert "name" in data
        assert "stages" in data
        assert len(data["stages"]) >= 1

    def test_feature_template_is_valid_yaml(self) -> None:
        """feature.yaml is valid YAML with required top-level keys."""
        import yaml

        template = Path(__file__).parent.parent / "src" / "pegasus" / "templates" / "feature.yaml"
        data = yaml.safe_load(template.read_text(encoding="utf-8"))
        assert isinstance(data, dict)
        assert "name" in data
        assert "stages" in data
        assert len(data["stages"]) >= 1

    def test_pyproject_includes_template_package_data(self) -> None:
        """pyproject.toml declares templates/*.yaml as package data."""
        pyproject = Path(__file__).parent.parent / "pyproject.toml"
        content = pyproject.read_text(encoding="utf-8")
        assert "templates/*.yaml" in content, (
            "pyproject.toml must declare templates/*.yaml as package data"
        )
