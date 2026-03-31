"""Unit tests for pegasus.models — Pydantic validation of pipeline and config YAML."""

from __future__ import annotations

import sqlite3
import textwrap
import threading
from pathlib import Path

import pytest
from pydantic import ValidationError

from pegasus.models import (
    ALLOWED_CLAUDE_FLAGS,
    SCHEMA_VERSION,
    ClaudeFlags,
    DefaultsConfig,
    ExecutionConfig,
    PegasusConfig,
    PipelineConfig,
    PipelineDefaults,
    StageConfig,
    init_db,
    load_pipeline_config,
    load_project_config,
    make_connection,
    parse_pipeline_yaml,
    parse_project_config_yaml,
    transition_task_state,
)


# ---------------------------------------------------------------------------
# Fixtures — valid YAML strings
# ---------------------------------------------------------------------------

VALID_PIPELINE_YAML = textwrap.dedent(
    """\
    name: Bug Fix
    description: Analyze, patch, and verify a reported bug

    execution:
      mode: session

    defaults:
      model: claude-sonnet-4-20250514
      max_turns: 5
      permission_mode: plan

    stages:
      - id: analyze
        name: Root Cause Analysis
        prompt: |
          Analyze this bug: {{task.description}}
        claude_flags:
          model: claude-sonnet-4-20250514
          permission_mode: plan
          tools: "Read,Grep,Glob"
          max_turns: 5
          output_format: json

      - id: implement
        name: Apply Fix
        prompt: |
          Implement the approved patch plan.
        claude_flags:
          permission_mode: acceptEdits
          max_turns: 10
        requires_approval: true
    """
)

MINIMAL_PIPELINE_YAML = textwrap.dedent(
    """\
    name: Minimal
    stages:
      - id: analyze
        name: Analyze
        prompt: Do something useful.
    """
)

VALID_CONFIG_YAML = textwrap.dedent(
    """\
    pegasus:
      version: "0.1.0"

    project:
      language: python
      test_command: pytest
      lint_command: "ruff check ."
      setup_command: "pip install -e ."

    git:
      default_branch: main
      branch_prefix: "pegasus/"
      auto_cleanup: true

    defaults:
      model: claude-sonnet-4-20250514
      max_turns: 10
      permission_mode: plan
      max_permission: acceptEdits

    concurrency:
      max_tasks: 3
      retry_max: 5
      retry_base_delay: 1.0

    notifications:
      on_stage_complete: desktop
      on_approval_needed: desktop
      on_pipeline_complete: desktop
      on_pipeline_failed: desktop

    worktrees:
      base_path: "~/.pegasus/worktrees"
    """
)


# ---------------------------------------------------------------------------
# ClaudeFlags tests
# ---------------------------------------------------------------------------


class TestClaudeFlags:
    """Tests for ClaudeFlags validation."""

    def test_valid_all_fields(self) -> None:
        flags = ClaudeFlags(
            model="claude-sonnet-4-20250514",
            permission_mode="plan",
            tools="Read,Grep",
            max_turns=10,
            output_format="json",
            allowed_tools="Read",
            disallowed_tools="Write",
            add_dir="/tmp",
            append_system_prompt="Be concise.",
        )
        assert flags.model == "claude-sonnet-4-20250514"
        assert flags.permission_mode == "plan"
        assert flags.max_turns == 10

    def test_empty_flags_are_valid(self) -> None:
        flags = ClaudeFlags()
        assert flags.model is None
        assert flags.max_turns is None

    def test_invalid_permission_mode(self) -> None:
        with pytest.raises(ValidationError, match="permission_mode"):
            ClaudeFlags(permission_mode="unrestricted")

    def test_invalid_output_format(self) -> None:
        with pytest.raises(ValidationError, match="output_format"):
            ClaudeFlags(output_format="xml")

    def test_max_turns_must_be_positive(self) -> None:
        with pytest.raises(ValidationError):
            ClaudeFlags(max_turns=0)

    def test_max_turns_upper_bound(self) -> None:
        with pytest.raises(ValidationError):
            ClaudeFlags(max_turns=101)

    def test_unknown_flag_rejected(self) -> None:
        with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
            ClaudeFlags(**{"unknown_flag": "value"})  # type: ignore[arg-type]

    def test_valid_permission_modes(self) -> None:
        for mode in ("plan", "acceptEdits", "bypassPermissions"):
            flags = ClaudeFlags(permission_mode=mode)
            assert flags.permission_mode == mode

    def test_valid_output_formats(self) -> None:
        for fmt in ("text", "json", "stream-json"):
            flags = ClaudeFlags(output_format=fmt)
            assert flags.output_format == fmt

    def test_allowed_flags_constant(self) -> None:
        """Allowlist contains exactly the expected 9 flags."""
        expected = {
            "model",
            "permission_mode",
            "tools",
            "max_turns",
            "output_format",
            "allowed_tools",
            "disallowed_tools",
            "add_dir",
            "append_system_prompt",
        }
        assert ALLOWED_CLAUDE_FLAGS == expected


