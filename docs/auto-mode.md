# Auto-Mode and Execution System

Auto-mode is Pegasus's autonomous feature development engine. When enabled, it continuously picks up features from the backlog, executes them with a Claude agent in an isolated git worktree, and handles the full lifecycle through completion — including concurrency management, question handling, plan approval, and crash recovery.

## Table of Contents

- [Overview](#overview)
- [Service Architecture](#service-architecture)
- [Feature Lifecycle](#feature-lifecycle)
- [Auto-Loop Coordinator](#auto-loop-coordinator)
- [Concurrency Management](#concurrency-management)
- [Execution Service](#execution-service)
- [Stage Runner and YAML Pipelines](#stage-runner-and-yaml-pipelines)
- [Question Handling](#question-handling)
- [Plan Approval Flow](#plan-approval-flow)
- [Recovery and Reconciliation](#recovery-and-reconciliation)
- [WebSocket Events](#websocket-events)
- [API Endpoints](#api-endpoints)
- [Key Types](#key-types)

---

## Overview

Auto-mode orchestrates autonomous feature implementation by:

1. Watching a project's backlog for features with `backlog` or `ready` status
2. Dispatching eligible features to the agent (subject to a concurrency limit)
3. Running the agent in an isolated git worktree (one per feature branch)
4. Persisting progress through crashes via pipeline-state checkpoints
5. Surfacing questions and plan approvals to the user over WebSocket
6. Resuming interrupted features when the server restarts

Auto-mode can run simultaneously across multiple projects and, within a project, across multiple worktrees. Each project/worktree combination has its own independent loop state.

---

## Service Architecture

The system uses a three-layer service hierarchy:

```
AutoModeServiceCompat          (compatibility shim used by routes)
├── GlobalAutoModeService      (singleton, global state across all projects)
│   ├── ConcurrencyManager     (tracks running features across all projects)
│   ├── AutoLoopCoordinator    (monitoring only — not for execution)
│   └── WorktreeResolver       (git worktree lookups)
└── AutoModeServiceFacade      (per-project, cached by project path)
    ├── AutoLoopCoordinator    (owns the loop for this project/worktree)
    ├── ExecutionService       (feature lifecycle coordination)
    ├── StageRunner            (YAML pipeline stage execution)
    ├── PlanApprovalService    (plan approval gating)
    ├── QuestionService        (agent question lifecycle)
    └── RecoveryService        (interrupted feature recovery)
```

### GlobalAutoModeService

Created once at server startup and shared across all facades. Responsible for:
- Global status (all running features across all projects)
- Active auto-loop project/worktree enumeration
- Graceful shutdown: marking all running features as `interrupted`
- Startup reconciliation: resetting features stuck in transient states

### AutoModeServiceFacade

Created per-project path (cached in `AutoModeServiceCompat`). Provides all per-project operations with clean method signatures that omit the `projectPath` parameter.

```typescript
// Creating a facade (internal pattern used by AutoModeServiceCompat)
const facade = AutoModeServiceFacade.create('/path/to/project', {
  events: eventEmitter,
  settingsService,
  sharedServices, // from GlobalAutoModeService.getSharedServices()
});

// Start auto-mode loop for the main worktree with up to 3 concurrent features
await facade.startAutoLoop(null, 3);

// Start auto-mode for a named worktree
await facade.startAutoLoop('feature/my-branch', 2);
```

### AutoModeServiceCompat

The compatibility shim that routes use. It owns the facade cache and delegates:
- Global operations to `GlobalAutoModeService`
- Per-project operations to the appropriate `AutoModeServiceFacade`

---

## Feature Lifecycle

Features progress through these statuses during auto-mode execution:

```
backlog / ready
    ↓  (auto-loop picks up feature)
in_progress
    ↓  (agent runs, may pause)
waiting_question     ← agent asked the user a question
    ↓  (user answers all questions → back to ready → re-queued)
    ↓  (or continuing)
waiting_approval     ← plan approval required, or agent did minimal work
    ↓  (user approves/rejects plan)
verified             ← agent completed with meaningful output
    ↓  (optional)
completed            ← user commits the worktree

(error paths)
interrupted          ← stopped by user or server shutdown
backlog              ← execution failed (reverts for retry)
merge_conflict       ← pipeline detected a git conflict
```

### Feature Eligibility for Auto-Mode

The `AutoModeServiceFacade.isFeatureEligibleForAutoMode()` static method determines eligibility:

```typescript
// A feature is eligible if:
// 1. Status is 'backlog', 'ready', 'interrupted', or a pipeline status
// 2. branchName matches the current worktree scope
AutoModeServiceFacade.isFeatureEligibleForAutoMode(feature, branchName, primaryBranch);
```

For the main worktree (`branchName === null`): features with no `branchName` or one matching the primary branch (e.g., `main`) are eligible.

For named worktrees: only features whose `branchName` exactly matches the worktree branch are eligible.

---

## Auto-Loop Coordinator

`AutoLoopCoordinator` manages the polling loop for a specific project/worktree combination.

### Starting and Stopping

```typescript
// Start the loop — returns the resolved maxConcurrency
const maxConcurrency = await coordinator.startAutoLoopForProject(
  '/path/to/project',
  null,        // branchName: null for main worktree
  3            // maxConcurrency (optional, falls back to settings)
);

// Stop the loop — returns count of still-running features
const runningCount = await coordinator.stopAutoLoopForProject('/path/to/project', null);
```

Each project/worktree gets a unique key: `${projectPath}::${branchName ?? '__main__'}`.

### Loop Behavior

The loop runs continuously while `isRunning === true`:

1. Count running features for this worktree (ALL features, both auto-mode and manual, count against the limit)
2. If at capacity: sleep 5 seconds
3. Load pending features (`backlog` or `ready` status, matching this worktree)
4. Filter to eligible features: not already running, dependencies satisfied
5. Sort by priority (lower number = higher priority; default priority is 2)
6. Dispatch the highest-priority eligible feature via `executeFeatureFn`
7. Sleep 2 seconds, then repeat

When no features remain and nothing is running, the loop emits `auto_mode_idle` and sleeps 10 seconds per iteration.

### Failure Tracking and Auto-Pause

The coordinator tracks consecutive failures within a 60-second window. The loop pauses automatically when:

- 3 or more consecutive failures occur within 60 seconds
- An error of type `quota_exhausted` or `rate_limit` is detected

When paused, the loop emits `auto_mode_paused_failures` and stops itself. The user must restart the loop manually.

### Concurrency Resolution

`maxConcurrency` is resolved in priority order:
1. Explicitly provided value (API parameter)
2. Per-worktree setting from `settings.autoModeByWorktree`
3. Global `settings.maxConcurrency`
4. `DEFAULT_MAX_CONCURRENCY` (1)

---

## Concurrency Management

`ConcurrencyManager` tracks all running features across all projects using lease-based reference counting. It is a singleton shared by all facades via `GlobalAutoModeService.getSharedServices()`.

### Lease-Based Reference Counting

```typescript
// Acquire a slot — throws 'already running' if occupied and allowReuse is false
const entry = concurrencyManager.acquire({
  featureId: 'feat-abc',
  projectPath: '/path/to/project',
  isAutoMode: true,
});

// Nested acquire (e.g., resumeFeature → executeFeature)
const entry = concurrencyManager.acquire({
  featureId: 'feat-abc',
  projectPath: '/path/to/project',
  isAutoMode: false,
  allowReuse: true,  // increments leaseCount instead of throwing
});

// Release — decrements leaseCount; removes entry when count reaches 0
concurrencyManager.release('feat-abc');

// Force-release (used by stopFeature to bypass leaseCount)
concurrencyManager.release('feat-abc', { force: true });
```

### Worktree-Aware Counting

The concurrency limit is enforced per worktree:

```typescript
// Count for main worktree (branchName: null)
// Matches features where branchName is null OR equals the primary branch name
const count = await concurrencyManager.getRunningCountForWorktree(projectPath, null);

// Count for a named worktree (exact branch match)
const count = await concurrencyManager.getRunningCountForWorktree(projectPath, 'feature/my-branch');
```

Manual feature starts (via `/run-feature`) bypass the concurrency limit and always execute immediately, but their presence is counted when auto-mode decides whether to dispatch additional features.

---

## Execution Service

`ExecutionService` coordinates the complete feature execution lifecycle. It is the core of what happens when a feature is dispatched.

### Execution Flow

```
executeFeature(projectPath, featureId, useWorktrees, isAutoMode)
    ↓
1. Acquire running slot (ConcurrencyManager)
2. Load feature JSON
3. Update status → in_progress
4. Check for approved plan → recursive call with continuationPrompt
5. Check for existing context (non-pipeline) → resume instead
6. Resolve worktree path from feature.branchName
7. Capture baseline file states (content hashes)
8. Branch: YAML pipeline? → StageRunner.run()
            Legacy flow?  → runAgentFn() + task retry + JSON pipeline steps
9. Detect agent-modified files (hash diff)
10. Determine final status: 'verified' or 'waiting_approval'
11. Save summary, record learnings
12. Emit auto_mode_feature_complete
    ↓
On error:
- PauseExecutionError → status = 'waiting_question' (not a failure)
- Abort signal → status = 'interrupted'
- Other error → status = 'backlog' (or 'waiting_approval' if pipeline completed)
    ↓
Finally: release running slot
```

### Working Directory Resolution

The agent's working directory is determined by the feature's `branchName`:

- `useWorktrees: true` and `branchName` set: find worktree path via `WorktreeResolver`
- Otherwise: use `projectPath` directly

### Agent-Modified File Tracking

Before and after agent execution, `ExecutionService` captures file content hashes (`git hash-object`) for all uncommitted files. The difference is saved to `feature.agentModifiedFiles` for downstream use (e.g., cherry-picking, PR generation).

### Task Retry Loop

For the legacy (non-YAML) flow, if the agent finishes but `planSpec.tasks` has pending items, the execution service re-runs the agent up to 3 times with a continuation prompt listing the remaining tasks.

### Final Status Determination

After successful execution:

| Condition | Final Status |
|-----------|-------------|
| `feature.skipTests === true` | `waiting_approval` |
| Agent output has no tool usage markers or is too short | `waiting_approval` |
| Agent did meaningful work (tool markers + sufficient output) | `verified` |

---

## Stage Runner and YAML Pipelines

When a feature has a `pipeline` field (e.g., `"feature"`, `"bug-fix"`), `ExecutionService` delegates to `StageRunner` instead of the legacy flow.

### YAML Pipeline Structure

Pipelines are defined in `.pegasus/pipelines/<slug>.yaml`. Each stage has:

```yaml
name: Feature Pipeline
defaults:
  model: sonnet
  max_turns: 10

stages:
  - id: plan
    name: Feature Planning
    prompt: |
      Plan the implementation of: {{task.description}}
      Project language: {{project.language}}
    claude_flags:
      model: opus
    requires_approval: true

  - id: implement
    name: Implementation
    prompt: |
      ## Previous context
      {{previous_context}}

      Implement: {{task.description}}
    question: "Which approach should be used?"
    question_meta:
      type: single-select
      options: ["Minimal change", "Full refactor"]
```

Template variables available in prompts:
- `{{task.description}}` — feature description
- `{{task.title}}` — feature title
- `{{project.language}}` — project language (from project settings)
- `{{project.test_command}}` — test command (from project settings)
- `{{previous_context}}` — accumulated output from all prior stages
- `{{inputs.<name>}}` — user-provided pipeline inputs
- `{{stages.<stageId>.question_response}}` — answer to a YAML-declared pre-stage question

### Stage Execution

`StageRunner.run()` executes stages sequentially:

1. Load persisted pipeline state (for resumption)
2. For each stage:
   a. Handle pre-stage `question` (if declared) — pauses for user answer
   b. Compile the Handlebars prompt template with current context
   c. Call `runAgentFn` (same agent infrastructure as legacy flow)
   d. Accumulate agent output into `accumulatedContext`
   e. Persist stage output to `stage-outputs/<stageId>.md`
   f. Checkpoint pipeline state to `pipeline-state.json`
3. Clear pipeline state on full success

### Pipeline Resumption

After a crash or stop, `StageRunner` reloads `pipeline-state.json` and skips stages that already completed, resuming from the next incomplete stage with the accumulated context from the last checkpoint. Stage order and IDs are validated before resuming; if they don't match the current pipeline definition, the runner starts fresh.

Events emitted during pipeline execution:
- `pipeline_step_started` — when a stage begins
- `pipeline_step_complete` — when a stage finishes
- `auto_mode_progress` — progress updates for the UI

---

## Question Handling

When the agent calls the SDK's built-in `AskUserQuestion` tool, `QuestionService` pauses execution and surfaces the questions to the user.

### Question Flow

```
Agent calls AskUserQuestion tool
    ↓
extractAndPauseForAskUserQuestion() intercepts the tool_use block
    ↓
QuestionService.askQuestion() persists questions to feature.questionState
    ↓
Emits 'question_required' event via WebSocket
    ↓
PauseExecutionError thrown → ExecutionService sets status = 'waiting_question'
    ↓
User submits answers via POST /answer-question
    ↓
QuestionService.resolveAnswer() updates questionState in feature JSON
    ↓
When all questions answered → feature.status = 'ready'
    ↓
AutoLoopCoordinator picks up the feature again (status 'ready' is eligible)
    ↓
Agent resumes with answered Q&A injected into the prompt
```

### Question Types

Questions can be:
- `free-text` — open-ended text input
- `single-select` — one of several provided options
- `multi-select` — multiple options

Questions are persisted to `feature.questionState` in `feature.json` and survive server restarts.

### YAML Pre-Stage Questions

YAML pipeline stages can declare a `question` field that is asked before the stage executes (as opposed to during agent execution). The answer is made available via `{{stages.<stageId>.question_response}}` in the stage prompt template.

---

## Plan Approval Flow

When a feature has `requirePlanApproval: true`, the agent generates a plan first and waits for user review before implementing.

### Approval Flow

```
Agent generates plan (status: 'waiting_approval')
    ↓
PlanApprovalService.waitForApproval() — in-memory Promise with 30-minute timeout
    ↓
Emits 'plan_generated' event to UI
    ↓
User reviews and submits POST /approve-plan
    ↓
PlanApprovalService.resolveApproval():
  - approved → feature.planSpec.status = 'approved'
                ExecutionService continues with continuationPrompt
  - rejected → feature.planSpec.status = 'rejected'
                feature.status = 'backlog'
                Emits 'plan_rejected'
```

### Approval Timeout

By default, plans time out after 30 minutes. This can be overridden via `planApprovalTimeoutMs` in project settings. On timeout, the feature execution is cancelled (not auto-approved).

### Recovery After Server Restart

If the server restarts while a plan is waiting for approval, `resolveApproval()` detects the orphaned state via `feature.planSpec.status === 'generated'` and handles recovery without requiring the agent to regenerate the plan.

---

## Recovery and Reconciliation

### Startup Reconciliation

On server startup, `GlobalAutoModeService.reconcileFeatureStates()` resets features stuck in transient states:

- `in_progress` → `backlog` or `interrupted` (depending on whether the feature had a pipeline)
- `pipeline_*` statuses → `interrupted`
- `interrupted` → left as-is (already a resting state)

This handles both clean shutdowns and hard crashes/kills.

### Resume Interrupted Features

`POST /resume-interrupted` triggers `RecoveryService` to find all interrupted features in a project and resume them if they have saved execution context. Features using YAML pipelines resume via `pipeline-state.json` checkpoints.

### Feature State Reconciliation on Demand

`POST /reconcile` can be called by the UI after reconnecting to force-correct any stale feature states without restarting the server.

---

## WebSocket Events

Auto-mode communicates state changes to the frontend in real time via WebSocket events. All events are under the `auto-mode:event` channel.

| Event Name | Description |
|-----------|-------------|
| `auto_mode_started` | Loop started for a project/worktree |
| `auto_mode_stopped` | Loop stopped |
| `auto_mode_idle` | No pending features — loop is waiting |
| `auto_mode_paused_failures` | Loop paused due to consecutive failures |
| `auto_mode_feature_start` | A feature began execution |
| `auto_mode_feature_complete` | A feature finished (success or abort) |
| `auto_mode_progress` | Progress text from agent execution |
| `auto_mode_error` | An error occurred (non-abort, non-pause) |
| `feature_status_changed` | Feature status updated |
| `question_required` | Agent asked one or more questions |
| `question_answered` | A question was answered |
| `plan_rejected` | User rejected an agent-generated plan |
| `planning_started` | Planning phase started |
| `pipeline_step_started` | A YAML pipeline stage began |
| `pipeline_step_complete` | A YAML pipeline stage finished |

---

## API Endpoints

All endpoints are mounted under `/api/auto-mode` and use `POST`.

### Loop Control

#### `POST /api/auto-mode/start`

Start the auto-mode loop for a project/worktree.

```json
// Request
{
  "projectPath": "/path/to/project",
  "branchName": null,       // null for main worktree, string for named worktree
  "maxConcurrency": 3       // optional; falls back to settings
}

// Response
{
  "success": true,
  "message": "Auto mode started with max 3 concurrent features",
  "branchName": null
}
```

#### `POST /api/auto-mode/stop`

Stop the auto-mode loop for a project/worktree. In-progress features continue running until completion.

```json
// Request
{
  "projectPath": "/path/to/project",
  "branchName": null
}

// Response
{
  "success": true,
  "message": "Auto mode stopped",
  "runningFeaturesCount": 2,
  "branchName": null
}
```

#### `POST /api/auto-mode/status`

Get auto-mode status. Returns per-project status if `projectPath` is provided; global status otherwise.

```json
// Request (per-project)
{
  "projectPath": "/path/to/project",
  "branchName": null
}

// Response (per-project)
{
  "success": true,
  "isRunning": true,
  "isAutoLoopRunning": true,
  "runningFeatures": ["feat-abc", "feat-def"],
  "runningCount": 2,
  "maxConcurrency": 3,
  "projectPath": "/path/to/project",
  "branchName": null
}

// Response (global, no projectPath)
{
  "success": true,
  "isRunning": true,
  "runningFeatures": ["feat-abc"],
  "runningCount": 1,
  "activeAutoLoopProjects": ["/path/to/project"],
  "activeAutoLoopWorktrees": [{ "projectPath": "/path/to/project", "branchName": null }]
}
```

### Feature Execution

#### `POST /api/auto-mode/run-feature`

Manually trigger a single feature. Bypasses the concurrency limit.

```json
// Request
{
  "projectPath": "/path/to/project",
  "featureId": "feat-abc",
  "useWorktrees": false
}

// Response
{ "success": true }
```

#### `POST /api/auto-mode/stop-feature`

Stop a specific running feature.

```json
// Request
{ "featureId": "feat-abc" }

// Response
{ "success": true, "stopped": true }
```

#### `POST /api/auto-mode/resume-feature`

Resume a feature that was previously interrupted.

```json
// Request
{
  "projectPath": "/path/to/project",
  "featureId": "feat-abc",
  "useWorktrees": false
}

// Response
{ "success": true }
```

#### `POST /api/auto-mode/follow-up-feature`

Run the agent again on a completed feature with a follow-up prompt.

```json
// Request
{
  "projectPath": "/path/to/project",
  "featureId": "feat-abc",
  "prompt": "Also add error handling for edge case X",
  "imagePaths": [],         // optional
  "useWorktrees": false
}

// Response
{ "success": true }
```

#### `POST /api/auto-mode/verify-feature`

Run the verification step for a feature.

```json
// Request
{
  "projectPath": "/path/to/project",
  "featureId": "feat-abc"
}

// Response
{ "success": true, "passes": true }
```

#### `POST /api/auto-mode/commit-feature`

Commit changes made by the agent in the feature's worktree.

```json
// Request
{
  "projectPath": "/path/to/project",
  "featureId": "feat-abc",
  "worktreePath": "/path/to/worktree"  // optional
}

// Response
{ "success": true, "commitHash": "abc123..." }
```

### User Interaction

#### `POST /api/auto-mode/approve-plan`

Approve or reject an agent-generated plan.

```json
// Request
{
  "projectPath": "/path/to/project",
  "featureId": "feat-abc",
  "approved": true,
  "editedPlan": "## Updated Plan\n...",  // optional; send edited plan content
  "feedback": "Looks good but..."        // optional
}

// Response
{
  "success": true,
  "approved": true,
  "message": "Plan approved - implementation will continue"
}
```

#### `POST /api/auto-mode/answer-question`

Submit an answer to an agent question.

```json
// Request
{
  "projectPath": "/path/to/project",
  "featureId": "feat-abc",
  "questionId": "uuid-of-question",
  "answer": "Use the minimal change approach"
}

// Response
{
  "success": true,
  "allAnswered": true,
  "message": "All questions answered — feature will resume"
}
```

### Recovery and Maintenance

#### `POST /api/auto-mode/reconcile`

Force-reset all features stuck in transient states for a project.

```json
// Request
{ "projectPath": "/path/to/project" }

// Response
{
  "success": true,
  "reconciledCount": 3,
  "message": "Reconciled 3 feature(s)"
}
```

#### `POST /api/auto-mode/resume-interrupted`

Resume any interrupted features found in a project.

```json
// Request
{ "projectPath": "/path/to/project" }

// Response
{ "success": true, "message": "Resume check completed" }
```

#### `POST /api/auto-mode/analyze-project`

Trigger project structure analysis (used to populate context for the AI agent).

```json
// Request
{ "projectPath": "/path/to/project" }

// Response
{ "success": true }
```

#### `POST /api/auto-mode/context-exists`

Check whether an agent context (saved conversation) exists for a feature.

```json
// Request
{
  "projectPath": "/path/to/project",
  "featureId": "feat-abc"
}

// Response
{ "success": true, "exists": true }
```

---

## Key Types

### Feature

Defined in `@pegasus/types` (`libs/types/src/feature.ts`). Key fields relevant to auto-mode:

```typescript
interface Feature {
  id: string;
  status?: string;              // See lifecycle states above
  branchName?: string | null;   // Target worktree branch
  pipeline?: string;            // YAML pipeline slug (e.g., "feature")
  pipelineInputs?: Record<string, string | number | boolean>;
  planningMode?: PlanningMode;  // 'skip' | 'spec' | 'full'
  requirePlanApproval?: boolean;
  planSpec?: PlanSpec;          // Plan generation and approval state
  questionState?: FeatureQuestionState; // Pending agent questions
  priority?: number;            // Lower = higher priority (default: 2)
  skipTests?: boolean;
  model?: string;               // Override model for this feature
  dependencies?: string[];      // Feature IDs that must complete first
}
```

### RunningFeature

Tracks an in-flight feature execution in `ConcurrencyManager`:

```typescript
interface RunningFeature {
  featureId: string;
  projectPath: string;
  worktreePath: string | null;
  branchName: string | null;
  abortController: AbortController;
  isAutoMode: boolean;
  startTime: number;
  leaseCount: number;           // Reference count for nested acquire/release
  model?: string;
  provider?: ModelProvider;
}
```

### AutoModeConfig

Configuration for a running auto-loop instance:

```typescript
interface AutoModeConfig {
  maxConcurrency: number;
  useWorktrees: boolean;
  projectPath: string;
  branchName: string | null;    // null for main worktree
}
```

### AgentQuestion

A question the agent posed during execution:

```typescript
interface AgentQuestion {
  id: string;
  stageId: string;              // Which pipeline stage or 'agent' for non-pipeline
  question: string;
  type: 'free-text' | 'single-select' | 'multi-select';
  options?: Array<{ label: string; description?: string }>;
  status: 'pending' | 'answered';
  answer?: string;
  source?: 'yaml' | 'agent';   // yaml: pre-stage; agent: mid-execution
}
```

---

## Developer Notes

### Adding a New Pipeline Stage

Create or edit a YAML file in `.pegasus/pipelines/`:

```yaml
name: My Custom Pipeline

defaults:
  model: sonnet
  max_turns: 20

stages:
  - id: analyze
    name: Analysis
    prompt: |
      Analyze this task: {{task.description}}
      Output a numbered list of implementation steps.

  - id: implement
    name: Implementation
    prompt: |
      Previous analysis:
      {{previous_context}}

      Now implement: {{task.description}}
```

Assign the pipeline slug to a feature via `feature.pipeline = "my-custom-pipeline"`.

### Shared State Across Facades

Facades share state through `SharedServices` provided by `GlobalAutoModeService.getSharedServices()`. The `ConcurrencyManager` and `WorktreeResolver` are singletons; each facade gets its own `AutoLoopCoordinator` for execution but shares the global one for read-only monitoring.

### Graceful Shutdown

On server shutdown, call `GlobalAutoModeService.markAllRunningFeaturesInterrupted(reason)` before exiting. This updates feature statuses to `interrupted` so the UI and next server startup can handle recovery correctly.
