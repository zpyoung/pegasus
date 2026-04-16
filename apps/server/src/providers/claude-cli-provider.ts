/**
 * ClaudeCodeCliProvider - Executes queries using the `claude` CLI
 *
 * Extends CliProvider with Claude Code CLI-specific behavior:
 * - JSONL event normalization for `--output-format stream-json`
 * - Session ID extraction from system/init events
 * - CLI flag mapping from ExecuteOptions
 * - Installation detection with three-state auth status
 *
 * Routes via `cli-` model prefix (e.g., cli-opus, cli-sonnet, cli-haiku).
 * Auth is delegated entirely to Claude Code's own OAuth — no Pegasus credential management.
 *
 * @see CursorProvider for the pattern this follows
 */

import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CliProvider,
  type CliSpawnConfig,
  type CliErrorInfo,
} from "./cli-provider.js";
import type { SubprocessOptions } from "@pegasus/platform";
import type {
  ProviderConfig,
  ExecuteOptions,
  ProviderMessage,
  ProviderUsageInfo,
  ClaudeCliSettings,
  InstallationStatus,
  ModelDefinition,
  ContentBlock,
} from "./types.js";
import type { ThinkingLevel } from "@pegasus/types";
import { createLogger, isAbortError } from "@pegasus/utils";
import { spawnJSONLProcess } from "@pegasus/platform";

// Create logger for this module
const logger = createLogger("ClaudeCodeCliProvider");

// =============================================================================
// Model Definitions
// =============================================================================

/**
 * Available models for the Claude CLI provider.
 * Users select these via the `cli-` prefix (e.g., cli-opus, cli-sonnet, cli-haiku).
 */
const CLAUDE_CLI_MODELS: ModelDefinition[] = [
  {
    id: "cli-opus",
    name: "Claude Opus (CLI)",
    modelString: "opus",
    provider: "claude-cli",
    description: "Most capable Claude model via CLI. Best for complex tasks.",
    supportsTools: true,
    supportsVision: false,
    tier: "premium",
  },
  {
    id: "cli-sonnet",
    name: "Claude Sonnet (CLI)",
    modelString: "sonnet",
    provider: "claude-cli",
    description:
      "Balanced capability and speed via CLI. Recommended for most tasks.",
    supportsTools: true,
    supportsVision: false,
    tier: "standard",
    default: true,
  },
  {
    id: "cli-haiku",
    name: "Claude Haiku (CLI)",
    modelString: "haiku",
    provider: "claude-cli",
    description: "Fastest Claude model via CLI. Best for simple, quick tasks.",
    supportsTools: true,
    supportsVision: false,
    tier: "basic",
  },
];

// =============================================================================
// Tool Handler Registry
// =============================================================================

/**
 * Tool handler for normalizing Claude CLI tool call inputs
 */
interface CliToolHandler {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapInput: (input: any) => unknown;
}

/**
 * Registry of Claude CLI tool handlers.
 * Claude Code uses canonical tool names that match Pegasus's own naming — mapping is mostly
 * identity, but kept here for consistency with CursorProvider pattern and future extensibility.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CLAUDE_CLI_TOOL_HANDLERS: Record<string, CliToolHandler> = {
  Read: {
    name: "Read",
    mapInput: (i: { file_path: string }) => ({ file_path: i.file_path }),
  },
  Write: {
    name: "Write",
    mapInput: (i: { file_path: string; content: string }) => ({
      file_path: i.file_path,
      content: i.content,
    }),
  },
  Edit: {
    name: "Edit",
    mapInput: (i: {
      file_path: string;
      old_string: string;
      new_string: string;
    }) => ({
      file_path: i.file_path,
      old_string: i.old_string,
      new_string: i.new_string,
    }),
  },
  Bash: {
    name: "Bash",
    mapInput: (i: { command: string }) => ({ command: i.command }),
  },
  Glob: {
    name: "Glob",
    mapInput: (i: { pattern: string; path?: string }) => ({
      pattern: i.pattern,
      path: i.path,
    }),
  },
  Grep: {
    name: "Grep",
    mapInput: (i: { pattern: string; path?: string }) => ({
      pattern: i.pattern,
      path: i.path,
    }),
  },
  WebSearch: {
    name: "WebSearch",
    mapInput: (i: { query: string }) => ({ query: i.query }),
  },
  WebFetch: {
    name: "WebFetch",
    mapInput: (i: { url: string; prompt?: string }) => ({
      url: i.url,
      prompt: i.prompt,
    }),
  },
  Task: {
    name: "Task",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapInput: (i: any) => i,
  },
  TodoWrite: {
    name: "TodoWrite",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapInput: (i: any) => i,
  },
  MultiEdit: {
    name: "MultiEdit",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapInput: (i: any) => i,
  },
  NotebookRead: {
    name: "NotebookRead",
    mapInput: (i: { notebook_path: string }) => ({
      notebook_path: i.notebook_path,
    }),
  },
  NotebookEdit: {
    name: "NotebookEdit",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapInput: (i: any) => i,
  },
  LS: {
    name: "LS",
    mapInput: (i: { path: string }) => ({ path: i.path }),
  },
  TodoRead: {
    name: "TodoRead",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapInput: (i: any) => i,
  },
  exit_plan_mode: {
    name: "exit_plan_mode",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapInput: (i: any) => i,
  },
};

// =============================================================================
// Env Whitelist (ADR-9)
// =============================================================================

/**
 * Environment variables allowed through to the Claude subprocess.
 * Excludes everything else from Pegasus's parent env to prevent credential leakage.
 * ANTHROPIC_API_KEY is added dynamically if present in process.env.
 * Note: CLAUDECODE is intentionally NOT included — it causes "cannot launch inside
 * another Claude Code session" errors (ADR-9, NFR-P4).
 */
