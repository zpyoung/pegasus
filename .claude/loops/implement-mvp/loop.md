# Implement the Pegasus MVP critical path features from .ai_tasks/MVP.spec.md, one feature per iteration.

## Execution Architecture

Orchestrator spawns one subagent per iteration. Orchestrator only manages the loop — it does NOT implement features.

### Orchestrator Loop

```
1. Run scan script: bash .claude/loops/implement-mvp/scripts/scan-backlog.sh
   → Outputs PENDING=N DONE=N and NEXT=<feature-id> with feature JSON
2. If PENDING=0: DONE — all critical path features implemented
3. Spawn subagent with:
   - Iteration number
   - The NEXT feature JSON from scan script output
   - State file paths
4. After subagent returns:
   Run check script: bash .claude/loops/implement-mvp/scripts/check-progress.sh
   → Outputs PENDING=N DONE=N TESTS=PASS|FAIL LINT=PASS|FAIL
5. If PENDING=0 AND TESTS=PASS: DONE
6. If TESTS=FAIL or LINT=FAIL: log warning, continue (next iteration may fix it)
7. Loop back to step 1
```

### Scripts

- **scan-backlog.sh** — Reads `state/backlog.json`, finds the next actionable feature (pending with all dependencies done), outputs its JSON for the subagent. On first run, generates the backlog from the MVP spec's critical path.
- **check-progress.sh** — Counts pending/done features, runs `pytest` and `ruff check`, prints machine-readable summary.

### Subagent Instructions

You are implementing one feature of the Pegasus MVP. Pegasus is a Python CLI/TUI tool that orchestrates Claude Code through YAML-defined multi-stage pipelines.

#### Step 1: Read Context

1. Read the MVP spec for full requirements context:
   - `.ai_tasks/MVP.spec.md` — the authoritative spec (read the sections relevant to your feature)
2. Read the backlog to understand your assigned feature:
   - `.claude/loops/implement-mvp/state/backlog.json` — find your feature by ID
3. Read progress from previous iterations:
   - `.claude/loops/implement-mvp/state/progress.md` — what's been built so far
4. Read any existing source code your feature depends on:
   - `src/pegasus/` — check what modules exist and what's already implemented
   - `tests/` — check existing test patterns

#### Step 2: Plan — understand what to build

1. Parse your assigned feature from the backlog JSON
2. Read the relevant sections of MVP.spec.md for detailed requirements:
   - For models.py features: Database Schema, Pipeline YAML Schema, Configuration sections
   - For runner.py features: Architecture > runner.py description, SDK Callback Mapping, ADR-001, ADR-005
   - For ui.py features: CLI Command Reference, TUI Layout, Keyboard Navigation
3. Check dependency features are actually implemented in the codebase (don't trust backlog status alone — verify files exist)
4. Plan the implementation: what functions/classes to create, what tests to write

#### Step 3: Implement — write the code

1. Write production code in `src/pegasus/` following the spec's architecture:
   - `models.py` — Pydantic models, SQLite schema, config resolution, validation
   - `runner.py` — PegasusEngine, worktree manager, pipeline executor
   - `ui.py` — Click CLI commands, Textual TUI
   - Never have runner.py import ui.py or vice versa. Only models.py is shared.
2. Write tests in `tests/` for every non-trivial function:
   - Use `tmp_path` fixtures for SQLite tests (NOT `:memory:` — WAL requires real files)
   - Use `FakeAgentRunner` for runner.py tests (never call real Claude API)
   - Use `App.run_test()` + Pilot API for Textual TUI tests
3. Follow these code conventions:
   - Python 3.10+ with type hints
   - Use `click` for CLI, `textual` for TUI, `pydantic` for validation
   - Use `sqlite3` stdlib (no SQLAlchemy)
   - Methods <= 20 lines where possible
   - Follow the implementation patterns from MVP.spec.md (make_connection, transition_task_state, AgentRunnerProtocol)
4. Scope boundaries:
   - Implement ONLY your assigned feature — do not touch other features
   - Do not modify `.ai_tasks/MVP.spec.md` — it is read-only
   - Do not modify other features' code unless your feature genuinely requires it (e.g., adding a field to a Pydantic model that your feature needs)

#### Step 4: Verify — run quality checks

1. Run `python3 -m pytest tests/ -v` — all tests must pass
2. Run `ruff check src/` — no lint errors (if ruff is available)
3. If tests fail: fix them before proceeding
4. If you cannot fix a test failure caused by a dependency issue (not your feature): note it in progress.md but still mark your feature as done if YOUR code is correct

#### Step 5: Record — update state files

1. Update `state/backlog.json`: change your feature's status from `"pending"` to `"done"`
2. Append to `state/progress.md`:
   ```
   ## Iteration N: <feature-id>
   **Feature**: <description>
   **Files created/modified**: <list>
   **Tests added**: <count>
   **Status**: done | partial (explain)
   **Notes**: <any blockers, design decisions, or deviations from spec>
   ```
3. Commit atomically: `git add -A && git commit -m "feat(pegasus): <feature description>"`

#### Step 6: Return — minimal summary to orchestrator

Return exactly this format:

```
IMPLEMENTED: <feature-id> | STATUS: done | TESTS: pass|fail | FILES: <count modified>
```

Or if blocked:

```
BLOCKED: <feature-id> | REASON: <why> | NEEDS: <what dependency is missing>
```

### Parallelization

parallel: false
Features are cumulative — each iteration builds on code written by previous iterations (e.g., runner.py imports from models.py). Sequential execution is mandatory.

### Loop Termination

The loop terminates when ALL of these are true:

- `PENDING=0` for critical priority items in backlog.json
- `TESTS=PASS` from check-progress.sh

Hard iteration cap is set at run time by the runner.
