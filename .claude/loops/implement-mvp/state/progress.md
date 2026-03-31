# Pegasus MVP — Implementation Progress

## Iteration 1: 01-scaffold
**Feature**: Project scaffolding: pyproject.toml, src/pegasus/ package structure, __main__.py entry point, tests/ directory, .gitignore updates
**Files created/modified**:
- `pyproject.toml` — build system (setuptools), project metadata, dependencies (click, textual, rich, pydantic, pyyaml, claude-agent-sdk), dev extras (pytest, ruff, mypy), console script entry point
- `src/pegasus/__init__.py` — package init with `__version__ = "0.1.0"`
- `src/pegasus/__main__.py` — entry point; defers to `pegasus.ui:cli` with graceful ImportError for pre-ui iterations
- `src/pegasus/templates/` — empty templates directory (package data, populated in 11-integration)
- `tests/__init__.py` — tests package marker
- `tests/test_scaffold.py` — 4 smoke tests: importable, version format, __main__ exists, main() callable
- `.gitignore` — Python, venv, Pegasus runtime files (.pegasus/pegasus.db*, .pegasus/logs/), Nuitka artifacts, macOS
**Tests added**: 4
**Status**: done
**Notes**: Used `setuptools.build_meta` (not `setuptools.backends.legacy:build`) for Python 3.10 compatibility. All 4 tests pass; ruff clean.

## Iteration 3: 03-sqlite-schema
**Feature**: SQLite schema (tasks, stage_runs, worktrees, schema_version tables), make_connection() factory, init_db(), transition_task_state() with BEGIN IMMEDIATE.
**Files created/modified**:
- `src/pegasus/models.py` — added `import sqlite3`, `SCHEMA_VERSION = 1`, `make_connection(db_path, read_only=False)` (WAL mode, busy_timeout=5000, synchronous=NORMAL, mode=ro URI for reads, NOT immutable=1), `init_db(conn)` (CREATE TABLE IF NOT EXISTS for schema_version/tasks/stage_runs/worktrees + three indexes), `transition_task_state(conn, task_id, from_state, to_state)` using BEGIN IMMEDIATE to prevent TOCTOU races
- `tests/test_models.py` — added 27 SQLite tests across TestMakeConnection (9 tests), TestInitDb (7 tests), TestTransitionTaskState (7 tests including threading race condition test); all use tmp_path fixtures; imported SCHEMA_VERSION, init_db, make_connection, transition_task_state
**Tests added**: 27 (total 85 with prior iterations)
**Status**: done
**Notes**: All tests pass; ruff clean. WAL mode confirmed via PRAGMA query. mode=ro URI used for read-only connections as required (immutable=1 rejected per ADR-002). Race condition test uses two threads with a single shared task row; exactly one transition wins. init_db is idempotent (CREATE IF NOT EXISTS + INSERT OR IGNORE).

## Iteration 4: 04-config-resolution
**Feature**: Layered config resolution (stage > pipeline > project > user > built-in), permission ceiling (deny-wins), auto-require-approval for write stages.
**Files modified**:
- `src/pegasus/models.py` — added `BUILT_IN_DEFAULTS` dict, `PERMISSION_ORDER` list, `_permission_index()`, `_cap_permission()`, `load_config(project_dir)` (built-in < user < project deep-merge), `resolve_stage_flags(stage, pipeline_defaults, project_config)` (returns `(ClaudeFlags, requires_approval)` tuple with permission ceiling applied and auto-requires-approval for write modes)
- `tests/test_models.py` — added 41 new tests across `TestPermissionHelpers` (10), `TestBuiltInDefaults` (4), `TestLoadConfig` (9), `TestResolveStageFlags` (18)
**Tests added**: 41 (total 126 including prior iterations)
**Status**: done
**Notes**: All 126 tests pass; ruff clean. Permission ceiling uses deny-wins: `_cap_permission` returns the lower of requested vs ceiling. `load_config` uses `Path.home()` for XDG user config; `resolve_stage_flags` applies ceiling after all four layers merge. Auto-require-approval triggers on `acceptEdits` and `bypassPermissions` (write modes); explicit `requires_approval=True` always preserved.

