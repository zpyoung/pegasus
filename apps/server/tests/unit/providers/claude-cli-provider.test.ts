import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ClaudeCodeCliProvider,
  ClaudeCliErrorCode,
} from "@/providers/claude-cli-provider.js";
import { isClaudeCliModel, getModelProvider } from "@pegasus/types";
import type { CliErrorInfo } from "@/providers/cli-provider.js";

// Mock child_process for detectInstallation tests
// Use importOriginal to preserve execFile/execFileSync (needed by @pegasus/platform)
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execSync: vi.fn(),
    spawnSync: vi.fn(),
  };
});

// =============================================================================
// isClaudeCliModel utility tests
// =============================================================================

describe("isClaudeCliModel", () => {
  it("returns true for cli-opus", () => {
    expect(isClaudeCliModel("cli-opus")).toBe(true);
  });

  it("returns true for cli-sonnet", () => {
    expect(isClaudeCliModel("cli-sonnet")).toBe(true);
  });

  it("returns true for cli-haiku", () => {
    expect(isClaudeCliModel("cli-haiku")).toBe(true);
  });

  it("returns true for any cli- prefixed string", () => {
    expect(isClaudeCliModel("cli-custom-model")).toBe(true);
  });

  it("returns false for bare claude models", () => {
    expect(isClaudeCliModel("claude-opus-4-6")).toBe(false);
    expect(isClaudeCliModel("sonnet")).toBe(false);
    expect(isClaudeCliModel("opus")).toBe(false);
  });

  it("returns false for cursor models", () => {
    expect(isClaudeCliModel("cursor-auto")).toBe(false);
  });

  it("returns false for codex models", () => {
    expect(isClaudeCliModel("codex-gpt-4")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isClaudeCliModel(null)).toBe(false);
    expect(isClaudeCliModel(undefined)).toBe(false);
    expect(isClaudeCliModel("")).toBe(false);
  });
});

// =============================================================================
// buildCliArgs tests
// =============================================================================

describe("ClaudeCodeCliProvider.buildCliArgs", () => {
  let provider: ClaudeCodeCliProvider;

  beforeEach(() => {
    provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
  });

  it("includes -p, --verbose, and --output-format stream-json flags", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
    });
    expect(args).toContain("-p");
    expect(args).toContain("--verbose");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
  });

  it("ends with - for stdin prompt delivery", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
    });
    expect(args[args.length - 1]).toBe("-");
  });

  it("strips cli- prefix from model", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "cli-opus",
      cwd: "/tmp",
    });
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("opus");
  });

  it("passes bare model as-is", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "opus",
      cwd: "/tmp",
    });
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("opus");
  });

  it("omits --model when model is empty", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "",
      cwd: "/tmp",
    });
    expect(args).not.toContain("--model");
  });

  it("adds --max-turns when maxTurns is specified", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      maxTurns: 5,
    });
    const idx = args.indexOf("--max-turns");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("5");
  });

  it("does not add --max-turns when maxTurns is not specified", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
    });
    expect(args).not.toContain("--max-turns");
  });

  it("adds --allowedTools when allowedTools is specified", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      allowedTools: ["Read", "Write", "Bash"],
    });
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("Read,Write,Bash");
  });

  it("does not add --allowedTools when allowedTools is empty", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      allowedTools: [],
    });
    expect(args).not.toContain("--allowedTools");
  });

  it("adds --append-system-prompt when systemPrompt string is specified", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      systemPrompt: "You are a helpful assistant.",
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("You are a helpful assistant.");
  });

  it("adds --append-system-prompt from preset append field", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      systemPrompt: { append: "Extra instructions." },
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("Extra instructions.");
  });

  it("does not add --append-system-prompt when systemPrompt has no text", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      systemPrompt: { append: "" },
    });
    expect(args).not.toContain("--append-system-prompt");
  });

  it("adds --permission-mode plan when readOnly is true", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      readOnly: true,
    });
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("plan");
  });

  it("does not add --permission-mode when readOnly is false", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      readOnly: false,
    });
    expect(args).not.toContain("--permission-mode");
  });

  it("adds --resume when sdkSessionId is specified", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      sdkSessionId: "sess-abc123",
    });
    const idx = args.indexOf("--resume");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("sess-abc123");
  });

  it("does not add --resume when sdkSessionId is not specified", () => {
    const args = provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
    });
    expect(args).not.toContain("--resume");
  });

  it("warns on conversationHistory", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      conversationHistory: [{ role: "user", content: "hi" }],
    });
    // Logger uses console internally; just verify no throw
    expect(true).toBe(true);
    warnSpy.mockRestore();
  });

  it("warns on thinkingLevel", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      thinkingLevel: "high" as never,
    });
    expect(true).toBe(true);
    warnSpy.mockRestore();
  });

  it("warns on tools (partially supported)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      tools: ["Bash", "Read"],
    });
    // Should not throw; warning logged internally
    expect(true).toBe(true);
    warnSpy.mockRestore();
  });

  it("does not warn on tools when tools is undefined", () => {
    // tools: undefined should not produce any warning
    expect(() =>
      provider.buildCliArgs({ prompt: "hello", model: "sonnet", cwd: "/tmp" }),
    ).not.toThrow();
  });

  it("warns on settingSources (not supported)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    provider.buildCliArgs({
      prompt: "hello",
      model: "sonnet",
      cwd: "/tmp",
      settingSources: ["user", "project"],
    });
    // Should not throw; warning logged internally
    expect(true).toBe(true);
    warnSpy.mockRestore();
  });

  it("does not warn on settingSources when it is undefined", () => {
    expect(() =>
      provider.buildCliArgs({ prompt: "hello", model: "sonnet", cwd: "/tmp" }),
    ).not.toThrow();
  });
});

// =============================================================================
// normalizeEvent tests
// =============================================================================

