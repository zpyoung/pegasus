#!/usr/bin/env bash
# scan-backlog.sh — Reads backlog.json, outputs the next pending feature for the subagent.
# If no backlog.json exists, generates it from the MVP spec's critical path.
set -euo pipefail

LOOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$LOOP_DIR/state"
BACKLOG="$STATE_DIR/backlog.json"

if [ ! -f "$BACKLOG" ]; then
  # First run: generate backlog from the critical path
  cat > "$BACKLOG" << 'BACKLOG_JSON'
[
  {
    "id": "01-scaffold",
    "description": "Project scaffolding: pyproject.toml, src/pegasus/ package structure, __main__.py entry point, tests/ directory, .gitignore updates",
    "priority": "critical",
    "status": "pending",
    "depends_on": [],
    "target_files": ["pyproject.toml", "src/pegasus/__init__.py", "src/pegasus/__main__.py"]
  },
  {
    "id": "02-pydantic-models",
    "description": "models.py: Pydantic models for pipeline YAML config validation, stage schema, claude_flags allowlist, config.yaml schema. Include unit tests with valid/invalid YAML fixtures.",
    "priority": "critical",
    "status": "pending",
    "depends_on": ["01-scaffold"],
    "target_files": ["src/pegasus/models.py", "tests/test_models.py"]
  },
  {
    "id": "03-sqlite-schema",
    "description": "models.py: SQLite schema (tasks, stage_runs, worktrees, schema_version tables), make_connection() factory with WAL mode + mode=ro for reads, init_db(), transition_task_state() with BEGIN IMMEDIATE. Include unit tests using tmp_path fixtures (NOT :memory:).",
    "priority": "critical",
    "status": "pending",
    "depends_on": ["01-scaffold"],
    "target_files": ["src/pegasus/models.py", "tests/test_models.py"]
  },
  {
    "id": "04-config-resolution",
    "description": "models.py: Layered config resolution (stage > pipeline > project > user > built-in). Load and merge YAML configs from .pegasus/config.yaml, ~/.config/pegasus/config.yaml, and built-in defaults. Include permission ceiling (max_permission, deny-wins) and default-require-approval for write stages. Unit tests for resolution order and edge cases.",
    "priority": "critical",
    "status": "pending",
    "depends_on": ["02-pydantic-models"],
    "target_files": ["src/pegasus/models.py", "tests/test_models.py"]
  },
  {
    "id": "05-pipeline-validation",
    "description": "models.py: pegasus validate implementation. Check YAML schema compliance, stage reference validity ({{stages.X.output}}), unknown claude_flags against allowlist, template variable resolution. Include Pydantic validation error formatting. Unit tests with broken pipeline fixtures.",
    "priority": "critical",
    "status": "pending",
    "depends_on": ["02-pydantic-models", "04-config-resolution"],
    "target_files": ["src/pegasus/models.py", "tests/test_models.py"]
  },
  {
    "id": "06-engine-abstraction",
    "description": "runner.py: AgentRunnerProtocol (Protocol class), ClaudeAgentRunner (concrete SDK wrapper with CLAUDECODE=1 unset), FakeAgentRunner (test fake). PegasusEngine class wrapping the protocol with session_id management, SDK callback mapping (on_message, on_tool_use, on_result, on_error), and cost tracking. Include unit tests with FakeAgentRunner.",
    "priority": "critical",
    "status": "pending",
    "depends_on": ["03-sqlite-schema"],
    "target_files": ["src/pegasus/runner.py", "tests/test_runner.py", "tests/fakes.py"]
  },
  {
    "id": "07-worktree-lifecycle",
    "description": "runner.py: Git worktree manager — create worktree (branch from default branch, run setup_command), health check (clean state, setup success), cleanup (git worktree remove + prune), orphan detection on startup. Include integration tests with real git operations in tmp directories.",
    "priority": "critical",
    "status": "pending",
    "depends_on": ["03-sqlite-schema"],
    "target_files": ["src/pegasus/runner.py", "tests/test_runner.py"]
  },
  {
    "id": "08-pipeline-executor",
    "description": "runner.py: Pipeline executor — read pipeline YAML, resolve config, iterate stages sequentially, call PegasusEngine per stage, write state transitions to SQLite, heartbeat every 5s, rate limit retry with exponential backoff, graceful shutdown (SIGTERM->SIGKILL), desktop notifications (osascript/notify-send). Integration tests with FakeAgentRunner.",
    "priority": "critical",
    "status": "pending",
    "depends_on": ["06-engine-abstraction", "07-worktree-lifecycle", "04-config-resolution"],
    "target_files": ["src/pegasus/runner.py", "tests/test_runner.py"]
  },
  {
    "id": "09-cli-commands",
    "description": "ui.py: Click CLI commands — pegasus init (auto-detect language, test command, lint command, default branch; scaffold .pegasus/ with starter templates), run (spawn runner subprocess, create task+worktree), status (read SQLite, display task progress), validate (call models.py validation, format errors), resume (restart failed task from failed stage). Include CLI integration tests.",
    "priority": "critical",
    "status": "pending",
    "depends_on": ["05-pipeline-validation", "08-pipeline-executor"],
    "target_files": ["src/pegasus/ui.py", "tests/test_ui.py"]
  },
  {
    "id": "10-tui-dashboard",
    "description": "ui.py: Textual TUI dashboard — pegasus tui command launches Textual app with dashboard view (split pane showing all active tasks, stage progress, live log tail). Poll SQLite via set_interval at 100ms using mode=ro connections. Keyboard bindings: D (toggle view), Tab (cycle tasks), A (approve), R (reject), L (toggle logs), Q (quit). Include Textual Pilot tests.",
    "priority": "critical",
    "status": "pending",
    "depends_on": ["09-cli-commands"],
    "target_files": ["src/pegasus/ui.py", "tests/test_ui.py"]
  },
  {
    "id": "11-integration",
    "description": "End-to-end integration: wire all modules together, ensure __main__.py entry point works, add smoke tests (init -> validate -> run --dry-run flow), verify import graph (runner never imports ui, ui never imports runner), add .pegasus/ starter pipeline templates as package data.",
    "priority": "critical",
    "status": "pending",
    "depends_on": ["09-cli-commands", "10-tui-dashboard"],
    "target_files": ["src/pegasus/__main__.py", "tests/test_integration.py"]
  }
]
BACKLOG_JSON
  echo "GENERATED backlog with 11 features"
fi

# Output: count pending critical items
PENDING=$(python3 -c "
import json, sys
with open('$BACKLOG') as f:
    items = json.load(f)
pending = [i for i in items if i['status'] == 'pending' and i['priority'] == 'critical']
done = [i for i in items if i['status'] == 'done']
blocked = [i for i in items if i['status'] == 'blocked']
print(f'PENDING={len(pending)} DONE={len(done)} BLOCKED={len(blocked)} TOTAL={len(items)}')
# Print next actionable item (pending with all deps done)
done_ids = {i['id'] for i in done}
for item in pending:
    if all(d in done_ids for d in item.get('depends_on', [])):
        print(f'NEXT={item[\"id\"]}')
        print(json.dumps(item))
        break
else:
    if not pending:
        print('NEXT=NONE')
    else:
        print('NEXT=BLOCKED')
")

echo "$PENDING"
