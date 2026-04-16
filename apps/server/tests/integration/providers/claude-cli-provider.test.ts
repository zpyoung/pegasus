/**
 * Integration tests for ClaudeCodeCliProvider (FR-G9 / NFR-G3).
 *
 * These tests spawn a real subprocess (mock-claude.sh) that emulates the
 * `claude -p --output-format stream-json` JSONL interface, so the provider's
 * spawn / stream / abort / cleanup plumbing is exercised end-to-end without
 * requiring the real Claude CLI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { ClaudeCodeCliProvider } from "@/providers/claude-cli-provider.js";
import type { ProviderMessage, ExecuteOptions } from "@/providers/types.js";
import type { SubprocessOptions } from "@pegasus/platform";

const MOCK_PATH = path.resolve(__dirname, "../../fixtures/mock-claude.sh");

/**
 * Construct a provider with CLI detection bypassed so executeQuery spawns
 * the mock fixture directly instead of searching PATH.
 */
function makeProvider(): ClaudeCodeCliProvider {
  const provider = new ClaudeCodeCliProvider();
  // Bypass ensureCliDetected() — the base class skips detection if cliPath is set
  // or detectedStrategy differs from 'native'. We set both to force the short-circuit.
  (provider as unknown as { cliPath: string }).cliPath = MOCK_PATH;
  (provider as unknown as { detectedStrategy: string }).detectedStrategy =
    "direct";
  return provider;
}

/**
 * Wrap buildSubprocessOptions so MOCK_CLAUDE_MODE is passed through to the
 * subprocess. The provider enforces an env whitelist that strips everything
 * else, so we explicitly inject the test-control variable after the base call.
 */
function injectMockMode(provider: ClaudeCodeCliProvider, mode: string): void {
  const original = (
    provider as unknown as {
      buildSubprocessOptions: (
        o: ExecuteOptions,
        a: string[],
      ) => SubprocessOptions;
    }
  ).buildSubprocessOptions.bind(provider);

  vi.spyOn(
    provider as unknown as {
      buildSubprocessOptions: (
        o: ExecuteOptions,
        a: string[],
      ) => SubprocessOptions;
    },
    "buildSubprocessOptions",
  ).mockImplementation((options: ExecuteOptions, args: string[]) => {
    const subprocessOptions = original(options, args);
    subprocessOptions.env = {
      ...(subprocessOptions.env ?? {}),
      MOCK_CLAUDE_MODE: mode,
    };
    return subprocessOptions;
  });
}

async function collectMessages(
  provider: ClaudeCodeCliProvider,
  options: ExecuteOptions,
): Promise<ProviderMessage[]> {
  const messages: ProviderMessage[] = [];
  for await (const msg of provider.executeQuery(options)) {
    messages.push(msg);
  }
  return messages;
}

