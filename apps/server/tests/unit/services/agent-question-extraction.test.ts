/**
 * Tests for the agent-initiated question extraction path: when the Claude
 * Agent SDK emits an `AskUserQuestion` tool_use block in the assistant
 * message stream, `extractAndPauseForAskUserQuestion` should persist the
 * question(s) via QuestionService, abort the provider stream, and throw
 * PauseExecutionError so the outer ExecutionService catch handler can
 * transition the feature to `waiting_question`.
 *
 * Also covers `formatAnsweredAgentQuestions` — the helper that injects
 * answered Q&A back into the resume prompt so the agent has the answer in
 * its new conversation context.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentQuestion, FeatureQuestionState } from "@pegasus/types";

// ============================================================================
// Mocks (must be declared before importing the SUT)
// ============================================================================

vi.mock("@pegasus/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  atomicWriteJson: vi.fn().mockResolvedValue(undefined),
  readJsonWithRecovery: vi.fn().mockResolvedValue({ data: null }),
  DEFAULT_BACKUP_COUNT: 3,
}));

vi.mock("@pegasus/platform", () => ({
  getFeatureDir: (projectPath: string, featureId: string) =>
    `${projectPath}/.pegasus/features/${featureId}`,
}));

// Imports after mocks
import {
  ASK_USER_QUESTION_TOOL_NAME,
  extractAndPauseForAskUserQuestion,
  formatAnsweredAgentQuestions,
  QuestionService,
} from "@/services/question-service.js";
import { PauseExecutionError } from "@/services/pause-execution-error.js";

// ============================================================================
// Fixtures
// ============================================================================

const PROJECT_PATH = "/test/project";
const FEATURE_ID = "feat-abc";

function makeMockQuestionService(): QuestionService {
  return {
    askQuestion: vi.fn().mockResolvedValue(undefined),
    resolveAnswer: vi.fn(),
    cancelQuestions: vi.fn(),
    getPendingQuestions: vi.fn(),
  } as unknown as QuestionService;
}

function makeAskUserQuestionBlock(overrides?: {
  name?: string;
  input?: unknown;
}) {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    input: {
      questions: [
        {
          question: "Which library should we use for date formatting?",
          header: "Library",
          options: [
            { label: "date-fns", description: "Modular, tree-shakeable" },
            { label: "dayjs", description: "Tiny, immutable" },
          ],
          multiSelect: false,
        },
      ],
    },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("extractAndPauseForAskUserQuestion", () => {
  let questionService: QuestionService;
  let abortController: AbortController;

  beforeEach(() => {
    vi.clearAllMocks();
    questionService = makeMockQuestionService();
    abortController = new AbortController();
  });

  describe("non-AskUserQuestion blocks", () => {
    it("is a no-op for tool_use blocks with a different name", async () => {
      const block = { name: "Bash", input: { command: "ls" } };

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).resolves.toBeUndefined();

      expect(questionService.askQuestion).not.toHaveBeenCalled();
      expect(abortController.signal.aborted).toBe(false);
    });

    it("is a no-op for tool_use blocks with no name", async () => {
      const block = { input: { questions: [] } };

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).resolves.toBeUndefined();

      expect(questionService.askQuestion).not.toHaveBeenCalled();
    });
  });

  describe("AskUserQuestion blocks", () => {
    it("throws PauseExecutionError for an AskUserQuestion tool call", async () => {
      const block = makeAskUserQuestionBlock();

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).rejects.toThrow(PauseExecutionError);
    });

    it('throws PauseExecutionError carrying the featureId and reason="question"', async () => {
      const block = makeAskUserQuestionBlock();
      let thrown: unknown;

      try {
        await extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(PauseExecutionError);
      const pauseError = thrown as PauseExecutionError;
      expect(pauseError.featureId).toBe(FEATURE_ID);
      expect(pauseError.reason).toBe("question");
    });

    it("persists the question via questionService.askQuestion before throwing", async () => {
      const block = makeAskUserQuestionBlock();

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).rejects.toThrow(PauseExecutionError);

      expect(questionService.askQuestion).toHaveBeenCalledTimes(1);
      const [actualProjectPath, actualFeatureId, actualQuestions] = vi.mocked(
        questionService.askQuestion,
      ).mock.calls[0];
      expect(actualProjectPath).toBe(PROJECT_PATH);
      expect(actualFeatureId).toBe(FEATURE_ID);
      expect(Array.isArray(actualQuestions)).toBe(true);
      expect(actualQuestions).toHaveLength(1);
    });

    it("does NOT abort the abort controller (regression guard)", async () => {
      // Regression guard for the bug fixed in the same commit as this assertion:
      //
      // A previous version of the extractor called `abortController.abort()` as
      // belt-and-suspenders before throwing PauseExecutionError. That caused
      // StageRunner.run() and PipelineOrchestrator.resumeFromStep() to see
      // `signal.aborted === true` in their catch blocks BEFORE checking the
      // error type, swallowing the PauseExecutionError as a generic "aborted"
      // return. The feature ended up in `interrupted` (and was then surfaced
      // in the Backlog column by the auto-mode eligibility filter), and the
      // user could never answer the question.
      //
      // The throw alone is sufficient to tear down the SDK stream: the
      // for-await-of loop in agent-executor calls iterator.return() on the
      // provider generator during cleanup, which closes the stream cleanly.
      const block = makeAskUserQuestionBlock();

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).rejects.toThrow(PauseExecutionError);

      expect(abortController.signal.aborted).toBe(false);
    });

    it("maps multi-question SDK input to multiple AgentQuestion entries", async () => {
      const block = {
        name: ASK_USER_QUESTION_TOOL_NAME,
        input: {
          questions: [
            {
              question: "Auth method?",
              header: "Auth",
              options: [
                { label: "OAuth", description: "Third-party" },
                { label: "JWT", description: "Self-issued" },
              ],
              multiSelect: false,
            },
            {
              question: "Which features do you want to enable?",
              header: "Features",
              options: [
                { label: "Email", description: "SMTP" },
                { label: "SMS", description: "Twilio" },
                { label: "Push", description: "FCM" },
              ],
              multiSelect: true,
            },
          ],
        },
      };

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).rejects.toThrow(PauseExecutionError);

      const [, , persistedQuestions] = vi.mocked(questionService.askQuestion)
        .mock.calls[0];
      expect(persistedQuestions).toHaveLength(2);
      expect(persistedQuestions[0]).toMatchObject({
        question: "Auth method?",
        header: "Auth",
        type: "single-select",
        source: "agent",
        status: "pending",
      });
      expect(persistedQuestions[0].options).toHaveLength(2);
      expect(persistedQuestions[1]).toMatchObject({
        question: "Which features do you want to enable?",
        header: "Features",
        type: "multi-select",
        source: "agent",
        status: "pending",
      });
      expect(persistedQuestions[1].options).toHaveLength(3);
    });

    it('marks every persisted question with source="agent"', async () => {
      const block = makeAskUserQuestionBlock();

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).rejects.toThrow(PauseExecutionError);

      const [, , persistedQuestions] = vi.mocked(questionService.askQuestion)
        .mock.calls[0];
      for (const q of persistedQuestions) {
        expect(q.source).toBe("agent");
      }
    });

    it("derives stageId from featureStatus when status starts with pipeline_", async () => {
      const block = makeAskUserQuestionBlock();

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
          featureStatus: "pipeline_implement",
        }),
      ).rejects.toThrow(PauseExecutionError);

      const [, , persistedQuestions] = vi.mocked(questionService.askQuestion)
        .mock.calls[0];
      expect(persistedQuestions[0].stageId).toBe("implement");
    });

    it('defaults stageId to "agent" when featureStatus is not a pipeline status', async () => {
      const block = makeAskUserQuestionBlock();

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
          featureStatus: "in_progress",
        }),
      ).rejects.toThrow(PauseExecutionError);

      const [, , persistedQuestions] = vi.mocked(questionService.askQuestion)
        .mock.calls[0];
      expect(persistedQuestions[0].stageId).toBe("agent");
    });

    it('defaults stageId to "agent" when featureStatus is undefined (legacy flow)', async () => {
      const block = makeAskUserQuestionBlock();

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).rejects.toThrow(PauseExecutionError);

      const [, , persistedQuestions] = vi.mocked(questionService.askQuestion)
        .mock.calls[0];
      expect(persistedQuestions[0].stageId).toBe("agent");
    });

    it("classifies a question with no options as free-text", async () => {
      const block = {
        name: ASK_USER_QUESTION_TOOL_NAME,
        input: {
          questions: [
            {
              question: "Describe the desired behavior in your own words.",
              header: "Describe",
            },
          ],
        },
      };

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).rejects.toThrow(PauseExecutionError);

      const [, , persistedQuestions] = vi.mocked(questionService.askQuestion)
        .mock.calls[0];
      expect(persistedQuestions[0].type).toBe("free-text");
      expect(persistedQuestions[0].options).toBeUndefined();
    });
  });

  describe("graceful no-op paths", () => {
    it("warns and does NOT throw when questionService is null", async () => {
      const block = makeAskUserQuestionBlock();

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService: null,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).resolves.toBeUndefined();

      expect(abortController.signal.aborted).toBe(false);
    });

    it("warns and does NOT throw when input is missing", async () => {
      const block = { name: ASK_USER_QUESTION_TOOL_NAME };

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).resolves.toBeUndefined();

      expect(questionService.askQuestion).not.toHaveBeenCalled();
      expect(abortController.signal.aborted).toBe(false);
    });

    it("warns and does NOT throw when questions array is empty", async () => {
      const block = {
        name: ASK_USER_QUESTION_TOOL_NAME,
        input: { questions: [] },
      };

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).resolves.toBeUndefined();

      expect(questionService.askQuestion).not.toHaveBeenCalled();
    });

    it("warns and does NOT throw when questions field is not an array", async () => {
      const block = {
        name: ASK_USER_QUESTION_TOOL_NAME,
        input: { questions: "not an array" },
      };

      await expect(
        extractAndPauseForAskUserQuestion({
          questionService,
          block,
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          abortController,
        }),
      ).resolves.toBeUndefined();

      expect(questionService.askQuestion).not.toHaveBeenCalled();
    });
  });
});

describe("formatAnsweredAgentQuestions", () => {
  function makeAnsweredQuestion(
    overrides?: Partial<AgentQuestion>,
  ): AgentQuestion {
    return {
      id: "q-1",
      stageId: "agent",
      question: "Which library?",
      type: "single-select",
      status: "answered",
      askedAt: "2024-01-01T00:00:00Z",
      answer: "date-fns",
      answeredAt: "2024-01-01T00:01:00Z",
      source: "agent",
      ...overrides,
    };
  }

  it("returns empty string when questionState is undefined", () => {
    expect(formatAnsweredAgentQuestions(undefined)).toBe("");
  });

  it("returns empty string when questionState has no questions", () => {
    const state: FeatureQuestionState = { questions: [], status: "pending" };
    expect(formatAnsweredAgentQuestions(state)).toBe("");
  });

  it("returns empty string when only YAML pre-stage questions are answered", () => {
    const state: FeatureQuestionState = {
      questions: [makeAnsweredQuestion({ source: "yaml" })],
      status: "answered",
    };
    expect(formatAnsweredAgentQuestions(state)).toBe("");
  });

  it("returns empty string when agent questions are still pending", () => {
    const state: FeatureQuestionState = {
      questions: [
        makeAnsweredQuestion({
          status: "pending",
          answer: undefined,
          answeredAt: undefined,
        }),
      ],
      status: "pending",
    };
    expect(formatAnsweredAgentQuestions(state)).toBe("");
  });

  it("formats a single answered agent question as a Q&A block", () => {
    const state: FeatureQuestionState = {
      questions: [makeAnsweredQuestion()],
      status: "answered",
    };
    const result = formatAnsweredAgentQuestions(state);

    expect(result).toContain("## Previous User Q&A");
    expect(result).toContain("**Q:** Which library?");
    expect(result).toContain("**A:** date-fns");
  });

  it("formats multiple answered agent questions in order", () => {
    const state: FeatureQuestionState = {
      questions: [
        makeAnsweredQuestion({ id: "q-1", question: "Q1?", answer: "A1" }),
        makeAnsweredQuestion({ id: "q-2", question: "Q2?", answer: "A2" }),
      ],
      status: "answered",
    };
    const result = formatAnsweredAgentQuestions(state);

    expect(result).toContain("**Q:** Q1?");
    expect(result).toContain("**A:** A1");
    expect(result).toContain("**Q:** Q2?");
    expect(result).toContain("**A:** A2");
    expect(result.indexOf("Q1?")).toBeLessThan(result.indexOf("Q2?"));
  });

  it("skips YAML questions even when mixed with answered agent questions", () => {
    const state: FeatureQuestionState = {
      questions: [
        makeAnsweredQuestion({
          id: "q-yaml",
          source: "yaml",
          question: "YAML pre-stage Q?",
          answer: "YAML A",
        }),
        makeAnsweredQuestion({
          id: "q-agent",
          source: "agent",
          question: "Agent Q?",
          answer: "Agent A",
        }),
      ],
      status: "answered",
    };
    const result = formatAnsweredAgentQuestions(state);

    expect(result).not.toContain("YAML pre-stage Q?");
    expect(result).not.toContain("YAML A");
    expect(result).toContain("Agent Q?");
    expect(result).toContain("Agent A");
  });
});
