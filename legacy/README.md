# Pegasus

Orchestrate Claude Code through YAML-defined multi-stage pipelines, each running in an isolated git worktree.

Define repeatable AI coding workflows (bug fixes, features, refactors) as YAML pipelines, then run them in parallel across isolated worktrees with a rich terminal dashboard.

## Quick Start

```bash
# Install
pip install -e .

# Initialize in your project
cd your-project
pegasus init

# Run a pipeline
pegasus run --pipeline bug-fix --desc "Login fails on Safari"

# Monitor progress
pegasus tui
```

## How It Works

Pegasus reads pipeline definitions from `.pegasus/pipelines/`, creates an isolated git worktree for each task, and executes stages sequentially through the Claude Agent SDK.

```
you define:                    pegasus runs:

.pegasus/pipelines/            worktree: ~/.pegasus/worktrees/myapp--a3f8c2
  bug-fix.yaml                   Stage 1: Root Cause Analysis  [claude-sonnet]
    analyze → implement → verify  Stage 2: Apply Fix            [claude-sonnet]
                                  Stage 3: Verify Fix           [claude-sonnet]
```

Each task gets its own git branch and worktree — run 3 tasks in parallel without file conflicts.

## Pipeline YAML

Pipelines live in `.pegasus/pipelines/`. Each stage maps to a Claude Code invocation with configurable flags:

```yaml
name: Bug Fix
description: Analyze, patch, and verify a reported bug

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
      permission_mode: plan
      max_turns: 5

  - id: implement
    name: Apply Fix
    prompt: |
      Implement the fix for the bug you analyzed.
    claude_flags:
      permission_mode: acceptEdits
      max_turns: 10
    requires_approval: true

  - id: verify
    name: Verify Fix
    prompt: |
      Verify the fix is correct.
    claude_flags:
      permission_mode: plan
      max_turns: 5
```

### Supported `claude_flags`

`model`, `permission_mode`, `tools`, `max_turns`, `output_format`, `allowed_tools`, `disallowed_tools`, `add_dir`, `append_system_prompt`

Flags are resolved in layers: **stage > pipeline defaults > project config > user config > built-in defaults**. Project-level `max_permission` acts as a ceiling — stages cannot exceed it (deny-wins).

## CLI Commands

| Command | Description |
|---------|-------------|
| `pegasus init` | Scaffold `.pegasus/` with auto-detected settings and starter templates |
| `pegasus run --pipeline <name> --desc "..."` | Create task, branch, worktree, and start pipeline |
| `pegasus run --dry-run ...` | Show resolved commands without API calls |
| `pegasus status` | List all active tasks with progress |
| `pegasus status <task-id>` | Detailed status for one task |
| `pegasus validate` | Check pipeline YAML files for errors |
| `pegasus resume <task-id>` | Restart a failed/paused task from the failed stage |
| `pegasus tui` | Launch the interactive terminal dashboard |

## TUI Dashboard

`pegasus tui` launches a Textual terminal interface showing all active tasks:

```
+-------------------------------------------------------------+
|  PEGASUS DASHBOARD                         3 tasks running   |
+--------------------+--------------------+--------------------+
| * a3f8c2 bug-fix   | * b7d1e9 feature   | * c4f2a0 refactor |
| Login fails Safari  | Dark mode toggle   | Extract auth svc  |
|                    |                    |                    |
| [done] Analyze     | [done] Parse Reqs  | [run]  Analyze    |
| [done] Plan        | [run]  Implement   | [wait] Plan       |
| [run]  Implement   | [wait] Test        | [wait] Implement  |
| [wait] Verify      |                    | [wait] Verify     |
+--------------------+--------------------+--------------------+
| LOGS (a3f8c2)                                                |
| [13:42] Stage 3: Generating patch using claude-sonnet-4      |
| [13:43] Awaiting approval for file write...                  |
+-------------------------------------------------------------+
```

**Keybindings**: `D` toggle view, `Tab` cycle tasks, `A` approve, `R` reject, `L` toggle logs, `Q` quit

## Configuration

### Project config (`.pegasus/config.yaml`)

```yaml
project:
  language: python
  test_command: "pytest"
  lint_command: "ruff check ."
  setup_command: "pip install -e ."

git:
  branch_prefix: "pegasus/"
  auto_cleanup: true

defaults:
  model: claude-sonnet-4-20250514
  max_turns: 10
  permission_mode: plan
  max_permission: acceptEdits  # deny-wins ceiling

concurrency:
  max_tasks: 3
```

### User config (`~/.config/pegasus/config.yaml`)

Personal defaults and pipelines that follow you across projects. Place custom pipelines in `~/.config/pegasus/pipelines/`.

### Config precedence

Stage flags > Pipeline defaults > Project config > User config > Built-in defaults

## Architecture

Three Python modules with zero coupling between runner and UI:

```
runner.py → writes state → pegasus.db ← reads state ← ui.py
                                      ← reads state ← future web GUI
```

- **runner.py** — Headless pipeline executor (Agent SDK, worktrees, heartbeat)
- **ui.py** — Click CLI + Textual TUI (reads SQLite only, never imports runner)
- **models.py** — Shared data contracts (Pydantic models, SQLite schema, config resolution)

SQLite (WAL mode) is the sole bridge. Any future UI (web dashboard, mobile) just reads the same database.

## Development

```bash
# Setup
uv venv .venv --python 3.10
source .venv/bin/activate
uv pip install -e ".[dev]"

# Tests
pytest tests/ -v

# Lint
ruff check src/
```

## Requirements

- Python 3.10+
- Git 2.20+ (worktree support)
- Anthropic API key

## License

MIT
