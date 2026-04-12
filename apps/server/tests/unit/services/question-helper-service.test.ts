import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Feature } from "@pegasus/types";

// ============================================================================
// Mocks — declared before any imports that trigger module evaluation
// ============================================================================

// vi.hoisted ensures mockLogger is initialized before the hoisted vi.mock factories run
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@pegasus/utils", () => ({
  createLogger: vi.fn(() => mockLogger),
  isAbortError: vi.fn().mockReturnValue(false),
  atomicWriteJson: vi.fn(),
  readJsonWithRecovery: vi.fn(),
  DEFAULT_BACKUP_COUNT: 3,
}));

vi.mock("@pegasus/types", async () => {
  const actual =
    await vi.importActual<typeof import("@pegasus/types")>("@pegasus/types");
  return {
    ...actual,
    DEFAULT_MODELS: { claude: "claude-opus-4-6" },
    stripProviderPrefix: vi.fn((id: string) => id),
  };
});

vi.mock("@/providers/provider-factory.js");

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { isAbortError } from "@pegasus/utils";
import { QuestionHelperService } from "@/services/question-helper-service.js";
import type { EventEmitter } from "@/lib/events.js";
import type { SettingsService } from "@/services/settings-service.js";
import type { FeatureLoader } from "@/services/feature-loader.js";
import { ProviderFactory } from "@/providers/provider-factory.js";

// ============================================================================
// Helpers
// ============================================================================

const FEATURE_ID = "feat-abc";
const PROJECT_PATH = "/test/project";

/** Create a minimal mock EventEmitter (only `.emit` is called by the service). */
function createMockEventBus(): EventEmitter {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
  } as unknown as EventEmitter;
}

function createMockSettingsService(): SettingsService {
  return {
    getGlobalSettings: vi
      .fn()
      .mockResolvedValue({ claudeCompatibleProviders: [] }),
    getCredentials: vi.fn().mockResolvedValue({ apiKey: "test-key" }),
  } as unknown as SettingsService;
}

function createMockFeatureLoader(
  feature: Partial<Feature> | null = null,
): FeatureLoader {
  return {
    get: vi.fn().mockResolvedValue(feature),
    getAll: vi.fn().mockResolvedValue([]),
  } as unknown as FeatureLoader;
}