## Iteration 5: 05-pipeline-validation
**Feature**: Pipeline YAML validation with stage reference and flag checks
**Files modified**:
- `src/pegasus/models.py` — added `PipelineValidationError` (slot-based class with `message`, `file_path`, `location`), `_levenshtein()` (pure-Python edit distance, no deps), `_suggest_flag()` (Levenshtein-based typo suggestions against ALLOWED_CLAUDE_FLAGS), `_format_pydantic_errors()` (converts Pydantic ValidationError to list of PipelineValidationError, strips "Value error, " prefix), `validate_pipeline(pipeline, file_path)` (accepts Path/str/dict; runs YAML syntax check, Pydantic schema validation, unknown claude_flags with suggestions, forward/unknown stage reference detection, template namespace checks), `validate_all_pipelines(project_dir)` (scans `.pegasus/pipelines/*.yaml|.yml`, returns dict of Path→errors)
- `tests/test_models.py` — added 43 new tests across `TestPipelineValidationError` (4), `TestLevenshtein` (6), `TestSuggestFlag` (5), `TestValidatePipeline` (24), `TestValidateAllPipelines` (8)
**Tests added**: 43 (total 173 including prior iterations)
**Status**: done
**Notes**: All 173 tests pass; ruff clean. validate_pipeline accepts Path objects (file load), str (raw YAML content), or pre-parsed dict. Forward reference detection distinguishes "forward reference" from "unknown stage ID" by checking if the ref ID exists anywhere in the pipeline. Levenshtein suggestion fires within edit distance ≤3. Pydantic ValidationError prefix stripped for cleaner UX. validate_all_pipelines returns empty dict when no pipelines directory exists.

## Iteration 6: 06-engine-abstraction
**Feature**: AgentRunnerProtocol (Protocol class), ClaudeAgentRunner (concrete SDK wrapper with CLAUDECODE=1 unset), FakeAgentRunner (test fake), PegasusEngine (session_id management, cost tracking, SDK callback mapping, SQLite state transitions).
**Files created**:
- `src/pegasus/runner.py` — `AgentRunnerProtocol` (@runtime_checkable Protocol), internal message dataclasses (`AgentMessage`, `ToolUseMessage`, `ResultMessage`, `ErrorMessage`), `ClaudeAgentRunner` (guards SDK import with try/except; unsets CLAUDECODE env var), `PegasusEngine` (run_stage method: queued→running transition, stage_runs row management, cost accumulation from both streaming messages and final ResultMessage, session_id persistence, four optional callbacks)
- `tests/fakes.py` — `FakeAgentRunner` (configurable messages list, raise_on_run for exception testing, run_calls tracking, interrupt_called flag), factory helpers `make_fake_runner_with_tool_use()` and `make_fake_runner_with_error()`
- `tests/test_runner.py` — 32 tests across 7 test classes: protocol structural checks, FakeAgentRunner behaviour, PegasusEngine happy path, cost tracking, session_id management, error handling, callbacks, interrupt delegation
**Tests added**: 32 (total 205 including prior iterations)
**Status**: done
**Notes**: All 205 tests pass; ruff clean. SDK import is guarded with try/except so tests work without claude-agent-sdk installed. Cost accumulation handles the case where ResultMessage.total_cost_usd may be higher than the sum of incremental AgentMessage costs (uses delta to prevent double-counting). Engine never imports ui.py.

## Iteration 7: 07-worktree-lifecycle
**Feature**: Git worktree lifecycle manager — create, health-check, cleanup, orphan detection
**Files created/modified**:
- `src/pegasus/runner.py` — added `WorktreeError` exception class, `WorktreeManager` class (6 public methods: `detect_default_branch`, `create_worktree`, `health_check`, `cleanup_worktree`, `detect_orphans`, `cleanup_orphans`), `_pid_alive()` helper; added `re`, `shlex`, `subprocess`, `Path` imports
- `tests/test_runner.py` — added 30 integration tests across 7 new test classes: `TestDetectDefaultBranch` (4), `TestCreateWorktree` (6), `TestHealthCheck` (4), `TestCleanupWorktree` (3), `TestDetectOrphans` (7), `TestCleanupOrphans` (4), `TestPidAlive` (2)
**Tests added**: 30 (total 235 including prior iterations)
**Status**: done
**Notes**: All 235 tests pass; ruff clean. Integration tests use real git repos in tmp_path: `_init_git_repo()` helper initialises a git repo with an initial commit and configures user identity. `detect_default_branch` tries `git symbolic-ref refs/remotes/origin/HEAD` first then falls back to current HEAD. Lock file test accounts for git worktree `.git` being a file (not directory) — temporarily swaps it with a directory to place the lock. Orphan detection uses SQLite's `strftime('%s', ...)` for heartbeat staleness check (>30s) combined with PID liveness check via `os.kill(pid, 0)`. `cleanup_worktree` infers main repo from gitdir pointer in the `.git` file when `repo_dir` is not provided.