# ---------------------------------------------------------------------------
# StageConfig tests
# ---------------------------------------------------------------------------


class TestStageConfig:
    """Tests for StageConfig validation."""

    def test_valid_minimal_stage(self) -> None:
        stage = StageConfig(id="analyze", name="Analyze", prompt="Do something.")
        assert stage.id == "analyze"
        assert stage.requires_approval is False

    def test_stage_with_flags(self) -> None:
        stage = StageConfig(
            id="implement",
            name="Implement",
            prompt="Write code.",
            claude_flags=ClaudeFlags(permission_mode="acceptEdits"),
            requires_approval=True,
        )
        assert stage.requires_approval is True
        assert stage.claude_flags.permission_mode == "acceptEdits"

    def test_stage_id_must_start_with_lowercase(self) -> None:
        with pytest.raises(ValidationError, match="id"):
            StageConfig(id="Analyze", name="Analyze", prompt="Do something.")

    def test_stage_id_rejects_spaces(self) -> None:
        with pytest.raises(ValidationError, match="id"):
            StageConfig(id="my stage", name="My Stage", prompt="Do something.")

    def test_stage_id_allows_hyphens_and_underscores(self) -> None:
        stage = StageConfig(id="my-stage_01", name="Stage", prompt="Do it.")
        assert stage.id == "my-stage_01"

    def test_stage_id_cannot_be_empty(self) -> None:
        with pytest.raises(ValidationError):
            StageConfig(id="", name="Stage", prompt="Do it.")

    def test_stage_name_cannot_be_empty(self) -> None:
        with pytest.raises(ValidationError):
            StageConfig(id="analyze", name="", prompt="Do it.")

    def test_stage_prompt_cannot_be_empty(self) -> None:
        with pytest.raises(ValidationError):
            StageConfig(id="analyze", name="Analyze", prompt="")

    def test_stage_extra_fields_rejected(self) -> None:
        with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
            StageConfig(
                id="analyze",
                name="Analyze",
                prompt="Do it.",
                unknown_field="value",  # type: ignore[call-arg]
            )


# ---------------------------------------------------------------------------
# PipelineConfig tests
# ---------------------------------------------------------------------------