const CLAUDE_CLI_ENV_WHITELIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  // Stream watchdog vars — allow pass-through from parent when set
  "CLAUDE_ENABLE_STREAM_WATCHDOG",
  "CLAUDE_STREAM_IDLE_TIMEOUT_MS",
  "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
] as const;

/**
 * Windows host env vars required to spawn `wsl.exe` successfully.
 * When the provider runs in WSL strategy on Windows, the parent process
 * spawning wsl.exe is a Windows host process — stripping these would
 * break the subprocess launch itself.
 */
const WSL_HOST_ENV_EXTRAS = [
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
  "TEMP",
  "TMP",
] as const;

// =============================================================================
// Error Codes
// =============================================================================

export enum ClaudeCliErrorCode {
  NOT_INSTALLED = "CLAUDE_CLI_NOT_INSTALLED",
  NOT_AUTHENTICATED = "CLAUDE_CLI_NOT_AUTHENTICATED",
  RATE_LIMITED = "CLAUDE_CLI_RATE_LIMITED",
  NETWORK_ERROR = "CLAUDE_CLI_NETWORK_ERROR",
  PROCESS_CRASHED = "CLAUDE_CLI_PROCESS_CRASHED",
  TIMEOUT = "CLAUDE_CLI_TIMEOUT",
  CREDITS_EXHAUSTED = "CLAUDE_CLI_CREDITS_EXHAUSTED",
  UPDATE_REQUIRED = "CLAUDE_CLI_UPDATE_REQUIRED",
  UNKNOWN = "CLAUDE_CLI_UNKNOWN_ERROR",
}

export interface ClaudeCliError extends Error {
  code: ClaudeCliErrorCode;
  recoverable: boolean;
  suggestion?: string;
}

// =============================================================================
// Version Gating (ADR-P6)
// =============================================================================

/**
 * Minimum supported Claude CLI version.
 * Probed live against v2.1.104; --verbose + --output-format stream-json require this.
 */
const MINIMUM_CLI_VERSION = "2.1.104";

// =============================================================================
// ThinkingLevel → --effort Mapping (FR-P2)
// =============================================================================

/**
 * Maps Pegasus ThinkingLevel values to Claude CLI --effort flag values.
 * 'none' and 'adaptive' are intentionally omitted — omitting --effort lets the CLI
 * choose its own default behavior.
 */
const THINKING_LEVEL_TO_EFFORT: Partial<Record<ThinkingLevel, string>> = {
  low: "low",
  medium: "medium",
  high: "high",
  ultrathink: "max",
};

// =============================================================================
// ClaudeCodeCliProvider
// =============================================================================

/**
 * ClaudeCodeCliProvider - Integrates the `claude` CLI as an AI provider
 *
 * Extends CliProvider with Claude Code CLI-specific behavior:
 * - stdin prompt delivery via `-` flag (avoids shell injection of special characters)
 * - `--output-format stream-json` JSONL normalization
 * - session_id extraction from `system/init` events (design ADR-5)
 * - Three-state auth detection via `claude auth status` exit code (design ADR-3)
 */
export class ClaudeCodeCliProvider extends CliProvider {
  /** Session ID extracted from the first system/init JSONL event */
  private sessionId: string | undefined = undefined;

  /** Path to temporary MCP config file created for current execution */
  private tempMcpConfigPath: string | null = null;

  /** Enriched metadata extracted from the system/init event (FR-P12) */
  private initMetadata: {
    tools?: string[];
    mcpServers?: string[];
    model?: string;
    permissionMode?: string;
    cliVersion?: string;
  } = {};

  constructor(config: ProviderConfig = {}) {
    super(config);
    // Lazy detection on first use (matches base CliProvider behavior)
  }

  // ==========================================================================
  // CliProvider Abstract Method Implementations
  // ==========================================================================

  getName(): string {
    return "claude-cli";
  }

  getCliName(): string {
    return "claude";
  }

  getSpawnConfig(): CliSpawnConfig {
    return {
      windowsStrategy: "wsl", // No Windows-native build; WSL only
      commonPaths: {
        darwin: [
          path.join(os.homedir(), ".local/bin/claude"), // Native install
          "/opt/homebrew/bin/claude", // Homebrew (Apple Silicon)
          "/usr/local/bin/claude", // Homebrew (Intel) or npm global
          path.join(os.homedir(), ".npm-global/bin/claude"), // npm global
        ],
        linux: [
          path.join(os.homedir(), ".local/bin/claude"),
          "/usr/local/bin/claude",
          "/usr/bin/claude",
          path.join(os.homedir(), ".npm-global/bin/claude"),
        ],
        win32: [], // WSL only — binary paths handled via WSL detection
      },
    };
  }