## Iteration 8: 08-pipeline-executor
**Feature**: Pipeline executor with heartbeat, retry, and desktop notification support
**Files modified**:
- `src/pegasus/runner.py` — added `PipelineExecutor` class (and `RateLimitError` sentinel), updated imports (`platform`, `signal`, `load_config`, `load_pipeline_config`, `resolve_stage_flags`). `PipelineExecutor` implements: `run_task` (full pipeline lifecycle: worktree creation, task/worktree DB rows, heartbeat loop, stage iteration with requires_approval gates, rate-limit retry with exponential backoff, SIGTERM/SIGINT graceful shutdown, desktop notifications on stage/pipeline events), `resume_task` (restart from first incomplete stage), `_heartbeat_loop` (async loop updating `heartbeat_at` every N seconds), `_send_notification` (osascript on macOS, notify-send on Linux, silent skip on other platforms), `_install_signal_handlers` (SIGTERM/SIGINT → graceful shutdown), `_is_rate_limit_error` (keyword detection for 429/rate-limit responses)
- `tests/test_runner.py` — added 23 integration tests across 7 new test classes: `TestPipelineExecutorHappyPath` (4), `TestPipelineExecutorStageFailure` (3), `TestPipelineExecutorApprovalGate` (3), `TestPipelineExecutorResumeTask` (3), `TestPipelineExecutorHeartbeat` (1), `TestPipelineExecutorRateLimitRetry` (2), `TestPipelineExecutorNotifications` (5), `TestRateLimitDetection` (2); also added `yaml` import, `PipelineExecutor` import, `patch` import, and helper functions `_make_pipeline_yaml`, `_make_executor`, `_make_project_with_git`
**Tests added**: 23 (total 258 including prior iterations)
**Status**: done
**Notes**: All 258 tests pass; ruff clean. Tests use isolated worktrees via per-test `.pegasus/config.yaml` overriding `worktrees.base_path` to `tmp_path/worktrees`. Heartbeat tests use 0.1s interval + 0.35s sleep to confirm updates without slowing the suite. Rate-limit retry tests use 0.01s base delay. Notification tests monkey-patch `_send_notification` directly to avoid spawning `osascript`/`notify-send` in tests. SIGTERM/SIGINT handling via `signal.signal` registers graceful shutdown that marks task `paused` and calls `engine.interrupt()`.

## Iteration 9: 09-cli-commands
**Feature**: Click CLI commands — init, run, status, validate, resume
**Files created/modified**:
- `src/pegasus/ui.py` — Click CLI with `@click.group()` + 5 commands: `init` (auto-detect language/test/lint/branch, scaffold `.pegasus/`, starter templates, gitignore update, SQLite init), `run` (verify pipeline exists, insert task row, spawn `python3 -m pegasus._run_task <task-id>` as detached subprocess via `start_new_session=True`, `--dry-run` mode), `status` (read-only SQLite via `make_connection(read_only=True)`, Rich table for all tasks, detailed view with stage_runs for single task), `validate` (calls `validate_all_pipelines` or `validate_pipeline`, formats errors with Rich colors, exits non-zero on errors), `resume` (checks task state is failed/paused, spawns runner with `--resume` flag)
- `src/pegasus/_run_task.py` — subprocess entry-point; sole importer of `runner.PipelineExecutor`; reads `PEGASUS_PROJECT_DIR` env var; calls `executor.run_task` or `executor.resume_task` depending on `--resume` flag
- `tests/test_ui.py` — 54 CLI integration tests across 7 classes: `TestDetectLanguage` (7), `TestInitCommand` (13), `TestValidateCommand` (8), `TestStatusCommand` (9), `TestRunCommand` (6), `TestResumeCommand` (7), `TestRunTaskModule` (2); uses `CliRunner` + `tmp_path`; monkeypatches `subprocess.Popen`
**Tests added**: 54 (total 312 including prior iterations)
**Status**: done
**Notes**: All 312 tests pass; ruff clean. Design constraint preserved — ui.py NEVER imports runner.py; _run_task.py is the sole bridge. Gitignore deduplication uses sentinel comment `# Pegasus runtime files`. Language auto-detection via ordered marker files (pyproject.toml→python, package.json→node, etc.). Subprocess spawned with `start_new_session=True` for proper daemon detachment. `PEGASUS_PROJECT_DIR` env var passed to subprocess for project discovery.