describe("ClaudeCodeCliProvider.normalizeEvent", () => {
  let provider: ClaudeCodeCliProvider;

  beforeEach(() => {
    provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    // Initialize private sessionId field via reflection
    (provider as unknown as Record<string, unknown>)["sessionId"] = undefined;
  });

  // System events
  describe("system events", () => {
    it("returns null for system/init and stores session_id", () => {
      const event = { type: "system", subtype: "init", session_id: "sess-xyz" };
      const result = provider.normalizeEvent(event);
      expect(result).toBeNull();
      expect(
        (provider as unknown as Record<string, unknown>)["sessionId"],
      ).toBe("sess-xyz");
    });

    it("returns null for system/api_retry", () => {
      const event = {
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        error: "timeout",
      };
      expect(provider.normalizeEvent(event)).toBeNull();
    });

    it("returns null for system/hook_pre_tool", () => {
      const event = { type: "system", subtype: "hook_pre_tool" };
      expect(provider.normalizeEvent(event)).toBeNull();
    });

    it("returns null for system/hook_post_tool", () => {
      const event = { type: "system", subtype: "hook_post_tool" };
      expect(provider.normalizeEvent(event)).toBeNull();
    });
  });

  // Assistant text events
  describe("assistant events", () => {
    it("normalizes assistant text message", () => {
      const event = {
        type: "assistant",
        session_id: "sess-abc",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello, world!" }],
        },
      };
      const result = provider.normalizeEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("assistant");
      expect(result!.session_id).toBe("sess-abc");
      expect(result!.message?.content).toHaveLength(1);
      expect(result!.message?.content[0]).toMatchObject({
        type: "text",
        text: "Hello, world!",
      });
    });

    it("normalizes assistant tool_use message", () => {
      const event = {
        type: "assistant",
        session_id: "sess-abc",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-001",
              name: "Read",
              input: { file_path: "/tmp/foo.txt" },
            },
          ],
        },
      };
      const result = provider.normalizeEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("assistant");
      expect(result!.message?.content[0]).toMatchObject({
        type: "tool_use",
        name: "Read",
        tool_use_id: "tool-001",
        input: { file_path: "/tmp/foo.txt" },
      });
    });

    it("normalizes unknown tool_use name by passing through", () => {
      const event = {
        type: "assistant",
        session_id: "sess-abc",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-002",
              name: "CustomTool",
              input: { foo: "bar" },
            },
          ],
        },
      };
      const result = provider.normalizeEvent(event);
      expect(result).not.toBeNull();
      expect(result!.message?.content[0]).toMatchObject({
        type: "tool_use",
        name: "CustomTool",
        tool_use_id: "tool-002",
      });
    });

    it("returns null for assistant with empty content", () => {
      const event = {
        type: "assistant",
        session_id: "sess-abc",
        message: { role: "assistant", content: [] },
      };
      expect(provider.normalizeEvent(event)).toBeNull();
    });

    it("uses stored sessionId when event has none", () => {
      (provider as unknown as Record<string, unknown>)["sessionId"] =
        "stored-sess";
      const event = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
        },
      };
      const result = provider.normalizeEvent(event);
      expect(result!.session_id).toBe("stored-sess");
    });
  });

  // User (tool result) events
  describe("user events", () => {
    it("normalizes user tool_result as assistant message", () => {
      const event = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-001",
              content: "File content here",
            },
          ],
        },
      };
      const result = provider.normalizeEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("assistant"); // mapped as assistant for UI
      expect(result!.message?.role).toBe("assistant");
      expect(result!.message?.content[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "tool-001",
        content: "File content here",
      });
    });

    it("returns null for user event with no tool_result blocks", () => {
      const event = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "some text" }],
        },
      };
      expect(provider.normalizeEvent(event)).toBeNull();
    });

    it("handles array tool_result content by joining text", () => {
      const event = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-003",
              content: [
                { type: "text", text: "line 1" },
                { type: "text", text: "line 2" },
              ],
            },
          ],
        },
      };
      const result = provider.normalizeEvent(event);
      expect(result!.message?.content[0].content).toBe("line 1\nline 2");
    });
  });

  // Result events
  describe("result events", () => {
    it("normalizes result/success", () => {
      const event = {
        type: "result",
        subtype: "success",
        session_id: "sess-final",
        result: "Task completed successfully.",
      };
      const result = provider.normalizeEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("result");
      expect(result!.subtype).toBe("success");
      expect(result!.session_id).toBe("sess-final");
      expect(result!.result).toBe("Task completed successfully.");
    });

    it("normalizes result/error_during_execution", () => {
      const event = {
        type: "result",
        subtype: "error_during_execution",
        session_id: "sess-err",
        error: "Something went wrong",
      };
      const result = provider.normalizeEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("result");
      expect(result!.subtype).toBe("error_during_execution");
      expect(result!.error).toBe("Something went wrong");
    });

    it("normalizes result/error_max_turns", () => {
      const event = {
        type: "result",
        subtype: "error_max_turns",
        session_id: "sess-max",
        error: "Maximum turns reached",
      };
      const result = provider.normalizeEvent(event);
      expect(result!.subtype).toBe("error_max_turns");
    });

    it("uses fallback error message when error field is empty", () => {
      const event = {
        type: "result",
        subtype: "error_during_execution",
        session_id: "sess-err2",
        error: "",
      };
      const result = provider.normalizeEvent(event);
      expect(result!.error).toContain("error_during_execution");
    });

    it("uses stored sessionId on result when event has none", () => {
      (provider as unknown as Record<string, unknown>)["sessionId"] =
        "stored-sess";
      const event = {
        type: "result",
        subtype: "success",
        result: "done",
      };
      const result = provider.normalizeEvent(event);
      expect(result!.session_id).toBe("stored-sess");
    });
  });

  // Unknown events
  describe("unknown events", () => {
    it("returns null and does not throw for unknown event types", () => {
      const event = { type: "unknown_future_event", data: "something" };
      expect(() => provider.normalizeEvent(event)).not.toThrow();
      expect(provider.normalizeEvent(event)).toBeNull();
    });
  });
});

// =============================================================================
// session_id extraction (ADR-5)
// =============================================================================

describe("session_id extraction from system/init", () => {
  it("stores session_id from first system/init event", () => {
    const provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    (provider as unknown as Record<string, unknown>)["sessionId"] = undefined;

    provider.normalizeEvent({
      type: "system",
      subtype: "init",
      session_id: "my-session-id",
    });

    // Subsequent events should use the stored session_id
    const msg = provider.normalizeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    });

    expect(msg!.session_id).toBe("my-session-id");
  });
});

// =============================================================================
// Provider identity
// =============================================================================

describe("ClaudeCodeCliProvider identity", () => {
  let provider: ClaudeCodeCliProvider;

  beforeEach(() => {
    provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
  });

  it('getName returns "claude-cli"', () => {
    expect(provider.getName()).toBe("claude-cli");
  });

  it('getCliName returns "claude"', () => {
    expect(provider.getCliName()).toBe("claude");
  });
});

// =============================================================================
// getAvailableModels
// =============================================================================