describe("ClaudeCodeCliProvider integration (mock executable)", () => {
  beforeEach(() => {
    // Sanity check: mock fixture must exist and be executable in every run
    expect(fs.existsSync(MOCK_PATH)).toBe(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Test 1: executes mock happy path and yields normalized messages", async () => {
    const provider = makeProvider();

    const start = Date.now();
    const messages = await collectMessages(provider, {
      prompt: "hello",
      model: "cli-sonnet",
      cwd: os.tmpdir(),
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);

    // First yielded message should be the assistant text event
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const first = messages[0];
    expect(first.type).toBe("assistant");
    if (first.type === "assistant") {
      const textBlock = first.message.content.find((b) => b.type === "text");
      expect(textBlock).toBeDefined();
      if (textBlock && textBlock.type === "text") {
        expect(textBlock.text).toBe("Hello from mock Claude");
      }
    }

    // Last message should be the success result with matching session_id
    const last = messages[messages.length - 1];
    expect(last.type).toBe("result");
    if (last.type === "result") {
      expect(last.subtype).toBe("success");
      expect(last.session_id).toBe("test-session-123");
    }

    // Every yielded message should carry the session_id (system/init is filtered
    // by normalizeEvent but attaches it onto subsequent messages)
    for (const msg of messages) {
      expect(msg.session_id).toBe("test-session-123");
    }
  });

  it("Test 2: abort signal terminates the subprocess cleanly", async () => {
    const provider = makeProvider();
    injectMockMode(provider, "slow");

    const abortController = new AbortController();
    const { execSync } = await import("child_process");

    const start = Date.now();
    const abortTimer = setTimeout(() => abortController.abort(), 500);

    let errorCaught: unknown = null;
    const messages: ProviderMessage[] = [];
    try {
      for await (const msg of provider.executeQuery({
        prompt: "please stall",
        model: "cli-sonnet",
        cwd: os.tmpdir(),
        abortController,
      })) {
        messages.push(msg);
      }
    } catch (err) {
      errorCaught = err;
    }
    clearTimeout(abortTimer);

    const elapsed = Date.now() - start;
    // Aborting a sleep-10 mock must NOT wait for the full 10s
    expect(elapsed).toBeLessThan(3000);

    // Either the generator returns cleanly (isAbortError branch) or the
    // AbortError is rethrown — both are acceptable for a consumer.
    if (errorCaught !== null) {
      const errMsg =
        errorCaught instanceof Error
          ? errorCaught.message
          : String(errorCaught);
      expect(errMsg.toLowerCase()).toMatch(
        /abort|signal|sigterm|killed|terminat/,
      );
    }

    // Give the OS up to 1s for SIGTERM/SIGKILL to be reaped
    await new Promise((r) => setTimeout(r, 1000));

    // No lingering mock-claude.sh process should still be running. Use ps to
    // probe; pgrep is not universally available on macOS/Linux CI images.
    let lingering = "";
    try {
      lingering = execSync(
        `ps -Ao pid=,command= | grep mock-claude.sh | grep -v grep`,
        {
          encoding: "utf8",
        },
      );
    } catch {
      // Non-zero exit (no match) — good, nothing lingering
      lingering = "";
    }
    expect(lingering.trim()).toBe("");
  });

  it("Test 3: preserves UTF-8 multi-byte characters through the JSONL stream", async () => {
    const provider = makeProvider();
    injectMockMode(provider, "utf8");

    const messages = await collectMessages(provider, {
      prompt: "hi",
      model: "cli-sonnet",
      cwd: os.tmpdir(),
    });

    const assistant = messages.find((m) => m.type === "assistant");
    expect(assistant).toBeDefined();
    if (assistant && assistant.type === "assistant") {
      const textBlock = assistant.message.content.find(
        (b) => b.type === "text",
      );
      expect(textBlock).toBeDefined();
      if (textBlock && textBlock.type === "text") {
        expect(textBlock.text).toBe("こんにちは 🚀");
        // No Unicode replacement character (U+FFFD) from a mis-decoded split
        expect(textBlock.text).not.toContain("\uFFFD");
      }
    }
  });

  it("Test 4: removes temp MCP config file even when buildSubprocessOptions throws", async () => {
    const provider = makeProvider();

    // Force buildSubprocessOptions to throw AFTER writeMcpConfig has run.
    // buildCliArgs() creates the temp file as a side-effect, so the cleanup
    // finally-block must still unlink it when the spawn path blows up.
    const throwSpy = vi
      .spyOn(
        provider as unknown as {
          buildSubprocessOptions: (
            o: ExecuteOptions,
            a: string[],
          ) => SubprocessOptions;
        },
        "buildSubprocessOptions",
      )
      .mockImplementation(() => {
        throw new Error("Simulated spawn setup failure");
      });

    const optionsWithMcp: ExecuteOptions = {
      prompt: "hi",
      model: "cli-sonnet",
      cwd: os.tmpdir(),
      mcpServers: {
        "test-server": {
          command: "echo",
          args: ["ok"],
        },
      },
    };

    let caught: unknown = null;
    try {
      for await (const _msg of provider.executeQuery(optionsWithMcp)) {
        void _msg;
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).message).toContain(
      "Simulated spawn setup failure",
    );

    // No pegasus-claude-mcp-*.json files should remain in tmpdir from this run
    const leftovers = fs
      .readdirSync(os.tmpdir())
      .filter(
        (name) =>
          name.startsWith("pegasus-claude-mcp-") && name.endsWith(".json"),
      );
    expect(leftovers).toEqual([]);

    throwSpy.mockRestore();
  });
});
