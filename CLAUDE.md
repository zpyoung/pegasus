# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Pegasus orchestrates Claude Code through YAML-defined multi-stage pipelines, each running in an isolated git worktree. Define repeatable AI coding workflows as YAML, run them in parallel with a terminal dashboard.

## Commands

```bash
# Install (editable)
pip3 install -e .

# Run tests
python3 -m pytest tests/ -q

# Run a single test file
python3 -m pytest tests/test_runner.py -v

# Run a specific test
python3 -m pytest tests/test_runner.py -k "test_approval_pauses"

# Lint
ruff check src/

# Type check
mypy src/pegasus/
```

## Architecture

### Critical Constraint: Zero Coupling Between UI and Runner

```
ui.py ──writes──→ SQLite ←──reads/writes── runner.py
         │                                      ↑
         └─ spawns subprocess ─→ _run_task.py ──┘
```

- **`ui.py` NEVER imports `runner.py`**. All state flows through SQLite.
- **`runner.py` NEVER imports `ui.py`**.
- `_run_task.py` is the only module that imports `runner.py` — it's the subprocess bridge.
- This allows any UI (CLI, TUI, web) to read the same database without touching runner code.

### Module Dependency Graph

```
models.py ← runner.py ← _run_task.py (subprocess entry point)
models.py ← ui.py      (CLI + TUI, spawns _run_task.py via Popen)
```

`models.py` has zero pegasus imports — it's the shared foundation (Pydantic schemas, SQLite, config loading).

### Module Roles

- **`models.py`** — Pydantic models for pipeline/config YAML, SQLite schema + connection factory (`make_connection`, `init_db`), layered config resolution (`resolve_stage_flags`), pipeline validation, permission ceiling logic
- **`runner.py`** — `ClaudeAgentRunner` (SDK wrapper), `PegasusEngine` (stage execution + cost tracking), `WorktreeManager` (git worktree lifecycle), `PipelineExecutor` (top-level orchestrator: worktree creation → stage loop → approval gates → retry)
- **`ui.py`** — Click CLI commands (`init`, `run`, `status`, `validate`, `resume`, `clean`, `tui`) and Textual TUI (`PegasusDashboard`, `TaskCard`, `LogPanel`, `TaskCreateModal`). All inside `_get_textual_app()` to defer Textual imports.
- **`_run_task.py`** — Subprocess entry point: `python3 -m pegasus._run_task <task-id> [--resume]`. Reads `PEGASUS_PROJECT_DIR` env var, imports runner, executes pipeline.

### Key Design Patterns

- **Protocol-based testing**: `AgentRunnerProtocol` + `FakeAgentRunner` in `tests/fakes.py` enables unit testing without the Claude SDK installed.
- **Layered config resolution**: stage overrides > pipeline defaults > project config > built-in defaults, with a deny-wins permission ceiling (`max_permission`).
- **Template variables**: `{{project.language}}`, `{{task.description}}`, `{{stages.X.output}}` resolved in `PipelineExecutor._resolve_prompt()`.
- **Post-stage approval gates**: stages with `requires_approval: true` pause after completion; runner polls SQLite every 2s for TUI-driven approval.
- **Session continuity**: `execution: mode: session` passes SDK `resume` parameter between stages so the agent retains conversation history.

### SQLite State Machine

Task states: `queued → running → paused → queued → running → completed` (or `→ failed` at any point). The TUI sets `paused → queued` (approve) or `paused → failed` (reject).

### Test Structure

- **`tests/fakes.py`** — `FakeAgentRunner` test double, factory helpers (`make_fake_runner_with_tool_use`, `make_fake_runner_with_error`)
- **`test_models.py`** — Pydantic validation, config resolution, permission ceiling, SQLite schema
- **`test_runner.py`** — PegasusEngine, WorktreeManager, PipelineExecutor (approval gates, retry, heartbeat). Inline runner classes (e.g., `SlowRunner`) must accept `session_id: str | None = None` parameter.
- **`test_ui.py`** — CLI commands via `CliRunner`, TUI widgets via `app.run_test()`. Uses `_make_project()`, `_insert_task()`, `_insert_stage_run()` helpers.
- **`test_integration.py`** — End-to-end pipeline execution

## Tool Config

- **ruff**: line-length=100, src=["src"], py310 target
- **mypy**: strict mode
- **pytest**: asyncio_mode="auto", testpaths=["tests"]
