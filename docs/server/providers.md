# Provider Architecture Reference

This document describes the modular provider architecture in `apps/server/src/providers/` that enables support for multiple AI model providers (Claude SDK, OpenAI Codex CLI, Cursor, Gemini, GitHub Copilot, OpenCode, and more).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Provider Hierarchy](#provider-hierarchy)
3. [Available Providers](#available-providers)
4. [Provider Factory and Registry](#provider-factory-and-registry)
5. [Disconnection Detection](#disconnection-detection)
6. [Simple Query Service](#simple-query-service)
7. [Adding New Providers](#adding-new-providers)
8. [Core Types](#core-types)
9. [Best Practices](#best-practices)
10. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

The provider architecture separates AI model execution logic from business logic. Providers register themselves with a central factory using a **registry pattern**, enabling dynamic provider lookup based on model ID patterns and priority.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│           AgentService / AutoModeService                 │
│                  (No provider logic)                     │
└──────────────────────────┬──────────────────────────────┘
                           │
                 ┌─────────▼──────────┐
                 │  ProviderFactory   │  Registry pattern
                 │  (Priority-based   │  Priority: cursor(10) >
                 │   routing)         │  copilot(6) > codex(5) >
                 └─────────┬──────────┘  gemini(4) > opencode(3) >
                           │             claude(0)
         ┌─────────────────┼─────────────────────────┐
         │                 │                           │
┌────────▼───────┐ ┌──────▼──────┐          ┌───────▼────────┐
│ BaseProvider   │ │ BaseProvider │          │  BaseProvider  │
│   (Claude)     │ │  (Cursor)   │    ...   │  (Copilot)     │
│  SDK-based     │ │  CLI-based  │          │  SDK-based     │
└────────────────┘ └──────┬──────┘          └────────────────┘
                          │
                  ┌───────▼────────┐
                  │  CliProvider   │  Abstract base for
                  │  (abstract)    │  all CLI-based providers
                  └────────────────┘
```

### Key Design Principles

- Providers self-register via `registerProvider()` on import — no central if/else chain
- Priority values determine model-match order when multiple providers could handle a model
- All providers implement the same `BaseProvider` interface for consistent behavior
- CLI-based providers share infrastructure via `CliProvider` (subprocess spawning, WSL, npx, error mapping)
- Types are defined in `@pegasus/types` and re-exported from `apps/server/src/providers/types.ts`

---

## Provider Hierarchy

### BaseProvider (abstract)

**Location**: `apps/server/src/providers/base-provider.ts`

The root abstract class all providers must extend. Provides shared `config` and `name` state.

```typescript
export abstract class BaseProvider {
  protected config: ProviderConfig;
  protected name: string;

  constructor(config: ProviderConfig = {}) { ... }

  abstract getName(): string;
  abstract executeQuery(options: ExecuteOptions): AsyncGenerator<ProviderMessage>;
  abstract detectInstallation(): Promise<InstallationStatus>;
  abstract getAvailableModels(): ModelDefinition[];

  // Concrete methods with defaults:
  validateConfig(): ValidationResult { ... }            // Returns { valid, errors, warnings }
  supportsFeature(feature: string): boolean { ... }     // Default: ['tools', 'text'].includes(feature)
  getConfig(): ProviderConfig { ... }
  setConfig(config: Partial<ProviderConfig>): void { ... }
}
```

The `supportsFeature()` default returns `true` for `'tools'` and `'text'`. Subclasses override to advertise additional features (e.g., `'vision'`, `'thinking'`, `'streaming'`).

### CliProvider (abstract, extends BaseProvider)

**Location**: `apps/server/src/providers/cli-provider.ts`

Abstract base for providers that spawn a CLI subprocess. Handles:

- Platform-specific CLI detection (PATH search, common installation paths)
- Windows execution strategies: `'wsl'`, `'npx'`, `'direct'`, `'cmd'`
- JSONL subprocess spawning and streaming via `spawnJSONLProcess()`
- Timeout calculation scaled to `reasoningEffort` (120 s base, multiplied by effort)
- System-prompt embedding into the user prompt (CLI tools have no separate system prompt channel)
- Standardized error mapping with recoverable/non-recoverable classification

#### CliProvider Exported Types

```typescript
export type SpawnStrategy = "wsl" | "npx" | "direct" | "cmd";

export interface CliSpawnConfig {
  windowsStrategy: SpawnStrategy;
  npxPackage?: string; // Required for 'npx' strategy
  wslDistribution?: string;
  commonPaths: Record<string, string[]>; // Per platform: 'linux' | 'darwin' | 'win32'
  versionCommand?: string;
}

export interface CliErrorInfo {
  code: string;
  message: string;
  recoverable: boolean;
  suggestion?: string;
}
```

Subclasses of `CliProvider` must implement:

- `getCliName()` — CLI executable name (e.g., `'cursor-agent'`)
- `getSpawnConfig()` — Platform-specific detection config
- `buildCliArgs(options)` — Translate `ExecuteOptions` to CLI argument array
- `normalizeEvent(event)` — Convert raw CLI JSONL event to `ProviderMessage | null`

---

## Available Providers

### 1. ClaudeProvider (SDK-based)

**Location**: `apps/server/src/providers/claude-provider.ts`
**Registration name**: `'claude'` (alias: `'anthropic'`)
**Priority**: 0 (default/fallback)

Uses `@anthropic-ai/claude-agent-sdk` directly. Does not spawn a subprocess.

#### Features

- Native multi-turn conversation via SDK session resumption (`sdkSessionId`)
- Vision support (image content blocks)
- Tool use with full `allowedTools` and `tools` control
- Extended thinking (`thinkingLevel`): `'none'`, `'low'`, `'medium'`, `'high'`, `'adaptive'`
- Structured JSON output via `outputFormat`
- Custom subagents via `agents` option
- Claude-compatible provider endpoints (alternative base URLs)
- `supportsFeature`: `['tools', 'text', 'vision', 'thinking']`

#### Model Detection

Handles models that start with `'claude-'` or whose name includes `'opus'`, `'sonnet'`, or `'haiku'`.

#### Authentication

Checked in priority order:

1. `ANTHROPIC_API_KEY` environment variable
2. `ANTHROPIC_AUTH_TOKEN` environment variable
3. API key from credentials file (managed via Settings UI)
4. Claude Max CLI OAuth (SDK handles automatically when no key present)

`detectInstallation()` always returns `installed: true` with `method: 'sdk'`.

#### Available Models

| Model ID                     | Name              | Context | Max Output | Tier     |
| ---------------------------- | ----------------- | ------- | ---------- | -------- |
| `claude-opus-4-6`            | Claude Opus 4.6   | 200K    | 128K       | premium  |
| `claude-sonnet-4-6`          | Claude Sonnet 4.6 | 200K    | 64K        | standard |
| `claude-sonnet-4-20250514`   | Claude Sonnet 4   | 200K    | 16K        | standard |
| `claude-3-5-sonnet-20241022` | Claude 3.5 Sonnet | 200K    | 8K         | standard |
| `claude-haiku-4-5-20251001`  | Claude Haiku 4.5  | 200K    | 8K         | basic    |

---

### 2. CodexProvider (CLI-based, extends BaseProvider directly)

**Location**: `apps/server/src/providers/codex-provider.ts`
**Registration name**: `'codex'` (alias: `'openai'`)
**Priority**: 5

Spawns the OpenAI Codex CLI (`codex exec`). Unlike other CLI providers, `CodexProvider` extends `BaseProvider` directly (not `CliProvider`) and manages its own subprocess strategy via `findCodexCliPath()` from `@pegasus/platform`.

#### Features

- Two execution modes: CLI (`codex exec --json`) and SDK (`executeCodexSdkQuery`)
- Reasoning effort control: `'none'` | `'minimal'` | `'low'` | `'medium'` | `'high'` | `'xhigh'`
- Dynamic timeout scaling per reasoning effort (prevents stalls with `'xhigh'`)
- Structured JSON output via `--output-schema`
- MCP server configuration via `CodexConfigManager` (generates `.codex/config.toml`)
- Session resumption via `codex resume`

#### Model Detection

Routes models matching `isCodexModel()` from `@pegasus/types`.

#### Authentication

Two methods:

1. CLI login: `codex login` (OAuth tokens stored in `~/.codex/auth.json`)
2. API key: `OPENAI_API_KEY` environment variable

#### Codex Event to ProviderMessage Mapping

| Codex Event                          | ProviderMessage                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `item.completed` (reasoning)         | `{ type: 'assistant', content: [{ type: 'thinking' }] }`                        |
| `item.completed` (agent_message)     | `{ type: 'assistant', content: [{ type: 'text' }] }`                            |
| `item.completed` (command_execution) | `{ type: 'assistant', content: [{ type: 'text', text: '```bash...' }] }`        |
| `item.started` (command_execution)   | `{ type: 'assistant', content: [{ type: 'tool_use' }] }`                        |
| `item.updated` (todo_list)           | `{ type: 'assistant', content: [{ type: 'text', text: '**Updated Todo...' }] }` |
| `turn.completed`                     | `{ type: 'result', subtype: 'success' }`                                        |
| `error`                              | `{ type: 'error', error: '...' }`                                               |

---

### 3. CursorProvider (CLI-based, extends CliProvider)

**Location**: `apps/server/src/providers/cursor-provider.ts`
**Registration name**: `'cursor'`
**Priority**: 10 (highest — checked first)

Spawns the `cursor-agent` CLI using streaming JSONL output. On Windows, requires WSL (no native Windows build). On Linux/macOS, searches versioned install paths under `~/.local/share/cursor-agent/versions/`.

#### Features

- Tool call normalization via a handler registry (`CURSOR_TOOL_HANDLERS`)
- Text block deduplication (Cursor CLI emits duplicate chunks)
- Session ID tracking for conversation continuity
- Read-only mode (omits `--force` flag when `readOnly: true`)
- `supportsFeature`: `['tools', 'text', 'vision']`

#### Model Detection

Routes models matching `isCursorModel()` from `@pegasus/types`.

#### Authentication

Requires Cursor account credentials stored in cursor-agent config. Check via Settings > Providers.

#### Tool Normalization

`CursorProvider` maps Cursor-native tool calls to standard Pegasus tool names:

| Cursor Tool         | Standard Name    |
| ------------------- | ---------------- |
| `readToolCall`      | `Read`           |
| `writeToolCall`     | `Write`          |
| `editToolCall`      | `Edit`           |
| `shellToolCall`     | `Bash`           |
| `deleteToolCall`    | `Delete`         |
| `grepToolCall`      | `Grep`           |
| `lsToolCall`        | `Ls`             |
| `globToolCall`      | `Glob`           |
| `semSearchToolCall` | `SemanticSearch` |
| `readLintsToolCall` | `ReadLints`      |

#### Error Codes

`CursorErrorCode`: `NOT_INSTALLED`, `NOT_AUTHENTICATED`, `RATE_LIMITED`, `MODEL_UNAVAILABLE`, `NETWORK_ERROR`, `PROCESS_CRASHED`, `TIMEOUT`, `UNKNOWN`

---

### 4. GeminiProvider (CLI-based, extends CliProvider)

**Location**: `apps/server/src/providers/gemini-provider.ts`
**Registration name**: `'gemini'` (alias: `'google'`)
**Priority**: 4

Spawns the `gemini` CLI (`@google/gemini-cli`) using `--output-format stream-json`. Prompt is passed via stdin to avoid shell escaping issues. On Windows, runs via `npx @google/gemini-cli`.

#### Features

- Google account OAuth login, API key, or Vertex AI authentication
- Session resumption via `--resume <sessionId>`
- Automatic `.geminiignore` creation to reduce startup time (reported improvement: 35 s → 11 s)
- Tool name normalization from Gemini CLI tool names to standard names
- `supportsFeature`: `['tools', 'text', 'streaming', 'vision', 'thinking']`

#### Model Detection

Routes models matching `isGeminiModel()` from `@pegasus/types`.

#### Authentication

Three methods (checked in order):

1. `GEMINI_API_KEY` environment variable
2. Vertex AI: `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_CLOUD_PROJECT`
3. Google OAuth: configured via `gemini` CLI interactive login (stored in `~/.gemini/settings.json`)

#### Tool Normalization

| Gemini Tool           | Standard Name |
| --------------------- | ------------- |
| `write_todos`         | `TodoWrite`   |
| `read_file`           | `Read`        |
| `read_many_files`     | `Read`        |
| `replace`             | `Edit`        |
| `write_file`          | `Write`       |
| `run_shell_command`   | `Bash`        |
| `search_file_content` | `Grep`        |
| `glob`                | `Glob`        |
| `list_directory`      | `Ls`          |
| `web_fetch`           | `WebFetch`    |
| `google_web_search`   | `WebSearch`   |

#### Gemini Stream Event Types

| Event Type                 | Handling                                                    |
| -------------------------- | ----------------------------------------------------------- |
| `init`                     | Captures `session_id`; no message yielded                   |
| `message` (assistant)      | Yields `{ type: 'assistant', content: [{ type: 'text' }] }` |
| `message` (user)           | Skipped                                                     |
| `tool_use`                 | Yields normalized `tool_use` content block                  |
| `tool_result`              | Yields `tool_result` content block                          |
| `result` (success)         | Yields `{ type: 'result', subtype: 'success' }`             |
| `result` / `error` (error) | Yields `{ type: 'error', error: '...' }`                    |

#### Error Codes

`GeminiErrorCode`: `NOT_INSTALLED`, `NOT_AUTHENTICATED`, `RATE_LIMITED`, `MODEL_UNAVAILABLE`, `NETWORK_ERROR`, `PROCESS_CRASHED`, `TIMEOUT`, `UNKNOWN`

---

### 5. CopilotProvider (SDK-based, extends CliProvider)

**Location**: `apps/server/src/providers/copilot-provider.ts`
**Registration name**: `'copilot'` (aliases: `'github-copilot'`, `'github'`)
**Priority**: 6

Uses the `@github/copilot-sdk` (`CopilotClient`) rather than spawning a subprocess. Extends `CliProvider` for CLI detection but overrides `executeQuery()` entirely with SDK calls. Creates a new client per execution with the correct working directory. Supports session resumption via `resumeSession()` if available in the SDK version.

#### Features

- GitHub OAuth authentication via `gh auth` or `GITHUB_TOKEN`
- Runtime model discovery via `copilot models list --format json`
- Both static (from `COPILOT_MODEL_MAP`) and dynamic runtime models
- Auto-approves all permission requests (fully autonomous mode)
- Tool name normalization from Copilot SDK tool names to standard names
- `supportsFeature`: `['tools', 'text', 'streaming']` (no vision currently)

#### Model Detection

Routes models matching `isCopilotModel()` from `@pegasus/types`.

#### Authentication

Checked in order:

1. `gh auth status` — GitHub CLI authentication
2. `copilot auth status` — Direct Copilot CLI auth check
3. `GITHUB_TOKEN` environment variable
4. `~/.config/gh/hosts.yml` OAuth token

#### Tool Normalization

Copilot SDK tools are normalized to standard names (case-insensitive lookup):

| Copilot Tool                                                             | Standard Name  |
| ------------------------------------------------------------------------ | -------------- |
| `read_file`, `read`, `view`, `read_many_files`                           | `Read`         |
| `write_file`, `write`, `create_file`                                     | `Write`        |
| `edit_file`, `edit`, `replace`, `patch`                                  | `Edit`         |
| `run_shell`, `run_shell_command`, `shell`, `bash`, `execute`, `terminal` | `Bash`         |
| `search`, `grep`, `search_file_content`                                  | `Grep`         |
| `find_files`, `glob`                                                     | `Glob`         |
| `list_dir`, `list_directory`, `ls`                                       | `Ls`           |
| `web_fetch`, `fetch`                                                     | `WebFetch`     |
| `web_search`, `search_web`, `google_web_search`                          | `WebSearch`    |
| `todo_write`, `write_todos`, `update_todos`                              | `TodoWrite`    |
| `report_intent`                                                          | `ReportIntent` |

#### Copilot SDK Event Types

| SDK Event                 | Handling                                                    |
| ------------------------- | ----------------------------------------------------------- |
| `assistant.message`       | Yields `{ type: 'assistant', content: [{ type: 'text' }] }` |
| `assistant.message_delta` | Skipped (final message has complete content)                |
| `tool.execution_start`    | Yields normalized `tool_use` content block                  |
| `tool.execution_complete` | Yields `tool_result` content block                          |
| `session.idle`            | Yields `{ type: 'result', subtype: 'success' }`             |
| `session.error`           | Yields `{ type: 'error', error: '...' }`                    |

#### Error Codes

`CopilotErrorCode`: `NOT_INSTALLED`, `NOT_AUTHENTICATED`, `RATE_LIMITED`, `MODEL_UNAVAILABLE`, `NETWORK_ERROR`, `PROCESS_CRASHED`, `TIMEOUT`, `CLI_ERROR`, `SDK_ERROR`, `UNKNOWN`

#### Runtime Model Management

```typescript
// Fetch and cache runtime models
await copilotProvider.fetchRuntimeModels();

// Refresh and return all models (static + runtime)
const models = await copilotProvider.refreshModels();

// Check and clear cache
copilotProvider.hasCachedModels();
copilotProvider.clearModelCache();
```

---

### 6. OpencodeProvider (CLI-based, extends CliProvider)

**Location**: `apps/server/src/providers/opencode-provider.ts`
**Registration name**: `'opencode'`
**Priority**: 3

Spawns the `opencode` CLI using `--output-format stream-json`. On Windows, runs via `npx`. Supports dynamic model discovery via `opencode models --verbose`.

#### Features

- Dynamic model discovery with 5-minute cache
- Multi-provider model access (OpenCode proxies Anthropic, OpenAI, Copilot, etc.)
- Auth status via `opencode auth list`
- `supportsFeature`: inherits `['tools', 'text']` default

#### Model Detection

Routes models matching `isOpencodeModel()` from `@pegasus/types`. OpenCode model IDs follow the pattern `<provider>/<model>` (e.g., `copilot/claude-sonnet-4-5`).

#### OpenCode Stream Event Types

| Event Type                   | Handling                                                    |
| ---------------------------- | ----------------------------------------------------------- |
| `text`                       | Yields `{ type: 'assistant', content: [{ type: 'text' }] }` |
| `tool_use`                   | Yields normalized `tool_use` or `tool_result` content block |
| `tool_call`                  | Yields `tool_use` content block                             |
| `tool_result`                | Yields `tool_result` content block                          |
| `step_start` / `step_finish` | Ignored (agentic loop bookkeeping)                          |
| `error` / `tool_error`       | Yields `{ type: 'error', error: '...' }`                    |

---

### 7. MockProvider (testing only, extends BaseProvider)

**Location**: `apps/server/src/providers/mock-provider.ts`
**Registration name**: N/A (not registered; used directly when `PEGASUS_MOCK_AGENT=true`)

A no-op provider for E2E and CI testing. Never calls external APIs. Used automatically by `ProviderFactory.getProviderForModel()` when `PEGASUS_MOCK_AGENT=true` is set.

```typescript
// Yields a fixed response then a success result:
yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Mock agent output for testing.' }] } };
yield { type: 'result', subtype: 'success' };
```

`detectInstallation()` always returns `installed: true, authenticated: true, method: 'sdk'`.

---

## Provider Factory and Registry

**Location**: `apps/server/src/providers/provider-factory.ts`

### Registration Pattern

Providers register themselves using `registerProvider()` on import. The factory file imports all providers and registers them with name, factory function, model matcher, priority, and optional aliases:

```typescript
registerProvider("claude", {
  factory: () => new ClaudeProvider(),
  aliases: ["anthropic"],
  canHandleModel: (model) =>
    model.startsWith("claude-") ||
    ["opus", "sonnet", "haiku"].some((n) => model.includes(n)),
  priority: 0,
});

registerProvider("cursor", {
  factory: () => new CursorProvider(),
  canHandleModel: (model) => isCursorModel(model),
  priority: 10,
});

// ... and so on for codex, opencode, gemini, copilot
```

### Priority Order

| Priority | Provider                  |
| -------- | ------------------------- |
| 10       | cursor                    |
| 6        | copilot                   |
| 5        | codex                     |
| 4        | gemini                    |
| 3        | opencode                  |
| 0        | claude (default fallback) |

### ProviderFactory Static Methods

```typescript
class ProviderFactory {
  /**
   * Get a provider instance for a model ID.
   * Returns MockProvider when PEGASUS_MOCK_AGENT=true.
   * Throws if provider is disconnected and throwOnDisconnected is true (default).
   */
  static getProviderForModel(
    modelId: string,
    options?: { throwOnDisconnected?: boolean },
  ): BaseProvider;

  /**
   * Get the ModelProvider name for a model without creating an instance.
   * Returns 'claude' as the default when no provider matches.
   */
  static getProviderNameForModel(model: string): ModelProvider;

  /**
   * Get the provider name string for a model (internal resolution).
   */
  static getProviderForModelName(modelId: string): string;

  /**
   * Get a provider instance by name or alias.
   * Returns null if not found.
   */
  static getProviderByName(name: string): BaseProvider | null;

  /**
   * Get an instance of every registered provider.
   */
  static getAllProviders(): BaseProvider[];

  /**
   * Get model definitions from all registered providers.
   */
  static getAllAvailableModels(): ModelDefinition[];

  /**
   * Get the list of all registered provider names.
   */
  static getRegisteredProviderNames(): string[];

  /**
   * Run detectInstallation() on all registered providers.
   */
  static async checkAllProviders(): Promise<Record<string, InstallationStatus>>;

  /**
   * Check if a model supports vision input.
   * Defaults to true if the model is not found in any provider's model list.
   */
  static modelSupportsVision(modelId: string): boolean;
}
```

### Model Resolution Logic

`getProviderForModel()` and `getProviderForModelName()` follow this resolution order:

1. Short-circuit to `MockProvider` / `'claude'` when `PEGASUS_MOCK_AGENT=true`
2. Sort all registered providers by priority (descending)
3. Call each provider's `canHandleModel(lowerModelId)` in priority order; return first match
4. Fall back to prefix matching: `lowerModelId.startsWith('<providerName>-')`
5. Default to `'claude'`

---

## Disconnection Detection

**Location**: `apps/server/src/providers/provider-factory.ts`

```typescript
export function isProviderDisconnected(providerName: string): boolean;
```

Checks for the presence of a sentinel file in `.pegasus/`:

| Provider   | Sentinel File            |
| ---------- | ------------------------ |
| `claude`   | `.claude-disconnected`   |
| `codex`    | `.codex-disconnected`    |
| `cursor`   | `.cursor-disconnected`   |
| `opencode` | `.opencode-disconnected` |
| `gemini`   | `.gemini-disconnected`   |
| `copilot`  | `.copilot-disconnected`  |

`getProviderForModel()` calls this check (when `throwOnDisconnected` is `true`, the default) and throws with a user-readable message directing the user to Settings > Providers to reconnect.

---

## Simple Query Service

**Location**: `apps/server/src/providers/simple-query-service.ts`

A higher-level interface over `ProviderFactory` for routes that only need text responses, without writing custom streaming loops.

### Functions

```typescript
// Accumulate a complete text response
async function simpleQuery(
  options: SimpleQueryOptions,
): Promise<SimpleQueryResult>;

// Stream with callbacks for real-time progress
async function streamingQuery(
  options: StreamingQueryOptions,
): Promise<SimpleQueryResult>;
```

### SimpleQueryOptions

```typescript
interface SimpleQueryOptions {
  prompt: string | Array<{ type: string; text?: string; source?: object }>;
  model?: string; // Default: 'claude-sonnet-4-6'
  cwd: string;
  systemPrompt?: string;
  maxTurns?: number; // Default: 1 for simpleQuery, 250 for streamingQuery
  allowedTools?: string[]; // Default: [] for simpleQuery, ['Read', 'Glob', 'Grep'] for streamingQuery
  abortController?: AbortController;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  thinkingLevel?: ThinkingLevel;
  reasoningEffort?: ReasoningEffort;
  readOnly?: boolean;
  settingSources?: Array<"user" | "project" | "local">;
  claudeCompatibleProvider?: ClaudeCompatibleProvider;
  claudeApiProfile?: ClaudeApiProfile; // @deprecated, use claudeCompatibleProvider
  credentials?: Credentials;
}
```

### StreamingQueryOptions

Extends `SimpleQueryOptions` with optional callbacks:

```typescript
interface StreamingQueryOptions extends SimpleQueryOptions {
  onText?: (text: string) => void;
  onToolUse?: (tool: string, input: unknown) => void;
  onThinking?: (thinking: string) => void;
}
```

### SimpleQueryResult

```typescript
interface SimpleQueryResult {
  text: string;
  structured_output?: Record<string, unknown>;
}
```

### Usage Example

```typescript
import {
  simpleQuery,
  streamingQuery,
} from "../providers/simple-query-service.js";

// Simple one-shot query
const result = await simpleQuery({
  prompt: "Generate a feature title for: user authentication",
  cwd: process.cwd(),
  systemPrompt: "You are a title generator. Return only the title.",
  maxTurns: 1,
  allowedTools: [],
});
console.log(result.text);

// Streaming with progress callbacks
const result = await streamingQuery({
  prompt: "Analyze this project and suggest improvements",
  cwd: "/path/to/project",
  maxTurns: 250,
  allowedTools: ["Read", "Glob", "Grep"],
  onText: (text) => emitProgressEvent(text),
  onToolUse: (tool, input) => emitToolUseEvent(tool, input),
  onThinking: (thinking) => emitThinkingEvent(thinking),
});
```

---

## Adding New Providers

### Step 1: Create the Provider File

For CLI-based providers, extend `CliProvider`:

```typescript
// apps/server/src/providers/myprovider-provider.ts
import { CliProvider, type CliSpawnConfig } from "./cli-provider.js";
import type {
  ExecuteOptions,
  ProviderMessage,
  InstallationStatus,
  ModelDefinition,
} from "./types.js";

export class MyProvider extends CliProvider {
  getName(): string {
    return "myprovider";
  }
  getCliName(): string {
    return "my-cli";
  }

  getSpawnConfig(): CliSpawnConfig {
    return {
      windowsStrategy: "npx",
      npxPackage: "@myorg/my-cli",
      commonPaths: {
        linux: ["~/.local/bin/my-cli", "/usr/local/bin/my-cli"],
        darwin: ["~/.local/bin/my-cli", "/opt/homebrew/bin/my-cli"],
        win32: [],
      },
    };
  }

  buildCliArgs(options: ExecuteOptions): string[] {
    return [
      "--json",
      "--model",
      options.model,
      "--prompt",
      options.prompt as string,
    ];
  }

  normalizeEvent(event: unknown): ProviderMessage | null {
    const e = event as { type: string; content?: string };
    if (e.type === "text") {
      return {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: e.content ?? "" }],
        },
      };
    }
    if (e.type === "done") {
      return { type: "result", subtype: "success" };
    }
    return null;
  }

  async detectInstallation(): Promise<InstallationStatus> {
    const installed = await this.isInstalled();
    return { installed, method: "cli", authenticated: true };
  }

  getAvailableModels(): ModelDefinition[] {
    return [
      {
        id: "myprovider-default",
        name: "My Provider Default",
        modelString: "default",
        provider: "myprovider",
        description: "...",
      },
    ];
  }
}
```

For SDK-based providers, extend `BaseProvider` directly.

### Step 2: Add the `isMyModel()` helper (optional)

Add a type-guard to `libs/types/src/` and export it from `libs/types/src/index.ts`:

```typescript
export function isMyProviderModel(modelId: string): boolean {
  return modelId.startsWith("myprovider-");
}
```

### Step 3: Register the Provider

Add the registration block at the bottom of `provider-factory.ts`:

```typescript
import { MyProvider } from "./myprovider-provider.js";
import { isMyProviderModel } from "@pegasus/types";

registerProvider("myprovider", {
  factory: () => new MyProvider(),
  aliases: ["my-alias"],
  canHandleModel: (model) => isMyProviderModel(model),
  priority: 7, // Choose a priority that reflects desired matching order
});
```

### Step 4: Export from the Index

Update `apps/server/src/providers/index.ts`:

```typescript
export { MyProvider } from "./myprovider-provider.js";
```

### No Other Changes Required

Services (`AgentService`, `AutoModeService`) use `ProviderFactory.getProviderForModel()` and are unaffected by new registrations.

---

## Core Types

All types are defined in `libs/types/src/provider.ts` and re-exported from `apps/server/src/providers/types.ts`.

### ProviderConfig

```typescript
interface ProviderConfig {
  apiKey?: string;
  cliPath?: string;
  env?: Record<string, string>;
}
```

### ExecuteOptions (key fields)

```typescript
interface ExecuteOptions {
  prompt: string | Array<{ type: string; text?: string; source?: object }>;
  /** Bare model ID without provider prefix */
  model: string;
  /** Original model ID with provider prefix (for logging) */
  originalModel?: string;
  cwd: string;
  systemPrompt?: string | SystemPromptPreset;
  maxTurns?: number;
  allowedTools?: string[];
  tools?: string[];                                   // Controls tool availability (not just approval)
  mcpServers?: Record<string, McpServerConfig>;
  mcpUnrestrictedTools?: boolean;
  mcpAutoApproveTools?: boolean;
  abortController?: AbortController;
  conversationHistory?: ConversationMessage[];
  sdkSessionId?: string;
  settingSources?: Array<'user' | 'project' | 'local'>;
  readOnly?: boolean;
  thinkingLevel?: ThinkingLevel;
  agents?: Record<string, AgentDefinition>;
  reasoningEffort?: ReasoningEffort;
  codexSettings?: { ... };                            // Codex-specific options
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  claudeCompatibleProvider?: ClaudeCompatibleProvider;
  claudeApiProfile?: ClaudeApiProfile;                // @deprecated
  credentials?: Credentials;
}
```

### ProviderMessage

```typescript
interface ProviderMessage {
  type: "assistant" | "user" | "error" | "result";
  subtype?:
    | "success"
    | "error"
    | "error_max_turns"
    | "error_max_structured_output_retries"
    | "error_during_execution"
    | "error_max_budget_usd";
  session_id?: string;
  message?: {
    role: "user" | "assistant";
    content: ContentBlock[];
  };
  result?: string;
  error?: string;
  parent_tool_use_id?: string | null;
  structured_output?: Record<string, unknown>;
}
```

### ContentBlock

```typescript
interface ContentBlock {
  type: "text" | "tool_use" | "thinking" | "tool_result";
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}
```

### InstallationStatus

```typescript
interface InstallationStatus {
  installed: boolean;
  path?: string;
  version?: string;
  /** 'cli' | 'wsl' | 'npm' | 'brew' | 'sdk' */
  method?: "cli" | "wsl" | "npm" | "brew" | "sdk";
  hasApiKey?: boolean;
  hasOAuthToken?: boolean;
  authenticated?: boolean;
  error?: string;
}
```

### ModelDefinition

```typescript
interface ModelDefinition {
  id: string;
  name: string;
  modelString: string;
  provider: string;
  description: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  tier?: "basic" | "standard" | "premium";
  default?: boolean;
  hasReasoning?: boolean;
}
```

### ReasoningEffort

```typescript
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

Timeout multipliers (applied to a 120 s CLI base or 30 s SDK base):
`none: 1.0`, `minimal: 1.2`, `low: 1.5`, `medium: 2.0`, `high: 3.0`, `xhigh: 4.0`

---

## Best Practices

### Message Format Consistency

All providers MUST yield the same `ProviderMessage` shape:

```typescript
// Correct
yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] } };
yield { type: 'result', subtype: 'success' };

// Correct for errors
yield { type: 'error', error: 'Something went wrong' };
```

### Conversation History

- **SDK providers** (Claude): Use SDK session resumption via `sdkSessionId` and `conversationHistory`
- **CLI providers**: Use `formatHistoryAsText()` from `@pegasus/utils` to prepend history as text

### Model IDs Passed to Providers

`AgentService` strips the provider prefix before calling `executeQuery()`. The `model` field in `ExecuteOptions` is the **bare** model ID (no `cursor-`, `gemini-`, etc. prefix). Use `validateBareModelId()` from `@pegasus/types` in your provider to assert this invariant.

Exception: `CopilotProvider` skips this check because Copilot model IDs legitimately contain prefixes like `claude-`, `gemini-`, `gpt-` that are part of the actual model name.

### Logging

Use `createLogger()` from `@pegasus/utils` with the provider class name:

```typescript
const logger = createLogger("MyProvider");
logger.debug("CLI detected at:", this.cliPath);
logger.error("Authentication failed:", error);
```

### Abort Signal

Respect the abort controller. `CliProvider.executeQuery()` handles this for CLI providers automatically via `isAbortError()`. SDK-based providers should check `isAbortError(error)` in their catch blocks.

---

## Troubleshooting

### Wrong Provider Selected

**Problem**: `ProviderFactory.getProviderForModel()` routes to the wrong provider.

**Debug**:

```typescript
console.log(ProviderFactory.getProviderNameForModel("my-model-id"));
console.log(ProviderFactory.getRegisteredProviderNames());
```

Check that: (1) the provider is registered, (2) `canHandleModel()` returns true for the model ID, (3) no higher-priority provider is matching first.

### Provider Shows as Disconnected

**Problem**: Calls throw "CLI is disconnected from the app."

**Solution**: Check for `.pegasus/.<provider>-disconnected` sentinel file in the project directory. Remove it or use Settings > Providers > Sign In to reconnect.

To bypass the check for diagnostics:

```typescript
ProviderFactory.getProviderForModel(modelId, { throwOnDisconnected: false });
```

### Authentication Errors

**Problem**: Provider fails with authentication error.

**Solution**:

1. Call `provider.detectInstallation()` and inspect `authenticated` field
2. For CLI providers: run the CLI interactively to authenticate (e.g., `gemini`, `codex login`, `gh auth login`)
3. Check environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GITHUB_TOKEN`

### CLI Not Found

**Problem**: CLI provider throws "CLI not found."

**Solution**:

1. Verify CLI is installed: run the CLI command directly in a terminal
2. Check `CliSpawnConfig.commonPaths` for expected installation locations
3. On Windows: verify WSL is installed and the CLI is available inside WSL (for WSL-strategy providers)

### Subprocess Hangs or Timeout

**Problem**: CLI subprocess produces no output.

**Solution**:

1. For reasoning models, check that `reasoningEffort` is set appropriately — `'xhigh'` uses 4× the base timeout
2. Enable debug output: set `PEGASUS_DEBUG_RAW_OUTPUT=true` and `LOG_LEVEL=debug`
3. Verify the CLI runs correctly in isolation with the same arguments

### JSONL Parsing Errors

**Problem**: Provider fails to parse CLI output.

**Solution**:

1. Run the CLI manually with the same flags and inspect raw output
2. Check for unexpected non-JSON lines (warnings, banners) that need to be filtered in `normalizeEvent()`
3. Return `null` from `normalizeEvent()` to silently skip unknown event types
