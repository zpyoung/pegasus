/**
 * Tests for AutoModeServiceFacade.resolveQuestion auto-resume behavior.
 *
 * The plan-approval flow has always directly invoked executeFeature when a
 * user approves (so the feature resumes regardless of whether auto-mode is
 * running). The question-answer flow used to just set the feature to `ready`
 * and rely on the auto-loop to pick it up — but if the user manually started
 * the feature with auto-mode off, the `ready` feature would sit in the
 * Backlog column forever waiting for an auto-loop that doesn't exist.
 *
 * This file pins down the corrected behavior: when allAnswered=true,
 * resolveQuestion must call executeFeature directly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock heavy dependencies that the facade pulls in transitively
vi.mock("../../../../src/services/agent-executor.js");
vi.mock("../../../../src/lib/settings-helpers.js");
vi.mock("../../../../src/providers/provider-factory.js");
vi.mock("../../../../src/lib/sdk-options.js");
vi.mock("@pegasus/model-resolver", () => ({
  resolveModelString: vi.fn((model, fallback) => model || fallback),
  DEFAULT_MODELS: { claude: "claude-3-5-sonnet" },
}));

import { AutoModeServiceFacade } from "../../../../src/services/auto-mode/facade.js";

const PROJECT_PATH = "/test/project";
const FEATURE_ID = "feat-resolve-question";
const QUESTION_ID = "q-1";

interface MockSettingsService {
  getGlobalSettings: ReturnType<typeof vi.fn>;
  getCredentials: ReturnType<typeof vi.fn>;
  getProjectSettings: ReturnType<typeof vi.fn>;
}

describe("AutoModeServiceFacade.resolveQuestion", () => {
  let facade: AutoModeServiceFacade;
  let mockSettingsService: MockSettingsService;
  let resolveAnswerSpy: ReturnType<typeof vi.fn>;
  let executeFeatureSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSettingsService = {
      getGlobalSettings: vi.fn().mockResolvedValue({}),
      getCredentials: vi.fn().mockResolvedValue({}),
      getProjectSettings: vi.fn().mockResolvedValue({}),
    };

    facade = AutoModeServiceFacade.create(PROJECT_PATH, {
      events: {
        on: vi.fn(),
        emit: vi.fn(),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
      } as any,
      settingsService: mockSettingsService as any,
      sharedServices: {
        eventBus: { emitAutoModeEvent: vi.fn() } as any,
        worktreeResolver: {
          getCurrentBranch: vi.fn().mockResolvedValue("main"),
        } as any,
        concurrencyManager: {
          isRunning: vi.fn().mockReturnValue(false),
          getRunningFeature: vi.fn().mockReturnValue(null),
        } as any,
      } as any,
    });

    // Stub out the underlying questionService.resolveAnswer (whose real
    // implementation reads/writes feature.json and isn't relevant to this test).
    resolveAnswerSpy = vi.fn();
    (facade as any).questionService = {
      resolveAnswer: resolveAnswerSpy,
    };

    // Stub executeFeature so we can assert on its calls without spinning up
    // the full execution pipeline. We use spyOn so the rest of the facade
    // remains intact.
    executeFeatureSpy = vi
      .spyOn(facade, "executeFeature")
      .mockResolvedValue(undefined);
  });

  it("persists the answer via questionService.resolveAnswer", async () => {
    resolveAnswerSpy.mockResolvedValue({ allAnswered: false });

    await facade.resolveQuestion(FEATURE_ID, QUESTION_ID, "my answer");

    expect(resolveAnswerSpy).toHaveBeenCalledTimes(1);
    expect(resolveAnswerSpy).toHaveBeenCalledWith(
      PROJECT_PATH,
      FEATURE_ID,
      QUESTION_ID,
      "my answer",
    );
  });

  it("does NOT auto-resume when more questions are still pending", async () => {
    resolveAnswerSpy.mockResolvedValue({ allAnswered: false });

    const result = await facade.resolveQuestion(
      FEATURE_ID,
      QUESTION_ID,
      "partial answer",
    );

    expect(result.allAnswered).toBe(false);
    expect(executeFeatureSpy).not.toHaveBeenCalled();
  });

  it("directly invokes executeFeature when the last question is answered", async () => {
    resolveAnswerSpy.mockResolvedValue({ allAnswered: true });

    await facade.resolveQuestion(FEATURE_ID, QUESTION_ID, "final answer");

    expect(executeFeatureSpy).toHaveBeenCalledTimes(1);
    // Match resolvePlanApproval's signature: useWorktrees=true, isAutoMode=false
    // (this is a user-triggered resume, not an auto-loop dispatch).
    expect(executeFeatureSpy).toHaveBeenCalledWith(FEATURE_ID, true, false);
  });

  it("returns the result from questionService unchanged", async () => {
    resolveAnswerSpy.mockResolvedValue({ allAnswered: true });

    const result = await facade.resolveQuestion(
      FEATURE_ID,
      QUESTION_ID,
      "final answer",
    );

    expect(result).toEqual({ allAnswered: true });
  });

  it("does not await executeFeature so the HTTP response returns immediately", async () => {
    // Make executeFeature hang forever — if resolveQuestion awaited it, this
    // test would time out. Vitest's default test timeout (5s) is well below
    // any reasonable production HTTP timeout.
    let resolveExecute: () => void = () => {};
    executeFeatureSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveExecute = resolve;
        }),
    );
    resolveAnswerSpy.mockResolvedValue({ allAnswered: true });

    const result = await facade.resolveQuestion(
      FEATURE_ID,
      QUESTION_ID,
      "final answer",
    );

    expect(result.allAnswered).toBe(true);
    expect(executeFeatureSpy).toHaveBeenCalledTimes(1);

    // Clean up the dangling promise so vitest doesn't warn about it
    resolveExecute();
  });

  it("does not rethrow when auto-resume fails (the answer was already saved)", async () => {
    executeFeatureSpy.mockRejectedValue(new Error("execution boom"));
    resolveAnswerSpy.mockResolvedValue({ allAnswered: true });

    // Must not throw — the answer was successfully persisted before the
    // resume attempt, and a resume failure should not look like an
    // answer-submission failure to the client. Errors get logged + emitted
    // via auto_mode_error events from executeFeature itself.
    await expect(
      facade.resolveQuestion(FEATURE_ID, QUESTION_ID, "final answer"),
    ).resolves.toEqual({ allAnswered: true });
  });
});
