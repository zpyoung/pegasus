/**
 * QuestionService - Manages agent question lifecycle
 *
 * Responsibilities:
 * - Persist questions to feature JSON (source of truth)
 * - Emit question_required event via TypedEventBus
 * - Resolve answers: update feature JSON, set status to 'ready' when all answered
 * - Cancel pending questions on feature stop
 * - Recovery: questions are loaded from feature JSON on UI reconnect (no in-memory state needed)
 *
 * Key design decision (ADR-2):
 * - No long-lived Promises. The "pause" is implemented via PauseExecutionError.
 * - The "resume" happens when AutoLoopCoordinator detects the feature is 'ready'.
 * - StageRunner's existing pipeline-state.json checkpoint logic skips completed stages.
 */

import path from "path";
import {
  createLogger,
  atomicWriteJson,
  readJsonWithRecovery,
  DEFAULT_BACKUP_COUNT,
} from "@pegasus/utils";
import { getFeatureDir } from "@pegasus/platform";
import type {
  Feature,
  AgentQuestion,
  FeatureQuestionState,
  QuestionType,
} from "@pegasus/types";
import { PauseExecutionError } from "./pause-execution-error.js";
import type { TypedEventBus } from "./typed-event-bus.js";

const logger = createLogger("QuestionService");

/**
 * Tool name used by the Claude Agent SDK's built-in interactive question tool.
 * The SDK emits this as a `tool_use` block in the assistant message stream.
 */
export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

/**
 * Structural type for the SDK's `AskUserQuestionInput` shape. The SDK does not
 * re-export this from `sdk.d.ts`, so we duck-type the parsed tool input here.
 * The SDK guarantees `questions` is an array of 1-4 entries with `question`,
 * `header`, `options[]`, and `multiSelect` (per `sdk-tools.d.ts`).
 */