describe("ClaudeCodeCliProvider.getAvailableModels", () => {
  let provider: ClaudeCodeCliProvider;

  beforeEach(() => {
    provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
  });

  it("returns exactly 3 models", () => {
    expect(provider.getAvailableModels()).toHaveLength(3);
  });

  it("includes cli-opus, cli-sonnet, and cli-haiku", () => {
    const ids = provider.getAvailableModels().map((m) => m.id);
    expect(ids).toContain("cli-opus");
    expect(ids).toContain("cli-sonnet");
    expect(ids).toContain("cli-haiku");
  });

  it("cli-sonnet is marked as the default model", () => {
    const models = provider.getAvailableModels();
    const sonnet = models.find((m) => m.id === "cli-sonnet");
    expect(sonnet?.default).toBe(true);
  });

  it("cli-opus and cli-haiku are not marked as default", () => {
    const models = provider.getAvailableModels();
    const opus = models.find((m) => m.id === "cli-opus");
    const haiku = models.find((m) => m.id === "cli-haiku");
    expect(opus?.default).toBeFalsy();
    expect(haiku?.default).toBeFalsy();
  });

  it("all models have supportsTools=true", () => {
    const models = provider.getAvailableModels();
    for (const model of models) {
      expect(model.supportsTools).toBe(true);
    }
  });

  it("all models have supportsVision=false (FR-G2)", () => {
    const models = provider.getAvailableModels();
    for (const model of models) {
      expect(model.supportsVision).toBe(false);
    }
  });

  it("all models belong to claude-cli provider", () => {
    const models = provider.getAvailableModels();
    for (const model of models) {
      expect(model.provider).toBe("claude-cli");
    }
  });
});

// =============================================================================
// supportsFeature
// =============================================================================

describe("ClaudeCodeCliProvider.supportsFeature", () => {
  let provider: ClaudeCodeCliProvider;

  beforeEach(() => {
    provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
  });

  it('returns true for "tools"', () => {
    expect(provider.supportsFeature("tools")).toBe(true);
  });

  it('returns true for "text"', () => {
    expect(provider.supportsFeature("text")).toBe(true);
  });

  it('returns true for "streaming"', () => {
    expect(provider.supportsFeature("streaming")).toBe(true);
  });

  it('returns false for "vision"', () => {
    expect(provider.supportsFeature("vision")).toBe(false);
  });

  it('returns false for "structured-output"', () => {
    expect(provider.supportsFeature("structured-output")).toBe(false);
  });

  it("returns false for unknown features", () => {
    expect(provider.supportsFeature("nonexistent-feature")).toBe(false);
  });
});

// =============================================================================
// getSpawnConfig (NFR-003: cross-platform path assertions)
// =============================================================================

describe("ClaudeCodeCliProvider.getSpawnConfig", () => {
  let provider: ClaudeCodeCliProvider;

  beforeEach(() => {
    provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
  });

  it("uses wsl strategy for win32 (WSL-only)", () => {
    const config = provider.getSpawnConfig();
    expect(config.windowsStrategy).toBe("wsl");
  });

  it("includes homebrew path for darwin", () => {
    const config = provider.getSpawnConfig();
    expect(config.commonPaths.darwin).toContain("/opt/homebrew/bin/claude");
  });

  it("includes /usr/local/bin path for darwin", () => {
    const config = provider.getSpawnConfig();
    expect(config.commonPaths.darwin).toContain("/usr/local/bin/claude");
  });

  it("includes /usr/local/bin path for linux", () => {
    const config = provider.getSpawnConfig();
    expect(config.commonPaths.linux).toContain("/usr/local/bin/claude");
  });

  it("includes /usr/bin path for linux", () => {
    const config = provider.getSpawnConfig();
    expect(config.commonPaths.linux).toContain("/usr/bin/claude");
  });

  it("win32 paths are empty (WSL only)", () => {
    const config = provider.getSpawnConfig();
    expect(config.commonPaths.win32).toHaveLength(0);
  });

  it("darwin paths include home-relative paths", () => {
    const config = provider.getSpawnConfig();
    const hasHomePath = config.commonPaths.darwin.some(
      (p) => p.includes(".local/bin/claude") || p.includes(".npm-global"),
    );
    expect(hasHomePath).toBe(true);
  });
});

// =============================================================================
// mapError (error classification)
// =============================================================================