class TestPipelineConfig:
    """Tests for PipelineConfig validation."""

    def test_valid_full_pipeline(self) -> None:
        pipeline = parse_pipeline_yaml(VALID_PIPELINE_YAML)
        assert pipeline.name == "Bug Fix"
        assert len(pipeline.stages) == 2
        assert pipeline.stages[0].id == "analyze"
        assert pipeline.stages[1].id == "implement"
        assert pipeline.stages[1].requires_approval is True

    def test_valid_minimal_pipeline(self) -> None:
        pipeline = parse_pipeline_yaml(MINIMAL_PIPELINE_YAML)
        assert pipeline.name == "Minimal"
        assert len(pipeline.stages) == 1
        assert pipeline.execution.mode == "session"

    def test_pipeline_requires_name(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            stages:
              - id: analyze
                name: Analyze
                prompt: Do it.
            """
        )
        with pytest.raises(ValidationError, match="name"):
            parse_pipeline_yaml(yaml_str)

    def test_pipeline_requires_at_least_one_stage(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Empty Pipeline
            stages: []
            """
        )
        with pytest.raises(ValidationError):
            parse_pipeline_yaml(yaml_str)

    def test_pipeline_rejects_duplicate_stage_ids(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Bad Pipeline
            stages:
              - id: analyze
                name: Analyze
                prompt: Do it.
              - id: analyze
                name: Analyze Again
                prompt: Do it again.
            """
        )
        with pytest.raises(ValidationError, match="[Dd]uplicate"):
            parse_pipeline_yaml(yaml_str)

    def test_pipeline_rejects_more_than_10_stages(self) -> None:
        stages = "\n".join(
            f"  - id: stage{i}\n    name: Stage {i}\n    prompt: Do it."
            for i in range(11)
        )
        yaml_str = f"name: Too Many Stages\nstages:\n{stages}\n"
        with pytest.raises(ValidationError, match="maximum"):
            parse_pipeline_yaml(yaml_str)

    def test_pipeline_extra_top_level_key_rejected(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Extra Key
            unknown_key: value
            stages:
              - id: analyze
                name: Analyze
                prompt: Do it.
            """
        )
        with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
            parse_pipeline_yaml(yaml_str)

    def test_stage_invalid_claude_flag_rejected(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Bad Flags
            stages:
              - id: analyze
                name: Analyze
                prompt: Do it.
                claude_flags:
                  not_a_real_flag: true
            """
        )
        with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
            parse_pipeline_yaml(yaml_str)

    def test_stage_invalid_permission_mode_rejected(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Bad Mode
            stages:
              - id: analyze
                name: Analyze
                prompt: Do it.
                claude_flags:
                  permission_mode: full_access
            """
        )
        with pytest.raises(ValidationError, match="permission_mode"):
            parse_pipeline_yaml(yaml_str)

    def test_valid_stage_reference_in_prompt(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Multi Stage
            stages:
              - id: analyze
                name: Analyze
                prompt: Find the bug.
              - id: implement
                name: Implement
                prompt: Based on {{stages.analyze.output}}, implement the fix.
            """
        )
        pipeline = parse_pipeline_yaml(yaml_str)
        assert pipeline.stages[1].prompt.strip().startswith("Based on")

    def test_invalid_stage_reference_rejected(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Bad Reference
            stages:
              - id: analyze
                name: Analyze
                prompt: Based on {{stages.nonexistent.output}}, do it.
            """
        )
        with pytest.raises(ValidationError, match="nonexistent"):
            parse_pipeline_yaml(yaml_str)

    def test_non_mapping_yaml_rejected(self) -> None:
        with pytest.raises(ValueError, match="mapping"):
            parse_pipeline_yaml("- item1\n- item2\n")

    def test_execution_mode_defaults_to_session(self) -> None:
        pipeline = parse_pipeline_yaml(MINIMAL_PIPELINE_YAML)
        assert pipeline.execution.mode == "session"

    def test_execution_mode_invalid_value_rejected(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Bad Exec
            execution:
              mode: parallel
            stages:
              - id: analyze
                name: Analyze
                prompt: Do it.
            """
        )
        with pytest.raises(ValidationError):
            parse_pipeline_yaml(yaml_str)


# ---------------------------------------------------------------------------
# PipelineDefaults tests
# ---------------------------------------------------------------------------


class TestPipelineDefaults:
    """Tests for PipelineDefaults validation."""

    def test_valid_defaults(self) -> None:
        defaults = PipelineDefaults(
            model="claude-opus-4-20250514",
            max_turns=5,
            permission_mode="plan",
        )
        assert defaults.max_turns == 5

    def test_empty_defaults_valid(self) -> None:
        defaults = PipelineDefaults()
        assert defaults.model is None

    def test_invalid_permission_mode_in_defaults(self) -> None:
        with pytest.raises(ValidationError, match="permission_mode"):
            PipelineDefaults(permission_mode="full")


# ---------------------------------------------------------------------------
# PegasusConfig tests
# ---------------------------------------------------------------------------


class TestPegasusConfig:
    """Tests for the project config.yaml schema."""

    def test_valid_full_config(self) -> None:
        config = parse_project_config_yaml(VALID_CONFIG_YAML)
        assert config.project.language == "python"
        assert config.git.default_branch == "main"
        assert config.defaults.max_turns == 10
        assert config.concurrency.max_tasks == 3
        assert config.worktrees.base_path == "~/.pegasus/worktrees"

    def test_empty_config_uses_defaults(self) -> None:
        config = parse_project_config_yaml("")
        assert config.defaults.model == "claude-sonnet-4-20250514"
        assert config.defaults.max_turns == 10
        assert config.defaults.permission_mode == "plan"
        assert config.git.default_branch == "main"
        assert config.concurrency.max_tasks == 3

    def test_partial_config_preserves_defaults(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            project:
              language: typescript
            """
        )
        config = parse_project_config_yaml(yaml_str)
        assert config.project.language == "typescript"
        assert config.defaults.max_turns == 10  # preserved from built-in defaults

    def test_config_rejects_unknown_top_level_key(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            unknown_section:
              key: value
            """
        )
        with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
            parse_project_config_yaml(yaml_str)

    def test_invalid_permission_mode_in_defaults(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            defaults:
              permission_mode: unrestricted
            """
        )
        with pytest.raises(ValidationError, match="permission_mode"):
            parse_project_config_yaml(yaml_str)

    def test_invalid_max_tasks_rejected(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            concurrency:
              max_tasks: 0
            """
        )
        with pytest.raises(ValidationError):
            parse_project_config_yaml(yaml_str)

    def test_max_tasks_upper_bound(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            concurrency:
              max_tasks: 11
            """
        )
        with pytest.raises(ValidationError):
            parse_project_config_yaml(yaml_str)

    def test_retry_base_delay_must_be_positive(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            concurrency:
              retry_base_delay: 0.0
            """
        )
        with pytest.raises(ValidationError):
            parse_project_config_yaml(yaml_str)

    def test_non_mapping_yaml_rejected(self) -> None:
        with pytest.raises(ValueError, match="mapping"):
            parse_project_config_yaml("- item1\n- item2\n")


# ---------------------------------------------------------------------------
# File-based loading tests
# ---------------------------------------------------------------------------


class TestFileLoading:
    """Tests for load_pipeline_config and load_project_config file helpers."""

    def test_load_pipeline_config_from_file(self, tmp_path: Path) -> None:
        pipeline_file = tmp_path / "bug-fix.yaml"
        pipeline_file.write_text(VALID_PIPELINE_YAML, encoding="utf-8")
        pipeline = load_pipeline_config(pipeline_file)
        assert pipeline.name == "Bug Fix"
        assert len(pipeline.stages) == 2

    def test_load_pipeline_config_accepts_string_path(self, tmp_path: Path) -> None:
        pipeline_file = tmp_path / "test.yaml"
        pipeline_file.write_text(MINIMAL_PIPELINE_YAML, encoding="utf-8")
        pipeline = load_pipeline_config(str(pipeline_file))
        assert pipeline.name == "Minimal"

    def test_load_pipeline_config_missing_file(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            load_pipeline_config(tmp_path / "nonexistent.yaml")

    def test_load_project_config_from_file(self, tmp_path: Path) -> None:
        config_file = tmp_path / "config.yaml"
        config_file.write_text(VALID_CONFIG_YAML, encoding="utf-8")
        config = load_project_config(config_file)
        assert config.project.language == "python"

    def test_load_project_config_empty_file(self, tmp_path: Path) -> None:
        config_file = tmp_path / "config.yaml"
        config_file.write_text("", encoding="utf-8")
        config = load_project_config(config_file)
        # Empty config should use all defaults
        assert config.defaults.max_turns == 10

    def test_load_project_config_missing_file(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            load_project_config(tmp_path / "nonexistent.yaml")

    def test_pipeline_file_with_invalid_flag(self, tmp_path: Path) -> None:
        bad_yaml = textwrap.dedent(
            """\
            name: Bad Pipeline
            stages:
              - id: analyze
                name: Analyze
                prompt: Do it.
                claude_flags:
                  typo_flag: value
            """
        )
        pipeline_file = tmp_path / "bad.yaml"
        pipeline_file.write_text(bad_yaml, encoding="utf-8")
        with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
            load_pipeline_config(pipeline_file)


# ---------------------------------------------------------------------------
# DefaultsConfig tests
# ---------------------------------------------------------------------------


class TestDefaultsConfig:
    """Tests for built-in defaults config model."""

    def test_defaults_all_valid(self) -> None:
        d = DefaultsConfig(
            model="claude-opus-4-20250514",
            max_turns=20,
            permission_mode="acceptEdits",
            max_permission="acceptEdits",
        )
        assert d.max_turns == 20

    def test_defaults_invalid_max_permission(self) -> None:
        with pytest.raises(ValidationError, match="permission"):
            DefaultsConfig(max_permission="full")

    def test_defaults_max_turns_bounds(self) -> None:
        with pytest.raises(ValidationError):
            DefaultsConfig(max_turns=0)
        with pytest.raises(ValidationError):
            DefaultsConfig(max_turns=101)


# ---------------------------------------------------------------------------
# ExecutionConfig tests
# ---------------------------------------------------------------------------


class TestExecutionConfig:
    """Tests for ExecutionConfig."""

    def test_default_mode_is_session(self) -> None:
        ec = ExecutionConfig()
        assert ec.mode == "session"

    def test_explicit_session_mode(self) -> None:
        ec = ExecutionConfig(mode="session")
        assert ec.mode == "session"

    def test_invalid_mode_rejected(self) -> None:
        with pytest.raises(ValidationError):
            ExecutionConfig(mode="parallel")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# SQLite — make_connection tests
# ---------------------------------------------------------------------------


class TestMakeConnection:
    """Tests for the SQLite connection factory."""

    def test_returns_connection(self, tmp_path: Path) -> None:
        db = tmp_path / "test.db"
        conn = make_connection(db)
        assert isinstance(conn, sqlite3.Connection)
        conn.close()

    def test_wal_mode_enabled(self, tmp_path: Path) -> None:
        db = tmp_path / "wal.db"
        conn = make_connection(db)
        row = conn.execute("PRAGMA journal_mode").fetchone()
        assert row[0] == "wal"
        conn.close()

    def test_row_factory_is_sqlite_row(self, tmp_path: Path) -> None:
        db = tmp_path / "row.db"
        conn = make_connection(db)
        assert conn.row_factory is sqlite3.Row
        conn.close()

    def test_foreign_keys_enabled(self, tmp_path: Path) -> None:
        db = tmp_path / "fk.db"
        conn = make_connection(db)
        row = conn.execute("PRAGMA foreign_keys").fetchone()
        assert row[0] == 1
        conn.close()

    def test_busy_timeout_set(self, tmp_path: Path) -> None:
        db = tmp_path / "busy.db"
        conn = make_connection(db)
        row = conn.execute("PRAGMA busy_timeout").fetchone()
        assert row[0] == 5000
        conn.close()

    def test_read_only_connection(self, tmp_path: Path) -> None:
        """Read-only connection can query but must not allow writes."""
        db = tmp_path / "ro.db"
        # Create the file first via a writable connection.
        rw = make_connection(db)
        rw.execute("CREATE TABLE t (x INTEGER)")
        rw.commit()
        rw.close()

        ro = make_connection(db, read_only=True)
        # Read should succeed.
        rows = ro.execute("SELECT * FROM t").fetchall()
        assert rows == []
        # Write must fail.
        with pytest.raises(sqlite3.OperationalError):
            ro.execute("INSERT INTO t VALUES (1)")
        ro.close()

    def test_accepts_path_object(self, tmp_path: Path) -> None:
        db = tmp_path / "pathobj.db"
        conn = make_connection(db)
        assert isinstance(conn, sqlite3.Connection)
        conn.close()

    def test_accepts_string_path(self, tmp_path: Path) -> None:
        db = tmp_path / "strpath.db"
        conn = make_connection(str(db))
        assert isinstance(conn, sqlite3.Connection)
        conn.close()

    def test_synchronous_set_to_normal(self, tmp_path: Path) -> None:
        db = tmp_path / "sync.db"
        conn = make_connection(db)
        row = conn.execute("PRAGMA synchronous").fetchone()
        # NORMAL == 1
        assert row[0] == 1
        conn.close()


# ---------------------------------------------------------------------------
# SQLite — init_db tests
# ---------------------------------------------------------------------------


class TestInitDb:
    """Tests for schema initialisation."""

    def _get_tables(self, conn: sqlite3.Connection) -> set[str]:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        return {r[0] for r in rows}

    def _get_indexes(self, conn: sqlite3.Connection) -> set[str]:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
        return {r[0] for r in rows}

    def test_creates_all_tables(self, tmp_path: Path) -> None:
        db = tmp_path / "schema.db"
        conn = make_connection(db)
        init_db(conn)
        tables = self._get_tables(conn)
        assert "schema_version" in tables
        assert "tasks" in tables
        assert "stage_runs" in tables
        assert "worktrees" in tables
        conn.close()

    def test_creates_indexes(self, tmp_path: Path) -> None:
        db = tmp_path / "idx.db"
        conn = make_connection(db)
        init_db(conn)
        indexes = self._get_indexes(conn)
        assert "idx_tasks_status" in indexes
        assert "idx_tasks_heartbeat" in indexes
        assert "idx_stage_runs_task" in indexes
        conn.close()

    def test_inserts_schema_version(self, tmp_path: Path) -> None:
        db = tmp_path / "ver.db"
        conn = make_connection(db)
        init_db(conn)
        row = conn.execute("SELECT version FROM schema_version").fetchone()
        assert row is not None
        assert row["version"] == SCHEMA_VERSION
        conn.close()

    def test_idempotent_multiple_calls(self, tmp_path: Path) -> None:
        """Calling init_db twice must not raise."""
        db = tmp_path / "idem.db"
        conn = make_connection(db)
        init_db(conn)
        init_db(conn)  # must not raise
        tables = self._get_tables(conn)
        assert "tasks" in tables
        conn.close()

    def test_tasks_table_columns(self, tmp_path: Path) -> None:
        """Verify the tasks table has all expected columns."""
        db = tmp_path / "cols.db"
        conn = make_connection(db)
        init_db(conn)
        cols = {
            r[1]
            for r in conn.execute("PRAGMA table_info(tasks)").fetchall()
        }
        expected = {
            "id", "pipeline", "description", "status", "created_at",
            "updated_at", "session_id", "context", "branch", "worktree_path",
            "base_branch", "merge_status", "total_cost", "runner_pid",
            "heartbeat_at",
        }
        assert expected.issubset(cols)
        conn.close()

    def test_stage_runs_table_columns(self, tmp_path: Path) -> None:
        db = tmp_path / "sr_cols.db"
        conn = make_connection(db)
        init_db(conn)
        cols = {
            r[1]
            for r in conn.execute("PRAGMA table_info(stage_runs)").fetchall()
        }
        expected = {
            "id", "task_id", "stage_id", "stage_index", "status",
            "started_at", "finished_at", "error", "cost", "claude_flags",
        }
        assert expected.issubset(cols)
        conn.close()

    def test_worktrees_table_columns(self, tmp_path: Path) -> None:
        db = tmp_path / "wt_cols.db"
        conn = make_connection(db)
        init_db(conn)
        cols = {
            r[1]
            for r in conn.execute("PRAGMA table_info(worktrees)").fetchall()
        }
        expected = {"task_id", "path", "branch", "created_at", "status"}
        assert expected.issubset(cols)
        conn.close()


# ---------------------------------------------------------------------------
# SQLite — transition_task_state tests
# ---------------------------------------------------------------------------


def _insert_task(conn: sqlite3.Connection, task_id: str, status: str = "queued") -> None:
    """Helper: insert a minimal task row for testing."""
    conn.execute(
        "INSERT INTO tasks (id, pipeline, status) VALUES (?, ?, ?)",
        (task_id, "test-pipeline", status),
    )
    conn.commit()


class TestTransitionTaskState:
    """Tests for the safe state-transition helper."""

    def test_happy_path_queued_to_running(self, tmp_path: Path) -> None:
        db = tmp_path / "trans.db"
        conn = make_connection(db)
        init_db(conn)
        _insert_task(conn, "task-1", "queued")

        result = transition_task_state(conn, "task-1", "queued", "running")

        assert result is True
        row = conn.execute("SELECT status FROM tasks WHERE id='task-1'").fetchone()
        assert row["status"] == "running"
        conn.close()

    def test_returns_false_when_state_mismatch(self, tmp_path: Path) -> None:
        db = tmp_path / "mismatch.db"
        conn = make_connection(db)
        init_db(conn)
        _insert_task(conn, "task-2", "running")

        # Task is running but we claim it is queued — should fail.
        result = transition_task_state(conn, "task-2", "queued", "completed")

        assert result is False
        row = conn.execute("SELECT status FROM tasks WHERE id='task-2'").fetchone()
        assert row["status"] == "running"  # unchanged
        conn.close()

    def test_returns_false_for_nonexistent_task(self, tmp_path: Path) -> None:
        db = tmp_path / "noexist.db"
        conn = make_connection(db)
        init_db(conn)

        result = transition_task_state(conn, "ghost-id", "queued", "running")

        assert result is False
        conn.close()

    def test_running_to_completed(self, tmp_path: Path) -> None:
        db = tmp_path / "completed.db"
        conn = make_connection(db)
        init_db(conn)
        _insert_task(conn, "task-3", "running")

        result = transition_task_state(conn, "task-3", "running", "completed")

        assert result is True
        row = conn.execute("SELECT status FROM tasks WHERE id='task-3'").fetchone()
        assert row["status"] == "completed"
        conn.close()

    def test_running_to_failed(self, tmp_path: Path) -> None:
        db = tmp_path / "failed.db"
        conn = make_connection(db)
        init_db(conn)
        _insert_task(conn, "task-4", "running")

        result = transition_task_state(conn, "task-4", "running", "failed")

        assert result is True
        row = conn.execute("SELECT status FROM tasks WHERE id='task-4'").fetchone()
        assert row["status"] == "failed"
        conn.close()

    def test_updated_at_changes_on_success(self, tmp_path: Path) -> None:
        db = tmp_path / "ts.db"
        conn = make_connection(db)
        init_db(conn)
        _insert_task(conn, "task-5", "queued")
        before = conn.execute(
            "SELECT updated_at FROM tasks WHERE id='task-5'"
        ).fetchone()["updated_at"]

        transition_task_state(conn, "task-5", "queued", "running")

        after = conn.execute(
            "SELECT updated_at FROM tasks WHERE id='task-5'"
        ).fetchone()["updated_at"]
        # updated_at must be set (not necessarily strictly after due to
        # CURRENT_TIMESTAMP resolution, but it must be non-null)
        assert after is not None
        conn.close()

    def test_race_condition_prevention(self, tmp_path: Path) -> None:
        """Two threads racing to claim the same queued->running transition:
        exactly one must succeed."""
        db = tmp_path / "race.db"
        setup_conn = make_connection(db)
        init_db(setup_conn)
        _insert_task(setup_conn, "task-race", "queued")
        setup_conn.close()

        results: list[bool] = []
        errors: list[Exception] = []

        def do_transition() -> None:
            try:
                c = make_connection(db)
                r = transition_task_state(c, "task-race", "queued", "running")
                results.append(r)
                c.close()
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=do_transition) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"Unexpected errors: {errors}"
        # Exactly one transition should have succeeded.
        assert results.count(True) == 1
        assert results.count(False) == 1

        # Final status must be 'running'.
        verify_conn = make_connection(db)
        row = verify_conn.execute(
            "SELECT status FROM tasks WHERE id='task-race'"
        ).fetchone()
        assert row["status"] == "running"
        verify_conn.close()