interface SdkAskUserQuestionEntry {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/**
 * A `tool_use` content block as it appears in an assistant message stream.
 * Only the fields we need are typed; everything else is opaque.
 */
interface ToolUseBlock {
  name?: string;
  input?: unknown;
}

/**
 * Inspect a `tool_use` content block. If it is the SDK's built-in
 * `AskUserQuestion` tool and a `QuestionService` was provided, persist the
 * question(s) to the feature, abort the in-flight stream, and throw
 * `PauseExecutionError` so the outer `executeFeature` handler can transition
 * the feature to `waiting_question`.
 *
 * No-ops (returns without throwing) when:
 * - The block is not an `AskUserQuestion` tool call
 * - No `questionService` is provided (the call is logged as a warning instead)
 * - The tool input is malformed (logged as a warning, no pause)
 *
 * The `stageId` field on the persisted question is derived from `featureStatus`
 * (`pipeline_<id>` → `<id>`), or defaults to `'agent'` for the legacy
 * non-pipeline flow. This lets `StageRunner.buildStagePrompt` and
 * `ExecutionService.buildFeatureDescription` route the answer back into the
 * appropriate prompt on resume.
 *
 * Exported (rather than embedded as a method on AgentExecutor) so it can be
 * unit-tested directly without setting up a full executor harness.
 */
export async function extractAndPauseForAskUserQuestion(params: {
  questionService: QuestionService | null;
  block: ToolUseBlock;
  featureId: string;
  projectPath: string;
  abortController: AbortController;
  featureStatus?: string;
}): Promise<void> {
  const {
    questionService,
    block,
    featureId,
    projectPath,
    abortController,
    featureStatus,
  } = params;

  if (block.name !== ASK_USER_QUESTION_TOOL_NAME) return;

  if (!questionService) {
    logger.warn(
      `[AskUserQuestion] Feature ${featureId} agent invoked AskUserQuestion but no ` +
        `QuestionService was provided — execution will continue without pausing ` +
        `and the agent will not receive a real answer.`,
    );
    return;
  }

  const input = block.input as
    | { questions?: SdkAskUserQuestionEntry[] }
    | undefined;

  if (
    !input ||
    !Array.isArray(input.questions) ||
    input.questions.length === 0
  ) {
    logger.warn(
      `[AskUserQuestion] Feature ${featureId} AskUserQuestion called with invalid ` +
        `input (expected { questions: [...] }). Skipping pause.`,
    );
    return;
  }

  const stageId = featureStatus?.startsWith("pipeline_")
    ? featureStatus.slice("pipeline_".length)
    : "agent";

  const askedAt = new Date().toISOString();
  const agentQuestions: AgentQuestion[] = input.questions.map((q) => {
    const hasOptions = Array.isArray(q.options) && q.options.length > 0;
    const type: QuestionType = hasOptions
      ? q.multiSelect
        ? "multi-select"
        : "single-select"
      : "free-text";
    return {
      id: crypto.randomUUID(),
      stageId,
      question: q.question,
      type,
      options: hasOptions
        ? q.options!.map((opt) => ({
            label: opt.label,
            description: opt.description,
          }))
        : undefined,
      header: q.header,
      status: "pending",
      askedAt,
      source: "agent",
    };
  });

  logger.info(
    `[AskUserQuestion] Feature ${featureId} agent asked ${agentQuestions.length} ` +
      `question(s) (stageId="${stageId}"). Pausing execution.`,
  );

  await questionService.askQuestion(projectPath, featureId, agentQuestions);

  // NOTE: We intentionally do NOT call abortController.abort() here.
  //
  // Throwing PauseExecutionError is sufficient to terminate the SDK stream:
  // the for-await-of loop in agent-executor will call iterator.return() on
  // the provider generator during cleanup, which closes the stream cleanly.
  //
  // If we ALSO abort the controller, downstream code that catches errors
  // from runAgentFn — specifically StageRunner.run() and
  // PipelineOrchestrator.resumeFromStep() — sees `signal.aborted === true`
  // BEFORE checking the error type, and conflates "agent asked a question"
  // with "user pressed Stop". They swallow PauseExecutionError as a
  // generic "aborted" return value, the feature ends up in `interrupted`
  // status (and is then surfaced in the Backlog column by the auto-mode
  // eligibility filter), and the user can never answer the question.
  //
  // The `abortController` parameter is kept on the signature so callers
  // don't need to know about this internal change, but it is intentionally
  // unused. Marked with `void` to satisfy strict no-unused-vars.

  void abortController;

  throw new PauseExecutionError(featureId, "question");
}

/**
 * Format the agent-asked questions on a feature into a markdown Q&A block
 * suitable for injection into a resume prompt.
 *
 * Only questions with `source === 'agent'` and an `answer` are included.
 * YAML pre-stage questions (`source === 'yaml'`) are intentionally skipped
 * because StageRunner already routes their answers via the
 * `{{stages.<stageId>.question_response}}` template variable.
 *
 * Returns an empty string when there are no agent-asked answered questions,
 * so callers can append unconditionally without an extra null check.
 */
export function formatAnsweredAgentQuestions(
  questionState: FeatureQuestionState | undefined,
): string {
  if (!questionState) return "";
  const answered = questionState.questions.filter(
    (q) =>
      q.source === "agent" && q.status === "answered" && q.answer !== undefined,
  );
  if (answered.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Previous User Q&A");
  lines.push("");
  lines.push(
    "You previously asked the user the following question(s) via AskUserQuestion " +
      "and they responded. Continue your work taking these answer(s) into account.",
  );
  lines.push("");
  for (const q of answered) {
    lines.push(`**Q:** ${q.question}`);
    lines.push(`**A:** ${q.answer}`);
    lines.push("");
  }
  return lines.join("\n");
}

export class QuestionService {
  constructor(private readonly eventBus: TypedEventBus) {}

  /**
   * Persist questions to feature JSON and emit question_required event.
   *
   * Does NOT block (no Promise awaited). The calling code (StageRunner or AgentExecutor)
   * should throw PauseExecutionError immediately after calling this.
   *
   * @param projectPath - Absolute path to the project root
   * @param featureId - The feature ID
   * @param questions - Questions to ask
   */
  async askQuestion(
    projectPath: string,
    featureId: string,
    questions: AgentQuestion[],
  ): Promise<void> {
    logger.info(
      `Persisting ${questions.length} question(s) for feature ${featureId}`,
    );

    const questionState: FeatureQuestionState = {
      questions,
      status: "pending",
    };

    await this.writeQuestionState(projectPath, featureId, questionState);

    // Emit event so UI can react immediately (within NFR-001: 500ms)
    const feature = await this.loadFeature(projectPath, featureId);
    this.eventBus.emitAutoModeEvent("question_required", {
      featureId,
      projectPath,
      branchName: feature?.branchName ?? undefined,
      questions,
    });

    logger.info(`Question event emitted for feature ${featureId}`);
  }

  /**
   * Resolve an answer for a specific question.
   *
   * Updates the question's answer in feature JSON. When all questions are answered,
   * sets feature status to 'ready' so the AutoLoopCoordinator re-queues the feature.
   *
   * @param projectPath - Absolute path to the project root
   * @param featureId - The feature ID
   * @param questionId - The question ID to answer
   * @param answer - The user's answer
   * @returns Whether all questions are now answered
   */
  async resolveAnswer(
    projectPath: string,
    featureId: string,
    questionId: string,
    answer: string,
  ): Promise<{ allAnswered: boolean }> {
    logger.info(
      `Resolving answer for question ${questionId} on feature ${featureId}`,
    );

    const feature = await this.loadFeature(projectPath, featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    const questionState = feature.questionState;
    if (!questionState) {
      throw new Error(`Feature ${featureId} has no pending questions`);
    }

    // Find and update the question
    const question = questionState.questions.find((q) => q.id === questionId);
    if (!question) {
      throw new Error(
        `Question ${questionId} not found for feature ${featureId}`,
      );
    }

    question.answer = answer;
    question.status = "answered";
    question.answeredAt = new Date().toISOString();

    // Check if all questions are answered
    const allAnswered = questionState.questions.every(
      (q) => q.status === "answered",
    );

    if (allAnswered) {
      questionState.status = "answered";
    }

    // Persist updated question state
    await this.writeQuestionState(projectPath, featureId, questionState);

    // Emit answer event for observability
    this.eventBus.emitAutoModeEvent("question_answered", {
      featureId,
      projectPath,
      questionId,
      allAnswered,
    });

    if (allAnswered) {
      // Set feature status to 'ready' so AutoLoopCoordinator re-queues it.
      // We update the feature JSON directly to ensure the status change is
      // persisted before emitting the status event.
      await this.setFeatureStatusToReady(projectPath, featureId, feature);
      logger.info(
        `All questions answered for feature ${featureId} — set to ready`,
      );
    }

    return { allAnswered };
  }

  /**
   * Cancel pending questions for a feature (called on feature stop).
   *
   * Clears questionState from feature JSON so it doesn't appear in UI on next load.
   *
   * @param projectPath - Absolute path to the project root
   * @param featureId - The feature ID
   */
  async cancelQuestions(projectPath: string, featureId: string): Promise<void> {
    logger.info(`Cancelling questions for feature ${featureId}`);

    const feature = await this.loadFeature(projectPath, featureId);
    if (!feature?.questionState) {
      return; // Nothing to cancel
    }

    const cancelledState: FeatureQuestionState = {
      ...feature.questionState,
      status: "cancelled",
    };

    await this.writeQuestionState(projectPath, featureId, cancelledState);
    logger.info(`Questions cancelled for feature ${featureId}`);
  }

  /**
   * Get pending questions for a feature (for UI polling / recovery).
   *
   * @param projectPath - Absolute path to the project root
   * @param featureId - The feature ID
   * @returns Pending questions, or null if no questions are pending
   */
  async getPendingQuestions(
    projectPath: string,
    featureId: string,
  ): Promise<AgentQuestion[] | null> {
    const feature = await this.loadFeature(projectPath, featureId);
    const state = feature?.questionState;

    if (!state || state.status !== "pending") {
      return null;
    }

    return state.questions.filter((q) => q.status === "pending");
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private async loadFeature(
    projectPath: string,
    featureId: string,
  ): Promise<Feature | null> {
    const featurePath = path.join(
      getFeatureDir(projectPath, featureId),
      "feature.json",
    );
    try {
      const result = await readJsonWithRecovery<Feature | null>(
        featurePath,
        null,
        {
          maxBackups: DEFAULT_BACKUP_COUNT,
          autoRestore: true,
        },
      );
      return result.data;
    } catch {
      return null;
    }
  }

  private async writeQuestionState(
    projectPath: string,
    featureId: string,
    questionState: FeatureQuestionState,
  ): Promise<void> {
    const featurePath = path.join(
      getFeatureDir(projectPath, featureId),
      "feature.json",
    );

    const result = await readJsonWithRecovery<Feature | null>(
      featurePath,
      null,
      {
        maxBackups: DEFAULT_BACKUP_COUNT,
        autoRestore: true,
      },
    );

    const feature = result.data;
    if (!feature) {
      logger.warn(
        `Could not load feature ${featureId} for question state update`,
      );
      return;
    }

    feature.questionState = questionState;
    feature.updatedAt = new Date().toISOString();

    await atomicWriteJson(featurePath, feature, {
      backupCount: DEFAULT_BACKUP_COUNT,
    });
  }

  private async setFeatureStatusToReady(
    projectPath: string,
    featureId: string,
    feature: Feature,
  ): Promise<void> {
    const featurePath = path.join(
      getFeatureDir(projectPath, featureId),
      "feature.json",
    );

    feature.status = "ready";
    feature.updatedAt = new Date().toISOString();

    await atomicWriteJson(featurePath, feature, {
      backupCount: DEFAULT_BACKUP_COUNT,
    });

    // Emit status changed event so the UI updates immediately
    this.eventBus.emitAutoModeEvent("feature_status_changed", {
      featureId,
      projectPath,
      status: "ready",
    });
  }
}