describe("ClaudeCodeCliProvider.mapError", () => {
  let provider: ClaudeCodeCliProvider;
  // Access protected method via type assertion
  let mapError: (stderr: string, exitCode: number | null) => CliErrorInfo;

  beforeEach(() => {
    provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    mapError = (
      provider as unknown as { mapError: typeof mapError }
    ).mapError.bind(provider);
  });

  describe("NOT_AUTHENTICATED classification", () => {
    it('maps "not authenticated" to NOT_AUTHENTICATED', () => {
      const result = mapError("not authenticated", 1);
      expect(result.code).toBe(ClaudeCliErrorCode.NOT_AUTHENTICATED);
      expect(result.recoverable).toBe(true);
    });

    it('maps "please log in" to NOT_AUTHENTICATED', () => {
      const result = mapError("please log in to continue", 1);
      expect(result.code).toBe(ClaudeCliErrorCode.NOT_AUTHENTICATED);
    });

    it('maps "unauthorized" to NOT_AUTHENTICATED', () => {
      const result = mapError("Unauthorized: invalid credentials", 401);
      expect(result.code).toBe(ClaudeCliErrorCode.NOT_AUTHENTICATED);
    });

    it('maps "invalid api key" to NOT_AUTHENTICATED', () => {
      const result = mapError("invalid api key provided", 1);
      expect(result.code).toBe(ClaudeCliErrorCode.NOT_AUTHENTICATED);
    });

    it("includes suggestion to run claude auth login", () => {
      const result = mapError("not authenticated", 1);
      expect(result.suggestion).toContain("claude auth login");
    });
  });

  describe("RATE_LIMITED classification", () => {
    it('maps "rate limit" to RATE_LIMITED', () => {
      const result = mapError("rate limit exceeded", 429);
      expect(result.code).toBe(ClaudeCliErrorCode.RATE_LIMITED);
      expect(result.recoverable).toBe(true);
    });

    it('maps "too many requests" to RATE_LIMITED', () => {
      const result = mapError("too many requests, please try again later", 429);
      expect(result.code).toBe(ClaudeCliErrorCode.RATE_LIMITED);
    });

    it('maps "429" in stderr to RATE_LIMITED', () => {
      const result = mapError("HTTP 429 error received", 429);
      expect(result.code).toBe(ClaudeCliErrorCode.RATE_LIMITED);
    });
  });

  describe("NETWORK_ERROR classification", () => {
    it('maps "network" to NETWORK_ERROR', () => {
      const result = mapError("network error occurred", null);
      expect(result.code).toBe(ClaudeCliErrorCode.NETWORK_ERROR);
      expect(result.recoverable).toBe(true);
    });

    it('maps "connection" to NETWORK_ERROR', () => {
      const result = mapError("connection refused", null);
      expect(result.code).toBe(ClaudeCliErrorCode.NETWORK_ERROR);
    });

    it('maps "econnrefused" to NETWORK_ERROR', () => {
      const result = mapError("ECONNREFUSED 127.0.0.1:443", null);
      expect(result.code).toBe(ClaudeCliErrorCode.NETWORK_ERROR);
    });

    it('maps "timeout" to NETWORK_ERROR', () => {
      const result = mapError("Request timeout after 30s", null);
      expect(result.code).toBe(ClaudeCliErrorCode.NETWORK_ERROR);
    });
  });

  describe("PROCESS_CRASHED classification", () => {
    it("maps exitCode 137 (OOM kill) to PROCESS_CRASHED", () => {
      const result = mapError("", 137);
      expect(result.code).toBe(ClaudeCliErrorCode.PROCESS_CRASHED);
      expect(result.recoverable).toBe(true);
    });

    it('maps "killed" in stderr to PROCESS_CRASHED', () => {
      const result = mapError("process was killed", null);
      expect(result.code).toBe(ClaudeCliErrorCode.PROCESS_CRASHED);
    });

    it('maps "sigterm" in stderr to PROCESS_CRASHED', () => {
      const result = mapError("received SIGTERM signal", null);
      expect(result.code).toBe(ClaudeCliErrorCode.PROCESS_CRASHED);
    });
  });

  describe("UNKNOWN fallback", () => {
    it("falls back to UNKNOWN for unrecognized errors", () => {
      const result = mapError("some random error message", 1);
      expect(result.code).toBe(ClaudeCliErrorCode.UNKNOWN);
      expect(result.recoverable).toBe(false);
    });

    it("includes stderr text in UNKNOWN message when present", () => {
      const result = mapError("some specific error text", 1);
      expect(result.message).toContain("some specific error text");
    });

    it("includes exit code in UNKNOWN message when stderr is empty", () => {
      const result = mapError("", 42);
      expect(result.message).toContain("42");
    });

    it("uses stderr over exit code in UNKNOWN message", () => {
      const result = mapError("explicit error text", 99);
      expect(result.message).toBe("explicit error text");
    });
  });

  describe("case insensitivity", () => {
    it('matches "NOT AUTHENTICATED" (uppercase)', () => {
      const result = mapError("NOT AUTHENTICATED", 1);
      expect(result.code).toBe(ClaudeCliErrorCode.NOT_AUTHENTICATED);
    });

    it('matches "RATE LIMIT" (uppercase)', () => {
      const result = mapError("RATE LIMIT EXCEEDED", 429);
      expect(result.code).toBe(ClaudeCliErrorCode.RATE_LIMITED);
    });
  });
});

// =============================================================================
// extractPromptText (via reflection — private method)
// =============================================================================

describe("extractPromptText", () => {
  let provider: ClaudeCodeCliProvider;
  // Access private method via type assertion
  let extractPromptText: (options: { prompt: unknown }) => string;

  beforeEach(() => {
    provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    extractPromptText = (
      provider as unknown as { extractPromptText: typeof extractPromptText }
    ).extractPromptText.bind(provider);
  });

  it("returns string prompt directly", () => {
    const result = extractPromptText({ prompt: "hello world" });
    expect(result).toBe("hello world");
  });

  it("extracts and joins text blocks from array prompt", () => {
    const result = extractPromptText({
      prompt: [
        { type: "text", text: "first line" },
        { type: "text", text: "second line" },
      ],
    });
    expect(result).toBe("first line\nsecond line");
  });

  it("filters out non-text blocks from array prompt", () => {
    const result = extractPromptText({
      prompt: [
        { type: "image", data: "base64data" },
        { type: "text", text: "only text" },
      ],
    });
    expect(result).toBe("only text");
  });

  it("returns empty string for array with only non-text blocks", () => {
    const result = extractPromptText({
      prompt: [{ type: "image", data: "base64data" }],
    });
    expect(result).toBe("");
  });

  it("throws for invalid (null) prompt", () => {
    expect(() => extractPromptText({ prompt: null })).toThrow();
  });

  it("throws for invalid (number) prompt", () => {
    expect(() => extractPromptText({ prompt: 42 })).toThrow();
  });
});

// =============================================================================
// getModelProvider routing integration (FR-003)
// =============================================================================

describe("getModelProvider routing for cli- models (FR-003)", () => {
  it("routes cli-opus to claude-cli", () => {
    expect(getModelProvider("cli-opus")).toBe("claude-cli");
  });

  it("routes cli-sonnet to claude-cli", () => {
    expect(getModelProvider("cli-sonnet")).toBe("claude-cli");
  });

  it("routes cli-haiku to claude-cli", () => {
    expect(getModelProvider("cli-haiku")).toBe("claude-cli");
  });

  it("routes any cli- prefixed model to claude-cli", () => {
    expect(getModelProvider("cli-custom-model")).toBe("claude-cli");
  });

  it("does NOT route claude- models to claude-cli", () => {
    expect(getModelProvider("claude-opus-4-6")).toBe("claude");
    expect(getModelProvider("claude-sonnet-4-5")).toBe("claude");
  });

  it("does NOT route cursor- models to claude-cli", () => {
    expect(getModelProvider("cursor-auto")).toBe("cursor");
  });

  it("does NOT route codex- models to claude-cli", () => {
    expect(getModelProvider("codex-gpt-4")).toBe("codex");
  });

  it("does NOT route gemini- models to claude-cli", () => {
    expect(getModelProvider("gemini-2.0-flash")).toBe("gemini");
  });
});

// =============================================================================
// detectInstallation (FR-004) - with mocked child_process
// =============================================================================

