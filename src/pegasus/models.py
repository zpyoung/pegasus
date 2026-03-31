"""Pegasus shared data contracts: Pydantic models for YAML config validation.

This module defines:
- Pipeline YAML schema (PipelineConfig, StageConfig, ClaudeFlags)
- Project config.yaml schema (PegasusConfig)
- claude_flags allowlist
- Helper utilities for loading and validating YAML configs
"""

from __future__ import annotations

import re
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
