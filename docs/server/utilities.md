# Server Utilities Reference

This document describes all utility modules available to the server. Utilities are split between **shared packages** (`@pegasus/*`) and **server-local lib files** (`apps/server/src/lib/`).

---

## Table of Contents

### Shared Packages (`@pegasus/*`)

1. [@pegasus/utils — Image Handler](#image-handler-pegasusutils)
2. [@pegasus/utils — Prompt Builder](#prompt-builder-pegasusutils)
3. [@pegasus/utils — Conversation Utils](#conversation-utils-pegasusutils)
4. [@pegasus/utils — Error Handler](#error-handler-pegasusutils)
5. [@pegasus/utils — Logger](#logger-pegasusutils)
6. [@pegasus/model-resolver — Model Resolver](#model-resolver-pegasusmodel-resolver)
7. [@pegasus/platform — Subprocess Manager](#subprocess-manager-pegasusplatform)
8. [@pegasus/platform — Security & Secure FS](#security--secure-fs-pegasusplatform)

### Server-Local Lib (`apps/server/src/lib/`)

9. [agent-discovery.ts](#agent-discoveryts)
10. [app-spec-format.ts](#app-spec-formatts)
11. [auth.ts](#authts)
12. [auth-utils.ts](#auth-utilsts)
13. [cli-detection.ts](#cli-detectionts)
14. [codex-auth.ts](#codex-authts)
15. [enhancement-prompts.ts](#enhancement-promptsts)
16. [error-handler.ts (server)](#error-handlerts-server)
17. [events.ts](#eventsts)
18. [exec-utils.ts](#exec-utilsts)
19. [git.ts](#gitts)
20. [git-log-parser.ts](#git-log-parserts)
21. [json-extractor.ts](#json-extractorts)
22. [permission-enforcer.ts](#permission-enforcerts)
23. [sdk-options.ts](#sdk-optionsts)
24. [secure-fs.ts (server-local)](#secure-fsts-server-local)
25. [settings-helpers.ts](#settings-helpersts)
26. [terminal-themes-data.ts](#terminal-themes-datats)
27. [validation-storage.ts](#validation-storagets)
28. [version.ts](#versionts)
29. [worktree-metadata.ts](#worktree-metadatats)
30. [xml-extractor.ts](#xml-extractorts)

---

## Shared Packages (`@pegasus/*`)

These utilities are defined in `libs/` and imported by the server via package name. Always import from the package, not from internal paths.

---

## Image Handler (`@pegasus/utils`)

**Source**: `libs/utils/src/image-handler.ts`
**Import**: `import { getMimeTypeForImage, ... } from '@pegasus/utils'`

Centralized utilities for processing image files, including MIME type detection, base64 encoding, and content block generation for Claude SDK format.

### Functions

#### `getMimeTypeForImage(imagePath: string): string`

Get MIME type for an image file based on its extension.

**Supported formats**:

- `.jpg`, `.jpeg` → `image/jpeg`
- `.png` → `image/png`
- `.gif` → `image/gif`
- `.webp` → `image/webp`
- Default: `image/png`

---

#### `readImageAsBase64(imagePath: string): Promise<ImageData>`

Read an image file and convert to base64 with metadata.

**Returns**: `ImageData`

```typescript
interface ImageData {
  base64: string;       // Base64-encoded image data
  mimeType: string;     // MIME type
  filename: string;     // File basename
  originalPath: string; // Original file path
}
```

---

#### `convertImagesToContentBlocks(imagePaths: string[], workDir?: string): Promise<ImageContentBlock[]>`

Convert image paths to content blocks in Claude SDK format. Handles both relative and absolute paths.

---

#### `formatImagePathsForPrompt(imagePaths: string[]): string`

Format image paths as a bulleted list for inclusion in text prompts. Returns empty string if no images.

---

## Prompt Builder (`@pegasus/utils`)

**Source**: `libs/utils/src/prompt-builder.ts`
**Import**: `import { buildPromptWithImages } from '@pegasus/utils'`

Standardized prompt building that combines text prompts with image attachments.

### Functions

#### `buildPromptWithImages(basePrompt: string, imagePaths?: string[], workDir?: string, includeImagePaths?: boolean): Promise<PromptWithImages>`

Build a prompt with optional image attachments.

```typescript
interface PromptWithImages {
  content: PromptContent; // string | Array<ContentBlock>
  hasImages: boolean;
}
```

**Use Cases**:

- **AgentService**: Set `includeImagePaths: true` to list paths for Read tool access
- **AutoModeService**: Set `includeImagePaths: false` to avoid duplication in feature descriptions

---

## Conversation Utils (`@pegasus/utils`)

**Source**: `libs/utils/src/conversation-utils.ts`
**Import**: `import { extractTextFromContent, ... } from '@pegasus/utils'`

Standardized conversation history processing for both SDK-based and CLI-based providers.

### Functions

- `extractTextFromContent(content)` — Extract plain text from string or array content
- `normalizeContentBlocks(content)` — Normalize message content to array format
- `formatHistoryAsText(history)` — Format conversation history as plain text for CLI providers
- `convertHistoryToMessages(history)` — Convert history to Claude SDK message format

---

## Error Handler (`@pegasus/utils`)

**Source**: `libs/utils/src/error-handler.ts`
**Import**: `import { classifyError, isAbortError, ... } from '@pegasus/utils'`

This is the **shared** error handler used across all packages. Note: a separate, more comprehensive `error-handler.ts` also exists in `apps/server/src/lib/` for server-specific CLI provider errors — see [Error Handler (server)](#error-handlerts-server).

### Types (from `@pegasus/types`)

```typescript
// ErrorType — 9 values
export type ErrorType =
  | 'authentication'
  | 'cancellation'
  | 'abort'
  | 'execution'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'model_not_found'
  | 'stream_disconnected'
  | 'unknown';

// ErrorInfo — 11 fields
export interface ErrorInfo {
  type: ErrorType;
  message: string;
  isAbort: boolean;
  isAuth: boolean;
  isCancellation: boolean;
  isRateLimit: boolean;
  isQuotaExhausted: boolean;    // Session/weekly usage limit reached
  isModelNotFound: boolean;     // Model does not exist or user lacks access
  isStreamDisconnected: boolean;// Stream disconnected before completion
  retryAfter?: number;          // Seconds to wait before retrying (rate limit errors)
  originalError: unknown;
}
```

### Functions

- `isAbortError(error)` — Detect abort/cancellation errors
- `isCancellationError(errorMessage)` — Detect user-initiated cancellations by message string
- `isAuthenticationError(errorMessage)` — Detect authentication/API key errors by message string
- `isRateLimitError(error)` — Detect 429 rate limit errors
- `isQuotaExhaustedError(error)` — Detect quota/session/weekly limit exhaustion
- `isModelNotFoundError(error)` — Detect unknown or inaccessible model errors
- `isStreamDisconnectedError(error)` — Detect premature stream disconnections
- `extractRetryAfter(error)` — Extract retry-after delay in seconds from rate limit errors
- `classifyError(error): ErrorInfo` — Classify an error into a typed `ErrorInfo`
- `getUserFriendlyErrorMessage(error)` — Get a user-friendly error message string
- `getErrorMessage(error)` — Extract raw error message string
- `logError(error, context)` — Log error with context using the shared logger

---

## Logger (`@pegasus/utils`)

**Source**: `libs/utils/src/logger.ts`
**Import**: `import { createLogger } from '@pegasus/utils'`

All server modules should use this for consistent structured logging.

```typescript
const logger = createLogger('MyModule');

logger.debug('Detailed info', { key: 'value' });
logger.info('Operation started');
logger.warn('Something unexpected');
logger.error('Failed', error);
```

**Additional exports**: `getLogLevel`, `setLogLevel`, `setColorsEnabled`, `setTimestampsEnabled`, `LogLevel`, `Logger`

---

## Model Resolver (`@pegasus/model-resolver`)

**Source**: `libs/model-resolver/src/resolver.ts`
**Import**: `import { resolveModelString, getEffectiveModel } from '@pegasus/model-resolver'`

Centralized model string mapping and resolution. Constants are re-exported from `@pegasus/types`.

### Constants

```typescript
// From @pegasus/types, re-exported by @pegasus/model-resolver
export const CLAUDE_MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-6',
};

export const DEFAULT_MODELS = {
  claude: 'claude-opus-4-6',
  openai: 'gpt-5.2',
};
```

### Functions

#### `resolveModelString(modelKey?: string, defaultModel?: string): string`

Resolve a model key/alias to a full model string.

**Logic**:

1. If `modelKey` is undefined → return `defaultModel`
2. If starts with `"gpt-"` or `"o"` → pass through (OpenAI/Codex model)
3. If includes `"claude-"` → pass through (full Claude model string)
4. If in `CLAUDE_MODEL_MAP` → return mapped value
5. Otherwise → return `defaultModel` with warning

**Example**:

```typescript
import { resolveModelString } from '@pegasus/model-resolver';

resolveModelString('opus');                     // → "claude-opus-4-6"
resolveModelString('gpt-5.2');                  // → "gpt-5.2"
resolveModelString('claude-sonnet-4-20250514'); // → "claude-sonnet-4-20250514"
```

#### `getEffectiveModel(explicitModel?, sessionModel?, defaultModel?): string`

Resolve effective model from multiple sources. Priority: explicit > session > default.

#### `resolvePhaseModel(phaseKey, settings?): ResolvedPhaseModel`

Resolve a model for a specific pipeline phase using settings overrides.

---

## Subprocess Manager (`@pegasus/platform`)

**Source**: `libs/platform/src/subprocess.ts`
**Import**: `import { spawnJSONLProcess, spawnProcess } from '@pegasus/platform'`

Utilities for spawning CLI processes (used by Codex, Cursor, and other CLI providers).

### Types

```typescript
export interface SubprocessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  abortController?: AbortController;
  timeout?: number; // Milliseconds of no output before timeout
}

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}
```

### Functions

#### `spawnJSONLProcess(options: SubprocessOptions): AsyncGenerator<unknown>`

Spawns a subprocess and streams JSONL output line-by-line. Handles abort signals, 30-second timeout detection, and parses each line as JSON.

#### `spawnProcess(options: SubprocessOptions): Promise<SubprocessResult>`

Spawns a subprocess and collects all output into a single result.

---

## Security & Secure FS (`@pegasus/platform`)

**Source**: `libs/platform/src/security.ts`, `libs/platform/src/secure-fs.ts`
**Import**: `import { secureFs, validatePath, isPathAllowed } from '@pegasus/platform'`

### Security Functions

- `initAllowedPaths(roots)` — Initialize allowed root directories
- `isPathAllowed(path)` — Check if a path is within an allowed root
- `validatePath(path)` — Validate path or throw `PathNotAllowedError`
- `isPathWithinDirectory(path, dir)` — Check path containment
- `getAllowedRootDirectory()` / `getDataDirectory()` / `getAllowedPaths()` — Getters

### Secure FS (`secureFs`)

Drop-in replacement for Node.js `fs` that validates all paths before I/O:

```typescript
import { secureFs } from '@pegasus/platform';

await secureFs.readFile('/safe/path/file.txt', 'utf8');
await secureFs.writeFile('/safe/path/out.txt', content);
await secureFs.mkdir('/safe/path/dir', { recursive: true });
```

Includes async and sync variants of: `access`, `readFile`, `writeFile`, `mkdir`, `readdir`, `stat`, `rm`, `unlink`, `copyFile`, `appendFile`, `rename`, `lstat`, `joinPath`, `resolvePath`, `existsSync`, `readFileSync`, `writeFileSync`, `mkdirSync`, `readdirSync`, `statSync`.

---

## Server-Local Lib (`apps/server/src/lib/`)

These files live only in the server package and are imported with relative paths using `.js` ESM extensions.

---

## `agent-discovery.ts`

Scans the filesystem for `AGENT.md` files to discover custom subagent definitions.

**Discovers from**:
- `~/.claude/agents/` (user-level, global)
- `.claude/agents/` (project-level)

**Key exports**:

```typescript
export interface FilesystemAgent {
  name: string;          // Directory name (e.g., 'code-reviewer')
  definition: AgentDefinition;
  source: 'user' | 'project';
  filePath: string;      // Full path to AGENT.md
}
```

Functions: `discoverAgents(projectPath?)`, `parseAgentContent(content)`

---

## `app-spec-format.ts`

XML format specification for `app_spec.txt`. Re-exports spec types from `@pegasus/types` and provides XML utilities.

**Key exports**:

- `escapeXml(str)` — Escape special XML characters (handles null/undefined)
- `specToXml(spec)` — Convert structured `SpecOutput` to XML format
- Re-exports `SpecOutput` type and `specOutputSchema` from `@pegasus/types`

---

## `auth.ts`

Authentication middleware for API security. Supports two methods:

1. **Header-based** (`X-API-Key`) — used by Electron mode
2. **Cookie-based** (HTTP-only session cookie) — used by web mode

Auto-generates an API key on first run if none is configured. Cookie name includes the server port to prevent collisions between multiple Pegasus instances on the same hostname.

**Key exports**:

```typescript
export function authMiddleware(req, res, next): void
export function isAuthEnabled(): boolean
export function getAuthStatus(): { enabled: boolean; method: string }
export function isRequestAuthenticated(req): boolean
export async function createSession(): Promise<string>
export function validateSession(token): boolean
export async function invalidateSession(token): Promise<void>
export function createWsConnectionToken(): string    // Short-lived (5 min) for WebSocket
export function validateWsConnectionToken(token): boolean
export function validateApiKey(key): boolean
export function getSessionCookieOptions(): object
export function getSessionCookieName(): string
```

---

## `auth-utils.ts`

Secure authentication utilities that avoid environment variable race conditions when passing credentials to child processes.

**Key exports**:

```typescript
export interface AuthValidationResult {
  isValid: boolean;
  error?: string;
  normalizedKey?: string;
}

export function validateApiKey(
  key: string,
  provider: 'anthropic' | 'openai' | 'cursor'
): AuthValidationResult
```

---

## `cli-detection.ts`

Unified CLI detection framework providing consistent CLI detection and management across all providers (Claude, Codex, Cursor, etc.).

**Key exports**:

```typescript
export interface CliInfo {
  name: string;
  command: string;
  version?: string;
  path?: string;
  installed: boolean;
  authenticated: boolean;
  authMethod: 'cli' | 'api_key' | 'none';
  platform?: string;
  architectures?: string[];
}

export interface CliDetectionOptions {
  timeout?: number;
  includeWsl?: boolean;
  wslDistribution?: string;
}
```

---

## `codex-auth.ts`

Shared utility for checking Codex CLI authentication status using `codex login status`. Never assumes authenticated — only returns true if the CLI confirms.

**Key exports**:

```typescript
export interface CodexAuthCheckResult {
  authenticated: boolean;
  method: 'api_key_env' | 'cli_authenticated' | 'none';
}

export async function checkCodexAuthentication(
  cliPath?: string | null
): Promise<CodexAuthCheckResult>
```

---

## `enhancement-prompts.ts`

Re-exports all enhancement prompts from `@pegasus/prompts` for backward compatibility with existing server imports.

**Re-exports**: `IMPROVE_SYSTEM_PROMPT`, `TECHNICAL_SYSTEM_PROMPT`, `SIMPLIFY_SYSTEM_PROMPT`, `ACCEPTANCE_SYSTEM_PROMPT`, plus `getEnhancementPrompt`, `getSystemPrompt`, `getExamples`, `buildUserPrompt`, `isValidEnhancementMode`, `getAvailableEnhancementModes`, and types `EnhancementMode`, `EnhancementExample`.

Prefer importing directly from `@pegasus/prompts` in new code.

---

## `error-handler.ts` (server)

**Note**: This is a *separate, more extensive* error handler from the one in `@pegasus/utils`. It provides multi-provider error classification with pattern matching, severity levels, and retry handling specifically for CLI providers (Claude, Codex, Cursor).

### Types

```typescript
// 13 error types
export enum ErrorType {
  AUTHENTICATION = 'authentication',
  BILLING = 'billing',
  RATE_LIMIT = 'rate_limit',
  NETWORK = 'network',
  TIMEOUT = 'timeout',
  VALIDATION = 'validation',
  PERMISSION = 'permission',
  CLI_NOT_FOUND = 'cli_not_found',
  CLI_NOT_INSTALLED = 'cli_not_installed',
  MODEL_NOT_SUPPORTED = 'model_not_supported',
  INVALID_REQUEST = 'invalid_request',
  SERVER_ERROR = 'server_error',
  UNKNOWN = 'unknown',
}

export enum ErrorSeverity { LOW = 'low', MEDIUM = 'medium', HIGH = 'high', CRITICAL = 'critical' }

export interface ErrorClassification {
  type: ErrorType;
  severity: ErrorSeverity;
  userMessage: string;
  technicalMessage: string;
  suggestedAction?: string;
  retryable: boolean;
  provider?: string;
  context?: Record<string, unknown>;
}
```

### Functions

- `classifyError(error, provider?, context?): ErrorClassification` — Pattern-match error against known patterns
- `getUserFriendlyErrorMessage(error, provider?): string` — Human-readable message with optional provider prefix
- `isRetryableError(error): boolean` — Check if error supports retry
- `isAuthenticationError(error): boolean` — Check for auth errors
- `isBillingError(error): boolean` — Check for billing/credit errors
- `isRateLimitError(error): boolean` — Check for rate limit errors
- `createErrorResponse(error, provider?, context?)` — Structured HTTP error response object
- `logError(error, provider?, operation?, additionalContext?): void` — Log with full classification context
- `createRetryHandler(maxRetries?, baseDelay?)` — Factory for exponential-backoff retry wrappers

**Provider namespaces**: `ProviderErrorHandler.claude`, `ProviderErrorHandler.codex`, `ProviderErrorHandler.cursor` — each with `.classify()`, `.getUserMessage()`, `.isAuth()`, `.isBilling()`, `.isRateLimit()` methods.

---

## `events.ts`

Event emitter for streaming events to WebSocket clients. Re-exports `EventType` and `EventCallback` from `@pegasus/types`.

**Key exports**:

```typescript
export interface EventEmitter {
  emit: (type: EventType, payload: unknown) => void;
  subscribe: (callback: EventCallback) => () => void; // returns unsubscribe fn
}

export function createEventEmitter(): EventEmitter
```

---

## `exec-utils.ts`

Shared process execution utilities providing a pre-configured PATH that includes common tool installation locations (`/opt/homebrew/bin`, `~/.local/bin`, etc.).

**Key exports**:

```typescript
export const extendedPath: string  // PATH extended with common tool locations
export const execEnv: Record<string, string | undefined>  // process.env with extendedPath

export function getErrorMessage(error: unknown): string  // Extract message from any error type
```

---

## `git.ts`

Canonical git command execution utilities. All server consumers should import from here rather than defining their own git helpers.

**Key exports**:

```typescript
export async function execGitCommand(args: string[], cwd: string, env?: object): Promise<string>
export async function getCurrentBranch(worktreePath: string): Promise<string>
export function isIndexLockError(errorMessage: string): boolean
export async function removeStaleIndexLock(worktreePath: string): Promise<boolean>
export async function execGitCommandWithLockRetry(
  args: string[], cwd: string, env?: object, maxRetries?: number
): Promise<string>
```

---

## `git-log-parser.ts`

Parse structured `git log` output (NUL-delimited) into typed commit objects.

**Key exports**:

```typescript
export interface CommitFields {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
}

export function parseGitLogOutput(output: string): CommitFields[]
```

---

## `json-extractor.ts`

Robust JSON extraction from AI responses that may contain markdown, code blocks, or other mixed text content. Used when structured output is unavailable (e.g., Cursor responses).

**Key exports**:

```typescript
export interface ExtractJsonOptions {
  logger?: JsonExtractorLogger;
  requiredKey?: string;   // Required key that must be present in extracted JSON
}

export function extractJson(text: string, options?: ExtractJsonOptions): unknown
export function extractJsonArray(text: string, options?: ExtractJsonOptions): unknown[]
```

---

## `permission-enforcer.ts`

Permission enforcement utilities for the Cursor provider. Checks tool calls (shell, read, write) against the configured `CursorCliConfigFile` permissions.

**Key exports**:

```typescript
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkToolCallPermission(
  toolCall: CursorToolCall,
  permissions: CursorCliConfigFile | null
): PermissionCheckResult
```

---

## `sdk-options.ts`

Centralized SDK options factory for the Claude Agent SDK. Provides presets for common use cases. All factory functions validate `cwd` against `ALLOWED_ROOT_DIRECTORY` as a security checkpoint.

**Use case presets**:

```typescript
export function createSpecGenerationOptions(config: CreateSdkOptionsConfig): Options
export function createFeatureGenerationOptions(config: CreateSdkOptionsConfig): Options
export function createSuggestionsOptions(config: CreateSdkOptionsConfig): Options
export function createChatOptions(config: CreateSdkOptionsConfig): Options
export function createAutoModeOptions(config: CreateSdkOptionsConfig): Options
export function createCustomOptions(config: CreateSdkOptionsConfig): Options
```

**Config type**:

```typescript
export interface CreateSdkOptionsConfig {
  cwd: string;
  model?: string;
  systemPrompt?: string;
  mcpServers?: McpServerConfig[];
  thinkingLevel?: ThinkingLevel;
  // ...
}
```

**Additional exports**: `TOOL_PRESETS`, `MAX_TURNS`, `getModelForUseCase()`, `checkSandboxCompatibility()`, `validateWorkingDirectory()`, `SandboxCompatibilityResult`, `SystemPromptConfig`

---

## `secure-fs.ts` (server-local)

Re-exports `secureFs` from `@pegasus/platform` for backward compatibility with existing server imports.

```typescript
// Prefer importing directly from @pegasus/platform in new code:
import { secureFs } from '@pegasus/platform';

// Legacy server imports still work via named destructuring:
import * as secureFs from '../lib/secure-fs.js';
```

---

## `settings-helpers.ts`

Helper utilities for loading settings and context file handling across different server routes and services.

**Key exports**:

```typescript
export const DEFAULT_MAX_TURNS = 10000;
export const MAX_ALLOWED_TURNS = 10000;

export async function getAutoLoadClaudeMdSetting(settingsService): Promise<boolean>
export async function getUseClaudeCodeSystemPromptSetting(settingsService): Promise<boolean>
export async function getDefaultMaxTurnsSetting(settingsService): Promise<number>
export function filterClaudeMdFromContext(contextFiles): ContextFilesResult
export async function getMCPServersFromSettings(settingsService, projectPath?): Promise<McpServerConfig[]>
export async function getPromptCustomization(settingsService, projectPath?): Promise<PromptCustomization>
export async function getSkillsConfiguration(settingsService): Promise<{ ... }>
export async function getSubagentsConfiguration(settingsService): Promise<{ ... }>
export async function getCustomSubagents(settingsService, projectPath?): Promise<AgentDefinition[]>
export async function getActiveClaudeApiProfile(settingsService): Promise<ActiveClaudeApiProfileResult>
export async function getProviderById(settingsService, providerId): Promise<ProviderByIdResult>
export async function getPhaseModelWithOverrides(settingsService, phaseKey, projectPath?): Promise<PhaseModelWithOverridesResult>
export async function resolveProviderContext(settingsService, options): Promise<ProviderContextResult>
```

---

## `terminal-themes-data.ts`

Re-exports terminal theme data from `@pegasus/platform` for use in the server.

**Key exports**:

```typescript
export function getTerminalThemeColors(theme: ThemeMode): TerminalTheme
export function getAllTerminalThemes(): Record<ThemeMode, TerminalTheme>
export default terminalThemeColors  // All themes keyed by ThemeMode
```

---

## `validation-storage.ts`

CRUD operations for GitHub issue validation results. Stores results in `.pegasus/validations/{issueNumber}/validation.json` with a 24-hour cache TTL.

**Key exports**:

```typescript
export type { StoredValidation }  // Re-exported from @pegasus/types

export async function writeValidation(projectPath, issueNumber, data: StoredValidation): Promise<void>
export async function readValidation(projectPath, issueNumber): Promise<StoredValidation | null>
export async function deleteValidation(projectPath, issueNumber): Promise<void>
export function isValidationStale(validation: StoredValidation): boolean
```

---

## `version.ts`

Reads and caches the server version from `package.json`. Handles both development (tsx) and built/packaged output path layouts.

**Key exports**:

```typescript
export function getVersion(): string  // Returns semver string, e.g. "1.0.0"
```

---

## `worktree-metadata.ts`

Worktree-specific metadata storage in `.pegasus/worktrees/:branch/worktree.json`. Re-exports `PRState` and `WorktreePRInfo` from `@pegasus/types`.

**Key exports**:

```typescript
export interface WorktreeMetadata {
  branch: string;
  createdAt: string;
  pr?: WorktreePRInfo;
  initScriptRan?: boolean;
  initScriptStatus?: 'running' | 'success' | 'failed';
  initScriptError?: string;
}

export async function readWorktreeMetadata(projectPath, branch): Promise<WorktreeMetadata | null>
export async function writeWorktreeMetadata(projectPath, branch, data): Promise<void>
export async function updateWorktreeMetadata(projectPath, branch, updates): Promise<void>
```

---

## `xml-extractor.ts`

Robust XML parsing utilities for extracting and updating sections from `app_spec.txt` XML content. Uses regex-based parsing suited for Pegasus's controlled XML structure.

**Key exports**:

```typescript
export interface ImplementedFeature {
  name: string;
  description: string;
  file_locations?: string[];
}

export function extractSection(xml: string, tagName: string): string | null
export function updateSection(xml: string, tagName: string, newContent: string): string
export function extractImplementedFeatures(xml: string): ImplementedFeature[]
export function extractSpec(xml: string): Partial<SpecOutput>
```

---

## Import Guidelines

### Shared Package Utilities

Always import shared utilities from their package, never from old internal paths:

```typescript
// ✅ Correct
import { createLogger, classifyError, getErrorMessage } from '@pegasus/utils';
import { buildPromptWithImages, convertImagesToContentBlocks } from '@pegasus/utils';
import { resolveModelString, DEFAULT_MODELS } from '@pegasus/model-resolver';
import { spawnProcess, spawnJSONLProcess, secureFs } from '@pegasus/platform';

// ❌ Never import from old paths
import { createLogger } from '../lib/logger.js';              // Wrong
import { resolveModelString } from '../lib/model-resolver.js'; // Wrong
```

### Server-Local Lib Files

Use `.js` extension in imports for ESM compatibility:

```typescript
// ✅ Correct
import { createEventEmitter } from '../lib/events.js';
import { execGitCommand } from '../lib/git.js';
import { createSpecGenerationOptions } from '../lib/sdk-options.js';

// ❌ Incorrect
import { createEventEmitter } from '../lib/events';
```

### Choosing Between the Two `error-handler.ts` Files

| Use case | Import from |
|---|---|
| General SDK error detection (`isAbortError`, `isRateLimitError`, `classifyError` → `ErrorInfo`) | `@pegasus/utils` |
| CLI provider errors with pattern matching, severity, provider namespaces | `../lib/error-handler.js` |