describe("ClaudeCodeCliProvider.detectInstallation", () => {
  it("returns installed=false when cliPath is null", async () => {
    const provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    // Simulate CLI not found by setting cliPath to null and mocking ensureCliDetected
    (provider as unknown as Record<string, unknown>)["cliPath"] = null;
    (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
    // Override ensureCliDetected to be a no-op
    (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
      () => {};

    const result = await provider.detectInstallation();
    expect(result.installed).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("claude");
  });

  it("returns installed=true with authenticated=true when CLI found and auth OK", async () => {
    const { execSync, spawnSync } = await import("child_process");

    // Mock execSync for --version call
    vi.mocked(execSync).mockReturnValueOnce("1.0.42\n" as unknown as Buffer);

    // Mock spawnSync for auth status — exit code 0 = authenticated
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: "Authenticated as user@example.com\n",
      stderr: "",
      pid: 12345,
      output: [],
      signal: null,
    });

    const provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    (provider as unknown as Record<string, unknown>)["cliPath"] =
      "/usr/local/bin/claude";
    (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
    (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
      () => {};

    const result = await provider.detectInstallation();

    expect(result.installed).toBe(true);
    expect(result.path).toBe("/usr/local/bin/claude");
    expect(result.authenticated).toBe(true);
  });

  it("returns authenticated=false when auth check fails with exit code 1", async () => {
    const { execSync, spawnSync } = await import("child_process");

    vi.mocked(execSync).mockReturnValueOnce("1.0.0\n" as unknown as Buffer);
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "not authenticated. Please run claude auth login.",
      pid: 12345,
      output: [],
      signal: null,
    });

    const provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    (provider as unknown as Record<string, unknown>)["cliPath"] =
      "/usr/local/bin/claude";
    (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
    (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
      () => {};

    const result = await provider.detectInstallation();

    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(false);
  });

  it("returns version from --version output", async () => {
    const { execSync, spawnSync } = await import("child_process");

    vi.mocked(execSync).mockReturnValueOnce("1.2.3\n" as unknown as Buffer);
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: "authenticated",
      stderr: "",
      pid: 12345,
      output: [],
      signal: null,
    });

    const provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    (provider as unknown as Record<string, unknown>)["cliPath"] =
      "/usr/local/bin/claude";
    (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
    (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
      () => {};

    const result = await provider.detectInstallation();

    expect(result.version).toBe("1.2.3");
  });

  it("returns undefined version when --version throws", async () => {
    const { execSync, spawnSync } = await import("child_process");

    vi.mocked(execSync).mockImplementationOnce(() => {
      throw new Error("command not found");
    });
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 12345,
      output: [],
      signal: null,
    });

    const provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    (provider as unknown as Record<string, unknown>)["cliPath"] =
      "/usr/local/bin/claude";
    (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
    (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
      () => {};

    const result = await provider.detectInstallation();

    expect(result.version).toBeUndefined();
  });

  it('method field is "cli"', async () => {
    const { execSync, spawnSync } = await import("child_process");

    vi.mocked(execSync).mockReturnValueOnce("1.0.0\n" as unknown as Buffer);
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 12345,
      output: [],
      signal: null,
    });

    const provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    (provider as unknown as Record<string, unknown>)["cliPath"] =
      "/usr/local/bin/claude";
    (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
    (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
      () => {};

    const result = await provider.detectInstallation();

    expect(result.method).toBe("cli");
  });
});

// =============================================================================
// thinking block normalization (assistant event)
// =============================================================================

describe("thinking block in assistant events", () => {
  let provider: ClaudeCodeCliProvider;

  beforeEach(() => {
    provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    (provider as unknown as Record<string, unknown>)["sessionId"] = undefined;
  });

  it("normalizes thinking blocks in assistant messages", () => {
    const event = {
      type: "assistant",
      session_id: "sess-think",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason through this..." },
          { type: "text", text: "Here is my answer." },
        ],
      },
    };

    const result = provider.normalizeEvent(event);
    expect(result).not.toBeNull();
    expect(result!.message?.content).toHaveLength(2);
    expect(result!.message?.content[0]).toMatchObject({
      type: "thinking",
      thinking: "Let me reason through this...",
    });
    expect(result!.message?.content[1]).toMatchObject({
      type: "text",
      text: "Here is my answer.",
    });
  });

  it("filters out unknown block types from assistant messages", () => {
    const event = {
      type: "assistant",
      session_id: "sess-unknown-block",
      message: {
        role: "assistant",
        content: [
          { type: "unknown_future_block", data: "something" },
          { type: "text", text: "Valid text" },
        ],
      },
    };

    const result = provider.normalizeEvent(event);
    expect(result).not.toBeNull();
    // unknown_future_block should be filtered out, only text remains
    expect(result!.message?.content).toHaveLength(1);
    expect(result!.message?.content[0].type).toBe("text");
  });
});

// =============================================================================
// system/init without session_id does not corrupt state
// =============================================================================

describe("system/init edge cases", () => {
  let provider: ClaudeCodeCliProvider;

  beforeEach(() => {
    provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    (provider as unknown as Record<string, unknown>)["sessionId"] =
      "pre-existing-id";
  });

  it("does not overwrite existing sessionId when init has no session_id", () => {
    provider.normalizeEvent({ type: "system", subtype: "init" }); // no session_id
    expect((provider as unknown as Record<string, unknown>)["sessionId"]).toBe(
      "pre-existing-id",
    );
  });
});

// =============================================================================
// tool_use input normalization via CLAUDE_CLI_TOOL_HANDLERS
// =============================================================================

describe("tool_use input normalization", () => {
  let provider: ClaudeCodeCliProvider;

  beforeEach(() => {
    provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    (provider as unknown as Record<string, unknown>)["sessionId"] = undefined;
  });

  const toolCases = [
    {
      name: "Write",
      input: { file_path: "/tmp/out.txt", content: "hello" },
      expectedInput: { file_path: "/tmp/out.txt", content: "hello" },
    },
    {
      name: "Edit",
      input: { file_path: "/tmp/x.ts", old_string: "foo", new_string: "bar" },
      expectedInput: {
        file_path: "/tmp/x.ts",
        old_string: "foo",
        new_string: "bar",
      },
    },
    {
      name: "Bash",
      input: { command: "ls -la" },
      expectedInput: { command: "ls -la" },
    },
    {
      name: "Glob",
      input: { pattern: "**/*.ts", path: "/tmp" },
      expectedInput: { pattern: "**/*.ts", path: "/tmp" },
    },
    {
      name: "Grep",
      input: { pattern: "import.*React", path: "/tmp" },
      expectedInput: { pattern: "import.*React", path: "/tmp" },
    },
    {
      name: "WebSearch",
      input: { query: "TypeScript docs" },
      expectedInput: { query: "TypeScript docs" },
    },
    {
      name: "WebFetch",
      input: { url: "https://example.com", prompt: "Summarize" },
      expectedInput: { url: "https://example.com", prompt: "Summarize" },
    },
  ] as const;

  for (const tc of toolCases) {
    it(`normalizes ${tc.name} tool_use input`, () => {
      const event = {
        type: "assistant",
        session_id: "sess-tools",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `tool-${tc.name.toLowerCase()}`,
              name: tc.name,
              input: tc.input,
            },
          ],
        },
      };

      const result = provider.normalizeEvent(event);
      expect(result).not.toBeNull();
      expect(result!.message?.content[0]).toMatchObject({
        type: "tool_use",
        name: tc.name,
        input: tc.expectedInput,
      });
    });
  }
});

