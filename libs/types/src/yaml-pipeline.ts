/**
 * YAML Pipeline Types - Type definitions for YAML-based pipeline configuration
 *
 * These types model the YAML pipeline files stored in `.pegasus/pipelines/`.
 * Each YAML file defines a multi-stage pipeline (e.g., feature.yaml, bug-fix.yaml)
 * with stages that are executed sequentially by the pipeline orchestrator.
 *
 * Flow: YAML file → YamlPipelineConfig (parsed) → ResolvedStage[] (defaults merged)
 *       → StageContext (runtime execution)
 */

/**
 * Claude CLI flags that can be set per-stage to override defaults.
 *
 * These map directly to the `claude_flags` section in each YAML stage definition.
 * Any field not specified falls back to the pipeline-level `defaults`.
 */
export interface YamlClaudeFlags {
  /** Model override for this stage (e.g., "opus", "sonnet", "claude-sonnet-4-20250514") */
  model?: string;
  /** Permission mode for this stage (e.g., "plan", "acceptEdits") */
  permission_mode?: string;
  /** Maximum number of agent conversation turns */
  max_turns?: number;
}

/**
 * A single stage definition within a YAML pipeline file.
 *
 * Each stage represents a discrete step in the pipeline workflow,
 * with its own prompt template and optional Claude CLI flag overrides.
 *
 * Prompt templates support Handlebars-style variables:
 * - `{{task.description}}` - The feature/task description
 * - `{{project.language}}` - The project language from config.yaml
 * - `{{project.test_command}}` - The test command from config.yaml
 */
export interface YamlStageConfig {
  /** Unique stage identifier (e.g., "plan", "implement", "review") */
  id: string;
  /** Human-readable stage name (e.g., "Feature Planning", "Implement Feature") */
  name: string;
  /** Prompt template with Handlebars-style variable placeholders */
  prompt: string;
  /** Optional Claude CLI flag overrides for this stage */
  claude_flags?: YamlClaudeFlags;
  /** Whether this stage requires user approval before proceeding to the next stage */
  requires_approval?: boolean;
}

/**
 * Pipeline execution mode configuration.
 *
 * Defines how the pipeline stages are coordinated.
 */
export interface YamlExecutionConfig {
  /** Execution mode - currently only "session" is supported */
  mode: 'session';
}

/**
 * Default settings applied to all stages unless overridden.
 *
 * These values are used as fallbacks when a stage's `claude_flags`
 * does not specify a particular setting.
 */
export interface YamlPipelineDefaults {
  /** Default model for all stages (e.g., "sonnet") */
  model?: string;
  /** Default maximum conversation turns per stage */
  max_turns?: number;
  /** Default permission mode for all stages (e.g., "plan") */
  permission_mode?: string;
}

/**
 * Top-level YAML pipeline configuration.
 *
 * Represents the complete parsed structure of a `.pegasus/pipelines/*.yaml` file.
 * Each YAML file defines one pipeline type (e.g., feature, bug-fix, feature-from-design).
 *
 * @example
 * ```yaml
 * name: Feature
 * description: Plan, implement, and test a new feature
 * execution:
 *   mode: session
 * defaults:
 *   model: sonnet
 *   max_turns: 10
 *   permission_mode: plan
 * stages:
 *   - id: plan
 *     name: Feature Planning
 *     prompt: |
 *       Plan the implementation for this feature...
 *     claude_flags:
 *       model: opus
 *       permission_mode: plan
 *     requires_approval: true
 * ```
 */
export interface YamlPipelineConfig {
  /** Pipeline display name (e.g., "Feature", "Bug Fix") */
  name: string;
  /** Human-readable description of the pipeline's purpose */
  description: string;
  /** Execution mode configuration */
  execution?: YamlExecutionConfig;
  /** Default settings applied to stages that don't override them */
  defaults?: YamlPipelineDefaults;
  /** Ordered list of stages in this pipeline */
  stages: YamlStageConfig[];
}

/**
 * A fully resolved stage with all defaults merged and template variables expanded.
 *
 * Created by merging a `YamlStageConfig` with the pipeline's `YamlPipelineDefaults`
 * and resolving any Handlebars-style template variables in the prompt.
 *
 * This is the stage representation used at execution time — all optional fields
 * from the YAML are guaranteed to have concrete values.
 */
export interface ResolvedStage {
  /** Unique stage identifier */
  id: string;
  /** Human-readable stage name */
  name: string;
  /** Fully resolved prompt with all template variables expanded */
  prompt: string;
  /** Resolved model (from stage claude_flags or pipeline defaults) */
  model: string;
  /** Resolved permission mode (from stage claude_flags or pipeline defaults) */
  permission_mode: string;
  /** Resolved max turns (from stage claude_flags or pipeline defaults) */
  max_turns: number;
  /** Whether this stage requires user approval before proceeding */
  requires_approval: boolean;
}

/**
 * Runtime context passed to each stage during pipeline execution.
 *
 * Provides the stage with all the information it needs about the current
 * execution environment, including project settings, feature details,
 * and accumulated output from previous stages.
 */
export interface StageContext {
  /** Absolute path to the project root */
  projectPath: string;
  /** ID of the feature being processed */
  featureId: string;
  /** The feature object being processed */
  feature: import('./feature.js').Feature;
  /** The resolved stage being executed */
  stage: ResolvedStage;
  /** Zero-based index of the current stage in the pipeline */
  stageIndex: number;
  /** Total number of stages in the pipeline */
  totalStages: number;
  /** Working directory for agent execution (may be a worktree path) */
  workDir: string;
  /** Path to the worktree, if using worktrees */
  worktreePath: string | null;
  /** Feature branch name, if applicable */
  branchName: string | null;
  /** Abort controller for cancellation support */
  abortController: AbortController;
  /** Accumulated output/context from previous stages */
  previousContext: string;
  /** Pipeline-level defaults for reference */
  pipelineDefaults: YamlPipelineDefaults;
  /** The source pipeline name (e.g., "Feature", "Bug Fix") */
  pipelineName: string;
}