/** Build an async generator that yields the given provider messages. */
function makeStream(messages: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

/** Convenience: mock provider that yields the given stream messages. */
function mockProvider(streamMessages: unknown[] = []) {
  const executeQuery = vi.fn().mockReturnValue(makeStream(streamMessages));
  vi.mocked(ProviderFactory.getProviderForModel).mockReturnValue({
    executeQuery,
  } as any);
  return { executeQuery };
}

// ============================================================================
// Tests
// ============================================================================

describe("QuestionHelperService", () => {
  let service: QuestionHelperService;
  let eventBus: EventEmitter;
  let settingsService: SettingsService;
  let featureLoader: FeatureLoader;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = createMockEventBus();
    settingsService = createMockSettingsService();
    featureLoader = createMockFeatureLoader({
      id: FEATURE_ID,
      title: "My Feature",
    });
    service = new QuestionHelperService(
      settingsService,
      eventBus,
      featureLoader,
    );
  });

  // ==========================================================================
  // getHistory
  // ==========================================================================

  describe("getHistory", () => {
    it("returns empty array when no session exists", () => {
      expect(service.getHistory(FEATURE_ID)).toEqual([]);
    });

    it("returns empty array for unknown featureId", () => {
      expect(service.getHistory("does-not-exist")).toEqual([]);
    });
  });

  // ==========================================================================
  // terminateSession
  // ==========================================================================

  describe("terminateSession", () => {
    it("does nothing silently when no session exists", () => {
      expect(() => service.terminateSession(FEATURE_ID)).not.toThrow();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it("emits session_terminated after termination", async () => {
      mockProvider([{ type: "result", subtype: "success" }]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);
      service.terminateSession(FEATURE_ID);

      expect(eventBus.emit).toHaveBeenCalledWith(
        "helper_chat_event",
        expect.objectContaining({
          featureId: FEATURE_ID,
          payload: { kind: "session_terminated" },
        }),
      );
    });

    it("clears the session so getHistory returns empty", async () => {
      mockProvider([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Hi there!" }] },
        },
        { type: "result", subtype: "success" },
      ]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);
      expect(service.getHistory(FEATURE_ID)).not.toHaveLength(0);

      service.terminateSession(FEATURE_ID);
      expect(service.getHistory(FEATURE_ID)).toHaveLength(0);
    });

    it("terminates only the matching feature session", async () => {
      const OTHER_FEATURE = "feat-other";
      const featureLoader2 = createMockFeatureLoader({ id: OTHER_FEATURE });
      // Both features share the same service
      vi.mocked(featureLoader2.get).mockResolvedValue({ id: OTHER_FEATURE });

      mockProvider([{ type: "result", subtype: "success" }]);

      await service.sendMessage(FEATURE_ID, "msg1", PROJECT_PATH);
      await service.sendMessage(OTHER_FEATURE, "msg2", PROJECT_PATH);

      service.terminateSession(FEATURE_ID);

      expect(service.getHistory(FEATURE_ID)).toHaveLength(0);
      // OTHER_FEATURE session's user message should still be in history
      expect(service.getHistory(OTHER_FEATURE)).toHaveLength(1);
    });
  });

  // ==========================================================================
  // sendMessage — session lifecycle
  // ==========================================================================

  describe("sendMessage — session lifecycle", () => {
    it("creates a new session on first call", async () => {
      mockProvider([{ type: "result", subtype: "success" }]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      expect(service.getHistory(FEATURE_ID)).toHaveLength(1);
    });

    it("reuses the same session on subsequent calls", async () => {
      mockProvider([{ type: "result", subtype: "success" }]);

      await service.sendMessage(FEATURE_ID, "first", PROJECT_PATH);
      await service.sendMessage(FEATURE_ID, "second", PROJECT_PATH);

      // History should contain both user messages
      const history = service.getHistory(FEATURE_ID);
      expect(history.filter((m) => m.role === "user")).toHaveLength(2);
    });

    it("accumulates user messages in history", async () => {
      mockProvider([{ type: "result", subtype: "success" }]);

      await service.sendMessage(FEATURE_ID, "question 1", PROJECT_PATH);
      await service.sendMessage(FEATURE_ID, "question 2", PROJECT_PATH);

      const userMsgs = service
        .getHistory(FEATURE_ID)
        .filter((m) => m.role === "user");
      expect(userMsgs[0].content).toBe("question 1");
      expect(userMsgs[1].content).toBe("question 2");
    });

    it("accumulates assistant text in history", async () => {
      mockProvider([
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Hello" },
              { type: "text", text: " world" },
            ],
          },
        },
        { type: "result", subtype: "success" },
      ]);

      await service.sendMessage(FEATURE_ID, "hi", PROJECT_PATH);

      const history = service.getHistory(FEATURE_ID);
      const assistantMsg = history.find((m) => m.role === "assistant");
      expect(assistantMsg?.content).toBe("Hello world");
    });
  });

  // ==========================================================================
  // sendMessage — event emission
  // ==========================================================================

  describe("sendMessage — event emission", () => {
    it("emits started event with a sessionId", async () => {
      mockProvider([{ type: "result", subtype: "success" }]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      expect(eventBus.emit).toHaveBeenCalledWith(
        "helper_chat_event",
        expect.objectContaining({
          featureId: FEATURE_ID,
          payload: expect.objectContaining({
            kind: "started",
            sessionId: expect.any(String),
          }),
        }),
      );
    });

    it("emits delta events for each text block", async () => {
      mockProvider([
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "First chunk" },
              { type: "text", text: " second chunk" },
            ],
          },
        },
        { type: "result", subtype: "success" },
      ]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      const deltaCalls = vi
        .mocked(eventBus.emit)
        .mock.calls.filter(([, arg]: any[]) => arg.payload?.kind === "delta");

      expect(deltaCalls).toHaveLength(2);
      expect(deltaCalls[0][1].payload).toEqual({
        kind: "delta",
        text: "First chunk",
      });
      expect(deltaCalls[1][1].payload).toEqual({
        kind: "delta",
        text: " second chunk",
      });
    });

    it("emits complete event at end of successful stream", async () => {
      mockProvider([{ type: "result", subtype: "success" }]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      expect(eventBus.emit).toHaveBeenCalledWith(
        "helper_chat_event",
        expect.objectContaining({
          featureId: FEATURE_ID,
          payload: { kind: "complete" },
        }),
      );
    });

    it("emits tool_call and immediate tool_complete events for tool blocks", async () => {
      mockProvider([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Read",
                tool_use_id: "tu-1",
                input: { file_path: "/some/file.ts" },
              },
            ],
          },
        },
        { type: "result", subtype: "success" },
      ]);

      await service.sendMessage(FEATURE_ID, "read a file", PROJECT_PATH);

      const emitCalls = vi
        .mocked(eventBus.emit)
        .mock.calls.map(([, arg]: any[]) => arg.payload);

      const toolCall = emitCalls.find((p: any) => p.kind === "tool_call");
      expect(toolCall).toMatchObject({
        kind: "tool_call",
        toolName: "Read",
        toolId: "tu-1",
        input: expect.stringContaining("file.ts"),
      });

      const toolComplete = emitCalls.find(
        (p: any) => p.kind === "tool_complete",
      );
      expect(toolComplete).toMatchObject({
        kind: "tool_complete",
        toolId: "tu-1",
      });
    });

    it("emits error payload when stream yields an error message", async () => {
      mockProvider([{ type: "error", error: "Something went wrong" }]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      expect(eventBus.emit).toHaveBeenCalledWith(
        "helper_chat_event",
        expect.objectContaining({
          payload: { kind: "error", message: "Something went wrong" },
        }),
      );
    });

    it("emits error payload when stream yields result with error subtype", async () => {
      mockProvider([
        {
          type: "result",
          subtype: "error_max_turns",
          error: "Max turns exceeded",
        },
      ]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      expect(eventBus.emit).toHaveBeenCalledWith(
        "helper_chat_event",
        expect.objectContaining({
          payload: expect.objectContaining({ kind: "error" }),
        }),
      );
    });

    it("emits error payload when executeQuery throws", async () => {
      const executeQuery = vi.fn().mockImplementation(() => {
        throw new Error("Provider unavailable");
      });
      vi.mocked(ProviderFactory.getProviderForModel).mockReturnValue({
        executeQuery,
      } as any);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      expect(eventBus.emit).toHaveBeenCalledWith(
        "helper_chat_event",
        expect.objectContaining({
          payload: { kind: "error", message: "Provider unavailable" },
        }),
      );
    });

    it("does not emit error when the stream is aborted", async () => {
      vi.mocked(isAbortError).mockReturnValueOnce(true);
      const executeQuery = vi.fn().mockImplementation(() => {
        throw new Error("AbortError");
      });
      vi.mocked(ProviderFactory.getProviderForModel).mockReturnValue({
        executeQuery,
      } as any);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      const emitCalls = vi
        .mocked(eventBus.emit)
        .mock.calls.map(([, arg]: any[]) => arg.payload);
      const errorPayload = emitCalls.find((p: any) => p.kind === "error");
      expect(errorPayload).toBeUndefined();
    });
  });

  // ==========================================================================
  // sendMessage — tool restriction (ADR-5 / CRITICAL C-1)
  // ==========================================================================

  describe("sendMessage — tool restriction (ADR-5)", () => {
    it("passes exactly Read, Grep, Glob as tools to executeQuery", async () => {
      const { executeQuery } = mockProvider([
        { type: "result", subtype: "success" },
      ]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      expect(executeQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: ["Read", "Grep", "Glob"],
        }),
      );
    });

    it("passes the same tool list as allowedTools", async () => {
      const { executeQuery } = mockProvider([
        { type: "result", subtype: "success" },
      ]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      expect(executeQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedTools: ["Read", "Grep", "Glob"],
        }),
      );
    });

    it("does not include Edit, Write, or Bash in tools", async () => {
      const { executeQuery } = mockProvider([
        { type: "result", subtype: "success" },
      ]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      const callArg = executeQuery.mock.calls[0][0];
      const forbidden = ["Edit", "Write", "Bash"];
      for (const tool of forbidden) {
        expect(callArg.tools).not.toContain(tool);
        expect(callArg.allowedTools).not.toContain(tool);
      }
    });
  });

  // ==========================================================================
  // sendMessage — system prompt content
  // ==========================================================================

  describe("sendMessage — system prompt", () => {
    it("includes the feature title when available", async () => {
      featureLoader = createMockFeatureLoader({
        id: FEATURE_ID,
        title: "Auth Module Refactor",
      });
      service = new QuestionHelperService(
        settingsService,
        eventBus,
        featureLoader,
      );
      const { executeQuery } = mockProvider([
        { type: "result", subtype: "success" },
      ]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      const systemPrompt = executeQuery.mock.calls[0][0].systemPrompt as string;
      expect(systemPrompt).toContain("Auth Module Refactor");
    });

    it("prohibits Edit, Write, Bash in system prompt text", async () => {
      const { executeQuery } = mockProvider([
        { type: "result", subtype: "success" },
      ]);

      await service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH);

      const systemPrompt = executeQuery.mock.calls[0][0].systemPrompt as string;
      expect(systemPrompt).toContain(
        "MUST NOT attempt to use Edit, Write, Bash",
      );
    });

    it("works when feature cannot be loaded (graceful degradation)", async () => {
      vi.mocked(featureLoader.get).mockRejectedValueOnce(
        new Error("not found"),
      );
      const { executeQuery } = mockProvider([
        { type: "result", subtype: "success" },
      ]);

      await expect(
        service.sendMessage(FEATURE_ID, "hello", PROJECT_PATH),
      ).resolves.not.toThrow();

      expect(executeQuery).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // sendMessage — turn count logging (R-2 tripwires)
  // ==========================================================================

  describe("sendMessage — turn count tripwires (R-2)", () => {
    it("logs warn when turnCount exceeds WARN threshold (5)", async () => {
      mockProvider([{ type: "result", subtype: "success" }]);

      // Send 6 messages to exceed the warn threshold of 5
      for (let i = 0; i < 6; i++) {
        await service.sendMessage(FEATURE_ID, `msg ${i}`, PROJECT_PATH);
      }

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ featureId: FEATURE_ID }),
        expect.stringContaining("warn threshold"),
      );
    });

    it("logs error when turnCount exceeds ERROR threshold (20)", async () => {
      mockProvider([{ type: "result", subtype: "success" }]);

      for (let i = 0; i < 21; i++) {
        await service.sendMessage(FEATURE_ID, `msg ${i}`, PROJECT_PATH);
      }

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ featureId: FEATURE_ID }),
        expect.stringContaining("error threshold"),
      );
    });
  });
});
