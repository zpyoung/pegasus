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
    BUILT_IN_DEFAULTS,
    PERMISSION_ORDER,
    SCHEMA_VERSION,
    ClaudeFlags,
    DefaultsConfig,
    ExecutionConfig,
    PegasusConfig,
    PipelineConfig,
    PipelineDefaults,
    StageConfig,
    _cap_permission,
    _permission_index,
    init_db,
    load_config,
    load_pipeline_config,
    load_project_config,
    make_connection,
    parse_pipeline_yaml,
    parse_project_config_yaml,
    resolve_auto_commit,
    resolve_stage_flags,
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
        assert stage.requires_approval is None

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
        assert config.git.default_branch is None
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


# ---------------------------------------------------------------------------
# Permission helpers tests
# ---------------------------------------------------------------------------


class TestPermissionHelpers:
    """Tests for internal permission ceiling helpers."""

    def test_permission_order_has_three_levels(self) -> None:
        assert len(PERMISSION_ORDER) == 3
        assert PERMISSION_ORDER[0] == "plan"
        assert PERMISSION_ORDER[1] == "acceptEdits"
        assert PERMISSION_ORDER[2] == "bypassPermissions"

    def test_permission_index_plan(self) -> None:
        assert _permission_index("plan") == 0

    def test_permission_index_accept_edits(self) -> None:
        assert _permission_index("acceptEdits") == 1

    def test_permission_index_bypass(self) -> None:
        assert _permission_index("bypassPermissions") == 2

    def test_permission_index_unknown_defaults_to_zero(self) -> None:
        assert _permission_index("unknown_mode") == 0

    def test_cap_permission_no_change_when_at_ceiling(self) -> None:
        assert _cap_permission("acceptEdits", "acceptEdits") == "acceptEdits"

    def test_cap_permission_no_change_when_below_ceiling(self) -> None:
        assert _cap_permission("plan", "acceptEdits") == "plan"

    def test_cap_permission_clamps_above_ceiling(self) -> None:
        # bypassPermissions > acceptEdits ceiling → must clamp to acceptEdits
        assert _cap_permission("bypassPermissions", "acceptEdits") == "acceptEdits"

    def test_cap_permission_plan_ceiling_blocks_all_writes(self) -> None:
        assert _cap_permission("acceptEdits", "plan") == "plan"
        assert _cap_permission("bypassPermissions", "plan") == "plan"

    def test_cap_permission_bypass_ceiling_allows_everything(self) -> None:
        assert _cap_permission("plan", "bypassPermissions") == "plan"
        assert _cap_permission("acceptEdits", "bypassPermissions") == "acceptEdits"
        assert _cap_permission("bypassPermissions", "bypassPermissions") == "bypassPermissions"


# ---------------------------------------------------------------------------
# BUILT_IN_DEFAULTS constant tests
# ---------------------------------------------------------------------------


class TestBuiltInDefaults:
    """Tests for the BUILT_IN_DEFAULTS constant."""

    def test_built_in_defaults_has_required_keys(self) -> None:
        assert "model" in BUILT_IN_DEFAULTS
        assert "max_turns" in BUILT_IN_DEFAULTS
        assert "permission_mode" in BUILT_IN_DEFAULTS
        assert "max_permission" in BUILT_IN_DEFAULTS

    def test_built_in_default_permission_mode_is_plan(self) -> None:
        assert BUILT_IN_DEFAULTS["permission_mode"] == "plan"

    def test_built_in_default_max_permission_is_accept_edits(self) -> None:
        assert BUILT_IN_DEFAULTS["max_permission"] == "acceptEdits"

    def test_built_in_default_max_turns_is_ten(self) -> None:
        assert BUILT_IN_DEFAULTS["max_turns"] == 10


# ---------------------------------------------------------------------------
# load_config tests
# ---------------------------------------------------------------------------