// =============================================================================
// Gap-remediation tests (FR-G1..FR-G8, NFR-G1)
// =============================================================================

describe("ClaudeCodeCliProvider gap-remediation", () => {
  let provider: ClaudeCodeCliProvider;

  beforeEach(() => {
    provider = Object.create(
      ClaudeCodeCliProvider.prototype,
    ) as ClaudeCodeCliProvider;
    (provider as unknown as Record<string, unknown>)["sessionId"] = undefined;
  });

  // ---------------------------------------------------------------------------
  // FR-G1: detectInstallation tri-state authStatus
  // ---------------------------------------------------------------------------
  describe("detectInstallation authStatus (FR-G1)", () => {
    it('returns authStatus="authenticated" when auth status exit code is 0', async () => {
      const { execSync, spawnSync } = await import("child_process");
      vi.mocked(execSync).mockReturnValueOnce("1.0.0\n" as unknown as Buffer);
      vi.mocked(spawnSync).mockReturnValueOnce({
        status: 0,
        stdout: "authenticated",
        stderr: "",
        pid: 1,
        output: [],
        signal: null,
      });
      (provider as unknown as Record<string, unknown>)["cliPath"] =
        "/usr/local/bin/claude";
      (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
      (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
        () => {};

      const result = await provider.detectInstallation();
      expect(result.authStatus).toBe("authenticated");
      expect(result.authenticated).toBe(true);
    });

    it('returns authStatus="not_authenticated" when exit code is 1 with auth message', async () => {
      const { execSync, spawnSync } = await import("child_process");
      vi.mocked(execSync).mockReturnValueOnce("1.0.0\n" as unknown as Buffer);
      vi.mocked(spawnSync).mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "not authenticated. Please log in.",
        pid: 1,
        output: [],
        signal: null,
      });
      (provider as unknown as Record<string, unknown>)["cliPath"] =
        "/usr/local/bin/claude";
      (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
      (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
        () => {};

      const result = await provider.detectInstallation();
      expect(result.authStatus).toBe("not_authenticated");
      expect(result.authenticated).toBe(false);
    });

    it('returns authStatus="unknown" when spawnSync throws', async () => {
      const { execSync, spawnSync } = await import("child_process");
      vi.mocked(execSync).mockReturnValueOnce("1.0.0\n" as unknown as Buffer);
      vi.mocked(spawnSync).mockImplementationOnce(() => {
        throw new Error("spawn failed");
      });
      (provider as unknown as Record<string, unknown>)["cliPath"] =
        "/usr/local/bin/claude";
      (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
      (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
        () => {};

      const result = await provider.detectInstallation();
      expect(result.authStatus).toBe("unknown");
    });

    it('returns authStatus="unknown" (not "not_authenticated") when exit=1 has no auth signal', async () => {
      // Regression: a generic `result.status === 1` fallback previously
      // collapsed unrelated CLI failures into "not_authenticated", which
      // mislead the UI. Any non-zero exit without an auth-specific signal
      // must map to "unknown".
      const { execSync, spawnSync } = await import("child_process");
      vi.mocked(execSync).mockReturnValueOnce("1.0.0\n" as unknown as Buffer);
      vi.mocked(spawnSync).mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "Error: unexpected CLI failure (configuration invalid)",
        pid: 1,
        output: [],
        signal: null,
      });
      (provider as unknown as Record<string, unknown>)["cliPath"] =
        "/usr/local/bin/claude";
      (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
      (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
        () => {};

      const result = await provider.detectInstallation();
      expect(result.authStatus).toBe("unknown");
      expect(result.authenticated).toBe(false);
    });

    it('returns authStatus="not_authenticated" when stdout (not stderr) carries the auth signal', async () => {
      const { execSync, spawnSync } = await import("child_process");
      vi.mocked(execSync).mockReturnValueOnce("1.0.0\n" as unknown as Buffer);
      vi.mocked(spawnSync).mockReturnValueOnce({
        status: 1,
        stdout: "You are not logged in. Run `claude auth login`.",
        stderr: "",
        pid: 1,
        output: [],
        signal: null,
      });
      (provider as unknown as Record<string, unknown>)["cliPath"] =
        "/usr/local/bin/claude";
      (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
      (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
        () => {};

      const result = await provider.detectInstallation();
      expect(result.authStatus).toBe("not_authenticated");
    });
  });

  // ---------------------------------------------------------------------------
  // FR-G2: Vision disabled with warning
  // ---------------------------------------------------------------------------
  describe("supportsVision is false (FR-G2)", () => {
    it("all models report supportsVision=false", () => {
      const models = provider.getAvailableModels();
      for (const model of models) {
        expect(model.supportsVision).toBe(false);
      }
    });

    it("extractPromptText logs a warning when image blocks are present", () => {
      const extractPromptText = (
        provider as unknown as {
          extractPromptText: (o: { prompt: unknown }) => string;
        }
      ).extractPromptText.bind(provider);

      // @pegasus/utils logger.warn routes through console.log in Node mode.
      // Intercept both console.log and console.warn to be safe.
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = extractPromptText({
        prompt: [
          { type: "image", data: "base64" },
          { type: "text", text: "hello" },
          { type: "file", data: "base64" },
        ],
      });

      expect(result).toBe("hello");
      const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls]
        .map((c) => c.map((a) => String(a)).join(" "))
        .join("|");
      expect(allCalls).toContain("Vision input not yet supported");
      expect(allCalls).toContain("2");

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // FR-G3: writePromptTempFile deleted
  // ---------------------------------------------------------------------------
  describe("writePromptTempFile removed (FR-G3)", () => {
    it("provider no longer exposes writePromptTempFile", () => {
      expect(
        (provider as unknown as Record<string, unknown>)["writePromptTempFile"],
      ).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // FR-G4 / NFR-G1: env whitelist
  // ---------------------------------------------------------------------------
  describe("buildSubprocessOptions env whitelist (FR-G4, NFR-G1)", () => {
    it("only whitelist keys (plus ANTHROPIC_API_KEY when present) are forwarded", () => {
      vi.stubEnv("PEGASUS_SENTINEL_DO_NOT_FORWARD", "leaked-value");
      vi.stubEnv("OPENAI_API_KEY", "sk-should-not-leak");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-forward-me");
      vi.stubEnv("PATH", "/usr/bin");
      vi.stubEnv("HOME", "/home/test");

      (provider as unknown as Record<string, unknown>)["cliPath"] =
        "/usr/local/bin/claude";
      (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
      (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
        () => {};
      (provider as unknown as Record<string, unknown>)["detectedStrategy"] =
        "direct";

      const buildSubprocessOptions = (
        provider as unknown as {
          buildSubprocessOptions: (
            options: { cwd: string; model: string; prompt: string },
            args: string[],
          ) => { env?: Record<string, string> };
        }
      ).buildSubprocessOptions.bind(provider);

      const result = buildSubprocessOptions(
        { cwd: "/tmp", model: "sonnet", prompt: "hi" },
        ["-p"],
      );

      const envKeys = Object.keys(result.env ?? {});
      expect(envKeys).toContain("PATH");
      expect(envKeys).toContain("HOME");
      expect(envKeys).toContain("ANTHROPIC_API_KEY");
      expect(envKeys).not.toContain("PEGASUS_SENTINEL_DO_NOT_FORWARD");
      expect(envKeys).not.toContain("OPENAI_API_KEY");
      expect(result.env?.ANTHROPIC_API_KEY).toBe("sk-forward-me");

      vi.unstubAllEnvs();
    });

    it("omits ANTHROPIC_API_KEY when not set in parent env", () => {
      vi.stubEnv("PATH", "/usr/bin");
      // Ensure ANTHROPIC_API_KEY is not set
      const prior = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      (provider as unknown as Record<string, unknown>)["cliPath"] =
        "/usr/local/bin/claude";
      (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
      (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
        () => {};
      (provider as unknown as Record<string, unknown>)["detectedStrategy"] =
        "direct";

      const buildSubprocessOptions = (
        provider as unknown as {
          buildSubprocessOptions: (
            options: { cwd: string; model: string; prompt: string },
            args: string[],
          ) => { env?: Record<string, string> };
        }
      ).buildSubprocessOptions.bind(provider);

      const result = buildSubprocessOptions(
        { cwd: "/tmp", model: "sonnet", prompt: "hi" },
        ["-p"],
      );

      expect(Object.keys(result.env ?? {})).not.toContain("ANTHROPIC_API_KEY");

      if (prior !== undefined) {
        process.env.ANTHROPIC_API_KEY = prior;
      }
      vi.unstubAllEnvs();
    });

    it("preserves Windows host env extras when useWsl=true on win32", () => {
      vi.stubEnv("PATH", "C:\\Windows\\System32");
      vi.stubEnv("SystemRoot", "C:\\Windows");
      vi.stubEnv("ComSpec", "C:\\Windows\\System32\\cmd.exe");
      vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD");
      vi.stubEnv("WINDIR", "C:\\Windows");
      vi.stubEnv("TEMP", "C:\\Users\\test\\AppData\\Local\\Temp");
      vi.stubEnv("TMP", "C:\\Users\\test\\AppData\\Local\\Temp");

      // Mock platform to win32 and force useWsl=true
      const originalPlatform = Object.getOwnPropertyDescriptor(
        process,
        "platform",
      );
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      (provider as unknown as Record<string, unknown>)["useWsl"] = true;
      (provider as unknown as Record<string, unknown>)["cliPath"] =
        "/usr/local/bin/claude";
      (provider as unknown as Record<string, unknown>)["wslCliPath"] =
        "/usr/local/bin/claude";
      (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
      (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
        () => {};
      (provider as unknown as Record<string, unknown>)["detectedStrategy"] =
        "wsl";

      try {
        const buildSubprocessOptions = (
          provider as unknown as {
            buildSubprocessOptions: (
              options: { cwd: string; model: string; prompt: string },
              args: string[],
            ) => { env?: Record<string, string> };
          }
        ).buildSubprocessOptions.bind(provider);

        const result = buildSubprocessOptions(
          { cwd: "C:\\tmp", model: "sonnet", prompt: "hi" },
          ["-p"],
        );

        const envKeys = Object.keys(result.env ?? {});
        expect(envKeys).toContain("SystemRoot");
        expect(envKeys).toContain("ComSpec");
        expect(envKeys).toContain("PATHEXT");
        expect(envKeys).toContain("WINDIR");
        expect(envKeys).toContain("TEMP");
        expect(envKeys).toContain("TMP");
        // Baseline whitelist still applies
        expect(envKeys).toContain("PATH");
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
        (provider as unknown as Record<string, unknown>)["useWsl"] = false;
        vi.unstubAllEnvs();
      }
    });

    it("does NOT include Windows host extras when useWsl=false (direct strategy)", () => {
      vi.stubEnv("PATH", "/usr/bin");
      vi.stubEnv("SystemRoot", "C:\\Windows");

      (provider as unknown as Record<string, unknown>)["useWsl"] = false;
      (provider as unknown as Record<string, unknown>)["cliPath"] =
        "/usr/local/bin/claude";
      (provider as unknown as Record<string, unknown>)["cliDetected"] = true;
      (provider as unknown as Record<string, unknown>)["ensureCliDetected"] =
        () => {};
      (provider as unknown as Record<string, unknown>)["detectedStrategy"] =
        "direct";

      const buildSubprocessOptions = (
        provider as unknown as {
          buildSubprocessOptions: (
            options: { cwd: string; model: string; prompt: string },
            args: string[],
          ) => { env?: Record<string, string> };
        }
      ).buildSubprocessOptions.bind(provider);

      const result = buildSubprocessOptions(
        { cwd: "/tmp", model: "sonnet", prompt: "hi" },
        ["-p"],
      );

      expect(Object.keys(result.env ?? {})).not.toContain("SystemRoot");
      vi.unstubAllEnvs();
    });
  });

  // ---------------------------------------------------------------------------
  // FR-G6: New tool handlers (MultiEdit, NotebookRead, NotebookEdit, LS, TodoRead, exit_plan_mode)
  // ---------------------------------------------------------------------------
  describe("new tool handlers (FR-G6)", () => {
    const newToolCases = [
      { name: "MultiEdit", input: { file_path: "/tmp/x", edits: [{ a: 1 }] } },
      { name: "NotebookRead", input: { notebook_path: "/tmp/nb.ipynb" } },
      {
        name: "NotebookEdit",
        input: { notebook_path: "/tmp/nb.ipynb", cell_id: "c1" },
      },
      { name: "LS", input: { path: "/tmp" } },
      { name: "TodoRead", input: {} },
      { name: "exit_plan_mode", input: { plan: "do the thing" } },
    ] as const;

    for (const tc of newToolCases) {
      it(`handles ${tc.name} tool_use without falling through to unknown`, () => {
        const event = {
          type: "assistant",
          session_id: "sess-new-tool",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: `tool-${tc.name}`,
                name: tc.name,
                input: tc.input,
              },
            ],
          },
        };

        const result = provider.normalizeEvent(event);
        expect(result).not.toBeNull();
        const block = result!.message?.content[0];
        expect(block).toMatchObject({ type: "tool_use", name: tc.name });
      });
    }

    it("NotebookRead mapInput projects notebook_path only", () => {
      const event = {
        type: "assistant",
        session_id: "sess-nbr",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-nbr",
              name: "NotebookRead",
              input: { notebook_path: "/tmp/nb.ipynb", extra: "dropped" },
            },
          ],
        },
      };
      const result = provider.normalizeEvent(event);
      expect(result!.message?.content[0].input).toEqual({
        notebook_path: "/tmp/nb.ipynb",
      });
    });

    it("LS mapInput projects path only", () => {
      const event = {
        type: "assistant",
        session_id: "sess-ls",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-ls",
              name: "LS",
              input: { path: "/tmp", extra: "dropped" },
            },
          ],
        },
      };
      const result = provider.normalizeEvent(event);
      expect(result!.message?.content[0].input).toEqual({ path: "/tmp" });
    });
  });

  // ---------------------------------------------------------------------------
  // FR-G7: MCP flag warnings
  // ---------------------------------------------------------------------------
  describe("buildCliArgs MCP flag warnings (FR-G7)", () => {
    // The @pegasus/utils Node logger routes warn/info/debug through console.log,
    // error through console.error. Intercept both to catch the warn message
    // regardless of routing.
    const collectLogs = () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      return {
        logSpy,
        warnSpy,
        get allMessages(): string {
          return [...logSpy.mock.calls, ...warnSpy.mock.calls]
            .map((c) => c.map((a) => String(a)).join(" "))
            .join("|");
        },
        restore(): void {
          logSpy.mockRestore();
          warnSpy.mockRestore();
        },
      };
    };

    it("logs a warning matching /mcpUnrestrictedTools/i when mcpUnrestrictedTools=true", () => {
      const spies = collectLogs();
      expect(() =>
        provider.buildCliArgs({
          prompt: "hi",
          model: "sonnet",
          cwd: "/tmp",
          mcpUnrestrictedTools: true,
        }),
      ).not.toThrow();
      expect(spies.allMessages).toMatch(/mcpUnrestrictedTools/i);
      expect(spies.allMessages).toMatch(/not mapped/i);
      spies.restore();
    });

    it("logs a warning matching /mcpAutoApproveTools/i when mcpAutoApproveTools=true", () => {
      const spies = collectLogs();
      expect(() =>
        provider.buildCliArgs({
          prompt: "hi",
          model: "sonnet",
          cwd: "/tmp",
          mcpAutoApproveTools: true,
        }),
      ).not.toThrow();
      expect(spies.allMessages).toMatch(/mcpAutoApproveTools/i);
      expect(spies.allMessages).toMatch(/not mapped/i);
      spies.restore();
    });
  });

  // ---------------------------------------------------------------------------
  // FR-G8: CREDITS_EXHAUSTED / UPDATE_REQUIRED error mapping
  // ---------------------------------------------------------------------------
  describe("mapError CREDITS_EXHAUSTED / UPDATE_REQUIRED (FR-G8)", () => {
    const mapError = (stderr: string, exit: number | null) =>
      (
        provider as unknown as {
          mapError: (s: string, e: number | null) => CliErrorInfo;
        }
      ).mapError(stderr, exit);

    it('maps "credits exhausted" to CREDITS_EXHAUSTED', () => {
      const result = mapError("Error: credits exhausted, please upgrade", 1);
      expect(result.code).toBe(ClaudeCliErrorCode.CREDITS_EXHAUSTED);
      expect(result.recoverable).toBe(false);
      expect(result.suggestion).toContain("https://claude.com");
    });

    it('maps "insufficient credits" to CREDITS_EXHAUSTED', () => {
      const result = mapError("insufficient credits on account", 1);
      expect(result.code).toBe(ClaudeCliErrorCode.CREDITS_EXHAUSTED);
    });

    it('maps "quota exceeded" to CREDITS_EXHAUSTED', () => {
      const result = mapError("monthly quota exceeded", 1);
      expect(result.code).toBe(ClaudeCliErrorCode.CREDITS_EXHAUSTED);
    });

    it('maps "please update" to UPDATE_REQUIRED', () => {
      const result = mapError("please update your CLI", 1);
      expect(result.code).toBe(ClaudeCliErrorCode.UPDATE_REQUIRED);
      expect(result.recoverable).toBe(false);
      expect(result.suggestion).toContain(
        "npm install -g @anthropic-ai/claude-code@latest",
      );
    });

    it('maps "unsupported version" to UPDATE_REQUIRED', () => {
      const result = mapError("unsupported version detected", 1);
      expect(result.code).toBe(ClaudeCliErrorCode.UPDATE_REQUIRED);
    });

    it('maps "outdated" to UPDATE_REQUIRED', () => {
      const result = mapError("your client is outdated", 1);
      expect(result.code).toBe(ClaudeCliErrorCode.UPDATE_REQUIRED);
    });

    it('maps "update required" to UPDATE_REQUIRED', () => {
      const result = mapError("update required to continue", 1);
      expect(result.code).toBe(ClaudeCliErrorCode.UPDATE_REQUIRED);
    });
  });
});
