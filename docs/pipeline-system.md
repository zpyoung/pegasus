# Pipeline System

Pegasus supports two kinds of pipelines that control how AI agents work through features on the Kanban board. This document covers both, focusing on the YAML-based pipeline system that is the primary mechanism for defining multi-stage agent workflows.

## Table of Contents

- [Overview](#overview)
- [Two Pipeline Systems](#two-pipeline-systems)
- [YAML Pipeline System](#yaml-pipeline-system)
  - [Pipeline YAML Format](#pipeline-yaml-format)
  - [Stage Configuration](#stage-configuration)
  - [Template Variables](#template-variables)
  - [Pipeline Inputs](#pipeline-inputs)
  - [Built-in Pipelines](#built-in-pipelines)
  - [Override Hierarchy](#override-hierarchy)
  - [Creating a Custom Pipeline](#creating-a-custom-pipeline)
- [JSON Pipeline System (Legacy)](#json-pipeline-system-legacy)
  - [Pipeline Steps](#pipeline-steps)
  - [Kanban Board Integration](#kanban-board-integration)
- [Execution Flow](#execution-flow)
  - [YAML Pipeline Execution](#yaml-pipeline-execution)
  - [Resumption and Fault Tolerance](#resumption-and-fault-tolerance)
  - [Context Accumulation Between Stages](#context-accumulation-between-stages)
- [API Reference](#api-reference)
  - [YAML Pipeline Discovery](#yaml-pipeline-discovery)
  - [Copy Built-in Templates](#copy-built-in-templates)
  - [JSON Pipeline Configuration (Legacy)](#json-pipeline-configuration-legacy)
- [File and Directory Layout](#file-and-directory-layout)

---

## Overview

The pipeline system lets you define multi-stage AI workflows that execute sequentially for a feature. Instead of running a single undifferentiated agent prompt, you can break work into distinct phases — planning, implementation, review, testing — each with its own model selection, permission mode, and prompt template.

Pipelines are especially useful when:
- You want the agent to analyze before acting (read-only analysis followed by targeted edits)
- You need an approval gate between planning and implementation
- Different stages require different models (e.g., Opus for design, Sonnet for coding)
- You want to ask the user a question before a stage begins

---

## Two Pipeline Systems

Pegasus has two pipeline systems:

| System | Config format | Primary use |
|--------|--------------|-------------|
| **YAML Pipeline** | `.yaml` files in `.pegasus/pipelines/` | Assigning a workflow to a feature before execution |
| **JSON Pipeline** | `.pegasus/pipeline.json` | Custom Kanban columns that appear between "In Progress" and "Done" |

The YAML pipeline is the recommended approach. When a feature has a `pipeline` field set to a pipeline slug (e.g., `"feature"` or `"bug-fix"`), the execution engine uses `StageRunner` to process the YAML stages. The JSON pipeline predates YAML pipelines and is still supported for legacy custom columns.

---

## YAML Pipeline System

### Pipeline YAML Format

A pipeline is defined in a YAML file stored in `.pegasus/pipelines/{slug}.yaml` (project-level) or `~/.pegasus/pipelines/{slug}.yaml` (user-level). The slug is the filename without the `.yaml` extension.

**Top-level fields:**

```yaml
name: Feature                          # Pipeline display name (required)
description: Plan, implement, and review a new feature  # (required)

execution:
  mode: session                        # Currently the only supported mode

defaults:                              # Fallback settings for all stages
  model: sonnet                        # Default model alias or full model ID
  max_turns: 10                        # Default max agent conversation turns
  permission_mode: plan                # Default permission mode

inputs:                                # Declared user inputs (optional)
  target_module:
    type: string
    required: true
    description: "Module to work on"

stages:                                # Ordered list of stages (required, min 1)
  - id: plan
    name: Feature Planning
    prompt: |
      Plan the implementation...
```

**Schema rules enforced at load time:**
- `name` and `description` are required and must be non-empty
- `stages` must contain at least one entry
- Stage `id` values must be unique within the pipeline
- Stage `id` must match the regex `^[a-z][a-z0-9_-]*$` (lowercase letters, numbers, hyphens, underscores; starts with a letter)

---

### Stage Configuration

Each stage in the `stages` array accepts:

```yaml
stages:
  - id: implement                      # Required. Unique within the pipeline.
    name: Implement Feature            # Required. Human-readable display name.
    prompt: |                          # Required. Handlebars template (see below).
      Implement {{task.description}}...
    claude_flags:                      # Optional. Override pipeline defaults for this stage.
      model: sonnet                    # Model alias or full model ID
      permission_mode: acceptEdits     # "plan" | "acceptEdits" | other Claude SDK modes
      max_turns: 20                    # Positive integer
    requires_approval: false           # If true, logs an approval gate notification
    question: "Which module should this target?"  # Pre-stage question shown to user
    question_meta:                     # Optional metadata for the question
      type: single-select              # "free-text" | "single-select" | "multi-select"
      options:
        - auth
        - payments
        - notifications
```

**`claude_flags` cascade (highest to lowest priority):**

1. Stage-level `claude_flags`
2. Pipeline-level `defaults`
3. System defaults: `model: sonnet`, `permission_mode: plan`, `max_turns: 10`

**`permission_mode` values:**
- `plan` — read-only, the agent can browse code and produce a plan but cannot write files
- `acceptEdits` — the agent can read and write files

---

### Template Variables

Stage prompts are Handlebars templates. Variables are resolved just before the stage executes, so each stage can reference the accumulated output of previous stages.

**Available namespaces:**

| Variable | Source |
|----------|--------|
| `{{task.description}}` | The feature's description field |
| `{{task.title}}` | The feature's title |
| `{{project.language}}` | From project settings |
| `{{project.test_command}}` | From project settings |
| `{{project.lint_command}}` | From project settings |
| `{{inputs.<name>}}` | User-provided pipeline inputs |
| `{{previous_context}}` | Accumulated agent output from all prior stages |
| `{{stages.<stageId>.question_response}}` | User's answer to a pre-stage question |

**Conditional blocks** using Handlebars helpers:

```yaml
prompt: |
  {{#if project.test_command}}- Run tests with: {{project.test_command}}{{/if}}
  {{#if project.lint_command}}- Run linter with: {{project.lint_command}}{{/if}}
```

**Missing variables** are rendered as empty strings. The server logs a warning listing any referenced variables that were not found in the context — useful for debugging pipelines that rely on optional project settings.

---

### Pipeline Inputs

Pipelines can declare inputs that users must provide when creating a feature with that pipeline. Inputs become `{{inputs.<name>}}` template variables in all stage prompts.

```yaml
inputs:
  design_doc_path:
    type: string           # "string" | "number" | "boolean"
    required: true
    description: "Path to the design document (e.g. .ai_tasks/feature-x.design.md)"
  max_iterations:
    type: number
    default: 3
    description: "Maximum retry attempts"
  run_tests:
    type: boolean
    default: true
```

Input values are stored on the feature and passed to the Handlebars context under the `inputs` key.

---

### Built-in Pipelines

Pegasus ships two built-in pipelines that are always available regardless of whether any YAML files exist on disk.

#### Bug Fix (`bug-fix`)

Three stages: `analyze` → `implement` → `verify`

| Stage | Model | Permission | max_turns | Approval |
|-------|-------|-----------|-----------|---------|
| Root Cause Analysis | sonnet | plan | 8 | No |
| Apply Fix | sonnet | acceptEdits | 15 | Yes |
| Verify Fix | sonnet | plan | 5 | No |

The analyze stage is read-only and instructs the agent to identify root cause without making changes. The implement stage uses `acceptEdits` to apply a minimal, targeted fix. The verify stage re-reads the changes and runs the test suite if `project.test_command` is configured.

#### Feature (`feature`)

Three stages: `plan` → `implement` → `review`

| Stage | Model | Permission | max_turns | Approval |
|-------|-------|-----------|-----------|---------|
| Feature Planning | opus | plan | 10 | Yes |
| Implement Feature | sonnet | acceptEdits | 20 | No |
| Code Review | sonnet | plan | 8 | No |

The plan stage uses Opus for deeper reasoning and requires approval before implementation begins. The implement stage follows the approved plan. The review stage verifies quality and runs tests.

---

### Override Hierarchy

When the server resolves which pipeline to use for a given slug, it applies this priority order (highest first):

1. **Project-level**: `.pegasus/pipelines/{slug}.yaml`
2. **User-level**: `~/.pegasus/pipelines/{slug}.yaml`
3. **Built-in**: Embedded templates shipped with Pegasus

If both a project-level and user-level pipeline exist with the same slug, the project-level file wins. Built-in pipelines are only used if no file with that slug exists at either level.

---

### Creating a Custom Pipeline

**Option 1: Copy a built-in template to your project and edit it**

Use the API endpoint (or the UI) to copy the built-in templates as a starting point:

```bash
curl -X POST http://localhost:3008/api/pipeline/copy-templates \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/path/to/project", "slugs": ["feature"], "overwrite": false}'
```

This writes `.pegasus/pipelines/feature.yaml` into your project. Edit it to suit your workflow.

**Option 2: Write a YAML file from scratch**

Create `.pegasus/pipelines/my-pipeline.yaml`:

```yaml
name: My Custom Pipeline
description: A three-stage workflow for my project

execution:
  mode: session

defaults:
  model: sonnet
  max_turns: 15
  permission_mode: plan

stages:
  - id: research
    name: Research
    prompt: |
      Research the codebase to understand the context for this task:

      {{task.description}}

      Summarize:
      1. Relevant existing code patterns
      2. Dependencies involved
      3. Suggested approach
    claude_flags:
      model: opus
      permission_mode: plan
      max_turns: 10
    requires_approval: true

  - id: implement
    name: Implement
    prompt: |
      Implement the task based on the research from the previous stage.

      Task: {{task.description}}

      Previous research:
      {{previous_context}}

      {{#if project.test_command}}- Run tests: {{project.test_command}}{{/if}}
    claude_flags:
      permission_mode: acceptEdits
      max_turns: 20

  - id: verify
    name: Verify
    prompt: |
      Verify the implementation is correct.
      Review the changes and run tests.
      {{#if project.test_command}}Run: {{project.test_command}}{{/if}}
    claude_flags:
      permission_mode: plan
      max_turns: 8
```

The pipeline becomes available immediately — it is discovered at runtime on the next API call to `/api/pipeline/discover`.

**Option 3: User-level pipeline (shared across projects)**

Place a YAML file at `~/.pegasus/pipelines/{slug}.yaml`. It is available to all projects on the machine unless overridden by a project-level file with the same slug.

---

## JSON Pipeline System (Legacy)

The JSON pipeline is configured per-project in `.pegasus/pipeline.json`. It defines custom columns that appear in the Kanban board between "In Progress" and the final approval/verified columns. This is separate from YAML pipelines and predates them.

### Pipeline Steps

Each step in `pipeline.json` creates a new Kanban column. Features transition through steps in order, with each step running an AI agent with the step's instructions.

**Step structure (from `@pegasus/types`):**

```typescript
interface PipelineStep {
  id: string;          // Auto-generated unique identifier
  name: string;        // Display name shown on the Kanban column
  order: number;       // Zero-based position in the pipeline
  instructions: string; // Prompt instructions for the agent at this step
  colorClass: string;  // CSS class used for the column color
  createdAt: string;   // ISO 8601 timestamp
  updatedAt: string;   // ISO 8601 timestamp
}
```

### Kanban Board Integration

Feature status transitions when a JSON pipeline is configured:

```
backlog → ready → in_progress → pipeline_{stepId_0} → pipeline_{stepId_1} → ... → waiting_approval / verified
```

Status strings use the format `pipeline_{stepId}` (e.g., `pipeline_step_1abc23_xyz456`). The `PipelineService.getNextStatus()` method computes the next status in this chain, respecting any steps that have been excluded via `feature.excludedPipelineSteps`.

---

## Execution Flow

### YAML Pipeline Execution

When a feature with `feature.pipeline` set to a slug is executed:

1. `ExecutionService.executeFeature()` detects `feature.pipeline` is set.
2. It calls `loadPipeline(projectPath, slug)` to read and validate the YAML file (with override hierarchy applied).
3. It calls `compilePipeline(config)` to merge defaults into each stage, producing `ResolvedStage[]`.
4. It builds a `StageCompilationContext` with `task`, `project`, and `inputs` data.
5. A `StageRunner` instance is created and `stageRunner.run(config)` is called.
6. For each stage in order, `StageRunner`:
   a. Checks for a pre-stage question; if the stage has `question` and no answer exists, pauses with `PauseExecutionError` (feature transitions to `waiting_question`).
   b. Calls `compileStage(stage, context)` to resolve Handlebars variables in the prompt.
   c. Calls `runAgentFn()` to execute the agent with the compiled prompt, model, and permission mode.
   d. Reads updated `agent-output.md` as the new `accumulatedContext`.
   e. Persists a snapshot to `.pegasus/features/{featureId}/stage-outputs/{stageId}.md`.
   f. Updates `.pegasus/features/{featureId}/pipeline-state.json`.
   g. Emits `pipeline_step_started` and `pipeline_step_complete` events.
7. After all stages complete, the pipeline state file is deleted (stage output snapshots are kept for auditing).
8. `ExecutionService` sets the feature status to `waiting_approval` or `verified` based on `feature.skipTests`.

### Resumption and Fault Tolerance

If a pipeline is interrupted (server restart, abort, crash), it resumes from the last completed stage rather than starting over.

**How it works:**

- After each stage completes, `StageRunner` writes `pipeline-state.json` to disk:

```json
{
  "version": 1,
  "pipelineName": "Feature",
  "totalStages": 3,
  "completedStages": [
    {
      "stageId": "plan",
      "stageName": "Feature Planning",
      "stageIndex": 0,
      "completedAt": "2024-01-01T12:00:00.000Z",
      "accumulatedContextSnapshot": "..."
    }
  ],
  "lastCompletedStageIndex": 0,
  "updatedAt": "2024-01-01T12:00:00.000Z"
}
```

- On the next call to `stageRunner.run()`, it reads this file and skips any stages whose index and ID match the completed stages list, restoring `accumulatedContext` from the last checkpoint.
- If the pipeline configuration has changed (stages reordered or removed), the state is considered invalid and execution restarts from the beginning.
- Note: YAML pipeline features skip the legacy `agent-output.md`-based resumption used for non-pipeline features.

### Context Accumulation Between Stages

Each stage receives the output of all prior stages as `previous_context`. The flow:

1. Before stage N starts, `accumulatedContext` contains everything written to `agent-output.md` by stages 0 through N-1.
2. Stage N's prompt template is compiled with `previous_context = accumulatedContext`.
3. The agent executes and writes its output to `agent-output.md` (overwriting previous content).
4. After stage N completes, `accumulatedContext` is updated by reading `agent-output.md`.
5. Stage N+1 receives the new `accumulatedContext` as its `previous_context`.

This means later stages always have full visibility into earlier stages' work.

---

## API Reference

All pipeline routes are mounted at `/api/pipeline`.

### YAML Pipeline Discovery

**`GET /api/pipeline/discover`**

Scans user-level and project-level pipeline directories for YAML files, validates them, and returns the deduplicated list (project overrides user for the same slug). Built-in pipelines are included in the response as `isBuiltIn: true`.

Query parameters:
- `projectPath` (required) — Absolute path to the project

Response:
```json
{
  "success": true,
  "pipelines": [
    {
      "slug": "feature",
      "filePath": "built-in://feature",
      "config": { "name": "Feature", "description": "...", "stages": [...] },
      "stageCount": 3,
      "isBuiltIn": true,
      "source": "user"
    },
    {
      "slug": "my-pipeline",
      "filePath": "/path/to/project/.pegasus/pipelines/my-pipeline.yaml",
      "config": { ... },
      "stageCount": 2,
      "isBuiltIn": false,
      "source": "project"
    }
  ]
}
```

---

### Copy Built-in Templates

**`POST /api/pipeline/copy-templates`**

Copies one or more built-in pipeline YAML templates to the project's `.pegasus/pipelines/` directory. By default, existing files are not overwritten.

Request body:
```json
{
  "projectPath": "/path/to/project",
  "slugs": ["feature", "bug-fix"],   // omit to copy all built-ins
  "overwrite": false
}
```

Response:
```json
{
  "success": true,
  "copied": ["feature"],
  "skipped": ["bug-fix"],
  "errors": []
}
```

Available built-in slugs: `feature`, `bug-fix`

---

### JSON Pipeline Configuration (Legacy)

These endpoints manage the legacy JSON pipeline stored in `.pegasus/pipeline.json`.

**`POST /api/pipeline/config`** — Get pipeline configuration

Request body: `{ "projectPath": "/path/to/project" }`

Response: `{ "success": true, "config": { "version": 1, "steps": [...] } }`

---

**`POST /api/pipeline/config/save`** — Save entire pipeline configuration

Request body:
```json
{
  "projectPath": "/path/to/project",
  "config": {
    "version": 1,
    "steps": [...]
  }
}
```

---

**`POST /api/pipeline/steps/add`** — Add a new pipeline step

Request body:
```json
{
  "projectPath": "/path/to/project",
  "step": {
    "name": "Security Review",
    "order": 0,
    "instructions": "Review the implementation for security vulnerabilities...",
    "colorClass": "bg-orange-500"
  }
}
```

Response: `{ "success": true, "step": { "id": "step_...", "name": "...", ... } }`

---

**`POST /api/pipeline/steps/update`** — Update an existing step

Request body:
```json
{
  "projectPath": "/path/to/project",
  "stepId": "step_1abc23_xyz456",
  "updates": { "name": "Updated Name", "instructions": "..." }
}
```

---

**`POST /api/pipeline/steps/delete`** — Delete a step

Request body: `{ "projectPath": "/path/to/project", "stepId": "step_..." }`

---

**`POST /api/pipeline/steps/reorder`** — Reorder steps

Request body:
```json
{
  "projectPath": "/path/to/project",
  "stepIds": ["step_first", "step_second", "step_third"]
}
```

Positions are assigned in the order of the `stepIds` array.

---

## File and Directory Layout

```
~/.pegasus/
└── pipelines/                    # User-level pipelines (all projects)
    ├── feature.yaml
    └── bug-fix.yaml

{projectPath}/
└── .pegasus/
    ├── pipeline.json             # Legacy JSON pipeline config
    ├── pipelines/                # Project-level YAML pipelines
    │   ├── feature.yaml
    │   ├── bug-fix.yaml
    │   └── my-custom.yaml
    └── features/
        └── {featureId}/
            ├── agent-output.md           # Accumulated agent output (all stages)
            ├── pipeline-state.json       # Resumption checkpoint (deleted on success)
            └── stage-outputs/
                ├── plan.md               # Snapshot after "plan" stage
                ├── implement.md          # Snapshot after "implement" stage
                └── review.md             # Snapshot after "review" stage
```

**Key files:**
- `pipeline-state.json` — Written after each stage; read on resume to skip completed stages. Deleted after all stages succeed.
- `stage-outputs/{stageId}.md` — Per-stage accumulated context snapshots. Preserved after pipeline completes for auditing and debugging.
- `agent-output.md` — The live context file updated after each stage. This is what later stages read as `previous_context`.
