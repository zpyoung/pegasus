"""Pegasus shared data contracts: Pydantic models for YAML config validation.

This module defines:
- Pipeline YAML schema (PipelineConfig, StageConfig, ClaudeFlags)
- Project config.yaml schema (PegasusConfig)
- claude_flags allowlist
- Helper utilities for loading and validating YAML configs
- Layered config resolution (stage > pipeline > project > user > built-in)
- Permission ceiling logic (max_permission, deny-wins)
- SQLite connection factory, schema initialization, and state transitions
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator

# ---------------------------------------------------------------------------
# claude_flags allowlist
# ---------------------------------------------------------------------------

#: Curated set of Claude Code CLI flags permitted in pipeline YAML.
#: Any flag not in this set will be rejected during validation.
ALLOWED_CLAUDE_FLAGS: frozenset[str] = frozenset(
    {
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
)

#: Valid permission modes for Claude Code.
VALID_PERMISSION_MODES: frozenset[str] = frozenset(
    {"plan", "acceptEdits", "bypassPermissions"}
)

#: Valid output formats.
VALID_OUTPUT_FORMATS: frozenset[str] = frozenset({"text", "json", "stream-json"})

#: Maximum number of stages allowed per pipeline (MVP constraint).
MAX_STAGES: int = 10

#: Maximum allowed max_turns per stage.
MAX_TURNS_LIMIT: int = 100


# ---------------------------------------------------------------------------
# ClaudeFlags — per-stage flag overrides
# ---------------------------------------------------------------------------


class ClaudeFlags(BaseModel):
    """Curated subset of Claude Code CLI flags.

    Only fields in ``ALLOWED_CLAUDE_FLAGS`` are accepted.  Unknown keys are
    rejected by Pydantic's ``model_config`` (no extras allowed).
    """

    model_config = {"extra": "forbid"}

    model: str | None = None
    permission_mode: str | None = None
    tools: str | None = None
    max_turns: Annotated[int, Field(gt=0, le=MAX_TURNS_LIMIT)] | None = None
    output_format: str | None = None
    allowed_tools: str | None = None
    disallowed_tools: str | None = None
    add_dir: str | None = None
    append_system_prompt: str | None = None

    @field_validator("permission_mode")
    @classmethod
    def validate_permission_mode(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_PERMISSION_MODES:
            raise ValueError(
                f"permission_mode '{v}' is not allowed. "
                f"Valid options: {sorted(VALID_PERMISSION_MODES)}"
            )
        return v

    @field_validator("output_format")
    @classmethod
    def validate_output_format(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_OUTPUT_FORMATS:
            raise ValueError(
                f"output_format '{v}' is not valid. "
                f"Valid options: {sorted(VALID_OUTPUT_FORMATS)}"
            )
        return v


# ---------------------------------------------------------------------------
# StageConfig — one pipeline stage
# ---------------------------------------------------------------------------


class StageConfig(BaseModel):
    """Configuration for a single pipeline stage."""

    model_config = {"extra": "forbid"}

    id: str = Field(..., min_length=1, pattern=r"^[a-z][a-z0-9_-]*$")
    name: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    claude_flags: ClaudeFlags = Field(default_factory=ClaudeFlags)
    requires_approval: bool = False

    @field_validator("id")
    @classmethod
    def validate_id(cls, v: str) -> str:
        if not re.match(r"^[a-z][a-z0-9_-]*$", v):
            raise ValueError(
                f"Stage id '{v}' must start with a lowercase letter and contain "
                "only lowercase letters, digits, underscores, or hyphens."
            )
        return v


# ---------------------------------------------------------------------------
# PipelineDefaults — pipeline-level claude_flags defaults
# ---------------------------------------------------------------------------


class PipelineDefaults(BaseModel):
    """Pipeline-level default flags applied to all stages unless overridden."""

    model_config = {"extra": "forbid"}

    model: str | None = None
    max_turns: Annotated[int, Field(gt=0, le=MAX_TURNS_LIMIT)] | None = None
    permission_mode: str | None = None

    @field_validator("permission_mode")
    @classmethod
    def validate_permission_mode(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_PERMISSION_MODES:
            raise ValueError(
                f"permission_mode '{v}' is not allowed. "
                f"Valid options: {sorted(VALID_PERMISSION_MODES)}"
            )
        return v


# ---------------------------------------------------------------------------
# ExecutionConfig — pipeline execution settings
# ---------------------------------------------------------------------------


class ExecutionConfig(BaseModel):
    """Pipeline execution settings."""

    model_config = {"extra": "forbid"}

    mode: Literal["session"] = "session"


# ---------------------------------------------------------------------------
# PipelineConfig — top-level pipeline YAML schema
# ---------------------------------------------------------------------------


class PipelineConfig(BaseModel):
    """Top-level schema for a Pegasus pipeline YAML file.

    Maps to ``.pegasus/pipelines/<name>.yaml``.
    """

    model_config = {"extra": "forbid"}

    name: str = Field(..., min_length=1)
    description: str | None = None
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)
    defaults: PipelineDefaults = Field(default_factory=PipelineDefaults)
    stages: list[StageConfig] = Field(..., min_length=1)

    @field_validator("stages")
    @classmethod
    def validate_stages(cls, v: list[StageConfig]) -> list[StageConfig]:
        if len(v) > MAX_STAGES:
            raise ValueError(
                f"Pipeline has {len(v)} stages, but the maximum is {MAX_STAGES}."
            )
        # Ensure stage IDs are unique
        ids = [s.id for s in v]
        if len(ids) != len(set(ids)):
            seen: set[str] = set()
            duplicates = [sid for sid in ids if sid in seen or seen.add(sid)]  # type: ignore[func-returns-value]
            raise ValueError(f"Duplicate stage IDs found: {sorted(set(duplicates))}")
        return v

    @model_validator(mode="after")
    def validate_stage_references(self) -> PipelineConfig:
        """Check that {{stages.X.output}} references point to valid stage IDs."""
        valid_ids = {s.id for s in self.stages}
        pattern = re.compile(r"\{\{stages\.([a-z][a-z0-9_-]*)\.(\w+)\}\}")
        for stage in self.stages:
            for match in pattern.finditer(stage.prompt):
                ref_id = match.group(1)
                if ref_id not in valid_ids:
                    raise ValueError(
                        f"Stage '{stage.id}' references unknown stage '{ref_id}' "
                        f"in template variable '{{{{stages.{ref_id}.{match.group(2)}}}}}'."
                    )
        return self


# ---------------------------------------------------------------------------
# PegasusConfig — project config.yaml schema
# ---------------------------------------------------------------------------


class ProjectConfig(BaseModel):
    """Project-level settings (language, commands)."""

    model_config = {"extra": "forbid"}

    language: str | None = None
    test_command: str | None = None
    lint_command: str | None = None
    setup_command: str | None = None


class GitConfig(BaseModel):
    """Git-related settings."""

    model_config = {"extra": "forbid"}

    default_branch: str = "main"
    branch_prefix: str = "pegasus/"
    auto_cleanup: bool = True


class DefaultsConfig(BaseModel):
    """Built-in default flag values."""

    model_config = {"extra": "forbid"}

    model: str = "claude-sonnet-4-20250514"
    max_turns: Annotated[int, Field(gt=0, le=MAX_TURNS_LIMIT)] = 10
    permission_mode: str = "plan"
    max_permission: str = "acceptEdits"

    @field_validator("permission_mode", "max_permission")
    @classmethod
    def validate_permission(cls, v: str) -> str:
        if v not in VALID_PERMISSION_MODES:
            raise ValueError(
                f"'{v}' is not a valid permission mode. "
                f"Valid options: {sorted(VALID_PERMISSION_MODES)}"
            )
        return v


class ConcurrencyConfig(BaseModel):
    """Concurrency and retry settings."""

    model_config = {"extra": "forbid"}

    max_tasks: Annotated[int, Field(gt=0, le=10)] = 3
    retry_max: Annotated[int, Field(ge=0, le=20)] = 5
    retry_base_delay: Annotated[float, Field(gt=0.0)] = 1.0


class NotificationEvent(BaseModel):
    """Notification target for a lifecycle event."""

    model_config = {"extra": "allow"}


class NotificationsConfig(BaseModel):
    """Desktop notification settings."""

    model_config = {"extra": "forbid"}

    on_stage_complete: str | None = "desktop"
    on_approval_needed: str | None = "desktop"
    on_pipeline_complete: str | None = "desktop"
    on_pipeline_failed: str | None = "desktop"


class WorktreesConfig(BaseModel):
    """Worktree storage settings."""

    model_config = {"extra": "forbid"}

    base_path: str = "~/.pegasus/worktrees"


class PegasusMetaConfig(BaseModel):
    """Top-level pegasus version metadata."""

    model_config = {"extra": "forbid"}

    version: str = "0.1.0"


class PegasusConfig(BaseModel):
    """Top-level schema for ``.pegasus/config.yaml`` (and user config).

    All sections are optional; omitted sections fall back to built-in defaults.
    """

    model_config = {"extra": "forbid"}

    pegasus: PegasusMetaConfig = Field(default_factory=PegasusMetaConfig)
    project: ProjectConfig = Field(default_factory=ProjectConfig)
    git: GitConfig = Field(default_factory=GitConfig)
    defaults: DefaultsConfig = Field(default_factory=DefaultsConfig)
    concurrency: ConcurrencyConfig = Field(default_factory=ConcurrencyConfig)
    notifications: NotificationsConfig = Field(default_factory=NotificationsConfig)
    worktrees: WorktreesConfig = Field(default_factory=WorktreesConfig)


# ---------------------------------------------------------------------------
# YAML loading helpers
# ---------------------------------------------------------------------------


def load_pipeline_config(path: str | Path) -> PipelineConfig:
    """Load and validate a pipeline YAML file.

    Args:
        path: Path to the pipeline YAML file.

    Returns:
        A validated ``PipelineConfig`` instance.

    Raises:
        FileNotFoundError: If the file does not exist.
        yaml.YAMLError: If the file is not valid YAML.
        pydantic.ValidationError: If the YAML content does not match the schema.
    """
    path = Path(path)
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"Pipeline YAML must be a mapping, got {type(raw).__name__}")
    return PipelineConfig.model_validate(raw)


def load_project_config(path: str | Path) -> PegasusConfig:
    """Load and validate a project or user ``config.yaml`` file.

    Args:
        path: Path to the config YAML file.

    Returns:
        A validated ``PegasusConfig`` instance.

    Raises:
        FileNotFoundError: If the file does not exist.
        yaml.YAMLError: If the file is not valid YAML.
        pydantic.ValidationError: If the YAML content does not match the schema.
    """
    path = Path(path)
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ValueError(f"Config YAML must be a mapping, got {type(raw).__name__}")
    return PegasusConfig.model_validate(raw)


def parse_pipeline_yaml(content: str) -> PipelineConfig:
    """Parse and validate pipeline YAML from a string.

    Args:
        content: YAML string content.

    Returns:
        A validated ``PipelineConfig`` instance.

    Raises:
        yaml.YAMLError: If the content is not valid YAML.
        pydantic.ValidationError: If the content does not match the schema.
    """
    raw: Any = yaml.safe_load(content)
    if not isinstance(raw, dict):
        raise ValueError(f"Pipeline YAML must be a mapping, got {type(raw).__name__}")
    return PipelineConfig.model_validate(raw)


def parse_project_config_yaml(content: str) -> PegasusConfig:
    """Parse and validate project config YAML from a string.

    Args:
        content: YAML string content.

    Returns:
        A validated ``PegasusConfig`` instance.
    """
    raw: Any = yaml.safe_load(content)
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ValueError(f"Config YAML must be a mapping, got {type(raw).__name__}")
    return PegasusConfig.model_validate(raw)


# ---------------------------------------------------------------------------
# Layered config resolution
# ---------------------------------------------------------------------------

#: Permission levels ordered from least to most permissive (index = power level).
#: deny-wins means we always cap at the *lowest* permitted ceiling.
PERMISSION_ORDER: list[str] = ["plan", "acceptEdits", "bypassPermissions"]

#: Built-in default values used when no config files override them.
BUILT_IN_DEFAULTS: dict[str, Any] = {
    "model": "claude-sonnet-4-20250514",
    "max_turns": 10,
    "permission_mode": "plan",
    "max_permission": "acceptEdits",
}

#: Write-mode permission levels that trigger auto-require-approval.
_WRITE_PERMISSION_MODES: frozenset[str] = frozenset({"acceptEdits", "bypassPermissions"})


def _permission_index(mode: str) -> int:
    """Return numeric index for a permission mode (lower = more restricted).

    Args:
        mode: One of ``plan``, ``acceptEdits``, ``bypassPermissions``.

    Returns:
        Integer index (0, 1, or 2).  Defaults to 0 (most restrictive) for
        unknown values so that unknown modes never escalate privilege.
    """
    try:
        return PERMISSION_ORDER.index(mode)
    except ValueError:
        return 0


def _cap_permission(requested: str, ceiling: str) -> str:
    """Apply the deny-wins permission ceiling.

    If *requested* is more permissive than *ceiling*, return *ceiling*.
    Otherwise return *requested* unchanged.

    Args:
        requested: The permission mode being requested by a stage.
        ceiling: The maximum permitted permission mode from project config.

    Returns:
        The effective (capped) permission mode string.
    """
    if _permission_index(requested) > _permission_index(ceiling):
        return ceiling
    return requested


def load_config(project_dir: str | Path | None = None) -> PegasusConfig:
    """Load and merge YAML configs: built-in < user < project.

    Resolution order (each layer overrides the previous):

    1. **Built-in defaults** — hard-coded in ``BUILT_IN_DEFAULTS``
    2. **User config** — ``~/.config/pegasus/config.yaml`` (XDG compliant)
    3. **Project config** — ``<project_dir>/.pegasus/config.yaml``

    Absent config files are silently skipped.  A present but empty file is
    treated as an empty mapping (all sections default).

    Args:
        project_dir: Root directory of the project.  When ``None``, the
            current working directory is used.  Project-level config is
            loaded from ``<project_dir>/.pegasus/config.yaml``.

    Returns:
        A merged ``PegasusConfig`` with the highest-precedence value for
        every field.
    """
    if project_dir is None:
        project_dir = Path.cwd()
    else:
        project_dir = Path(project_dir)

    # --- Layer 1: built-in defaults (always present) ---
    merged: dict[str, Any] = {}

    def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
        """Recursively merge *override* into *base*.  Returns a new dict."""
        result = dict(base)
        for key, val in override.items():
            if (
                key in result
                and isinstance(result[key], dict)
                and isinstance(val, dict)
            ):
                result[key] = _deep_merge(result[key], val)
            else:
                result[key] = val
        return result

    # --- Layer 2: user config (~/.config/pegasus/config.yaml) ---
    user_config_path = Path.home() / ".config" / "pegasus" / "config.yaml"
    if user_config_path.exists():
        raw_user: Any = yaml.safe_load(user_config_path.read_text(encoding="utf-8"))
        if raw_user is None:
            raw_user = {}
        if isinstance(raw_user, dict):
            merged = _deep_merge(merged, raw_user)

    # --- Layer 3: project config (.pegasus/config.yaml) ---
    project_config_path = project_dir / ".pegasus" / "config.yaml"
    if project_config_path.exists():
        raw_project: Any = yaml.safe_load(project_config_path.read_text(encoding="utf-8"))
        if raw_project is None:
            raw_project = {}
        if isinstance(raw_project, dict):
            merged = _deep_merge(merged, raw_project)

    return PegasusConfig.model_validate(merged)


def resolve_stage_flags(
    stage: StageConfig,
    pipeline_defaults: PipelineDefaults | None = None,
    project_config: PegasusConfig | None = None,
) -> tuple[ClaudeFlags, bool]:
    """Resolve the effective ``ClaudeFlags`` and ``requires_approval`` for a stage.

    Resolution order (later overrides earlier):

    1. Built-in defaults (``BUILT_IN_DEFAULTS``)
    2. Project config ``defaults`` section
    3. Pipeline ``defaults`` block
    4. Stage-level ``claude_flags`` overrides

    After merging, the permission ceiling (``max_permission`` from project
    config) is applied using deny-wins: if the effective ``permission_mode``
    exceeds the ceiling, it is clamped down to the ceiling value.

    ``requires_approval`` is auto-set to ``True`` for any stage whose
    effective ``permission_mode`` is a write mode (``acceptEdits`` or
    ``bypassPermissions``).  An explicit ``requires_approval=True`` on the
    stage is always preserved; auto-set only upgrades ``False -> True``.

    Args:
        stage: The ``StageConfig`` whose flags to resolve.
        pipeline_defaults: Optional pipeline-level defaults (from
            ``PipelineConfig.defaults``).
        project_config: Optional loaded ``PegasusConfig`` (project/user/built-in
            merged).  When ``None``, only ``BUILT_IN_DEFAULTS`` apply.

    Returns:
        A ``(ClaudeFlags, requires_approval)`` tuple with fully resolved values.
    """
    # --- Start with built-in defaults ---
    effective: dict[str, Any] = {
        "model": BUILT_IN_DEFAULTS["model"],
        "max_turns": BUILT_IN_DEFAULTS["max_turns"],
        "permission_mode": BUILT_IN_DEFAULTS["permission_mode"],
    }

    # --- Layer 2: project config defaults ---
    max_permission: str = BUILT_IN_DEFAULTS["max_permission"]
    if project_config is not None:
        d = project_config.defaults
        if d.model is not None:
            effective["model"] = d.model
        if d.max_turns is not None:
            effective["max_turns"] = d.max_turns
        if d.permission_mode is not None:
            effective["permission_mode"] = d.permission_mode
        max_permission = d.max_permission

    # --- Layer 3: pipeline defaults ---
    if pipeline_defaults is not None:
        if pipeline_defaults.model is not None:
            effective["model"] = pipeline_defaults.model
        if pipeline_defaults.max_turns is not None:
            effective["max_turns"] = pipeline_defaults.max_turns
        if pipeline_defaults.permission_mode is not None:
            effective["permission_mode"] = pipeline_defaults.permission_mode

    # --- Layer 4: stage-level overrides ---
    stage_flags = stage.claude_flags
    if stage_flags.model is not None:
        effective["model"] = stage_flags.model
    if stage_flags.max_turns is not None:
        effective["max_turns"] = stage_flags.max_turns
    if stage_flags.permission_mode is not None:
        effective["permission_mode"] = stage_flags.permission_mode
    # Pass through remaining stage-specific flags directly.
    if stage_flags.tools is not None:
        effective["tools"] = stage_flags.tools
    if stage_flags.output_format is not None:
        effective["output_format"] = stage_flags.output_format
    if stage_flags.allowed_tools is not None:
        effective["allowed_tools"] = stage_flags.allowed_tools
    if stage_flags.disallowed_tools is not None:
        effective["disallowed_tools"] = stage_flags.disallowed_tools
    if stage_flags.add_dir is not None:
        effective["add_dir"] = stage_flags.add_dir
    if stage_flags.append_system_prompt is not None:
        effective["append_system_prompt"] = stage_flags.append_system_prompt

    # --- Apply permission ceiling (deny-wins) ---
    effective["permission_mode"] = _cap_permission(
        effective["permission_mode"], max_permission
    )

    resolved_flags = ClaudeFlags.model_validate(effective)

    # --- Auto-require-approval for write stages ---
    requires_approval = stage.requires_approval
    if resolved_flags.permission_mode in _WRITE_PERMISSION_MODES:
        requires_approval = True

    return resolved_flags, requires_approval


# ---------------------------------------------------------------------------
# SQLite schema version
# ---------------------------------------------------------------------------

#: Current schema version.  Bump this when DDL changes.
SCHEMA_VERSION: int = 1

# ---------------------------------------------------------------------------
# SQLite connection factory
# ---------------------------------------------------------------------------

_DDL = """
CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    pipeline      TEXT NOT NULL,
    description   TEXT,
    status        TEXT DEFAULT 'queued',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    session_id    TEXT,
    context       TEXT,
    branch        TEXT,
    worktree_path TEXT,
    base_branch   TEXT,
    merge_status  TEXT,
    total_cost    REAL DEFAULT 0.0,
    runner_pid    INTEGER,
    heartbeat_at  DATETIME
);

