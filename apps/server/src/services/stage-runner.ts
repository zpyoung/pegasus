/**
 * StageRunner - Sequential execution of YAML pipeline stages
 *
 * Executes ResolvedStage[] sequentially, building up context between stages.
 * Each stage's output becomes the `previous_context` for the next stage's
 * Handlebars template resolution.
 *
 * Flow: ResolvedStage[] → compile templates → execute sequentially → accumulate context
 *
 * This class is the YAML-pipeline counterpart to the legacy PipelineOrchestrator.
 * While PipelineOrchestrator executes JSON-configured PipelineStep[] objects,
 * StageRunner executes YAML-configured ResolvedStage[] objects produced by
 * the PipelineCompiler.
 *
 * Key responsibilities:
 * - Iterate through resolved stages in order
 * - Compile stage prompts with Handlebars template variables (including previous_context)
 * - Execute each stage via the RunAgentFn callback
 * - Accumulate agent output context between stages
 * - Persist per-stage output snapshots and pipeline execution state for resumption
 * - Resume from the last completed stage after crashes or aborts
 * - Emit pipeline stage events via TypedEventBus
 * - Support cancellation via AbortController
 * - Report approval gates for stages that require user approval
 */

import path from 'path';
import type {
  AgentQuestion,
  CompletedStageState,
  Feature,
  PipelineExecutionState,
  ResolvedStage,
  StageCompilationContext,
  YamlPipelineDefaults,
} from '@pegasus/types';
import { createLogger } from '@pegasus/utils';
import {
  getFeatureDir,
  getPipelineStatePath,
  getStageOutputsDir,
  getStageOutputPath,
} from '@pegasus/platform';
import * as secureFs from '../lib/secure-fs.js';
import { compileStage } from './pipeline-compiler.js';
import { PauseExecutionError } from './pause-execution-error.js';
import { formatAnsweredAgentQuestions } from './question-service.js';
import type { TypedEventBus } from './typed-event-bus.js';
import type { QuestionService } from './question-service.js';

const logger = createLogger('StageRunner');

// ============================================================================
// Types
// ============================================================================

/**
 * Function signature for running the agent on a single stage.
 *
 * This is intentionally aligned with the existing RunAgentFn pattern used
 * by PipelineOrchestrator and ExecutionService, allowing the same underlying
 * agent execution infrastructure to be reused.
 */
export type StageRunAgentFn = (
  workDir: string,
  featureId: string,
  prompt: string,
  abortController: AbortController,
  projectPath: string,
  imagePaths?: string[],
  model?: string,
  options?: Record<string, unknown>
) => Promise<void>;

/**
 * Configuration for a StageRunner execution.
 *
 * Contains all the information needed to execute a sequence of YAML pipeline
 * stages for a specific feature.
 */
export interface StageRunnerConfig {
  /** Absolute path to the project root */
  projectPath: string;
  /** ID of the feature being processed */
  featureId: string;
  /** The feature object being processed */
  feature: Feature;
  /** Ordered array of resolved stages to execute */
  stages: ResolvedStage[];
  /** Working directory for agent execution (may be a worktree path) */
  workDir: string;
  /** Path to the worktree, if using worktrees */
  worktreePath: string | null;
  /** Feature branch name, if applicable */
  branchName: string | null;
  /** Abort controller for cancellation support */
  abortController: AbortController;
  /** Pipeline-level defaults for reference */
  pipelineDefaults: YamlPipelineDefaults;
  /** The source pipeline name (e.g., "Feature", "Bug Fix") */
  pipelineName: string;
  /** Stage compilation context for Handlebars template variable resolution */
  compilationContext: StageCompilationContext;
}

/**
 * Result of running all stages sequentially.
 *
 * Provides comprehensive status information including which stages completed,
 * accumulated context, and failure details.
 */
export interface StageRunResult {
  /** Whether all stages completed successfully */
  success: boolean;
  /** Number of stages that completed */
  stagesCompleted: number;
  /** Total number of stages */
  totalStages: number;
  /** Accumulated context from all stages */
  accumulatedContext: string;
  /** Whether execution was aborted via AbortController */
  aborted: boolean;
  /** Error message if a stage failed */
  error?: string;
  /** ID of the stage that was executing when failure occurred */
  failedStageId?: string;
  /** Number of stages that were skipped (already completed on resume) */
  stagesSkipped: number;
}

// ============================================================================
// StageRunner Class
// ============================================================================

