/**
 * Unit tests for StageRunner
 *
 * Tests YAML pipeline stage execution with focus on:
 * - Sequential stage execution with context accumulation
 * - Per-stage output persistence (stage-outputs/{stageId}.md)
 * - Pipeline execution state persistence (pipeline-state.json)
 * - Resumption from persisted state (skip completed stages)
 * - Abort/cancellation handling
 * - Error handling and failure recovery
 * - Legacy fallback (agent-output.md) when no pipeline state exists
 * - Pipeline state clearing after successful completion
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  Feature,
  ResolvedStage,
  PipelineExecutionState,
} from "@pegasus/types";

// ============================================================================
// Mocks
// ============================================================================

vi.mock("@pegasus/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@pegasus/platform", () => ({
  getFeatureDir: (projectPath: string, featureId: string) =>
    `${projectPath}/.pegasus/features/${featureId}`,
  getPipelineStatePath: (projectPath: string, featureId: string) =>
    `${projectPath}/.pegasus/features/${featureId}/pipeline-state.json`,
  getStageOutputsDir: (projectPath: string, featureId: string) =>
    `${projectPath}/.pegasus/features/${featureId}/stage-outputs`,
  getStageOutputPath: (
    projectPath: string,
    featureId: string,
    stageId: string,
  ) =>
    `${projectPath}/.pegasus/features/${featureId}/stage-outputs/${stageId}.md`,
}));

vi.mock("@/lib/secure-fs.js", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/pipeline-compiler.js", () => ({
  compileStage: vi.fn((stage: ResolvedStage) => ({
    stage,
    missingVariables: [],
    hasMissingVariables: false,
  })),
}));

// Import after mocks are set up
import * as secureFs from "@/lib/secure-fs.js";
import { compileStage } from "@/services/pipeline-compiler.js";
import { StageRunner } from "@/services/stage-runner.js";
import type {
  StageRunnerConfig,
  StageRunAgentFn,
} from "@/services/stage-runner.js";

// ============================================================================
// Test Fixtures
// ============================================================================

const PROJECT_PATH = "/test/project";
const FEATURE_ID = "feat-123";
const PIPELINE_NAME = "Feature";

function createMockFeature(overrides?: Partial<Feature>): Feature {
  return {
    id: FEATURE_ID,
    title: "Test Feature",
    description: "A test feature",
    category: "feature",
    status: "in_progress",
    ...overrides,
  };
}

function createMockStage(id: string, name: string): ResolvedStage {
  return {
    id,
    name,
    prompt: `Execute ${name}`,
    model: "sonnet",
    permission_mode: "plan",
    max_turns: 10,
    requires_approval: false,
  };
}

function createMockEventBus() {
  return {
    emitAutoModeEvent: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as import("@/services/typed-event-bus.js").TypedEventBus;
}

function createMockConfig(
  overrides?: Partial<StageRunnerConfig>,
): StageRunnerConfig {
  return {
    projectPath: PROJECT_PATH,
    featureId: FEATURE_ID,
    feature: createMockFeature(),
    stages: [
      createMockStage("plan", "Planning"),
      createMockStage("implement", "Implementation"),
      createMockStage("test", "Testing"),
    ],
    workDir: "/test/workdir",
    worktreePath: null,
    branchName: "feat/test",
    abortController: new AbortController(),
    pipelineDefaults: {
      model: "sonnet",
      max_turns: 10,
      permission_mode: "plan",
    },
    pipelineName: PIPELINE_NAME,
    compilationContext: {
      task: { description: "Test task" },
      project: { language: "TypeScript" },
    },
    ...overrides,
  };
}

function createPipelineState(
  completedStageIds: string[],
  stages: ResolvedStage[],
  pipelineName = PIPELINE_NAME,
  accumulatedContexts?: string[],
): PipelineExecutionState {
  return {
    version: 1,
    pipelineName,
    totalStages: stages.length,
    completedStages: completedStageIds.map((stageId, idx) => {
      const stage = stages.find((s) => s.id === stageId)!;
      const stageIndex = stages.indexOf(stage);
      return {
        stageId: stage.id,
        stageName: stage.name,
        stageIndex,
        completedAt: new Date().toISOString(),
        accumulatedContextSnapshot:
          accumulatedContexts?.[idx] ?? `Output after ${stageId}`,
      };
    }),
    lastCompletedStageIndex: (() => {
      const lastId = completedStageIds[completedStageIds.length - 1];
      return stages.findIndex((s) => s.id === lastId);
    })(),
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("StageRunner", () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let runAgentFn: ReturnType<typeof vi.fn<StageRunAgentFn>>;
  let runner: StageRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = createMockEventBus();
    runAgentFn = vi.fn<StageRunAgentFn>().mockResolvedValue(undefined);
    runner = new StageRunner(eventBus, runAgentFn);
  });

  // ==========================================================================
  // Fresh Execution (No Persisted State)
  // ==========================================================================

  describe("fresh execution", () => {
    it("should execute all stages sequentially", async () => {
      const config = createMockConfig();

      const result = await runner.run(config);

      expect(result.success).toBe(true);
      expect(result.stagesCompleted).toBe(3);
      expect(result.totalStages).toBe(3);
      expect(result.stagesSkipped).toBe(0);
      expect(result.aborted).toBe(false);
      expect(runAgentFn).toHaveBeenCalledTimes(3);
    });

    it("should call runAgentFn with correct parameters for each stage", async () => {
      const config = createMockConfig();

      await runner.run(config);

      // First stage
      expect(runAgentFn).toHaveBeenNthCalledWith(
        1,
        "/test/workdir",
        FEATURE_ID,
        expect.stringContaining("Planning"),
        config.abortController,
        PROJECT_PATH,
        undefined,
        "sonnet",
        expect.objectContaining({
          projectPath: PROJECT_PATH,
          status: "pipeline_plan",
          branchName: "feat/test",
        }),
      );

      // Second stage
      expect(runAgentFn).toHaveBeenNthCalledWith(
        2,
        "/test/workdir",
        FEATURE_ID,
        expect.stringContaining("Implementation"),
        config.abortController,
        PROJECT_PATH,
        undefined,
        "sonnet",
        expect.objectContaining({
          status: "pipeline_implement",
        }),
      );
    });

    it("should emit pipeline_step_started and pipeline_step_complete events for each stage", async () => {
      const config = createMockConfig();

      await runner.run(config);

      // 3 stages × 2 events (started + progress) + 3 stages × 1 event (complete) = 9 calls
      // But we also have auto_mode_progress calls
      const emitCalls = (eventBus.emitAutoModeEvent as ReturnType<typeof vi.fn>)
        .mock.calls;

      // Check that pipeline_step_started was emitted for each stage
      const startedCalls = emitCalls.filter(
        ([event]: [string]) => event === "pipeline_step_started",
      );
      expect(startedCalls).toHaveLength(3);
      expect(startedCalls[0][1]).toMatchObject({
        featureId: FEATURE_ID,
        stepId: "plan",
        stepIndex: 0,
        totalSteps: 3,
      });
      expect(startedCalls[1][1]).toMatchObject({
        stepId: "implement",
        stepIndex: 1,
      });
      expect(startedCalls[2][1]).toMatchObject({
        stepId: "test",
        stepIndex: 2,
      });

      // Check that pipeline_step_complete was emitted for each stage
      const completeCalls = emitCalls.filter(
        ([event]: [string]) => event === "pipeline_step_complete",
      );
      expect(completeCalls).toHaveLength(3);
    });

    it("should load legacy agent-output.md context when no pipeline state exists", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.reject(new Error("ENOENT"));
        }
        if (filePath.endsWith("agent-output.md")) {
          return Promise.resolve("Previous legacy context");
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig();
      await runner.run(config);

      // The first stage should have the legacy context
      expect(runAgentFn).toHaveBeenCalledTimes(3);
    });
  });

  // ==========================================================================
  // Per-Stage Output Persistence
  // ==========================================================================

  describe("per-stage output persistence", () => {
    it("should save stage output after each stage completes", async () => {
      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
        mkdir: ReturnType<typeof vi.fn>;
      };

      // Simulate agent writing output after each stage
      let callCount = 0;
      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.reject(new Error("ENOENT"));
        }
        if (filePath.endsWith("agent-output.md")) {
          callCount++;
          return Promise.resolve(`Output after stage ${callCount}`);
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig();
      await runner.run(config);

      // Check that stage output files were written
      const writeFileCalls = mockSecureFs.writeFile.mock.calls;
      const stageOutputWrites = writeFileCalls.filter(([path]: [string]) =>
        path.includes("stage-outputs/"),
      );

      expect(stageOutputWrites).toHaveLength(3);
      expect(stageOutputWrites[0][0]).toBe(
        `${PROJECT_PATH}/.pegasus/features/${FEATURE_ID}/stage-outputs/plan.md`,
      );
      expect(stageOutputWrites[1][0]).toBe(
        `${PROJECT_PATH}/.pegasus/features/${FEATURE_ID}/stage-outputs/implement.md`,
      );
      expect(stageOutputWrites[2][0]).toBe(
        `${PROJECT_PATH}/.pegasus/features/${FEATURE_ID}/stage-outputs/test.md`,
      );
    });

    it("should create stage-outputs directory before writing", async () => {
      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
        mkdir: ReturnType<typeof vi.fn>;
      };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig();
      await runner.run(config);

      const mkdirCalls = mockSecureFs.mkdir.mock.calls;
      const stageOutputDirCreations = mkdirCalls.filter(([dirPath]: [string]) =>
        dirPath.includes("stage-outputs"),
      );

      // Once per stage
      expect(stageOutputDirCreations.length).toBeGreaterThanOrEqual(3);
      expect(stageOutputDirCreations[0][0]).toBe(
        `${PROJECT_PATH}/.pegasus/features/${FEATURE_ID}/stage-outputs`,
      );
      expect(stageOutputDirCreations[0][1]).toEqual({ recursive: true });
    });

    it("should persist pipeline state after each stage completes", async () => {
      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("agent-output.md")) {
          return Promise.resolve("stage output");
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig();
      await runner.run(config);

      const writeFileCalls = mockSecureFs.writeFile.mock.calls;
      const stateWrites = writeFileCalls.filter(([path]: [string]) =>
        path.endsWith("pipeline-state.json"),
      );

      // One state write per completed stage
      expect(stateWrites).toHaveLength(3);

      // Verify the state structure of the last write
      const lastStateJson = JSON.parse(
        stateWrites[2][1] as string,
      ) as PipelineExecutionState;
      expect(lastStateJson.version).toBe(1);
      expect(lastStateJson.pipelineName).toBe(PIPELINE_NAME);
      expect(lastStateJson.totalStages).toBe(3);
      expect(lastStateJson.completedStages).toHaveLength(3);
      expect(lastStateJson.lastCompletedStageIndex).toBe(2);
      expect(lastStateJson.completedStages[0].stageId).toBe("plan");
      expect(lastStateJson.completedStages[1].stageId).toBe("implement");
      expect(lastStateJson.completedStages[2].stageId).toBe("test");
    });

    it("should include accumulated context snapshot in pipeline state", async () => {
      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
      };

      // Track reads specifically for after-stage context reads (not the initial load).
      // readFile is called for:
      //   1. pipeline-state.json (ENOENT - no state)
      //   2. agent-output.md during resolveResumptionPoint (initial context load)
      //   3. agent-output.md after stage 1 completes
      //   4. agent-output.md after stage 2 completes
      //   5. agent-output.md after stage 3 completes
      let agentOutputReadCount = 0;
      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("agent-output.md")) {
          agentOutputReadCount++;
          return Promise.resolve(`Context snapshot ${agentOutputReadCount}`);
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig();
      await runner.run(config);

      const writeFileCalls = mockSecureFs.writeFile.mock.calls;
      const stateWrites = writeFileCalls.filter(([path]: [string]) =>
        path.endsWith("pipeline-state.json"),
      );

      // First state write (after stage 1) should have context from the
      // post-stage read (agentOutputReadCount=2, since initial load was #1)
      const firstState = JSON.parse(
        stateWrites[0][1] as string,
      ) as PipelineExecutionState;
      expect(firstState.completedStages[0].accumulatedContextSnapshot).toBe(
        "Context snapshot 2",
      );

      // Second state write (after stage 2) should have context from #3
      const secondState = JSON.parse(
        stateWrites[1][1] as string,
      ) as PipelineExecutionState;
      expect(secondState.completedStages[1].accumulatedContextSnapshot).toBe(
        "Context snapshot 3",
      );
    });

    it("should not fail pipeline if stage output write fails", async () => {
      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
        mkdir: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));
      // Make mkdir fail for stage-outputs (simulating permission error)
      mockSecureFs.mkdir.mockRejectedValue(new Error("EACCES"));
      // writeFile for pipeline-state.json will also fail since it's a write op
      mockSecureFs.writeFile.mockRejectedValue(new Error("EACCES"));

      const config = createMockConfig();
      const result = await runner.run(config);

      // Pipeline should still complete successfully
      expect(result.success).toBe(true);
      expect(result.stagesCompleted).toBe(3);
    });
  });

  // ==========================================================================
  // Resumption from Persisted State
  // ==========================================================================

  describe("resumption", () => {
    it("should skip completed stages and resume from next stage", async () => {
      const stages = [
        createMockStage("plan", "Planning"),
        createMockStage("implement", "Implementation"),
        createMockStage("test", "Testing"),
      ];

      const existingState = createPipelineState(
        ["plan"],
        stages,
        PIPELINE_NAME,
        ["Plan output context"],
      );

      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.resolve(JSON.stringify(existingState));
        }
        if (filePath.endsWith("agent-output.md")) {
          return Promise.resolve("Updated context");
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig({ stages });
      const result = await runner.run(config);

      expect(result.success).toBe(true);
      expect(result.stagesCompleted).toBe(3); // 1 skipped + 2 executed
      expect(result.stagesSkipped).toBe(1);
      expect(runAgentFn).toHaveBeenCalledTimes(2); // Only implement and test
    });

    it("should restore accumulated context from last completed stage", async () => {
      const stages = [
        createMockStage("plan", "Planning"),
        createMockStage("implement", "Implementation"),
        createMockStage("test", "Testing"),
      ];

      const existingState = createPipelineState(
        ["plan"],
        stages,
        PIPELINE_NAME,
        ["Plan output context from previous run"],
      );

      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.resolve(JSON.stringify(existingState));
        }
        if (filePath.endsWith("agent-output.md")) {
          return Promise.resolve("Updated after implement");
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig({ stages });
      await runner.run(config);

      // The first executed stage (implement) should use the restored context
      const firstCall = runAgentFn.mock.calls[0];
      const prompt = firstCall[2]; // prompt parameter
      expect(prompt).toContain("Plan output context from previous run");
    });

    it("should skip multiple completed stages", async () => {
      const stages = [
        createMockStage("plan", "Planning"),
        createMockStage("implement", "Implementation"),
        createMockStage("test", "Testing"),
      ];

      const existingState = createPipelineState(
        ["plan", "implement"],
        stages,
        PIPELINE_NAME,
        ["Plan output", "Implement output"],
      );

      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.resolve(JSON.stringify(existingState));
        }
        if (filePath.endsWith("agent-output.md")) {
          return Promise.resolve("Test output");
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig({ stages });
      const result = await runner.run(config);

      expect(result.success).toBe(true);
      expect(result.stagesCompleted).toBe(3); // 2 skipped + 1 executed
      expect(result.stagesSkipped).toBe(2);
      expect(runAgentFn).toHaveBeenCalledTimes(1); // Only test
    });

    it("should return early if all stages already completed", async () => {
      const stages = [
        createMockStage("plan", "Planning"),
        createMockStage("implement", "Implementation"),
        createMockStage("test", "Testing"),
      ];

      const existingState = createPipelineState(
        ["plan", "implement", "test"],
        stages,
        PIPELINE_NAME,
        ["Plan out", "Implement out", "Test out"],
      );

      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.resolve(JSON.stringify(existingState));
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig({ stages });
      const result = await runner.run(config);

      expect(result.success).toBe(true);
      expect(result.stagesCompleted).toBe(3);
      expect(result.stagesSkipped).toBe(3);
      expect(runAgentFn).not.toHaveBeenCalled();
    });

    it("should start fresh if pipeline name does not match", async () => {
      const stages = [
        createMockStage("plan", "Planning"),
        createMockStage("implement", "Implementation"),
      ];

      const existingState = createPipelineState(
        ["plan"],
        stages,
        "Different Pipeline", // Different pipeline name
        ["Plan output"],
      );

      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.resolve(JSON.stringify(existingState));
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig({ stages });
      const result = await runner.run(config);

      // All stages executed (no skipping)
      expect(result.stagesSkipped).toBe(0);
      expect(runAgentFn).toHaveBeenCalledTimes(2);
    });

    it("should start fresh if pipeline configuration changed (stage IDs reordered)", async () => {
      const stages = [
        createMockStage("implement", "Implementation"), // was at index 1, now at 0
        createMockStage("plan", "Planning"), // was at index 0, now at 1
      ];

      // State says 'plan' was at index 0, but now 'implement' is at index 0
      const existingState: PipelineExecutionState = {
        version: 1,
        pipelineName: PIPELINE_NAME,
        totalStages: 2,
        completedStages: [
          {
            stageId: "plan",
            stageName: "Planning",
            stageIndex: 0,
            completedAt: new Date().toISOString(),
            accumulatedContextSnapshot: "Plan output",
          },
        ],
        lastCompletedStageIndex: 0,
        updatedAt: new Date().toISOString(),
      };

      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.resolve(JSON.stringify(existingState));
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig({ stages });
      const result = await runner.run(config);

      // Should start fresh since configuration changed
      expect(result.stagesSkipped).toBe(0);
      expect(runAgentFn).toHaveBeenCalledTimes(2);
    });

    it("should start fresh if pipeline state has unsupported version", async () => {
      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.resolve(
            JSON.stringify({
              version: 99, // Unsupported version
              pipelineName: PIPELINE_NAME,
              totalStages: 3,
              completedStages: [],
              lastCompletedStageIndex: -1,
              updatedAt: new Date().toISOString(),
            }),
          );
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig();
      const result = await runner.run(config);

      // Should start fresh
      expect(result.stagesSkipped).toBe(0);
      expect(runAgentFn).toHaveBeenCalledTimes(3);
    });
  });

  // ==========================================================================
  // Pipeline State Clearing
  // ==========================================================================

  describe("state clearing", () => {
    it("should clear pipeline state after all stages complete successfully", async () => {
      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
        unlink: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig();
      await runner.run(config);

      expect(mockSecureFs.unlink).toHaveBeenCalledWith(
        `${PROJECT_PATH}/.pegasus/features/${FEATURE_ID}/pipeline-state.json`,
      );
    });

    it("should NOT clear pipeline state if a stage fails", async () => {
      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
        unlink: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));
      runAgentFn.mockRejectedValueOnce(new Error("Agent failed"));

      const config = createMockConfig();
      const result = await runner.run(config);

      expect(result.success).toBe(false);
      // unlink should not be called for pipeline-state.json
      const unlinkCalls = mockSecureFs.unlink.mock.calls;
      const stateUnlinks = unlinkCalls.filter(([path]: [string]) =>
        path.endsWith("pipeline-state.json"),
      );
      expect(stateUnlinks).toHaveLength(0);
    });

    it("should NOT clear pipeline state if execution is aborted", async () => {
      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
        unlink: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const abortController = new AbortController();
      runAgentFn.mockImplementation(async () => {
        abortController.abort();
      });

      const config = createMockConfig({ abortController });
      const result = await runner.run(config);

      expect(result.aborted).toBe(true);
      const unlinkCalls = mockSecureFs.unlink.mock.calls;
      const stateUnlinks = unlinkCalls.filter(([path]: [string]) =>
        path.endsWith("pipeline-state.json"),
      );
      expect(stateUnlinks).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Abort Handling
  // ==========================================================================

  describe("abort handling", () => {
    it("should return aborted result when aborted before a stage starts", async () => {
      const abortController = new AbortController();
      abortController.abort(); // Abort immediately

      const config = createMockConfig({ abortController });
      const result = await runner.run(config);

      expect(result.success).toBe(false);
      expect(result.aborted).toBe(true);
      expect(result.error).toBe("Pipeline execution aborted");
      expect(result.failedStageId).toBe("plan");
      expect(runAgentFn).not.toHaveBeenCalled();
    });

    it("should return aborted result when agent throws due to abort", async () => {
      const abortController = new AbortController();

      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      runAgentFn.mockImplementationOnce(async () => {
        abortController.abort();
        throw new Error("Aborted");
      });

      const config = createMockConfig({ abortController });
      const result = await runner.run(config);

      expect(result.success).toBe(false);
      expect(result.aborted).toBe(true);
      expect(result.stagesSkipped).toBe(0);
    });

    it("should include stagesSkipped in abort result when resuming", async () => {
      const stages = [
        createMockStage("plan", "Planning"),
        createMockStage("implement", "Implementation"),
        createMockStage("test", "Testing"),
      ];

      const existingState = createPipelineState(
        ["plan"],
        stages,
        PIPELINE_NAME,
        ["Plan output"],
      );

      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.resolve(JSON.stringify(existingState));
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const abortController = new AbortController();
      runAgentFn.mockImplementationOnce(async () => {
        abortController.abort();
        throw new Error("Aborted");
      });

      const config = createMockConfig({ stages, abortController });
      const result = await runner.run(config);

      expect(result.aborted).toBe(true);
      expect(result.stagesSkipped).toBe(1);
      expect(result.stagesCompleted).toBe(1); // Only the skipped one
    });
  });

  // ==========================================================================
  // Error Handling
  // ==========================================================================

  describe("error handling", () => {
    it("should return failure result when a stage throws", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      runAgentFn
        .mockResolvedValueOnce(undefined) // plan succeeds
        .mockRejectedValueOnce(new Error("Implementation failed")); // implement fails

      const config = createMockConfig();
      const result = await runner.run(config);

      expect(result.success).toBe(false);
      expect(result.aborted).toBe(false);
      expect(result.error).toBe(
        'Stage "implement" failed: Implementation failed',
      );
      expect(result.failedStageId).toBe("implement");
      expect(result.stagesCompleted).toBe(1);
      expect(runAgentFn).toHaveBeenCalledTimes(2);
    });

    it("should persist state for completed stages even when a later stage fails", async () => {
      const mockSecureFs = secureFs as {
        readFile: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
      };

      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("agent-output.md")) {
          return Promise.resolve("Stage output");
        }
        return Promise.reject(new Error("ENOENT"));
      });

      runAgentFn
        .mockResolvedValueOnce(undefined) // plan succeeds
        .mockRejectedValueOnce(new Error("Fail")); // implement fails

      const config = createMockConfig();
      await runner.run(config);

      // Pipeline state should have been written at least once (for the first completed stage)
      const writeFileCalls = mockSecureFs.writeFile.mock.calls;
      const stateWrites = writeFileCalls.filter(([path]: [string]) =>
        path.endsWith("pipeline-state.json"),
      );
      expect(stateWrites.length).toBeGreaterThanOrEqual(1);

      // The persisted state should have only the "plan" stage
      const lastState = JSON.parse(
        stateWrites[stateWrites.length - 1][1] as string,
      ) as PipelineExecutionState;
      expect(lastState.completedStages).toHaveLength(1);
      expect(lastState.completedStages[0].stageId).toBe("plan");
    });
  });

  // ==========================================================================
  // State Management Methods
  // ==========================================================================

  describe("loadPipelineState", () => {
    it("should return null when no state file exists", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const state = await runner.loadPipelineState(PROJECT_PATH, FEATURE_ID);
      expect(state).toBeNull();
    });

    it("should return parsed state when file exists", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      const expectedState: PipelineExecutionState = {
        version: 1,
        pipelineName: "Feature",
        totalStages: 3,
        completedStages: [],
        lastCompletedStageIndex: -1,
        updatedAt: new Date().toISOString(),
      };
      mockSecureFs.readFile.mockResolvedValue(JSON.stringify(expectedState));

      const state = await runner.loadPipelineState(PROJECT_PATH, FEATURE_ID);
      expect(state).toEqual(expectedState);
    });

    it("should return null for unsupported version", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockResolvedValue(
        JSON.stringify({ version: 2, pipelineName: "Feature" }),
      );

      const state = await runner.loadPipelineState(PROJECT_PATH, FEATURE_ID);
      expect(state).toBeNull();
    });
  });

  describe("savePipelineState", () => {
    it("should write state to the correct path", async () => {
      const mockSecureFs = secureFs as { writeFile: ReturnType<typeof vi.fn> };
      const state: PipelineExecutionState = {
        version: 1,
        pipelineName: "Feature",
        totalStages: 3,
        completedStages: [],
        lastCompletedStageIndex: -1,
        updatedAt: new Date().toISOString(),
      };

      await runner.savePipelineState(PROJECT_PATH, FEATURE_ID, state);

      expect(mockSecureFs.writeFile).toHaveBeenCalledWith(
        `${PROJECT_PATH}/.pegasus/features/${FEATURE_ID}/pipeline-state.json`,
        JSON.stringify(state, null, 2),
        "utf-8",
      );
    });

    it("should not throw when write fails", async () => {
      const mockSecureFs = secureFs as { writeFile: ReturnType<typeof vi.fn> };
      mockSecureFs.writeFile.mockRejectedValue(new Error("EACCES"));

      const state: PipelineExecutionState = {
        version: 1,
        pipelineName: "Feature",
        totalStages: 3,
        completedStages: [],
        lastCompletedStageIndex: -1,
        updatedAt: new Date().toISOString(),
      };

      // Should not throw
      await expect(
        runner.savePipelineState(PROJECT_PATH, FEATURE_ID, state),
      ).resolves.toBeUndefined();
    });
  });

  describe("saveStageOutput", () => {
    it("should create directory and write output file", async () => {
      const mockSecureFs = secureFs as {
        mkdir: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
      };

      await runner.saveStageOutput(
        PROJECT_PATH,
        FEATURE_ID,
        "plan",
        "Plan output",
      );

      expect(mockSecureFs.mkdir).toHaveBeenCalledWith(
        `${PROJECT_PATH}/.pegasus/features/${FEATURE_ID}/stage-outputs`,
        { recursive: true },
      );
      expect(mockSecureFs.writeFile).toHaveBeenCalledWith(
        `${PROJECT_PATH}/.pegasus/features/${FEATURE_ID}/stage-outputs/plan.md`,
        "Plan output",
        "utf-8",
      );
    });

    it("should not throw when write fails", async () => {
      const mockSecureFs = secureFs as {
        mkdir: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
      };
      mockSecureFs.mkdir.mockRejectedValue(new Error("EACCES"));

      await expect(
        runner.saveStageOutput(PROJECT_PATH, FEATURE_ID, "plan", "Plan output"),
      ).resolves.toBeUndefined();
    });
  });

  describe("clearPipelineState", () => {
    it("should unlink the state file", async () => {
      const mockSecureFs = secureFs as { unlink: ReturnType<typeof vi.fn> };

      await runner.clearPipelineState(PROJECT_PATH, FEATURE_ID);

      expect(mockSecureFs.unlink).toHaveBeenCalledWith(
        `${PROJECT_PATH}/.pegasus/features/${FEATURE_ID}/pipeline-state.json`,
      );
    });

    it("should not throw when unlink fails", async () => {
      const mockSecureFs = secureFs as { unlink: ReturnType<typeof vi.fn> };
      mockSecureFs.unlink.mockRejectedValue(new Error("ENOENT"));

      await expect(
        runner.clearPipelineState(PROJECT_PATH, FEATURE_ID),
      ).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // StageRunResult.stagesSkipped
  // ==========================================================================

  describe("stagesSkipped in result", () => {
    it("should be 0 for fresh execution", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig();
      const result = await runner.run(config);

      expect(result.stagesSkipped).toBe(0);
    });

    it("should reflect number of completed stages on resume", async () => {
      const stages = [
        createMockStage("plan", "Planning"),
        createMockStage("implement", "Implementation"),
        createMockStage("test", "Testing"),
      ];

      const existingState = createPipelineState(
        ["plan", "implement"],
        stages,
        PIPELINE_NAME,
        ["Plan out", "Implement out"],
      );

      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.resolve(JSON.stringify(existingState));
        }
        if (filePath.endsWith("agent-output.md")) {
          return Promise.resolve("Test output");
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig({ stages });
      const result = await runner.run(config);

      expect(result.stagesSkipped).toBe(2);
      expect(result.stagesCompleted).toBe(3);
    });
  });

  // ==========================================================================
  // Prompt Building
  // ==========================================================================

  describe("buildStagePrompt (via run)", () => {
    it("should include stage name and pipeline metadata", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig({
        stages: [createMockStage("plan", "Planning")],
      });
      await runner.run(config);

      const prompt = runAgentFn.mock.calls[0][2];
      expect(prompt).toContain("## Pipeline Stage 1/1: Planning");
      expect(prompt).toContain(
        "This is an automated pipeline stage execution.",
      );
    });

    it("should include feature context", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig({
        stages: [createMockStage("plan", "Planning")],
        feature: createMockFeature({
          title: "Dark Mode",
          description: "Add dark mode",
        }),
      });
      await runner.run(config);

      const prompt = runAgentFn.mock.calls[0][2];
      expect(prompt).toContain("**Title:** Dark Mode");
      expect(prompt).toContain("**Description:** Add dark mode");
    });

    it("should include summary requirement section", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig({
        stages: [createMockStage("plan", "Planning")],
      });
      await runner.run(config);

      const prompt = runAgentFn.mock.calls[0][2];
      expect(prompt).toContain("<summary>");
      expect(prompt).toContain("</summary>");
      expect(prompt).toContain("### Changes Implemented");
    });
  });

  // ==========================================================================
  // Sequential Execution Ordering
  // ==========================================================================

  describe("sequential execution ordering", () => {
    it("should execute stages in array order", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const executionOrder: string[] = [];
      runAgentFn.mockImplementation(async (_workDir, _featureId, prompt) => {
        if (prompt.includes("Planning")) executionOrder.push("plan");
        if (prompt.includes("Implementation")) executionOrder.push("implement");
        if (prompt.includes("Testing")) executionOrder.push("test");
      });

      const config = createMockConfig();
      await runner.run(config);

      expect(executionOrder).toEqual(["plan", "implement", "test"]);
    });

    it("should complete one stage before starting the next", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      let concurrentExecutions = 0;
      let maxConcurrentExecutions = 0;

      runAgentFn.mockImplementation(async () => {
        concurrentExecutions++;
        maxConcurrentExecutions = Math.max(
          maxConcurrentExecutions,
          concurrentExecutions,
        );
        // Simulate some async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrentExecutions--;
      });

      const config = createMockConfig();
      await runner.run(config);

      // Should never have more than 1 concurrent execution
      expect(maxConcurrentExecutions).toBe(1);
    });

    it("should handle a single stage pipeline", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig({
        stages: [createMockStage("only-stage", "The Only Stage")],
      });
      const result = await runner.run(config);

      expect(result.success).toBe(true);
      expect(result.stagesCompleted).toBe(1);
      expect(result.totalStages).toBe(1);
      expect(runAgentFn).toHaveBeenCalledTimes(1);
    });

    it("should return success with zero stages for empty stages array", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig({ stages: [] });
      const result = await runner.run(config);

      expect(result.success).toBe(true);
      expect(result.stagesCompleted).toBe(0);
      expect(result.totalStages).toBe(0);
      expect(result.stagesSkipped).toBe(0);
      expect(result.aborted).toBe(false);
      expect(runAgentFn).not.toHaveBeenCalled();
    });

    it("should not execute remaining stages after a failure", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const executionOrder: string[] = [];
      runAgentFn
        .mockImplementationOnce(async () => {
          executionOrder.push("plan");
        })
        .mockRejectedValueOnce(new Error("Fail"))
        .mockImplementationOnce(async () => {
          executionOrder.push("test");
        });

      const config = createMockConfig();
      await runner.run(config);

      // Third stage should never execute
      expect(executionOrder).toEqual(["plan"]);
      expect(runAgentFn).toHaveBeenCalledTimes(2);
    });

    it("should pass stage-specific model and options to runAgentFn", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const stages = [
        {
          ...createMockStage("plan", "Planning"),
          model: "opus",
          max_turns: 20,
        },
        {
          ...createMockStage("implement", "Implementation"),
          model: "sonnet",
          max_turns: 10,
        },
      ];

      const config = createMockConfig({ stages });
      await runner.run(config);

      // First stage should use opus
      expect(runAgentFn.mock.calls[0][6]).toBe("opus");
      expect(runAgentFn.mock.calls[0][7]).toMatchObject({
        status: "pipeline_plan",
      });

      // Second stage should use sonnet
      expect(runAgentFn.mock.calls[1][6]).toBe("sonnet");
      expect(runAgentFn.mock.calls[1][7]).toMatchObject({
        status: "pipeline_implement",
      });
    });
  });

  // ==========================================================================
  // Context Accumulation
  // ==========================================================================

  describe("context accumulation", () => {
    it("should pass empty previous_context to compileStage for the first stage on fresh execution", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const mockCompileStage = compileStage as ReturnType<typeof vi.fn>;

      const config = createMockConfig({
        stages: [createMockStage("plan", "Planning")],
      });
      await runner.run(config);

      // compileStage should have been called with previous_context = ''
      expect(mockCompileStage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          previous_context: "",
        }),
      );
    });

    it("should pass accumulated context from stage N as previous_context to compileStage for stage N+1", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };

      // Simulate agent writing different output after each stage
      let readCount = 0;
      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("agent-output.md")) {
          readCount++;
          if (readCount === 1) return Promise.resolve(""); // initial load (resolveResumptionPoint)
          if (readCount === 2)
            return Promise.resolve("Plan output from stage 1");
          if (readCount === 3)
            return Promise.resolve(
              "Plan output from stage 1\nImplement output from stage 2",
            );
          return Promise.resolve("Final output");
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const mockCompileStage = compileStage as ReturnType<typeof vi.fn>;

      const config = createMockConfig();
      await runner.run(config);

      // compileStage call #1 (plan): previous_context should be '' (from initial legacy load)
      expect(mockCompileStage.mock.calls[0][1]).toMatchObject({
        previous_context: "",
      });

      // compileStage call #2 (implement): previous_context should be output after plan stage
      expect(mockCompileStage.mock.calls[1][1]).toMatchObject({
        previous_context: "Plan output from stage 1",
      });

      // compileStage call #3 (test): previous_context should be output after implement stage
      expect(mockCompileStage.mock.calls[2][1]).toMatchObject({
        previous_context:
          "Plan output from stage 1\nImplement output from stage 2",
      });
    });

    it("should pass accumulated context as previousContent in runAgentFn options", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };

      let agentOutputReadCount = 0;
      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("agent-output.md")) {
          agentOutputReadCount++;
          if (agentOutputReadCount === 1) return Promise.resolve(""); // initial load
          return Promise.resolve(
            `Context after stage ${agentOutputReadCount - 1}`,
          );
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig();
      await runner.run(config);

      // First stage: previousContent should be the initial (empty) context
      expect(runAgentFn.mock.calls[0][7]).toMatchObject({
        previousContent: "",
      });

      // Second stage: previousContent should be context after stage 1
      expect(runAgentFn.mock.calls[1][7]).toMatchObject({
        previousContent: "Context after stage 1",
      });

      // Third stage: previousContent should be context after stage 2
      expect(runAgentFn.mock.calls[2][7]).toMatchObject({
        previousContent: "Context after stage 2",
      });
    });

    it('should include previous context in prompt as "Previous Work" section', async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };

      let agentOutputReadCount = 0;
      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("agent-output.md")) {
          agentOutputReadCount++;
          if (agentOutputReadCount === 1) return Promise.resolve(""); // initial load
          return Promise.resolve("Previous stage output content");
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const stages = [
        createMockStage("plan", "Planning"),
        createMockStage("implement", "Implementation"),
      ];
      const config = createMockConfig({ stages });
      await runner.run(config);

      // Second stage prompt should include "Previous Work" with the accumulated context
      const secondStagePrompt = runAgentFn.mock.calls[1][2];
      expect(secondStagePrompt).toContain("### Previous Work");
      expect(secondStagePrompt).toContain("Previous stage output content");
    });

    it('should not include "Previous Work" section when context is empty', async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig({
        stages: [createMockStage("plan", "Planning")],
      });
      await runner.run(config);

      const prompt = runAgentFn.mock.calls[0][2];
      expect(prompt).not.toContain("### Previous Work");
    });

    it("should return the final accumulated context in the result", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };

      let readCount = 0;
      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("agent-output.md")) {
          readCount++;
          if (readCount <= 1) return Promise.resolve(""); // initial load
          return Promise.resolve("Final accumulated output");
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig({
        stages: [createMockStage("plan", "Planning")],
      });
      const result = await runner.run(config);

      expect(result.accumulatedContext).toBe("Final accumulated output");
    });

    it("should preserve context when agent-output.md read fails after a stage", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };

      let agentOutputReadCount = 0;
      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("agent-output.md")) {
          agentOutputReadCount++;
          if (agentOutputReadCount === 1) return Promise.resolve(""); // initial load (resolveResumptionPoint)
          if (agentOutputReadCount === 2) return Promise.resolve("Plan output"); // after stage 1
          // After stage 2, reading fails — context should not change
          return Promise.reject(new Error("ENOENT"));
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const stages = [
        createMockStage("plan", "Planning"),
        createMockStage("implement", "Implementation"),
        createMockStage("test", "Testing"),
      ];
      const config = createMockConfig({ stages });
      const result = await runner.run(config);

      // Third stage should still get 'Plan output' as context (unchanged from failed read)
      expect(runAgentFn.mock.calls[2][7]).toMatchObject({
        previousContent: "Plan output",
      });
      expect(result.accumulatedContext).toBe("Plan output");
    });

    it("should use legacy agent-output.md context as starting context for first stage", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };

      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.reject(new Error("ENOENT"));
        }
        if (filePath.endsWith("agent-output.md")) {
          return Promise.resolve("Legacy context from previous run");
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig({
        stages: [createMockStage("plan", "Planning")],
      });
      await runner.run(config);

      const mockCompileStage = compileStage as ReturnType<typeof vi.fn>;
      // First stage should receive legacy context as previous_context
      expect(mockCompileStage.mock.calls[0][1]).toMatchObject({
        previous_context: "Legacy context from previous run",
      });

      // The prompt should include the legacy context
      const prompt = runAgentFn.mock.calls[0][2];
      expect(prompt).toContain("### Previous Work");
      expect(prompt).toContain("Legacy context from previous run");
    });

    it("should merge compilationContext fields with previous_context for compileStage", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const mockCompileStage = compileStage as ReturnType<typeof vi.fn>;

      const config = createMockConfig({
        stages: [createMockStage("plan", "Planning")],
        compilationContext: {
          task: { description: "Custom task description" },
          project: { language: "Python", test_command: "pytest" },
        },
      });
      await runner.run(config);

      // compileStage should receive both the original context fields and previous_context
      expect(mockCompileStage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          task: { description: "Custom task description" },
          project: { language: "Python", test_command: "pytest" },
          previous_context: "",
        }),
      );
    });
  });

  // ==========================================================================
  // Event Emission Details
  // ==========================================================================

  describe("event emission details", () => {
    it("should emit auto_mode_progress with correct content format", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig();
      await runner.run(config);

      const emitCalls = (eventBus.emitAutoModeEvent as ReturnType<typeof vi.fn>)
        .mock.calls;
      const progressCalls = emitCalls.filter(
        ([event]: [string]) => event === "auto_mode_progress",
      );

      expect(progressCalls).toHaveLength(3);

      // Verify content format: "Starting pipeline stage X/Y: StageName"
      expect(progressCalls[0][1]).toMatchObject({
        featureId: FEATURE_ID,
        branchName: "feat/test",
        content: "Starting pipeline stage 1/3: Planning",
        projectPath: PROJECT_PATH,
      });
      expect(progressCalls[1][1]).toMatchObject({
        content: "Starting pipeline stage 2/3: Implementation",
      });
      expect(progressCalls[2][1]).toMatchObject({
        content: "Starting pipeline stage 3/3: Testing",
      });
    });

    it("should emit events in correct order: started → progress → complete per stage", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig({
        stages: [createMockStage("plan", "Planning")],
      });
      await runner.run(config);

      const emitCalls = (eventBus.emitAutoModeEvent as ReturnType<typeof vi.fn>)
        .mock.calls;
      const eventNames = emitCalls.map(([event]: [string]) => event);

      // For a single stage: started, progress, then complete
      expect(eventNames).toEqual([
        "pipeline_step_started",
        "auto_mode_progress",
        "pipeline_step_complete",
      ]);
    });

    it("should emit events in correct order for multiple stages", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig({
        stages: [
          createMockStage("plan", "Planning"),
          createMockStage("implement", "Implementation"),
        ],
      });
      await runner.run(config);

      const emitCalls = (eventBus.emitAutoModeEvent as ReturnType<typeof vi.fn>)
        .mock.calls;
      const eventNames = emitCalls.map(([event]: [string]) => event);

      // Stage 1: started, progress, complete — Stage 2: started, progress, complete
      expect(eventNames).toEqual([
        "pipeline_step_started",
        "auto_mode_progress",
        "pipeline_step_complete",
        "pipeline_step_started",
        "auto_mode_progress",
        "pipeline_step_complete",
      ]);
    });

    it("should include pipelineName in started and complete events", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig({
        stages: [createMockStage("plan", "Planning")],
        pipelineName: "Bug Fix",
      });
      await runner.run(config);

      const emitCalls = (eventBus.emitAutoModeEvent as ReturnType<typeof vi.fn>)
        .mock.calls;

      const startedCall = emitCalls.find(
        ([event]: [string]) => event === "pipeline_step_started",
      );
      expect(startedCall![1]).toMatchObject({
        pipelineName: "Bug Fix",
      });

      const completeCall = emitCalls.find(
        ([event]: [string]) => event === "pipeline_step_complete",
      );
      expect(completeCall![1]).toMatchObject({
        pipelineName: "Bug Fix",
      });
    });

    it("should include correct stepIndex and totalSteps in events", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig();
      await runner.run(config);

      const emitCalls = (eventBus.emitAutoModeEvent as ReturnType<typeof vi.fn>)
        .mock.calls;
      const startedCalls = emitCalls.filter(
        ([event]: [string]) => event === "pipeline_step_started",
      );

      expect(startedCalls[0][1]).toMatchObject({ stepIndex: 0, totalSteps: 3 });
      expect(startedCalls[1][1]).toMatchObject({ stepIndex: 1, totalSteps: 3 });
      expect(startedCalls[2][1]).toMatchObject({ stepIndex: 2, totalSteps: 3 });
    });

    it("should not emit pipeline_step_complete for a failed stage", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      runAgentFn
        .mockResolvedValueOnce(undefined) // plan succeeds
        .mockRejectedValueOnce(new Error("Implementation failed")); // implement fails

      const config = createMockConfig();
      await runner.run(config);

      const emitCalls = (eventBus.emitAutoModeEvent as ReturnType<typeof vi.fn>)
        .mock.calls;
      const completeCalls = emitCalls.filter(
        ([event]: [string]) => event === "pipeline_step_complete",
      );

      // Only the first stage (plan) should have a complete event
      expect(completeCalls).toHaveLength(1);
      expect(completeCalls[0][1]).toMatchObject({
        stepId: "plan",
      });
    });

    it("should not emit events for skipped stages on resumption", async () => {
      const stages = [
        createMockStage("plan", "Planning"),
        createMockStage("implement", "Implementation"),
        createMockStage("test", "Testing"),
      ];

      const existingState = createPipelineState(
        ["plan"],
        stages,
        PIPELINE_NAME,
        ["Plan output"],
      );

      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith("pipeline-state.json")) {
          return Promise.resolve(JSON.stringify(existingState));
        }
        if (filePath.endsWith("agent-output.md")) {
          return Promise.resolve("Updated output");
        }
        return Promise.reject(new Error("ENOENT"));
      });

      const config = createMockConfig({ stages });
      await runner.run(config);

      const emitCalls = (eventBus.emitAutoModeEvent as ReturnType<typeof vi.fn>)
        .mock.calls;
      const startedCalls = emitCalls.filter(
        ([event]: [string]) => event === "pipeline_step_started",
      );

      // Only implement and test should have started events (plan was skipped)
      expect(startedCalls).toHaveLength(2);
      expect(startedCalls[0][1]).toMatchObject({
        stepId: "implement",
        stepIndex: 1,
      });
      expect(startedCalls[1][1]).toMatchObject({
        stepId: "test",
        stepIndex: 2,
      });
    });

    it("should not emit any events when aborted before first stage", async () => {
      const abortController = new AbortController();
      abortController.abort(); // Abort immediately

      const config = createMockConfig({ abortController });
      await runner.run(config);

      expect(eventBus.emitAutoModeEvent).not.toHaveBeenCalled();
    });

    it("should include projectPath in all event payloads", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig({
        stages: [createMockStage("plan", "Planning")],
      });
      await runner.run(config);

      const emitCalls = (eventBus.emitAutoModeEvent as ReturnType<typeof vi.fn>)
        .mock.calls;

      // Every emitted event should include projectPath
      for (const [, payload] of emitCalls) {
        expect(payload).toHaveProperty("projectPath", PROJECT_PATH);
      }
    });

    it("should include stepName in started and complete events", async () => {
      const mockSecureFs = secureFs as { readFile: ReturnType<typeof vi.fn> };
      mockSecureFs.readFile.mockRejectedValue(new Error("ENOENT"));

      const config = createMockConfig({
        stages: [createMockStage("plan", "My Custom Stage Name")],
      });
      await runner.run(config);

      const emitCalls = (eventBus.emitAutoModeEvent as ReturnType<typeof vi.fn>)
        .mock.calls;

      const startedCall = emitCalls.find(
        ([event]: [string]) => event === "pipeline_step_started",
      );
      expect(startedCall![1]).toMatchObject({
        stepName: "My Custom Stage Name",
      });

      const completeCall = emitCalls.find(
        ([event]: [string]) => event === "pipeline_step_complete",
      );
      expect(completeCall![1]).toMatchObject({
        stepName: "My Custom Stage Name",
      });
    });
  });
});