CREATE TABLE IF NOT EXISTS stage_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT REFERENCES tasks(id),
    stage_id    TEXT NOT NULL,
    stage_index INTEGER NOT NULL,
    status      TEXT DEFAULT 'pending',
    started_at  DATETIME,
    finished_at DATETIME,
    error       TEXT,
    cost        REAL DEFAULT 0.0,
    claude_flags TEXT
);

CREATE TABLE IF NOT EXISTS worktrees (
    task_id    TEXT PRIMARY KEY REFERENCES tasks(id),
    path       TEXT NOT NULL UNIQUE,
    branch     TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status     TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_heartbeat ON tasks(heartbeat_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_stage_runs_task ON stage_runs(task_id);
"""


def make_connection(db_path: str | Path, read_only: bool = False) -> sqlite3.Connection:
    """Create a SQLite connection with WAL mode and appropriate settings.

    For read-only connections (e.g. TUI polling) the URI ``mode=ro`` parameter
    is used.  This allows reads to proceed without blocking active writers and,
    critically, does NOT cache data the way ``immutable=1`` would — so the TUI
    always sees the latest committed state.

    Args:
        db_path: Path to the SQLite database file.
        read_only: When ``True``, open with ``mode=ro`` URI flag.

    Returns:
        A configured ``sqlite3.Connection`` with WAL mode enabled.
    """
    path_str = str(db_path)
    if read_only:
        # CRITICAL: use mode=ro, NOT immutable=1.
        # immutable=1 caches data and never detects external writes (stale TUI).
        uri = f"file:{path_str}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
    else:
        conn = sqlite3.connect(path_str, timeout=30.0, check_same_thread=False)

    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA wal_autocheckpoint = 100")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# ---------------------------------------------------------------------------
# Schema initialisation
# ---------------------------------------------------------------------------


def init_db(conn: sqlite3.Connection) -> None:
    """Create all Pegasus tables and indexes if they do not already exist.

    Also inserts the current ``SCHEMA_VERSION`` row into ``schema_version``
    (ignored if already present).

    Args:
        conn: An open ``sqlite3.Connection`` (writable, not ``mode=ro``).
    """
    conn.executescript(_DDL)
    conn.execute(
        "INSERT OR IGNORE INTO schema_version (version) VALUES (?)",
        (SCHEMA_VERSION,),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Safe state transition
# ---------------------------------------------------------------------------


def transition_task_state(
    conn: sqlite3.Connection,
    task_id: str,
    from_state: str,
    to_state: str,
) -> bool:
    """Atomically transition a task from *from_state* to *to_state*.

    Uses ``BEGIN IMMEDIATE`` to acquire the write lock upfront, avoiding
    TOCTOU races when multiple runner processes operate concurrently.

    Args:
        conn: An open ``sqlite3.Connection``.
        task_id: The task ``id`` to update.
        from_state: Expected current status; the transition aborts if the
            actual status differs.
        to_state: The target status to set.

    Returns:
        ``True`` if the transition succeeded, ``False`` if the task was not
        found or its status did not match *from_state*.
    """
    conn.execute("BEGIN IMMEDIATE")
    row = conn.execute(
        "SELECT status FROM tasks WHERE id = ?", (task_id,)
    ).fetchone()
    if row is None or row["status"] != from_state:
        conn.rollback()
        return False
    conn.execute(
        "UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (to_state, task_id),
    )
    conn.commit()
    return True