  /**
   * Build CLI arguments from ExecuteOptions.
   *
   * Orchestrates categorized helper methods (FR-P1). The prompt is NOT included here —
   * it is passed via stdin using `stdinData` + `-` flag to avoid shell interpretation
   * of special characters ($(), backticks, etc.).
   */
  buildCliArgs(options: ExecuteOptions): string[] {
    const args: string[] = [];
    this.buildCoreFlags(args);
    this.buildModelFlags(args, options);
    this.buildToolFlags(args, options);
    this.buildSessionFlags(args, options);
    this.buildOutputFlags(args, options);
    this.buildContextFlags(args, options);
    this.warnUnsupportedFields(options);
    args.push("-");
    return args;
  }

  // --------------------------------------------------------------------------
  // buildCliArgs Categorized Helpers (FR-P1, NFR-P1 — each ≤30 lines)
  // --------------------------------------------------------------------------

  /** Core non-interactive streaming flags. Always present. */
  private buildCoreFlags(args: string[]): void {
    // -p: print mode (non-interactive). --verbose required by CLI v2.1.104+
    args.push("-p", "--verbose", "--output-format", "stream-json");
  }

  /** Model, effort (ThinkingLevel→--effort), fallback-model, max-turns. */
  private buildModelFlags(args: string[], options: ExecuteOptions): void {
    if (options.model) {
      const bareModel = options.model.startsWith("cli-")
        ? options.model.slice("cli-".length)
        : options.model;
      if (bareModel) args.push("--model", bareModel);
    }
    if (options.maxTurns !== undefined) {
      args.push("--max-turns", String(options.maxTurns));
    }
    if (options.thinkingLevel !== undefined) {
      const effort = THINKING_LEVEL_TO_EFFORT[options.thinkingLevel];
      if (effort) {
        if (
          effort === "max" &&
          options.model &&
          !options.model.includes("opus")
        ) {
          logger.debug(
            `[ClaudeCodeCliProvider] --effort max on non-Opus model "${options.model}"; CLI may downgrade`,
          );
        }
        args.push("--effort", effort);
      }
    }
    const cli = options.claudeCliSettings as ClaudeCliSettings | undefined;
    if (cli?.fallbackModel) args.push("--fallback-model", cli.fallbackModel);
  }

  /** allowedTools, disallowedTools (from options.tools), agents JSON. */
  private buildToolFlags(args: string[], options: ExecuteOptions): void {
    if (options.allowedTools && options.allowedTools.length > 0) {
      args.push("--allowedTools", options.allowedTools.join(","));
    }
    if (options.tools !== undefined) {
      if (options.tools.length === 0) {
        logger.debug(
          '[ClaudeCodeCliProvider] tools is an empty array — no CLI equivalent for "disallow nothing"; skipping --disallowedTools',
        );
      } else {
        args.push("--disallowedTools", options.tools.join(","));
      }
    }
    if (options.agents && Object.keys(options.agents).length > 0) {
      const cliAgents: Record<string, unknown> = {};
      for (const [name, def] of Object.entries(options.agents)) {
        cliAgents[name] = {
          description: def.description,
          prompt: def.prompt,
          ...(def.model && def.model !== "inherit" && { model: def.model }),
          ...(def.tools && { tools: def.tools.join(",") }),
        };
      }
      args.push("--agents", JSON.stringify(cliAgents));
    }
  }

  /**
   * Session flags: --resume (sdkSessionId) takes priority over --session-id /
   * --name (claudeCliSettings). Mutually exclusive by priority (ADR-P5).
   */
  private buildSessionFlags(args: string[], options: ExecuteOptions): void {
    const cli = options.claudeCliSettings as ClaudeCliSettings | undefined;
    if (options.sdkSessionId) {
      args.push("--resume", options.sdkSessionId);
      if (cli?.deterministicSessionId) {
        logger.debug(
          "[ClaudeCodeCliProvider] sdkSessionId (--resume) takes priority over deterministicSessionId (--session-id)",
        );
      }
      return;
    }
    if (cli?.deterministicSessionId)
      args.push("--session-id", cli.deterministicSessionId);
    if (cli?.sessionName) args.push("--name", cli.sessionName);
  }

  /** Output flags: --json-schema (outputFormat), --max-budget-usd. */
  private buildOutputFlags(args: string[], options: ExecuteOptions): void {
    if (
      options.outputFormat?.type === "json_schema" &&
      options.outputFormat.schema
    ) {
      const schemaJson = JSON.stringify(options.outputFormat.schema);
      const byteLength = Buffer.byteLength(schemaJson, "utf8");
      const maxBytes = 102400; // 100 KB
      if (byteLength > maxBytes) {
        throw new Error(
          `[ClaudeCodeCliProvider] --json-schema argument exceeds the 100 KB inline size limit (${byteLength} bytes). Reduce the schema size before passing it to the CLI.`,
        );
      }
      args.push("--json-schema", schemaJson);
    }
    const cli = options.claudeCliSettings as ClaudeCliSettings | undefined;
    if (cli?.maxBudgetUsd !== undefined) {
      args.push("--max-budget-usd", String(cli.maxBudgetUsd));
    }
  }