/**
 * StageRunner executes YAML pipeline stages sequentially.
 *
 * Each stage's compiled prompt is sent to the agent for execution, and the
 * accumulated agent output is fed into subsequent stages as `previous_context`.
 *
 * **Persistence & Resumption:**
 * After each stage completes, the runner persists:
 * 1. A per-stage output snapshot to `stage-outputs/{stageId}.md`
 * 2. The overall pipeline execution state to `pipeline-state.json`
 *
 * On subsequent calls to `run()`, the runner loads the persisted state and
 * skips any stages that have already completed, resuming from the next
 * incomplete stage with the accumulated context from the last checkpoint.
 *
 * Events emitted (via TypedEventBus):
 * - `pipeline_step_started` — when a stage begins execution
 * - `pipeline_step_complete` — when a stage finishes successfully
 * - `auto_mode_progress` — progress updates for the frontend
 *
 * @example
 * ```ts
 * const runner = new StageRunner(eventBus, runAgentFn);
 * const result = await runner.run({
 *   projectPath: '/path/to/project',
 *   featureId: 'feat-123',
 *   feature,
 *   stages: resolvedStages,
 *   workDir: '/path/to/workdir',
 *   worktreePath: null,
 *   branchName: 'feat/my-feature',
 *   abortController: new AbortController(),
 *   pipelineDefaults: { model: 'sonnet', max_turns: 10 },
 *   pipelineName: 'Feature',
 *   compilationContext: {
 *     task: { description: 'Add dark mode' },
 *     project: { language: 'TypeScript' },
 *   },
 * });
 *
 * if (result.success) {
 *   console.log(`All ${result.totalStages} stages completed`);
 * }
 * ```
 */
export class StageRunner {
  constructor(
    private eventBus: TypedEventBus,
    private runAgentFn: StageRunAgentFn,
    private questionService?: QuestionService
  ) {}

  // ==========================================================================
  // Pipeline Execution State Management
  // ==========================================================================

  /**
   * Load the persisted pipeline execution state for a feature.
   *
   * Returns null if no state file exists (fresh execution).
   *
   * @param projectPath - Absolute path to the project root
   * @param featureId - Feature identifier
   * @returns The persisted state, or null if not found
   */
  async loadPipelineState(
    projectPath: string,
    featureId: string
  ): Promise<PipelineExecutionState | null> {
    try {
      const statePath = getPipelineStatePath(projectPath, featureId);
      const content = (await secureFs.readFile(statePath, 'utf-8')) as string;
      const state = JSON.parse(content) as PipelineExecutionState;

      // Validate version for forward compatibility
      if (state.version !== 1) {
        logger.warn(
          `Pipeline state for feature ${featureId} has unsupported version ${state.version}. ` +
            `Ignoring persisted state and starting fresh.`
        );
        return null;
      }

      return state;
    } catch {
      // No existing state — fresh execution
      return null;
    }
  }