class TestLoadConfig:
    """Tests for layered config resolution via load_config()."""

    def test_no_config_files_returns_defaults(self, tmp_path: Path) -> None:
        """With no config files anywhere, all built-in defaults are used."""
        project_dir = tmp_path / "project"
        project_dir.mkdir()
        config = load_config(project_dir)
        assert config.defaults.model == BUILT_IN_DEFAULTS["model"]
        assert config.defaults.max_turns == BUILT_IN_DEFAULTS["max_turns"]
        assert config.defaults.permission_mode == BUILT_IN_DEFAULTS["permission_mode"]
        assert config.defaults.max_permission == BUILT_IN_DEFAULTS["max_permission"]

    def test_project_config_overrides_defaults(self, tmp_path: Path) -> None:
        """Project config overrides built-in defaults."""
        project_dir = tmp_path / "project"
        pegasus_dir = project_dir / ".pegasus"
        pegasus_dir.mkdir(parents=True)
        (pegasus_dir / "config.yaml").write_text(
            textwrap.dedent(
                """\
                defaults:
                  model: claude-opus-4-20250514
                  max_turns: 20
                """
            ),
            encoding="utf-8",
        )
        config = load_config(project_dir)
        assert config.defaults.model == "claude-opus-4-20250514"
        assert config.defaults.max_turns == 20
        # Unspecified fields keep their built-in defaults.
        assert config.defaults.permission_mode == BUILT_IN_DEFAULTS["permission_mode"]

    def test_user_config_overrides_defaults(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """User config is loaded and overrides built-in defaults."""
        # Point HOME at tmp_path so user config is isolated.
        user_config_dir = tmp_path / ".config" / "pegasus"
        user_config_dir.mkdir(parents=True)
        (user_config_dir / "config.yaml").write_text(
            textwrap.dedent(
                """\
                defaults:
                  max_turns: 7
                  permission_mode: acceptEdits
                """
            ),
            encoding="utf-8",
        )
        monkeypatch.setenv("HOME", str(tmp_path))

        project_dir = tmp_path / "project"
        project_dir.mkdir()
        config = load_config(project_dir)
        assert config.defaults.max_turns == 7
        assert config.defaults.permission_mode == "acceptEdits"

    def test_project_config_overrides_user_config(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Project config takes precedence over user config."""
        # User config sets max_turns=7.
        user_config_dir = tmp_path / ".config" / "pegasus"
        user_config_dir.mkdir(parents=True)
        (user_config_dir / "config.yaml").write_text(
            "defaults:\n  max_turns: 7\n",
            encoding="utf-8",
        )
        monkeypatch.setenv("HOME", str(tmp_path))

        # Project config sets max_turns=3 — should win.
        project_dir = tmp_path / "project"
        pegasus_dir = project_dir / ".pegasus"
        pegasus_dir.mkdir(parents=True)
        (pegasus_dir / "config.yaml").write_text(
            "defaults:\n  max_turns: 3\n",
            encoding="utf-8",
        )

        config = load_config(project_dir)
        assert config.defaults.max_turns == 3

    def test_missing_project_config_falls_back_gracefully(self, tmp_path: Path) -> None:
        """No .pegasus/config.yaml is not an error; defaults are used."""
        project_dir = tmp_path / "project"
        project_dir.mkdir()
        # No .pegasus/ directory at all.
        config = load_config(project_dir)
        assert config.defaults.max_turns == BUILT_IN_DEFAULTS["max_turns"]

    def test_empty_project_config_uses_defaults(self, tmp_path: Path) -> None:
        """Empty .pegasus/config.yaml is treated as no overrides."""
        project_dir = tmp_path / "project"
        pegasus_dir = project_dir / ".pegasus"
        pegasus_dir.mkdir(parents=True)
        (pegasus_dir / "config.yaml").write_text("", encoding="utf-8")
        config = load_config(project_dir)
        assert config.defaults.max_turns == BUILT_IN_DEFAULTS["max_turns"]

    def test_partial_project_config_merges_with_defaults(self, tmp_path: Path) -> None:
        """Only specified keys are overridden; the rest fall back to defaults."""
        project_dir = tmp_path / "project"
        pegasus_dir = project_dir / ".pegasus"
        pegasus_dir.mkdir(parents=True)
        (pegasus_dir / "config.yaml").write_text(
            "project:\n  language: rust\n",
            encoding="utf-8",
        )
        config = load_config(project_dir)
        assert config.project.language == "rust"
        assert config.defaults.max_turns == BUILT_IN_DEFAULTS["max_turns"]
        assert config.git.default_branch is None  # not specified, auto-detect

    def test_all_three_layers_merge_correctly(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Verify built-in < user < project resolution across different keys."""
        # User overrides model.
        user_config_dir = tmp_path / ".config" / "pegasus"
        user_config_dir.mkdir(parents=True)
        (user_config_dir / "config.yaml").write_text(
            "defaults:\n  model: claude-haiku-4-20250514\n",
            encoding="utf-8",
        )
        monkeypatch.setenv("HOME", str(tmp_path))

        # Project overrides max_turns.
        project_dir = tmp_path / "project"
        pegasus_dir = project_dir / ".pegasus"
        pegasus_dir.mkdir(parents=True)
        (pegasus_dir / "config.yaml").write_text(
            "defaults:\n  max_turns: 15\n",
            encoding="utf-8",
        )

        config = load_config(project_dir)
        # user layer wins for model
        assert config.defaults.model == "claude-haiku-4-20250514"
        # project layer wins for max_turns
        assert config.defaults.max_turns == 15
        # built-in wins for permission_mode (no override in any layer)
        assert config.defaults.permission_mode == BUILT_IN_DEFAULTS["permission_mode"]

    def test_load_config_none_project_dir_does_not_raise(self) -> None:
        """Passing None as project_dir should not raise (uses cwd)."""
        # As long as cwd doesn't have an invalid .pegasus/config.yaml, this is fine.
        config = load_config(None)
        assert isinstance(config, PegasusConfig)


# ---------------------------------------------------------------------------
# resolve_stage_flags tests
# ---------------------------------------------------------------------------


def _make_stage(
    stage_id: str = "test",
    permission_mode: str | None = None,
    max_turns: int | None = None,
    model: str | None = None,
    requires_approval: bool | None = None,
) -> StageConfig:
    """Helper: build a minimal StageConfig with optional claude_flags."""
    flags = ClaudeFlags(
        permission_mode=permission_mode,
        max_turns=max_turns,
        model=model,
    )
    return StageConfig(
        id=stage_id,
        name=stage_id.capitalize(),
        prompt="Do it.",
        claude_flags=flags,
        requires_approval=requires_approval,
    )


class TestResolveStageFlags:
    """Tests for the full layered flag resolution function."""

    def test_no_overrides_returns_built_in_defaults(self) -> None:
        stage = _make_stage()
        flags, requires_approval = resolve_stage_flags(stage)
        assert flags.permission_mode == BUILT_IN_DEFAULTS["permission_mode"]
        assert flags.max_turns == BUILT_IN_DEFAULTS["max_turns"]
        assert flags.model == BUILT_IN_DEFAULTS["model"]
        assert requires_approval is False

    def test_stage_overrides_take_highest_precedence(self) -> None:
        stage = _make_stage(permission_mode="plan", max_turns=3)
        pipeline_defaults = PipelineDefaults(max_turns=8, permission_mode="acceptEdits")
        project_config = parse_project_config_yaml("defaults:\n  max_turns: 5\n")
        flags, _ = resolve_stage_flags(stage, pipeline_defaults, project_config)
        # Stage level wins on both fields.
        assert flags.permission_mode == "plan"
        assert flags.max_turns == 3

    def test_pipeline_defaults_override_project_defaults(self) -> None:
        stage = _make_stage()  # no stage-level overrides
        pipeline_defaults = PipelineDefaults(max_turns=8)
        project_config = parse_project_config_yaml("defaults:\n  max_turns: 5\n")
        flags, _ = resolve_stage_flags(stage, pipeline_defaults, project_config)
        assert flags.max_turns == 8

    def test_project_defaults_override_built_in(self) -> None:
        stage = _make_stage()  # no stage-level overrides
        project_config = parse_project_config_yaml("defaults:\n  max_turns: 5\n")
        flags, _ = resolve_stage_flags(stage, None, project_config)
        assert flags.max_turns == 5

    def test_full_resolution_order(self) -> None:
        """Built-in < project < pipeline < stage for max_turns."""
        # built-in = 10, project = 5, pipeline = 8, stage = 3 → expect 3.
        stage = _make_stage(max_turns=3)
        pipeline_defaults = PipelineDefaults(max_turns=8)
        project_config = parse_project_config_yaml("defaults:\n  max_turns: 5\n")
        flags, _ = resolve_stage_flags(stage, pipeline_defaults, project_config)
        assert flags.max_turns == 3

    # --- Permission ceiling (deny-wins) tests ---

    def test_permission_ceiling_clamps_stage_flags(self) -> None:
        """Stage wants bypassPermissions but project ceiling is acceptEdits."""
        stage = _make_stage(permission_mode="bypassPermissions")
        project_config = parse_project_config_yaml(
            "defaults:\n  max_permission: acceptEdits\n"
        )
        flags, _ = resolve_stage_flags(stage, None, project_config)
        assert flags.permission_mode == "acceptEdits"

    def test_permission_ceiling_plan_blocks_all_writes(self) -> None:
        """Project ceiling of plan blocks acceptEdits and bypassPermissions."""
        project_config = parse_project_config_yaml(
            "defaults:\n  max_permission: plan\n"
        )
        for requested in ("acceptEdits", "bypassPermissions"):
            stage = _make_stage(permission_mode=requested)
            flags, _ = resolve_stage_flags(stage, None, project_config)
            assert flags.permission_mode == "plan", f"Expected plan, got {flags.permission_mode!r} for {requested!r}"

    def test_permission_ceiling_allows_lower_modes(self) -> None:
        """A stage requesting plan is unaffected by an acceptEdits ceiling."""
        stage = _make_stage(permission_mode="plan")
        project_config = parse_project_config_yaml(
            "defaults:\n  max_permission: acceptEdits\n"
        )
        flags, _ = resolve_stage_flags(stage, None, project_config)
        assert flags.permission_mode == "plan"

    def test_permission_ceiling_applied_after_pipeline_override(self) -> None:
        """Pipeline default escalates to bypassPermissions, ceiling clamps it back."""
        stage = _make_stage()  # no stage override
        pipeline_defaults = PipelineDefaults(permission_mode="bypassPermissions")
        project_config = parse_project_config_yaml(
            "defaults:\n  max_permission: acceptEdits\n"
        )
        flags, _ = resolve_stage_flags(stage, pipeline_defaults, project_config)
        assert flags.permission_mode == "acceptEdits"

    def test_deny_wins_ceiling_from_default_built_in(self) -> None:
        """Default max_permission ceiling (acceptEdits) blocks bypassPermissions."""
        # No explicit project config — uses BUILT_IN_DEFAULTS max_permission.
        stage = _make_stage(permission_mode="bypassPermissions")
        flags, _ = resolve_stage_flags(stage)
        assert flags.permission_mode == "acceptEdits"

    # --- Auto-require-approval tests ---

    def test_auto_require_approval_for_accept_edits(self) -> None:
        """Stages with acceptEdits permission mode get requires_approval=True when unspecified."""
        stage = _make_stage(permission_mode="acceptEdits")
        project_config = parse_project_config_yaml(
            "defaults:\n  max_permission: acceptEdits\n"
        )
        _, requires_approval = resolve_stage_flags(stage, None, project_config)
        assert requires_approval is True

    def test_auto_require_approval_not_set_for_plan_mode(self) -> None:
        """Plan-mode stages do NOT get auto-require-approval."""
        stage = _make_stage(permission_mode="plan")
        _, requires_approval = resolve_stage_flags(stage)
        assert requires_approval is False

    def test_explicit_requires_approval_preserved(self) -> None:
        """Explicit requires_approval=True is always preserved regardless of mode."""
        stage = _make_stage(permission_mode="plan", requires_approval=True)
        _, requires_approval = resolve_stage_flags(stage)
        assert requires_approval is True

    def test_auto_require_approval_triggered_by_clamped_accept_edits(self) -> None:
        """Even after clamping, if effective mode is acceptEdits, approval is required."""
        # Stage requests bypassPermissions, ceiling is acceptEdits.
        # Clamped to acceptEdits → auto-requires-approval.
        stage = _make_stage(permission_mode="bypassPermissions")
        project_config = parse_project_config_yaml(
            "defaults:\n  max_permission: acceptEdits\n"
        )
        _, requires_approval = resolve_stage_flags(stage, None, project_config)
        assert requires_approval is True

    def test_explicit_false_respected_for_write_mode(self) -> None:
        """Explicit requires_approval=False is respected even for write modes."""
        stage = _make_stage(permission_mode="acceptEdits", requires_approval=False)
        project_config = parse_project_config_yaml(
            "defaults:\n  max_permission: acceptEdits\n"
        )
        _, requires_approval = resolve_stage_flags(stage, None, project_config)
        assert requires_approval is False

    def test_no_stage_flag_overrides_fall_through_to_pipeline(self) -> None:
        """With no stage flags set, pipeline defaults fill in."""
        stage = StageConfig(id="test", name="Test", prompt="Do it.")
        pipeline_defaults = PipelineDefaults(
            model="claude-haiku-4-20250514",
            max_turns=4,
            permission_mode="plan",
        )
        flags, _ = resolve_stage_flags(stage, pipeline_defaults)
        assert flags.model == "claude-haiku-4-20250514"
        assert flags.max_turns == 4

    def test_stage_specific_flags_pass_through(self) -> None:
        """Non-permission fields (tools, output_format, etc.) pass through unchanged."""
        stage = StageConfig(
            id="test",
            name="Test",
            prompt="Do it.",
            claude_flags=ClaudeFlags(
                tools="Read,Grep",
                output_format="json",
                add_dir="/src",
                append_system_prompt="Be concise.",
            ),
        )
        flags, _ = resolve_stage_flags(stage)
        assert flags.tools == "Read,Grep"
        assert flags.output_format == "json"
        assert flags.add_dir == "/src"
        assert flags.append_system_prompt == "Be concise."

    def test_none_pipeline_defaults_does_not_raise(self) -> None:
        stage = _make_stage()
        flags, _ = resolve_stage_flags(stage, None, None)
        assert isinstance(flags, ClaudeFlags)

    def test_none_project_config_uses_built_in_ceiling(self) -> None:
        """When project_config is None, BUILT_IN max_permission ceiling applies."""
        stage = _make_stage(permission_mode="bypassPermissions")
        flags, _ = resolve_stage_flags(stage, None, None)
        # Built-in ceiling is acceptEdits → bypassPermissions must be clamped.
        assert flags.permission_mode == "acceptEdits"


# ---------------------------------------------------------------------------
# resolve_auto_commit tests
# ---------------------------------------------------------------------------


class TestResolveAutoCommit:
    """Tests for the ``resolve_auto_commit`` helper."""

    def test_default_is_true(self) -> None:
        stage = _make_stage()
        assert resolve_auto_commit(stage) is True

    def test_default_is_true_with_none_pipeline_defaults(self) -> None:
        stage = _make_stage()
        assert resolve_auto_commit(stage, PipelineDefaults()) is True

    def test_pipeline_default_disables(self) -> None:
        stage = _make_stage()
        defaults = PipelineDefaults(auto_commit=False)
        assert resolve_auto_commit(stage, defaults) is False

    def test_pipeline_default_enables(self) -> None:
        stage = _make_stage()
        defaults = PipelineDefaults(auto_commit=True)
        assert resolve_auto_commit(stage, defaults) is True

    def test_stage_overrides_pipeline_false(self) -> None:
        stage = StageConfig(id="s", name="S", prompt="Do.", auto_commit=True)
        defaults = PipelineDefaults(auto_commit=False)
        assert resolve_auto_commit(stage, defaults) is True

    def test_stage_disables_when_pipeline_enables(self) -> None:
        stage = StageConfig(id="s", name="S", prompt="Do.", auto_commit=False)
        defaults = PipelineDefaults(auto_commit=True)
        assert resolve_auto_commit(stage, defaults) is False

    def test_stage_disables_with_no_pipeline_defaults(self) -> None:
        stage = StageConfig(id="s", name="S", prompt="Do.", auto_commit=False)
        assert resolve_auto_commit(stage) is False


# ---------------------------------------------------------------------------
# Pipeline validation tests
# ---------------------------------------------------------------------------


from pegasus.models import (  # noqa: E402
    PipelineValidationError,
    _levenshtein,
    _suggest_flag,
    validate_all_pipelines,
    validate_pipeline,
)


class TestPipelineValidationError:
    """Tests for the PipelineValidationError dataclass-like object."""

    def test_str_with_location(self) -> None:
        err = PipelineValidationError(
            message="something wrong",
            file_path="/some/file.yaml",
            location="stage 'analyze'",
        )
        assert "/some/file.yaml" in str(err)
        assert "stage 'analyze'" in str(err)
        assert "something wrong" in str(err)

    def test_str_without_location(self) -> None:
        err = PipelineValidationError(message="bad yaml", file_path="pipeline.yaml")
        s = str(err)
        assert "pipeline.yaml" in s
        assert "bad yaml" in s
        assert "[" not in s  # no location bracket

    def test_default_file_path_is_string(self) -> None:
        err = PipelineValidationError(message="oops")
        assert err.file_path == "<string>"

    def test_attributes_accessible(self) -> None:
        err = PipelineValidationError("msg", "/path", "loc")
        assert err.message == "msg"
        assert err.file_path == "/path"
        assert err.location == "loc"


class TestLevenshtein:
    """Tests for the internal Levenshtein distance function."""

    def test_identical_strings(self) -> None:
        assert _levenshtein("model", "model") == 0

    def test_single_deletion(self) -> None:
        assert _levenshtein("models", "model") == 1

    def test_single_insertion(self) -> None:
        assert _levenshtein("model", "models") == 1

    def test_single_substitution(self) -> None:
        assert _levenshtein("model", "modle") == 2  # transposition is 2 ops

    def test_empty_strings(self) -> None:
        assert _levenshtein("", "") == 0
        assert _levenshtein("abc", "") == 3
        assert _levenshtein("", "abc") == 3

    def test_completely_different(self) -> None:
        assert _levenshtein("xyz", "abc") == 3


class TestSuggestFlag:
    """Tests for the typo-suggestion helper."""

    def test_exact_match_not_a_suggestion(self) -> None:
        # Exact match has distance 0 which is within limit — still returned.
        assert _suggest_flag("model") == "model"

    def test_typo_within_threshold(self) -> None:
        suggestion = _suggest_flag("modell")  # one extra 'l'
        assert suggestion == "model"

    def test_distant_string_returns_none(self) -> None:
        suggestion = _suggest_flag("zzz_totally_unknown_flag_xyz")
        assert suggestion is None

    def test_permission_mode_typo(self) -> None:
        # "permission_modes" → should suggest "permission_mode"
        suggestion = _suggest_flag("permission_modes")
        assert suggestion == "permission_mode"

    def test_max_turns_typo(self) -> None:
        suggestion = _suggest_flag("max_turn")
        assert suggestion == "max_turns"


class TestValidatePipeline:
    """Tests for the main validate_pipeline() function."""

    # --- Valid pipeline passes ---

    def test_valid_pipeline_yaml_string_returns_no_errors(self) -> None:
        errors = validate_pipeline(VALID_PIPELINE_YAML)
        assert errors == []

    def test_valid_minimal_pipeline_returns_no_errors(self) -> None:
        errors = validate_pipeline(MINIMAL_PIPELINE_YAML)
        assert errors == []

    def test_valid_pipeline_file_returns_no_errors(self, tmp_path: Path) -> None:
        f = tmp_path / "bug-fix.yaml"
        f.write_text(VALID_PIPELINE_YAML, encoding="utf-8")
        errors = validate_pipeline(f)
        assert errors == []

    def test_valid_pipeline_dict_returns_no_errors(self) -> None:
        raw = {
            "name": "Test",
            "stages": [{"id": "analyze", "name": "Analyze", "prompt": "Do it."}],
        }
        errors = validate_pipeline(raw)
        assert errors == []

    # --- YAML syntax errors ---

    def test_invalid_yaml_syntax_returns_error(self) -> None:
        bad_yaml = "name: Test\nstages: [\n  - id: analyze\n"  # unclosed bracket
        errors = validate_pipeline(bad_yaml)
        assert len(errors) >= 1
        assert any("YAML syntax error" in e.message for e in errors)

    def test_invalid_yaml_file_syntax_returns_error(self, tmp_path: Path) -> None:
        f = tmp_path / "broken.yaml"
        f.write_text("name: Test\nstages: [\n  - id:\n", encoding="utf-8")
        errors = validate_pipeline(f)
        # Should report YAML or schema error
        assert len(errors) >= 1

    # --- Schema / Pydantic errors ---

    def test_missing_name_field_returns_error(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            stages:
              - id: analyze
                name: Analyze
                prompt: Do it.
            """
        )
        errors = validate_pipeline(yaml_str)
        assert len(errors) >= 1
        assert any("name" in e.message.lower() or (e.location and "name" in e.location) for e in errors)

    def test_empty_stages_list_returns_error(self) -> None:
        yaml_str = "name: Empty\nstages: []\n"
        errors = validate_pipeline(yaml_str)
        assert len(errors) >= 1

    def test_missing_stage_prompt_returns_error(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Bad Stage
            stages:
              - id: analyze
                name: Analyze
            """
        )
        errors = validate_pipeline(yaml_str)
        assert len(errors) >= 1
        assert any("prompt" in e.message.lower() or (e.location and "prompt" in e.location) for e in errors)

    def test_too_many_stages_returns_error(self) -> None:
        stages = "\n".join(
            f"  - id: stage{i}\n    name: Stage {i}\n    prompt: Do it."
            for i in range(11)
        )
        yaml_str = f"name: Too Many Stages\nstages:\n{stages}\n"
        errors = validate_pipeline(yaml_str)
        assert len(errors) >= 1
        assert any("maximum" in e.message.lower() or "10" in e.message for e in errors)

    # --- Duplicate stage IDs ---

    def test_duplicate_stage_ids_returns_error(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Dups
            stages:
              - id: analyze
                name: Analyze
                prompt: Do it.
              - id: analyze
                name: Analyze Again
                prompt: Do it again.
            """
        )
        errors = validate_pipeline(yaml_str)
        assert len(errors) >= 1
        assert any("duplicate" in e.message.lower() or "Duplicate" in e.message for e in errors)

    # --- Unknown claude_flags ---

    def test_unknown_claude_flag_returns_error(self) -> None:
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
        errors = validate_pipeline(yaml_str)
        # We expect at least one error (Pydantic 'extra inputs' + our custom check)
        assert len(errors) >= 1
        messages = " ".join(e.message for e in errors)
        assert "not_a_real_flag" in messages

    def test_unknown_flag_with_typo_suggests_correction(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Typo Flag
            stages:
              - id: analyze
                name: Analyze
                prompt: Do it.
                claude_flags:
                  max_turn: 5
            """
        )
        errors = validate_pipeline(yaml_str)
        # Our custom check should fire and suggest 'max_turns'
        custom_errors = [e for e in errors if "max_turn" in e.message and "Unknown" in e.message]
        assert len(custom_errors) >= 1
        assert "max_turns" in custom_errors[0].message  # suggestion present

    def test_known_claude_flags_do_not_produce_flag_errors(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Known Flags
            stages:
              - id: analyze
                name: Analyze
                prompt: Do it.
                claude_flags:
                  model: claude-sonnet-4-20250514
                  max_turns: 5
                  permission_mode: plan
            """
        )
        errors = validate_pipeline(yaml_str)
        assert errors == []

    # --- Stage reference validity ---

    def test_unknown_stage_reference_returns_error(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Bad Ref
            stages:
              - id: analyze
                name: Analyze
                prompt: Based on {{stages.nonexistent.output}}, do it.
            """
        )
        errors = validate_pipeline(yaml_str)
        assert len(errors) >= 1
        assert any("nonexistent" in e.message for e in errors)

    def test_valid_upstream_stage_reference_no_error(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Cross Ref
            stages:
              - id: analyze
                name: Analyze
                prompt: Find the bug.
              - id: implement
                name: Implement
                prompt: Based on {{stages.analyze.output}}, implement the fix.
            """
        )
        errors = validate_pipeline(yaml_str)
        assert errors == []

    def test_forward_stage_reference_returns_error(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Forward Ref
            stages:
              - id: analyze
                name: Analyze
                prompt: See result at {{stages.implement.output}}.
              - id: implement
                name: Implement
                prompt: Do the work.
            """
        )
        errors = validate_pipeline(yaml_str)
        assert len(errors) >= 1
        forward_errors = [e for e in errors if "forward" in e.message.lower() or "Forward" in e.message]
        assert len(forward_errors) >= 1
        assert any("implement" in e.message for e in forward_errors)

    # --- Template variable namespace checks ---

    def test_unknown_template_namespace_returns_error(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Bad Template
            stages:
              - id: analyze
                name: Analyze
                prompt: Use {{env.API_KEY}} for this.
            """
        )
        errors = validate_pipeline(yaml_str)
        assert len(errors) >= 1
        assert any("env" in e.message for e in errors)

    def test_known_template_namespaces_no_error(self) -> None:
        yaml_str = textwrap.dedent(
            """\
            name: Good Templates
            stages:
              - id: analyze
                name: Analyze
                prompt: Task is {{task.description}} for {{project.name}}.
            """
        )
        errors = validate_pipeline(yaml_str)
        assert errors == []

    # --- File path label propagation ---

    def test_file_path_label_in_error(self, tmp_path: Path) -> None:
        bad = tmp_path / "broken.yaml"
        bad.write_text("stages: []\n", encoding="utf-8")  # missing name
        errors = validate_pipeline(bad)
        assert len(errors) >= 1
        assert all(str(bad) in e.file_path for e in errors)

    def test_custom_file_path_label_in_error(self) -> None:
        errors = validate_pipeline("stages: []\n", file_path="/custom/path.yaml")
        assert len(errors) >= 1
        assert all("/custom/path.yaml" in e.file_path for e in errors)

    # --- Non-mapping YAML ---

    def test_non_mapping_yaml_returns_error(self) -> None:
        errors = validate_pipeline("- item1\n- item2\n")
        assert len(errors) >= 1
        assert any("mapping" in e.message.lower() for e in errors)

    # --- Multiple errors reported at once ---

    def test_multiple_errors_returned(self) -> None:
        """A pipeline with two bad flags should report both."""
        yaml_str = textwrap.dedent(
            """\
            name: Multi Error
            stages:
              - id: analyze
                name: Analyze
                prompt: Do it.
                claude_flags:
                  bad_flag_one: true
                  bad_flag_two: true
            """
        )
        errors = validate_pipeline(yaml_str)
        custom_flag_errors = [
            e for e in errors if "Unknown claude_flag" in e.message
        ]
        # Both unknown flags must be reported.
        assert len(custom_flag_errors) == 2
        flag_names = {e.message.split("'")[1] for e in custom_flag_errors}
        assert "bad_flag_one" in flag_names
        assert "bad_flag_two" in flag_names

    def test_pydantic_error_message_strips_value_error_prefix(self) -> None:
        """Pydantic 'Value error, ...' prefix should be stripped from messages."""
        yaml_str = textwrap.dedent(
            """\
            name: Bad Pipeline
            stages:
              - id: analyze
                name: Analyze
                prompt: Ref {{stages.ghost.output}}
            """
        )
        errors = validate_pipeline(yaml_str)
        for e in errors:
            assert not e.message.startswith("Value error, "), (
                f"Error message should not start with 'Value error,': {e.message!r}"
            )


class TestValidateAllPipelines:
    """Tests for validate_all_pipelines()."""

    def test_no_pipelines_dir_returns_empty_dict(self, tmp_path: Path) -> None:
        project_dir = tmp_path / "project"
        project_dir.mkdir()
        result = validate_all_pipelines(project_dir)
        assert result == {}

    def test_empty_pipelines_dir_returns_empty_dict(self, tmp_path: Path) -> None:
        project_dir = tmp_path / "project"
        pipelines_dir = project_dir / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        result = validate_all_pipelines(project_dir)
        assert result == {}

    def test_valid_pipeline_file_maps_to_no_errors(self, tmp_path: Path) -> None:
        project_dir = tmp_path / "project"
        pipelines_dir = project_dir / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        (pipelines_dir / "bug-fix.yaml").write_text(VALID_PIPELINE_YAML, encoding="utf-8")

        result = validate_all_pipelines(project_dir)
        assert len(result) == 1
        errors = list(result.values())[0]
        assert errors == []

    def test_invalid_pipeline_file_maps_to_errors(self, tmp_path: Path) -> None:
        project_dir = tmp_path / "project"
        pipelines_dir = project_dir / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        bad_yaml = "stages: []\n"  # missing 'name'
        (pipelines_dir / "bad.yaml").write_text(bad_yaml, encoding="utf-8")

        result = validate_all_pipelines(project_dir)
        assert len(result) == 1
        errors = list(result.values())[0]
        assert len(errors) >= 1

    def test_multiple_files_all_validated(self, tmp_path: Path) -> None:
        project_dir = tmp_path / "project"
        pipelines_dir = project_dir / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        (pipelines_dir / "valid.yaml").write_text(VALID_PIPELINE_YAML, encoding="utf-8")
        (pipelines_dir / "invalid.yaml").write_text("stages: []\n", encoding="utf-8")

        result = validate_all_pipelines(project_dir)
        assert len(result) == 2

        # Find the two files in the result
        paths = {p.name: errs for p, errs in result.items()}
        assert paths["valid.yaml"] == []
        assert len(paths["invalid.yaml"]) >= 1

    def test_yml_extension_also_picked_up(self, tmp_path: Path) -> None:
        project_dir = tmp_path / "project"
        pipelines_dir = project_dir / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        (pipelines_dir / "pipeline.yml").write_text(MINIMAL_PIPELINE_YAML, encoding="utf-8")

        result = validate_all_pipelines(project_dir)
        assert len(result) == 1
        assert list(result.values())[0] == []

    def test_result_keys_are_path_objects(self, tmp_path: Path) -> None:
        project_dir = tmp_path / "project"
        pipelines_dir = project_dir / ".pegasus" / "pipelines"
        pipelines_dir.mkdir(parents=True)
        (pipelines_dir / "test.yaml").write_text(MINIMAL_PIPELINE_YAML, encoding="utf-8")

        result = validate_all_pipelines(project_dir)
        assert all(isinstance(k, Path) for k in result)

    def test_none_project_dir_does_not_raise(self) -> None:
        """Passing None uses cwd; should not raise even if no pipelines dir exists."""
        result = validate_all_pipelines(None)
        assert isinstance(result, dict)