  /**
   * Context flags: system prompt append, --add-dir, --mcp-config,
   * --strict-mcp-config, --permission-mode, --read-only.
   */
  private buildContextFlags(args: string[], options: ExecuteOptions): void {
    if (options.systemPrompt) {
      const systemText =
        typeof options.systemPrompt === "string"
          ? options.systemPrompt
          : (options.systemPrompt.append ?? "");
      if (systemText) args.push("--append-system-prompt", systemText);
    }
    if (options.readOnly) args.push("--permission-mode", "plan");
    const cli = options.claudeCliSettings as ClaudeCliSettings | undefined;
    if (cli?.additionalDirs && cli.additionalDirs.length > 0) {
      for (const dir of cli.additionalDirs) {
        args.push("--add-dir", dir);
      }
    }
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      const mcpConfigPath = this.writeMcpConfig(options.mcpServers);
      if (mcpConfigPath) {
        args.push("--mcp-config", mcpConfigPath);
        if (cli?.strictMcpConfig) args.push("--strict-mcp-config");
      }
    }
  }

  /** Warn on fields that have no Claude CLI equivalent (FR-G7, FR-002). */
  private warnUnsupportedFields(options: ExecuteOptions): void {
    if (options.mcpUnrestrictedTools) {
      logger.warn(
        "[ClaudeCodeCliProvider] mcpUnrestrictedTools is not mapped to a Claude CLI flag",
      );
    }
    if (options.mcpAutoApproveTools) {
      logger.warn(
        "[ClaudeCodeCliProvider] mcpAutoApproveTools is not mapped to a Claude CLI flag",
      );
    }
    if (options.conversationHistory && options.conversationHistory.length > 0) {
      logger.warn(
        "[ClaudeCodeCliProvider] conversationHistory is not supported by the Claude CLI. " +
          "Use sdkSessionId with --resume for session continuation.",
      );
    }
    if (options.settingSources !== undefined) {
      logger.warn(
        "[ClaudeCodeCliProvider] settingSources is not supported by the Claude CLI. " +
          "The CLI loads its own CLAUDE.md settings hierarchy.",
      );
    }
  }

  /**
   * Override base class to replace the full process.env with an explicit whitelist
   * so Pegasus parent secrets (e.g., OPENAI_API_KEY, database URLs, OAuth tokens)
   * do not leak into the Claude subprocess. ANTHROPIC_API_KEY is included only
   * if set in the parent env (ADR-9 / ADR-G via gap design).
   */
  protected buildSubprocessOptions(
    options: ExecuteOptions,
    cliArgs: string[],
  ): SubprocessOptions {
    const subprocessOptions = super.buildSubprocessOptions(options, cliArgs);

    const whitelistedEnv: Record<string, string> = {};
    for (const key of CLAUDE_CLI_ENV_WHITELIST) {
      const value = process.env[key];
      if (value !== undefined) {
        whitelistedEnv[key] = value;
      }
    }
    if (process.env.ANTHROPIC_API_KEY !== undefined) {
      whitelistedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }

    // When running in WSL strategy on Windows, the parent process spawning
    // wsl.exe is a Windows host process. Preserve the Windows-essential vars
    // that wsl.exe itself needs to launch; stripping them would break the
    // subprocess entirely.
    if (process.platform === "win32" && this.useWsl) {
      for (const key of WSL_HOST_ENV_EXTRAS) {
        const value = process.env[key];
        if (value !== undefined) {
          whitelistedEnv[key] = value;
        }
      }
    }

    // Always prevent credential leakage to child-of-child processes (NFR-P4)
    whitelistedEnv["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] = "1";

    // Stream watchdog: inject when caller configures it via claudeCliSettings
    const cli = options.claudeCliSettings as ClaudeCliSettings | undefined;
    if (cli?.streamWatchdogTimeoutMs !== undefined) {
      whitelistedEnv["CLAUDE_ENABLE_STREAM_WATCHDOG"] = "1";
      whitelistedEnv["CLAUDE_STREAM_IDLE_TIMEOUT_MS"] = String(
        cli.streamWatchdogTimeoutMs,
      );
    }

    subprocessOptions.env = whitelistedEnv;

    logger.debug(
      `[ClaudeCodeCliProvider] Subprocess env whitelist: ${Object.keys(whitelistedEnv).join(", ")}`,
    );

    return subprocessOptions;
  }

  /**
   * Normalize a raw Claude CLI JSONL event to ProviderMessage format.
   *
   * Event types (stream-json mode):
   * - system/init: extract session_id, do not yield
   * - system/api_retry: log, do not yield
   * - system/hook_*: filter silently (design ADR-6)
   * - assistant: yield with text and tool_use content blocks
   * - user: yield tool_result blocks as assistant message (design spec)
   * - result/success: yield success result
   * - result/error*: yield error result
   * - unknown: log warning, skip
   */
  normalizeEvent(event: unknown): ProviderMessage | null {
    const e = event as { type: string; subtype?: string; session_id?: string };

    switch (e.type) {
      case "system": {
        if (e.subtype === "init") {
          // Extract session_id from first init event (design ADR-5)
          if (e.session_id) {
            this.sessionId = e.session_id;
          }
          // FR-P12: extract enriched init metadata for diagnostics
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const initRaw = event as any;
          this.initMetadata = {
            tools: initRaw.tools ?? [],
            mcpServers: initRaw.mcp_servers ?? [],
            model: initRaw.model,
            permissionMode: initRaw.permissionMode,
            cliVersion: initRaw.claude_code_version,
          };
          logger.debug(
            `[ClaudeCodeCliProvider] Session started: ${this.sessionId}, ` +
              `CLI v${this.initMetadata.cliVersion ?? "unknown"}, model: ${this.initMetadata.model ?? "unknown"}`,
          );
          return null;
        }
        if (e.subtype === "api_retry") {
          const retryEvent = e as { attempt?: number; error?: string };
          logger.debug(
            `[ClaudeCodeCliProvider] API retry attempt ${retryEvent.attempt ?? "?"}: ${retryEvent.error ?? ""}`,
          );
          return null;
        }
        if (e.subtype?.startsWith("hook_")) {
          // Hook events can produce 20k+ token contexts — filter silently (design ADR-6)
          return null;
        }
        return null;
      }

      case "assistant": {
        const assistantEvent = event as unknown as {
          session_id?: string;
          message: {
            role: "assistant";
            content: Array<{
              type: string;
              text?: string;
              id?: string;
              name?: string;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              input?: any;
              thinking?: string;
            }>;
          };
        };

        const content: ContentBlock[] = assistantEvent.message.content
          .map((block): ContentBlock | null => {
            if (block.type === "text") {
              return { type: "text", text: block.text ?? "" };
            }
            if (block.type === "tool_use") {
              const handler = CLAUDE_CLI_TOOL_HANDLERS[block.name ?? ""];
              const normalizedInput = handler
                ? handler.mapInput(block.input ?? {})
                : block.input;
              return {
                type: "tool_use",
                name: handler ? handler.name : (block.name ?? "unknown"),
                tool_use_id: block.id ?? "",
                input: normalizedInput,
              };
            }
            if (block.type === "thinking") {
              return { type: "thinking", thinking: block.thinking ?? "" };
            }
            return null;
          })
          .filter((b): b is ContentBlock => b !== null);

        if (content.length === 0) return null;

        return {
          type: "assistant",
          session_id: assistantEvent.session_id ?? this.sessionId,
          message: {
            role: "assistant",
            content,
          },
        };
      }

      case "user": {
        // Tool results — yielded as assistant message for UI display (design spec)
        const userEvent = event as unknown as {
          message: {
            role: "user";
            content: Array<{
              type: string;
              tool_use_id?: string;
              content?: string | Array<{ type: string; text?: string }>;
            }>;
          };
        };

        const toolResultBlocks: ContentBlock[] = userEvent.message.content
          .filter((block) => block.type === "tool_result")
          .map((block): ContentBlock => {
            const resultContent =
              typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .filter((c) => c.type === "text")
                      .map((c) => c.text ?? "")
                      .join("\n")
                  : "";
            return {
              type: "tool_result",
              tool_use_id: block.tool_use_id ?? "",
              content: resultContent,
            };
          });

        if (toolResultBlocks.length === 0) return null;

        return {
          type: "assistant",
          session_id: this.sessionId,
          message: {
            role: "assistant",
            content: toolResultBlocks,
          },
        };
      }

      case "result": {
        const resultEvent = e as {
          subtype: string;
          session_id?: string;
          result?: string;
          error?: string;
        };

        const sessionId = resultEvent.session_id ?? this.sessionId;

        // FR-P11: extract usage metadata via parseResultMetadata (NFR-P6: defensive parsing)
        const usage = this.parseResultMetadata(event);

        if (resultEvent.subtype === "success") {
          // FR-P3 / ADR-P3: when --json-schema is used, result may be empty while
          // structured_output holds the validated JSON. Populate result with the JSON
          // string so text-first consumers (agent-service, agent-executor) don't blank.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const structuredOutput = (event as any).structured_output as
            | Record<string, unknown>
            | undefined;
          const resultText =
            resultEvent.result ||
            (structuredOutput ? JSON.stringify(structuredOutput) : undefined);
          return {
            type: "result",
            subtype: "success",
            session_id: sessionId,
            result: resultText,
            structured_output: structuredOutput,
            usage,
          };
        }

        // FR-P13: explicit handling for budget and structured output retry limits
        if (resultEvent.subtype === "error_max_budget_usd") {
          return {
            type: "result",
            subtype: "error_max_budget_usd",
            session_id: sessionId,
            error:
              resultEvent.error ||
              "Budget limit reached. Increase --max-budget-usd or upgrade your Claude Code plan.",
            usage,
          };
        }
        if (resultEvent.subtype === "error_max_structured_output_retries") {
          return {
            type: "result",
            subtype: "error_max_structured_output_retries",
            session_id: sessionId,
            error:
              resultEvent.error ||
              "Structured output validation failed after maximum retries. Check your JSON schema.",
            usage,
          };
        }

        // Generic error subtypes: error_during_execution, error_max_turns, etc.
        return {
          type: "result",
          subtype: resultEvent.subtype as
            | "error"
            | "error_max_turns"
            | "error_during_execution",
          session_id: sessionId,
          error:
            resultEvent.error ||
            `Claude CLI failed (subtype: ${resultEvent.subtype})`,
          usage,
        };
      }

      default: {
        logger.warn(
          `[ClaudeCodeCliProvider] Unknown JSONL event type: "${e.type}". ` +
            `Full event: ${JSON.stringify(event).substring(0, 200)}`,
        );
        return null;
      }
    }
  }

  // ==========================================================================
  // executeQuery Override
  // ==========================================================================

  /**
   * Execute a query using the Claude CLI with JSONL streaming.
   *
   * Overrides base class to:
   * - Reset session state per execution
   * - Pass prompt via stdin (stdinData + '-' flag) for safety
   * - Attach session_id to all messages
   * - Clean up temp files after execution
   */
  async *executeQuery(
    options: ExecuteOptions,
  ): AsyncGenerator<ProviderMessage> {
    this.ensureCliDetected();

    if (!this.cliPath) {
      throw this.createCliError(
        ClaudeCliErrorCode.NOT_INSTALLED,
        "Claude Code CLI (claude) is not installed",
        true,
        this.getInstallInstructions(),
      );
    }

    // Reset session state for this execution
    this.sessionId = undefined;
    this.initMetadata = {};

    // Extract prompt text for stdin delivery
    const promptText = this.extractPromptText(options);

    const debugRawEvents =
      process.env.PEGASUS_DEBUG_RAW_OUTPUT === "true" ||
      process.env.PEGASUS_DEBUG_RAW_OUTPUT === "1";

    // Internal AbortController for post-result grace period (FR-P14 / ADR-P4).
    // We wrap the caller's AbortController so we can trigger termination ourselves
    // without disturbing the caller's signal.
    const gracePeriodController = new AbortController();
    let gracePeriodTimer: NodeJS.Timeout | null = null;

    // Propagate caller's abort to our internal controller
    if (options.abortController?.signal.aborted) {
      gracePeriodController.abort();
    } else {
      options.abortController?.signal.addEventListener("abort", () =>
        gracePeriodController.abort(),
      );
    }

    try {
      // Build args (may create MCP temp file) and subprocess options INSIDE the try
      // so cleanupTempFiles() runs even if buildSubprocessOptions throws.
      const cliArgs = this.buildCliArgs(options);
      const effectiveOptions = {
        ...options,
        abortController: gracePeriodController,
      };
      const subprocessOptions = this.buildSubprocessOptions(
        effectiveOptions,
        cliArgs,
      );

      // Pass prompt via stdin to avoid shell interpretation of special characters
      // (like $(), backticks, etc.) that may appear in file content
      subprocessOptions.stdinData = promptText;

      logger.debug(
        `[ClaudeCodeCliProvider] Executing with model: "${options.model}", ` +
          `args (excluding last '-'): ${cliArgs.slice(0, -1).join(" ")}`,
      );

      for await (const rawEvent of spawnJSONLProcess(subprocessOptions)) {
        if (debugRawEvents) {
          const ev = rawEvent as { type?: string; subtype?: string };
          logger.info(
            `[RAW EVENT] type=${ev.type ?? "unknown"} subtype=${ev.subtype ?? "none"}`,
          );
        }

        const normalized = this.normalizeEvent(rawEvent);
        if (normalized) {
          // Attach session_id if not already set on the message
          if (!normalized.session_id && this.sessionId) {
            normalized.session_id = this.sessionId;
          }
          yield normalized;

          // FR-P14 / ADR-P4: once a terminal result is received, stop iterating
          // and schedule SIGTERM after 5s grace period. spawnJSONLProcess will
          // escalate to SIGKILL after another 3s if the process hasn't exited.
          if (normalized.type === "result") {
            gracePeriodTimer = setTimeout(() => {
              logger.debug(
                "[ClaudeCodeCliProvider] Post-result grace period expired; aborting subprocess",
              );
              gracePeriodController.abort();
            }, 5000);
            return; // Break out of JSONL iterator — result is final
          }
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        logger.debug("[ClaudeCodeCliProvider] Query aborted");
        return;
      }

      if (error instanceof Error && "stderr" in error) {
        const errorInfo = this.mapError(
          (error as { stderr?: string }).stderr || error.message,
          (error as { exitCode?: number | null }).exitCode ?? null,
        );
        throw this.createCliError(
          errorInfo.code as ClaudeCliErrorCode,
          errorInfo.message,
          errorInfo.recoverable,
          errorInfo.suggestion,
        );
      }

      throw error;
    } finally {
      if (gracePeriodTimer) {
        clearTimeout(gracePeriodTimer);
        gracePeriodTimer = null;
      }
      this.cleanupTempFiles();
    }
  }

  // ==========================================================================
  // Installation Detection
  // ==========================================================================

  /**
   * Detect installation status including version and three-state auth status
   */
  async detectInstallation(): Promise<InstallationStatus> {
    this.ensureCliDetected();

    if (!this.cliPath) {
      return {
        installed: false,
        error:
          "Claude Code CLI (claude) not found. Install with: npm install -g @anthropic-ai/claude-code",
      };
    }

    const version = this.getCliVersion();
    const authStatus = this.checkAuthStatus();

    // FR-P15 / ADR-P6: parse version and warn if below minimum (2.1.104)
    if (version) {
      const parsedVersion = this.parseCliVersion(version);
      if (
        parsedVersion &&
        !this.isVersionAtLeast(parsedVersion, MINIMUM_CLI_VERSION)
      ) {
        logger.warn(
          `[ClaudeCodeCliProvider] CLI version ${parsedVersion} is below minimum ${MINIMUM_CLI_VERSION}. ` +
            "Some features may not work. Run: npm install -g @anthropic-ai/claude-code@latest",
        );
      }
    }

    return {
      installed: true,
      path: this.cliPath,
      version: version ?? undefined,
      method: "cli",
      authenticated: authStatus === "authenticated",
      authStatus,
    };
  }

  /**
   * Parse a Claude CLI version string to extract the semver part.
   * Handles format "2.1.104 (2026-04-01)" (date suffix is optional).
   */
  private parseCliVersion(versionString: string): string | null {
    const match = versionString.match(/^(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  }

  /**
   * Compare two semver strings (major.minor.patch). Returns true if version >= minimum.
   */
  private isVersionAtLeast(version: string, minimum: string): boolean {
    const [aMaj, aMin, aPatch] = version.split(".").map(Number);
    const [bMaj, bMin, bPatch] = minimum.split(".").map(Number);
    if (aMaj !== bMaj) return aMaj > bMaj;
    if (aMin !== bMin) return aMin > bMin;
    return aPatch >= bPatch;
  }

  /**
   * Get the Claude CLI version string
   */
  private getCliVersion(): string | null {
    if (!this.cliPath) return null;
    try {
      const result = execSync(`"${this.cliPath}" --version`, {
        encoding: "utf8",
        timeout: 5000,
        stdio: "pipe",
      }).trim();
      return result || null;
    } catch {
      return null;
    }
  }

  /**
   * Check auth status via `claude auth status` exit code.
   *
   * Returns three states (design ADR-3):
   * - 'authenticated': exit code 0
   * - 'not_authenticated': exit code non-zero with auth-related message
   * - 'unknown': could not determine (CLI error, timeout, etc.)
   */
  private checkAuthStatus(): "authenticated" | "not_authenticated" | "unknown" {
    if (!this.cliPath) return "unknown";
    try {
      const result = spawnSync(this.cliPath, ["auth", "status"], {
        encoding: "utf8",
        timeout: 10000,
        stdio: "pipe",
      });
      if (result.status === 0) {
        return "authenticated";
      }
      // Only map to 'not_authenticated' when stdout/stderr contain an
      // auth-specific signal. Any other non-zero exit (broken install,
      // transient error, unknown failure) collapses to 'unknown' so the UI
      // doesn't mislead users into running `claude auth login` when the
      // real problem is elsewhere.
      const combined = (
        (result.stderr ?? "").toString() +
        "\n" +
        (result.stdout ?? "").toString()
      ).toLowerCase();
      if (
        combined.includes("not authenticated") ||
        combined.includes("not logged in") ||
        combined.includes("please log in") ||
        combined.includes("unauthorized") ||
        combined.includes("invalid api key")
      ) {
        return "not_authenticated";
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  // ==========================================================================
  // Model Definitions
  // ==========================================================================

  getAvailableModels(): ModelDefinition[] {
    return CLAUDE_CLI_MODELS;
  }

  supportsFeature(feature: string): boolean {
    return ["tools", "text", "streaming"].includes(feature);
  }

  // ==========================================================================
  // Error Mapping Override
  // ==========================================================================

  protected mapError(stderr: string, exitCode: number | null): CliErrorInfo {
    const lower = stderr.toLowerCase();

    if (
      lower.includes("not authenticated") ||
      lower.includes("please log in") ||
      lower.includes("unauthorized") ||
      lower.includes("invalid api key")
    ) {
      return {
        code: ClaudeCliErrorCode.NOT_AUTHENTICATED,
        message: "Claude CLI is not authenticated",
        recoverable: true,
        suggestion: 'Run "claude auth login" to authenticate',
      };
    }

    if (
      lower.includes("rate limit") ||
      lower.includes("too many requests") ||
      lower.includes("429")
    ) {
      return {
        code: ClaudeCliErrorCode.RATE_LIMITED,
        message: "Claude API rate limit exceeded",
        recoverable: true,
        suggestion: "Wait a few minutes and try again",
      };
    }

    if (
      lower.includes("network") ||
      lower.includes("connection") ||
      lower.includes("econnrefused") ||
      lower.includes("timeout")
    ) {
      return {
        code: ClaudeCliErrorCode.NETWORK_ERROR,
        message: "Network connection error",
        recoverable: true,
        suggestion: "Check your internet connection and try again",
      };
    }

    if (
      exitCode === 137 ||
      lower.includes("killed") ||
      lower.includes("sigterm")
    ) {
      return {
        code: ClaudeCliErrorCode.PROCESS_CRASHED,
        message: "Claude CLI process was terminated",
        recoverable: true,
        suggestion:
          "The process may have run out of memory. Try a simpler task.",
      };
    }

    if (/credits exhausted|insufficient credits|quota exceeded/i.test(stderr)) {
      return {
        code: ClaudeCliErrorCode.CREDITS_EXHAUSTED,
        message: "Claude CLI credits exhausted or quota exceeded",
        recoverable: false,
        suggestion: "Upgrade your Claude Code plan at https://claude.com",
      };
    }

    if (
      /update required|please update|unsupported version|outdated/i.test(stderr)
    ) {
      return {
        code: ClaudeCliErrorCode.UPDATE_REQUIRED,
        message: "Claude CLI version is outdated",
        recoverable: false,
        suggestion: "Run: npm install -g @anthropic-ai/claude-code@latest",
      };
    }

    return {
      code: ClaudeCliErrorCode.UNKNOWN,
      message: stderr || `Claude CLI exited with code ${exitCode}`,
      recoverable: false,
    };
  }

  protected getInstallInstructions(): string {
    if (process.platform === "win32") {
      return "Claude Code CLI requires WSL on Windows. Install WSL, then run: npm install -g @anthropic-ai/claude-code";
    }
    return "Install with: npm install -g @anthropic-ai/claude-code";
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Extract typed usage/cost metadata from a CLI result event.
   *
   * All field accesses use optional chaining with defaults (NFR-P6, Gemini recommendation).
   * Returns undefined if no meaningful usage data is present.
   */
  private parseResultMetadata(event: unknown): ProviderUsageInfo | undefined {
    const e = event as Record<string, unknown>;
    const usage = (e["usage"] ?? {}) as Record<string, unknown>;
    const hasData =
      e["usage"] !== undefined ||
      e["total_cost_usd"] !== undefined ||
      e["duration_ms"] !== undefined ||
      e["num_turns"] !== undefined;
    if (!hasData) return undefined;
    return {
      inputTokens: usage["input_tokens"] as number | undefined,
      outputTokens: usage["output_tokens"] as number | undefined,
      cacheReadTokens: usage["cache_read_input_tokens"] as number | undefined,
      cacheCreationTokens: usage["cache_creation_input_tokens"] as
        | number
        | undefined,
      totalCostUsd: e["total_cost_usd"] as number | undefined,
      durationMs: e["duration_ms"] as number | undefined,
      durationApiMs: e["duration_api_ms"] as number | undefined,
      numTurns: e["num_turns"] as number | undefined,
      stopReason: e["stop_reason"] as string | undefined,
      terminalReason: e["terminal_reason"] as string | undefined,
      modelUsage: e["modelUsage"] as ProviderUsageInfo["modelUsage"],
    };
  }

  /**
   * Extract prompt text from ExecuteOptions for stdin delivery.
   * Non-text blocks (images/files) are dropped with a warning — vision is not
   * yet supported by this provider (ADR-G2).
   */
  private extractPromptText(options: ExecuteOptions): string {
    if (typeof options.prompt === "string") {
      return options.prompt;
    } else if (Array.isArray(options.prompt)) {
      const nonTextBlockCount = options.prompt.filter(
        (p) => p.type !== "text",
      ).length;
      if (nonTextBlockCount > 0) {
        logger.warn(
          `[ClaudeCodeCliProvider] Vision input not yet supported; dropped ${nonTextBlockCount} image/file block(s)`,
        );
      }
      return options.prompt
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text)
        .join("\n");
    }
    throw new Error("[ClaudeCodeCliProvider] Invalid prompt format");
  }

  /**
   * Write MCP server config to a temporary JSON file and return the path.
   * Returns null on failure (non-fatal — execution continues without MCP).
   */
  private writeMcpConfig(
    mcpServers: NonNullable<ExecuteOptions["mcpServers"]>,
  ): string | null {
    try {
      const mcpConfig: Record<string, unknown> = {};
      for (const [name, server] of Object.entries(mcpServers)) {
        if ("command" in server) {
          // StdIO server
          mcpConfig[name] = {
            type: "stdio",
            command: server.command,
            args: (server as { args?: string[] }).args ?? [],
            env: (server as { env?: Record<string, string> }).env ?? {},
          };
        } else if ("url" in server) {
          // SSE or HTTP server
          mcpConfig[name] = {
            type: "sse",
            url: (server as { url: string }).url,
          };
        }
      }

      const tmpPath = path.join(
        os.tmpdir(),
        `pegasus-claude-mcp-${Date.now()}-${process.pid}.json`,
      );
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({ mcpServers: mcpConfig }, null, 2),
        "utf8",
      );
      this.tempMcpConfigPath = tmpPath;
      logger.debug(`[ClaudeCodeCliProvider] Wrote MCP config to: ${tmpPath}`);
      return tmpPath;
    } catch (err) {
      logger.warn(`[ClaudeCodeCliProvider] Failed to write MCP config: ${err}`);
      return null;
    }
  }

  /**
   * Remove temporary files created during execution
   */
  private cleanupTempFiles(): void {
    if (this.tempMcpConfigPath) {
      try {
        fs.unlinkSync(this.tempMcpConfigPath);
      } catch {
        // Ignore cleanup errors
      }
      this.tempMcpConfigPath = null;
    }
  }

  /**
   * Create a ClaudeCliError with structured details
   */
  private createCliError(
    code: ClaudeCliErrorCode,
    message: string,
    recoverable: boolean = false,
    suggestion?: string,
  ): ClaudeCliError {
    const error = new Error(message) as ClaudeCliError;
    error.code = code;
    error.recoverable = recoverable;
    error.suggestion = suggestion;
    error.name = "ClaudeCliError";
    return error;
  }
}