  /**
   * Persist the pipeline execution state to disk.
   *
   * Called after each stage completes to checkpoint progress.
   * The state file is written atomically (overwrite) to prevent
   * partial writes from corrupting the state.
   *
   * @param projectPath - Absolute path to the project root
   * @param featureId - Feature identifier
   * @param state - The pipeline execution state to persist
   */
  async savePipelineState(
    projectPath: string,
    featureId: string,
    state: PipelineExecutionState
  ): Promise<void> {
    try {
      const statePath = getPipelineStatePath(projectPath, featureId);
      await secureFs.writeFile(
        statePath,
        JSON.stringify(state, null, 2),
        'utf-8'
      );
    } catch (error) {
      // Non-fatal: log but don't fail the pipeline
      logger.warn(
        `Failed to save pipeline state for feature ${featureId}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Persist a per-stage output snapshot to disk.
   *
   * Saves the accumulated context after a stage completes to a dedicated
   * file in the `stage-outputs/` directory. This provides:
   * - Fine-grained recovery (restore from any stage checkpoint)
   * - Debugging visibility (inspect output at each stage boundary)
   * - Audit trail for pipeline execution
   *
   * @param projectPath - Absolute path to the project root
   * @param featureId - Feature identifier
   * @param stageId - Stage identifier
   * @param accumulatedContext - The accumulated context after the stage completed
   */
  async saveStageOutput(
    projectPath: string,
    featureId: string,
    stageId: string,
    accumulatedContext: string
  ): Promise<void> {
    try {
      // Ensure the stage-outputs directory exists
      const stageOutputsDir = getStageOutputsDir(projectPath, featureId);
      await secureFs.mkdir(stageOutputsDir, { recursive: true });

      // Write the stage output snapshot
      const outputPath = getStageOutputPath(projectPath, featureId, stageId);
      await secureFs.writeFile(outputPath, accumulatedContext, 'utf-8');
    } catch (error) {
      // Non-fatal: log but don't fail the pipeline
      logger.warn(
        `Failed to save stage output for stage "${stageId}" ` +
          `(feature ${featureId}): ${(error as Error).message}`
      );
    }
  }

  /**
   * Clear the persisted pipeline execution state for a feature.
   *
   * Called after all stages complete successfully to clean up state.
   * Stage output snapshots are intentionally preserved for auditing.
   *
   * @param projectPath - Absolute path to the project root
   * @param featureId - Feature identifier
   */
  async clearPipelineState(
    projectPath: string,
    featureId: string
  ): Promise<void> {
    try {
      const statePath = getPipelineStatePath(projectPath, featureId);
      await secureFs.unlink(statePath);
    } catch {
      // Ignore — state may not exist
    }
  }

  // ==========================================================================
  // Resumption Logic
  // ==========================================================================

  /**
   * Determine the starting stage index and accumulated context for a run.
   *
   * If a valid pipeline state exists from a previous run of the same pipeline,
   * skips already-completed stages and restores context. Otherwise, falls back
   * to loading from agent-output.md (legacy behavior) or starts fresh.
   *
   * @param projectPath - Absolute path to the project root
   * @param featureId - Feature identifier
   * @param stages - The ordered stages to execute
   * @param pipelineName - The pipeline name (must match persisted state)
   * @returns Object with startIndex, accumulatedContext, and stagesSkipped
   */
  private async resolveResumptionPoint(
    projectPath: string,
    featureId: string,
    stages: ResolvedStage[],
    pipelineName: string
  ): Promise<{
    startIndex: number;
    accumulatedContext: string;
    stagesSkipped: number;
  }> {
    // Try to load persisted pipeline state
    const state = await this.loadPipelineState(projectPath, featureId);

    if (state && state.pipelineName === pipelineName && state.completedStages.length > 0) {
      // Validate that completed stages match the current pipeline configuration.
      // If stages have been reordered or removed, we can't safely resume.
      const isValid = state.completedStages.every((completed) => {
        const matchingStage = stages[completed.stageIndex];
        return matchingStage && matchingStage.id === completed.stageId;
      });

      if (isValid) {
        const lastCompleted = state.completedStages[state.completedStages.length - 1];
        const startIndex = lastCompleted.stageIndex + 1;
        const accumulatedContext = lastCompleted.accumulatedContextSnapshot;
        const stagesSkipped = startIndex;

        if (startIndex < stages.length) {
          logger.info(
            `Resuming pipeline "${pipelineName}" for feature ${featureId} ` +
              `from stage ${startIndex + 1}/${stages.length} ` +
              `(${stagesSkipped} stage(s) already completed: ` +
              `${state.completedStages.map((s) => s.stageId).join(', ')})`
          );
        } else {
          logger.info(
            `All stages already completed for pipeline "${pipelineName}" ` +
              `(feature ${featureId}). Nothing to execute.`
          );
        }

        return { startIndex, accumulatedContext, stagesSkipped };
      }

      logger.warn(
        `Pipeline state for feature ${featureId} does not match current pipeline ` +
          `configuration. Starting fresh execution.`
      );
    }

    // Fallback: load any existing context from agent-output.md (legacy support)
    let accumulatedContext = '';
    const contextPath = path.join(getFeatureDir(projectPath, featureId), 'agent-output.md');
    try {
      accumulatedContext = (await secureFs.readFile(contextPath, 'utf-8')) as string;
    } catch {
      // No existing context — this is a fresh execution
    }

    return { startIndex: 0, accumulatedContext, stagesSkipped: 0 };
  }

  // ==========================================================================
  // Main Execution
  // ==========================================================================

  /**
   * Execute all stages sequentially, with resumption support.
   *
   * On each invocation, the runner checks for persisted pipeline state:
   * - If valid state exists, already-completed stages are skipped and execution
   *   resumes from the next incomplete stage with restored context.
   * - If no state exists (or the pipeline configuration changed), all stages
   *   are executed from the beginning.
   *
   * After each stage completes, the runner persists:
   * 1. A per-stage output snapshot (`stage-outputs/{stageId}.md`)
   * 2. Updated pipeline execution state (`pipeline-state.json`)
   *
   * After all stages complete, the pipeline state file is cleared (stage
   * output snapshots are preserved for auditing).
   *
   * Execution stops early if:
   * - The AbortController signals cancellation
   * - A stage's agent execution throws an error
   *
   * @param config - The complete execution configuration
   * @returns Promise resolving to the execution result
   */
  async run(config: StageRunnerConfig): Promise<StageRunResult> {
    const {
      projectPath,
      featureId,
      feature,
      stages,
      workDir,
      abortController,
      pipelineName,
      compilationContext,
    } = config;

    const totalStages = stages.length;

    // Resolve the resumption point (skip completed stages if any)
    const { startIndex, accumulatedContext: initialContext, stagesSkipped } =
      await this.resolveResumptionPoint(projectPath, featureId, stages, pipelineName);

    let stagesCompleted = stagesSkipped;
    let accumulatedContext = initialContext;

    // If all stages already completed, return early
    if (startIndex >= totalStages) {
      return {
        success: true,
        stagesCompleted: totalStages,
        totalStages,
        accumulatedContext,
        aborted: false,
        stagesSkipped,
      };
    }

    // Load existing pipeline state to append to, or create a new one
    let pipelineState: PipelineExecutionState =
      (await this.loadPipelineState(projectPath, featureId)) ?? {
        version: 1,
        pipelineName,
        totalStages,
        completedStages: [],
        lastCompletedStageIndex: -1,
        updatedAt: new Date().toISOString(),
      };

    logger.info(
      `Starting stage execution for feature ${featureId}: ` +
        `${totalStages} stage(s) in pipeline "${pipelineName}"` +
        (stagesSkipped > 0
          ? ` (resuming from stage ${startIndex + 1}, ${stagesSkipped} skipped)`
          : '')
    );

    // Build stages context from existing question answers in feature.questionState.
    // This populates {{stages.<stageId>.question_response}} template variables for
    // subsequent stage prompt compilation.
    const stagesContext: Record<string, { question_response?: string; question_responses?: string }> = {};
    if (feature.questionState?.questions) {
      for (const q of feature.questionState.questions) {
        if (q.status === 'answered' && q.answer !== undefined) {
          stagesContext[q.stageId] = {
            question_response: q.answer,
            question_responses: q.answer,
          };
        }
      }
    }

    // Load any existing context from agent-output.md for the contextPath reference
    const contextPath = path.join(getFeatureDir(projectPath, featureId), 'agent-output.md');

    for (let i = startIndex; i < stages.length; i++) {
      const stage = stages[i];

      // Check for abort before starting each stage
      if (abortController.signal.aborted) {
        logger.info(
          `Stage execution aborted before stage "${stage.id}" for feature ${featureId}`
        );
        return {
          success: false,
          stagesCompleted,
          totalStages,
          accumulatedContext,
          aborted: true,
          error: 'Pipeline execution aborted',
          failedStageId: stage.id,
          stagesSkipped,
        };
      }

      // Check for pre-stage YAML question. If the stage defines a question and
      // no answer has been recorded yet, ask it and pause execution.
      if (stage.question && this.questionService) {
        const existingResponse = stagesContext[stage.id];
        if (!existingResponse?.question_response) {
          // Build the question options from shorthand string array (if provided)
          const options = stage.question_meta?.options?.map((label) => ({ label })) ?? undefined;

          const agentQuestion: AgentQuestion = {
            id: crypto.randomUUID(),
            stageId: stage.id,
            question: stage.question,
            type: stage.question_meta?.type ?? 'free-text',
            options,
            status: 'pending',
            askedAt: new Date().toISOString(),
            source: 'yaml',
          };

          logger.info(
            `Stage "${stage.id}" requires user input before execution. ` +
              `Asking question for feature ${featureId}.`
          );

          await this.questionService.askQuestion(projectPath, featureId, [agentQuestion]);
          throw new PauseExecutionError(featureId, 'question');
        }

        logger.info(
          `Stage "${stage.id}" question already answered for feature ${featureId}. Proceeding.`
        );
      }

      // Compile stage prompt with current accumulated context
      const stageCompilationContext: StageCompilationContext = {
        ...compilationContext,
        previous_context: accumulatedContext,
        stages: stagesContext,
      };

      const compilationResult = compileStage(stage, stageCompilationContext);

      if (compilationResult.hasMissingVariables) {
        logger.warn(
          `Stage "${stage.id}" has missing template variables: ` +
            `${compilationResult.missingVariables.join(', ')}. Proceeding with empty values.`
        );
      }

      const compiledStage = compilationResult.stage;

      // Emit stage started event
      // Uses 'pipeline_step_started' for compatibility with existing frontend event handling
      this.eventBus.emitAutoModeEvent('pipeline_step_started', {
        featureId,
        stepId: stage.id,
        stepName: stage.name,
        stepIndex: i,
        totalSteps: totalStages,
        projectPath,
        pipelineName,
      });

      this.eventBus.emitAutoModeEvent('auto_mode_progress', {
        featureId,
        branchName: config.branchName,
        content: `Starting pipeline stage ${i + 1}/${totalStages}: ${stage.name}`,
        projectPath,
      });

      logger.info(
        `Executing stage ${i + 1}/${totalStages}: "${stage.id}" (${stage.name}) ` +
          `for feature ${featureId} [model=${compiledStage.model}, ` +
          `max_turns=${compiledStage.max_turns}, ` +
          `permission_mode=${compiledStage.permission_mode}]`
      );

      // Build the full stage prompt
      const stagePrompt = this.buildStagePrompt(
        compiledStage,
        feature,
        accumulatedContext,
        i,
        totalStages
      );

      try {
        // Execute the stage via the agent runner
        await this.runAgentFn(
          workDir,
          featureId,
          stagePrompt,
          abortController,
          projectPath,
          undefined, // no image paths for stage execution
          compiledStage.model,
          {
            projectPath,
            planningMode: 'skip', // Stages handle their own planning via prompt templates
            requirePlanApproval: false,
            previousContent: accumulatedContext,
            thinkingLevel: feature.thinkingLevel,
            reasoningEffort: feature.reasoningEffort,
            status: `pipeline_${stage.id}`,
            providerId: feature.providerId,
            branchName: config.branchName,
          }
        );
      } catch (error) {
        // PauseExecutionError signals an intentional pause (the agent asked
        // the user a question, or a YAML pre-stage question fired). It MUST
        // propagate up to ExecutionService unchanged so the catch block
        // there can transition the feature to `waiting_question`. We check
        // this BEFORE the abort-signal check below because the question
        // pause path used to also abort the controller, which made
        // `signal.aborted === true` look identical to a user-initiated stop.
        if (error instanceof PauseExecutionError) {
          throw error;
        }

        const errorMessage = (error as Error).message || 'Unknown error';

        // Check if the error was caused by an abort
        if (abortController.signal.aborted) {
          logger.info(
            `Stage "${stage.id}" aborted for feature ${featureId}`
          );
          return {
            success: false,
            stagesCompleted,
            totalStages,
            accumulatedContext,
            aborted: true,
            error: 'Pipeline execution aborted',
            failedStageId: stage.id,
            stagesSkipped,
          };
        }

        logger.error(
          `Stage "${stage.id}" failed for feature ${featureId}: ${errorMessage}`
        );

        return {
          success: false,
          stagesCompleted,
          totalStages,
          accumulatedContext,
          aborted: false,
          error: `Stage "${stage.id}" failed: ${errorMessage}`,
          failedStageId: stage.id,
          stagesSkipped,
        };
      }

      // Read updated context after stage execution
      // The agent writes its output to agent-output.md, which becomes the
      // accumulated context for subsequent stages
      try {
        accumulatedContext = (await secureFs.readFile(contextPath, 'utf-8')) as string;
      } catch {
        // Context may not have been written — agent output may be empty
        logger.warn(
          `Could not read agent output after stage "${stage.id}" for feature ${featureId}`
        );
      }

      stagesCompleted++;

      // Persist per-stage output snapshot
      await this.saveStageOutput(projectPath, featureId, stage.id, accumulatedContext);

      // Update and persist pipeline execution state
      const completedStageState: CompletedStageState = {
        stageId: stage.id,
        stageName: stage.name,
        stageIndex: i,
        completedAt: new Date().toISOString(),
        accumulatedContextSnapshot: accumulatedContext,
      };

      pipelineState = {
        ...pipelineState,
        completedStages: [...pipelineState.completedStages, completedStageState],
        lastCompletedStageIndex: i,
        updatedAt: new Date().toISOString(),
      };

      await this.savePipelineState(projectPath, featureId, pipelineState);

      // Emit stage complete event
      this.eventBus.emitAutoModeEvent('pipeline_step_complete', {
        featureId,
        stepId: stage.id,
        stepName: stage.name,
        stepIndex: i,
        totalSteps: totalStages,
        projectPath,
        pipelineName,
      });

      logger.info(
        `Stage "${stage.id}" completed (${stagesCompleted}/${totalStages}) ` +
          `for feature ${featureId}`
      );

      // Log approval gate status for stages that require approval
      // The caller (e.g., a higher-level orchestrator) is responsible for
      // actually pausing execution and waiting for approval
      if (stage.requires_approval && i < stages.length - 1) {
        logger.info(
          `Stage "${stage.id}" requires approval before proceeding to next stage. ` +
            `Approval handling is delegated to the caller.`
        );
      }
    }

    logger.info(
      `All ${totalStages} stage(s) completed successfully for feature ${featureId} ` +
        `in pipeline "${pipelineName}"`
    );

    // Clear pipeline state after successful completion
    // Stage output snapshots are preserved for auditing
    await this.clearPipelineState(projectPath, featureId);

    return {
      success: true,
      stagesCompleted,
      totalStages,
      accumulatedContext,
      aborted: false,
      stagesSkipped,
    };
  }

  /**
   * Build the prompt for a single stage execution.
   *
   * Wraps the compiled stage prompt (with Handlebars variables resolved)
   * with pipeline context, previous work output, and stage metadata.
   * The prompt format mirrors the PipelineOrchestrator's `buildPipelineStepPrompt`
   * to maintain consistency in agent output formatting.
   *
   * @param stage - The compiled stage with resolved prompt
   * @param feature - The feature being processed
   * @param previousContext - Accumulated output from prior stages
   * @param stageIndex - Zero-based index of the current stage
   * @param totalStages - Total number of stages in the pipeline
   * @returns The fully assembled prompt string for agent execution
   */
  private buildStagePrompt(
    stage: ResolvedStage,
    feature: Feature,
    previousContext: string,
    stageIndex: number,
    totalStages: number
  ): string {
    const parts: string[] = [];

    // Stage header with pipeline metadata
    parts.push(
      `## Pipeline Stage ${stageIndex + 1}/${totalStages}: ${stage.name}`
    );
    parts.push('');
    parts.push('This is an automated pipeline stage execution.');
    parts.push('');

    // Feature context
    if (feature.title || feature.description) {
      parts.push('### Feature Context');
      if (feature.title) {
        parts.push(`**Title:** ${feature.title}`);
      }
      if (feature.description) {
        parts.push(`**Description:** ${feature.description}`);
      }
      parts.push('');
    }

    // Previous stage output
    if (previousContext) {
      parts.push('### Previous Work');
      parts.push(previousContext);
      parts.push('');
    }

    // When the agent paused mid-stage for an AskUserQuestion call and was
    // resumed after the user answered, inject the prior Q&A so the agent has
    // the answer in its new conversation context. YAML pre-stage questions
    // (`source === 'yaml'`) are intentionally skipped here because their
    // answers are routed via `{{stages.<stageId>.question_response}}` in the
    // compiled stage prompt template.
    const qaBlock = formatAnsweredAgentQuestions(feature.questionState);
    if (qaBlock) {
      parts.push(qaBlock);
      parts.push('');
    }

    // Stage instructions (the compiled prompt with resolved template variables)
    parts.push('### Stage Instructions');
    parts.push(stage.prompt);
    parts.push('');

    // Task directive
    parts.push('### Task');
    parts.push('Complete the stage instructions above.');
    parts.push('');

    // Summary requirement — consistent with PipelineOrchestrator format
    parts.push(
      '**CRITICAL: After completing the instructions, you MUST output a summary using this EXACT format:**'
    );
    parts.push('');
    parts.push('<summary>');
    parts.push(`## Summary: ${stage.name}`);
    parts.push('');
    parts.push('### Changes Implemented');
    parts.push('- [List all changes made in this stage]');
    parts.push('');
    parts.push('### Files Modified');
    parts.push('- [List all files modified in this stage]');
    parts.push('');
    parts.push('### Outcome');
    parts.push('- [Describe the result of this stage]');
    parts.push('</summary>');
    parts.push('');
    parts.push(
      'The <summary> and </summary> tags MUST be on their own lines. This is REQUIRED.'
    );

    return parts.join('\n');
  }
}
