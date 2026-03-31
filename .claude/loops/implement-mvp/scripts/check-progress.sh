#!/usr/bin/env bash
# check-progress.sh — Runs verification and checks backlog completion.
# Prints machine-readable summary for orchestrator termination check.
set -euo pipefail

LOOP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$LOOP_DIR/state"
BACKLOG="$STATE_DIR/backlog.json"
PROJECT_ROOT="$(cd "$LOOP_DIR/../../.." && pwd)"

cd "$PROJECT_ROOT"

# Activate venv if it exists
if [ -f "$PROJECT_ROOT/.venv/bin/activate" ]; then
  source "$PROJECT_ROOT/.venv/bin/activate"
fi

# Check if backlog exists
if [ ! -f "$BACKLOG" ]; then
  echo "PENDING=11 DONE=0 TESTS=SKIP LINT=SKIP"
  exit 0
fi

# Count backlog status
COUNTS=$(python3 -c "
import json
with open('$BACKLOG') as f:
    items = json.load(f)
critical = [i for i in items if i['priority'] == 'critical']
pending = len([i for i in critical if i['status'] == 'pending'])
done = len([i for i in critical if i['status'] == 'done'])
blocked = len([i for i in critical if i['status'] == 'blocked'])
print(f'PENDING={pending} DONE={done} BLOCKED={blocked}')
")

# Run tests if src/pegasus exists
TESTS="SKIP"
if [ -d "src/pegasus" ] && [ -f "pyproject.toml" ]; then
  if python3 -m pytest tests/ -q --tb=no 2>/dev/null; then
    TESTS="PASS"
  else
    TESTS="FAIL"
  fi
fi

# Run linter if src/pegasus exists
LINT="SKIP"
if [ -d "src/pegasus" ] && command -v ruff &>/dev/null; then
  if ruff check src/ 2>/dev/null; then
    LINT="PASS"
  else
    LINT="FAIL"
  fi
fi

echo "$COUNTS TESTS=$TESTS LINT=$LINT"