/** Source location where a pipeline was discovered */
export type PipelineSource = 'project' | 'user';

/**
 * Represents a pipeline YAML file discovered from project or user-level directories.
 *
 * Pipelines are scanned from two locations:
 * - **Project-level**: `{projectPath}/.pegasus/pipelines/` (project-specific pipelines)
 * - **User-level**: `~/.pegasus/pipelines/` (shared across all projects)
 *
 * When both locations contain a pipeline with the same slug, the project-level
 * pipeline takes precedence (overrides the user-level one).
 *
 * Used when scanning for available pipelines to present to the user.
 * Contains both the parsed configuration and filesystem metadata.
 */
export interface DiscoveredPipeline {
  /** Pipeline slug derived from filename (e.g., "feature", "bug-fix", "feature-from-design") */
  slug: string;
  /** Absolute path to the YAML file */
  filePath: string;
  /** The parsed pipeline configuration */
  config: YamlPipelineConfig;
  /** Number of stages in this pipeline */
  stageCount: number;
  /** Whether this is a built-in pipeline (shipped with Pegasus) vs user-created */
  isBuiltIn: boolean;
  /** Where this pipeline was discovered from: 'project' (`.pegasus/pipelines/`) or 'user' (`~/.pegasus/pipelines/`) */
  source: PipelineSource;
}

/**
 * Context data used to resolve Handlebars template variables in stage prompts.
 *
 * Provides the template variables available during stage compilation:
 * - `task.*` - Feature/task information (description, title, etc.)
 * - `project.*` - Project configuration from config.yaml (language, test_command, etc.)
 * - `inputs.*` - User-provided pipeline input values from the feature
 * - `previous_context` - Accumulated output from prior stages
 *
 * @example
 * ```ts
 * const context: StageCompilationContext = {
 *   task: { description: 'Add user auth', title: 'Auth Feature' },
 *   project: { language: 'typescript', test_command: 'pnpm test' },
 *   inputs: { target_module: 'auth' },
 * };
 * ```
 */
export interface StageCompilationContext {
  /** Task/feature information (mapped from Feature properties) */
  task: {
    /** The feature/task description */
    description: string;
    /** The feature/task title */
    title?: string;
    /** Allow additional task-level variables */
    [key: string]: unknown;
  };
  /** Project configuration from config.yaml */
  project: {
    /** The project's primary language (e.g., "typescript", "python") */
    language?: string;
    /** Command to run tests (e.g., "pnpm test", "pytest") */
    test_command?: string;
    /** Command to lint the project */
    lint_command?: string;
    /** Allow additional project-level variables */
    [key: string]: unknown;
  };
  /** User-provided pipeline input values from Feature.pipelineInputs */
  inputs?: Record<string, string | number | boolean>;
  /** Accumulated output/context from previous pipeline stages */
  previous_context?: string;
}

/**
 * Result of compiling a single stage's prompt template.
 *
 * Contains the resolved stage with Handlebars variables expanded,
 * plus metadata about any template variables that were referenced
 * but not provided in the compilation context.
 */
export interface StageCompilationResult {
  /** The stage with its prompt template fully resolved */
  stage: ResolvedStage;
  /** Template variables referenced in the prompt but not found in the context */
  missingVariables: string[];
  /** Whether any variables were missing (convenience flag) */
  hasMissingVariables: boolean;
}

// ============================================================================
// Pipeline Execution State Types
// ============================================================================

/**
 * Persisted state for a single completed pipeline stage.
 *
 * Stored as part of `PipelineExecutionState` to track which stages have
 * finished and what output they produced. This enables resumption after
 * crashes, aborts, or server restarts — the runner can skip completed
 * stages and pick up from where it left off.
 */
export interface CompletedStageState {
  /** Stage identifier (matches ResolvedStage.id) */
  stageId: string;
  /** Human-readable stage name */
  stageName: string;
  /** Zero-based index of the stage in the pipeline */
  stageIndex: number;
  /** ISO 8601 timestamp when the stage completed */
  completedAt: string;
  /** Accumulated context snapshot after this stage completed */
  accumulatedContextSnapshot: string;
}

/**
 * Full pipeline execution state persisted to disk.
 *
 * Stored at `.pegasus/features/{featureId}/pipeline-state.json` and updated
 * after each stage completes. Used by StageRunner to:
 * 1. Determine which stages have already completed (skip on resume)
 * 2. Restore accumulated context from the last completed stage
 * 3. Provide progress information to the caller
 *
 * @example
 * ```json
 * {
 *   "version": 1,
 *   "pipelineName": "Feature",
 *   "totalStages": 3,
 *   "completedStages": [
 *     { "stageId": "plan", "stageName": "Planning", "stageIndex": 0, "completedAt": "...", "accumulatedContextSnapshot": "..." }
 *   ],
 *   "lastCompletedStageIndex": 0,
 *   "updatedAt": "2024-01-01T00:00:00.000Z"
 * }
 * ```
 */
export interface PipelineExecutionState {
  /** Schema version for forward compatibility */
  version: 1;
  /** Name of the pipeline being executed */
  pipelineName: string;
  /** Total number of stages in the pipeline */
  totalStages: number;
  /** Ordered array of stages that have completed successfully */
  completedStages: CompletedStageState[];
  /** Index of the last completed stage (-1 if no stages completed) */
  lastCompletedStageIndex: number;
  /** ISO 8601 timestamp of the last state update */
  updatedAt: string;
}