## Iteration 2: 02-pydantic-models
**Feature**: models.py: Pydantic models for pipeline YAML config validation, stage schema, claude_flags allowlist, config.yaml schema. Include unit tests with valid/invalid YAML fixtures.
**Files created/modified**:
- `src/pegasus/models.py` — Pydantic models: `ClaudeFlags` (9-flag allowlist, extras forbidden), `StageConfig` (id pattern, name, prompt, flags, requires_approval), `PipelineConfig` (name, description, execution, defaults, stages with duplicate/count/reference validation), `PegasusConfig` (project, git, defaults, concurrency, notifications, worktrees), plus YAML loading helpers (`load_pipeline_config`, `load_project_config`, `parse_pipeline_yaml`, `parse_project_config_yaml`)
- `tests/test_models.py` — 58 unit tests covering valid/invalid YAML fixtures for all model classes; file-based loading with `tmp_path`; allowlist correctness
**Tests added**: 58 (total 62 with scaffold)
**Status**: done
**Notes**: All extras forbidden at every model level. Stage ID validated with regex `^[a-z][a-z0-9_-]*$`. Stage count capped at 10. Cross-stage reference validation via regex scan of prompts. Empty config YAML defaults gracefully to built-ins. Removed quoted self-reference in `model_validator` to satisfy `ruff UP037`.

## Iteration 10: 10-tui-dashboard
**Feature**: Textual TUI dashboard — pegasus tui command, PegasusDashboard App, TaskCard widget, LogPanel widget
**Files created/modified**:
- `src/pegasus/ui.py` — added `_build_stage_lines()` helper, `_get_textual_app()` factory (deferred Textual imports), `PegasusDashboard(App)` (Header, Horizontal task-card area, LogPanel, Footer; `on_mount` opens read-only SQLite connection; `set_interval(0.1, poll_db)` for live updates; `_refresh_cards()` reconciles TaskCard widgets; `_refresh_logs()` tails log files), `TaskCard(Widget)` (header/stages/activity statics; `update_data` method), `LogPanel(Widget)` (tails `.pegasus/logs/<task-id>.log`, toggled visible via CSS class), `tui` Click command (resolves db_path, exits with error if missing, runs app)
- `tests/test_ui.py` — added `TestBuildStageLines` (3 tests), `TestPegasusDashboardApp` (14 tests: app launch, no-tasks placeholder, poll_db task population, multiple tasks, stage runs, activity field, Q quit, L toggle logs, Tab cycle focus, A approve paused→queued, R reject paused→failed, approve non-paused unchanged, log file tail, graceful no-db handling), `TestTuiCommand` (2 tests: no-db error, tui command registered)
**Tests added**: 19 (total 331 including prior iterations)
**Status**: done
**Notes**: All 331 tests pass; ruff clean. Tab binding requires `priority=True` to override Textual's default focus cycling (Textual intercepts Tab at the Screen level). Deferred Textual imports via `_get_textual_app()` so Textual is only loaded when `pegasus tui` is invoked. Mode=ro SQLite connections preserved per ADR-002. Log panel reads last 8 lines from `.pegasus/logs/<task-id>.log`. Approve action writes `status='queued'` directly to SQLite (runner picks it up). Reject writes `status='failed'`. D binding shows "focus view: v0.2" notification per spec.
