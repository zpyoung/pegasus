# Pegasus Shared Packages - LLM Guide

This guide helps AI assistants understand how to use Pegasus's shared packages effectively.

## Package Overview

Pegasus uses a monorepo structure with shared packages in `libs/`:

```
libs/
├── types/              # Type definitions (no dependencies)
├── platform/           # Platform utilities
├── prompts/            # AI prompt templates
├── model-resolver/     # Claude model resolution
├── dependency-resolver/# Feature dependency resolution
├── spec-parser/        # XML spec parser
├── utils/              # Utility functions (depends on @pegasus/platform)
├── git-utils/          # Git operations (depends on @pegasus/utils)
└── chat-ui/            # Headless React chat UI primitives
```

## When to Use Each Package

### @pegasus/types

**Use when:** You need type definitions for any Pegasus concept.

**Import for:**

- `Feature` - Feature interface with all properties
- `ExecuteOptions` - Claude agent execution options
- `ConversationMessage` - Chat message format
- `ErrorType`, `ErrorInfo` - Error handling types
- `CLAUDE_MODEL_MAP` - Model alias to ID mapping
- `DEFAULT_MODELS` - Default model configurations (`claude`, `cursor`, `codex`)

**Example:**

```typescript
import type { Feature, ExecuteOptions } from "@pegasus/types";
```

**Never import from:** `services/feature-loader`, `providers/types`

### @pegasus/platform

**Use when:** You need to work with Pegasus's directory structure, security, or spawn processes.

**Import for:**

- `getPegasusDir(projectPath)` - Get .pegasus directory
- `getFeaturesDir(projectPath)` - Get features directory
- `getFeatureDir(projectPath, featureId)` - Get specific feature directory
- `ensurePegasusDir(projectPath)` - Create .pegasus if needed
- `spawnJSONLProcess()` - Spawn process with JSONL output
- `spawnProcess()` - Spawn a subprocess
- `initAllowedPaths()` - Security path validation
- `isPathAllowed(path)` - Check if path is allowed
- `validatePath(path)` - Validate path against allowed list
- `getIdeationDir()`, `getIdeasDir()`, `getPipelinesDir()` - Additional directory helpers
- `STATIC_PORT`, `SERVER_PORT` - Port constants
- `detectDefaultEditor()`, `openInEditor()` - Editor detection/launching
- `detectDefaultTerminal()`, `openInExternalTerminal()` - Terminal detection/launching

**Example:**

```typescript
import { getFeatureDir, ensurePegasusDir } from "@pegasus/platform";
```

**Never import from:** `lib/pegasus-paths`, `lib/subprocess-manager`, `lib/security`

### @pegasus/prompts

**Use when:** You need AI prompt templates for text enhancement or other AI-powered features.

**Import for:**

- `getEnhancementPrompt(mode)` - Get complete prompt config for enhancement mode; returns `{ systemPrompt, description }`
- `getSystemPrompt(mode)` - Get system prompt for specific mode
- `getExamples(mode)` - Get few-shot examples for a mode
- `buildUserPrompt(mode, text, includeExamples?)` - Build user prompt; args are `(mode, text, includeExamples=true)`
- `isValidEnhancementMode(mode)` - Check if mode is valid
- `getAvailableEnhancementModes()` - Returns all valid mode names
- `IMPROVE_SYSTEM_PROMPT` - System prompt for improving vague descriptions
- `TECHNICAL_SYSTEM_PROMPT` - System prompt for adding technical details
- `SIMPLIFY_SYSTEM_PROMPT` - System prompt for simplifying verbose text
- `ACCEPTANCE_SYSTEM_PROMPT` - System prompt for adding acceptance criteria
- `UX_REVIEWER_SYSTEM_PROMPT` - System prompt for UX/design review
- Default prompt constants: `DEFAULT_AUTO_MODE_PROMPTS`, `DEFAULT_AGENT_PROMPTS`, `DEFAULT_BACKLOG_PLAN_PROMPTS`, `DEFAULT_ENHANCEMENT_PROMPTS`, `DEFAULT_COMMIT_MESSAGE_PROMPTS`, `DEFAULT_TITLE_GENERATION_PROMPTS`, `DEFAULT_IDEATION_PROMPTS`, `DEFAULT_APP_SPEC_PROMPTS`, `DEFAULT_SUGGESTIONS_PROMPTS`, `DEFAULT_TASK_EXECUTION_PROMPTS`, `DEFAULT_PROMPTS`
- Prompt merge utilities: `mergeAutoModePrompts`, `mergeAgentPrompts`, `mergeAllPrompts`, etc.

**Example:**

```typescript
import {
  getEnhancementPrompt,
  buildUserPrompt,
  isValidEnhancementMode,
} from "@pegasus/prompts";

if (isValidEnhancementMode("improve")) {
  const { systemPrompt, description } = getEnhancementPrompt("improve");
  const userPrompt = buildUserPrompt("improve", description);
  const result = await callClaude(systemPrompt, userPrompt);
}
```

**Never import from:** `lib/enhancement-prompts`

**Enhancement modes:**

- `improve` - Transform vague requests into clear, actionable tasks
- `technical` - Add implementation details and technical specifications
- `simplify` - Make verbose descriptions concise and focused
- `acceptance` - Add testable acceptance criteria
- `ux-reviewer` - Review and enhance from a user experience and design perspective

### @pegasus/model-resolver

**Use when:** You need to convert model aliases to full model IDs.

**Import for:**

- `resolveModelString(modelOrAlias?, defaultModel?)` - Convert alias to full ID
- `getEffectiveModel(explicitModel?, sessionModel?, defaultModel?)` - Priority-based model selection
- `resolvePhaseModel(phaseModel, defaultModel?)` - Resolve a phase model entry (string or object); returns `{ model, thinkingLevel?, reasoningEffort?, providerId? }`
- `DEFAULT_MODELS` - Access default models (`claude`, `cursor`, `codex`)

**Example:**

```typescript
import { resolveModelString, DEFAULT_MODELS } from "@pegasus/model-resolver";

// Convert user input to model ID
const modelId = resolveModelString("sonnet"); // → 'claude-sonnet-4-6'
const fallback = resolveModelString(undefined, DEFAULT_MODELS.claude);
```

**Never import from:** `lib/model-resolver`

**Model aliases:**

- `haiku` / `claude-haiku` → `claude-haiku-4-5-20251001` (fast, simple tasks)
- `sonnet` / `claude-sonnet` → `claude-sonnet-4-6` (balanced, recommended)
- `opus` / `claude-opus` → `claude-opus-4-6` (maximum capability)

**`DEFAULT_MODELS` keys:** `claude`, `cursor`, `codex` — there is no `autoMode` key.

### @pegasus/dependency-resolver

**Use when:** You need to order features by dependencies or check if dependencies are satisfied.

**Import for:**

- `resolveDependencies(features)` - Topological sort with priority; returns `{ orderedFeatures, circularDependencies, missingDependencies, blockedFeatures }`
- `areDependenciesSatisfied(feature, allFeatures, options?)` - Check if ready to execute
- `getBlockingDependencies(feature, allFeatures)` - Get incomplete dependencies
- `createFeatureMap(features)` - Build a feature ID map for repeated lookups
- `getBlockingDependenciesFromMap(feature, featureMap)` - Like `getBlockingDependencies` but takes a pre-built map
- `wouldCreateCircularDependency(featureId, newDepId, features)` - Pre-check before adding a dependency
- `dependencyExists(featureId, depId, features)` - Check if a dependency link exists
- `getAncestors(featureId, features)` - Get all ancestor features in dependency order
- `formatAncestorContextForPrompt(ancestors)` - Format ancestor info for AI prompts

**Example:**

```typescript
import {
  resolveDependencies,
  areDependenciesSatisfied,
} from "@pegasus/dependency-resolver";

const {
  orderedFeatures,
  circularDependencies,
  missingDependencies,
  blockedFeatures,
} = resolveDependencies(features);

if (circularDependencies.length === 0) {
  for (const feature of orderedFeatures) {
    if (areDependenciesSatisfied(feature, features)) {
      await execute(feature);
    }
  }
}
```

**Never import from:** `lib/dependency-resolver`

**Used in:**

- Auto-mode feature execution (server)
- Board view feature ordering (UI)

### @pegasus/spec-parser

**Use when:** You need to parse, generate, or validate XML app specs (`app_spec.txt`).

**Import for:**

- `xmlToSpec(xmlContent)` - Parse XML spec content into a `SpecOutput` object; returns `ParseResult`
- `specToXml(spec)` - Convert a `SpecOutput` object back to XML string
- `validateSpec(spec)` - Validate a `SpecOutput` object; returns `ValidationResult`
- `isValidSpecXml(xmlContent)` - Quick check whether XML content is valid spec XML
- `escapeXml(str)`, `unescapeXml(str)` - XML string escaping helpers
- `extractXmlSection(xml, tag)` - Extract a named XML section
- `extractXmlElements(xml, tag)` - Extract multiple XML elements by tag
- `SpecOutput` (re-exported from `@pegasus/types`) - Spec data type

**Example:**

```typescript
import { xmlToSpec, specToXml, validateSpec } from "@pegasus/spec-parser";

const result = xmlToSpec(rawXmlString);
if (result.success) {
  const { errors } = validateSpec(result.spec);
  if (errors.length === 0) {
    const xml = specToXml(result.spec);
  }
}
```

**Never import from:** `lib/spec-parser`

### @pegasus/utils

**Use when:** You need common utilities like logging, error handling, file I/O, or context loading.

**Depends on:** `@pegasus/platform`, `@pegasus/types`

**Import for:**

Error handling:

- `isAbortError(error)` - Check if error is an abort/cancellation
- `isCancellationError(error)` - Check if error is cancellation
- `isAuthenticationError(error)` - Check auth errors
- `isRateLimitError(error)` - Check rate limit errors
- `isQuotaExhaustedError(error)` - Check quota errors
- `isModelNotFoundError(error)` - Check model-not-found errors
- `isStreamDisconnectedError(error)` - Check stream disconnect errors
- `classifyError(error)` - Classify an error into an `ErrorInfo` object
- `getUserFriendlyErrorMessage(error)` - Human-readable error message
- `getErrorMessage(error)` - Extract error message string
- `logError(logger, error)` - Log an error with context
- `extractRetryAfter(error)` - Extract retry-after header value

Logging:

- `createLogger(context)` - Create a structured logger for a named context
- `getLogLevel()` / `setLogLevel(level)` - Get/set global log level
- `setColorsEnabled(enabled)` - Toggle ANSI colors
- `setTimestampsEnabled(enabled)` - Toggle log timestamps
- `LogLevel` - Log level enum

Conversation utilities:

- `extractTextFromContent(content)` - Extract text from message content blocks
- `normalizeContentBlocks(content)` - Normalize content to block array
- `formatHistoryAsText(history)` - Format conversation history as plain text
- `convertHistoryToMessages(history)` - Convert history to message format

Image handling:

- `getMimeTypeForImage(path)` - Get MIME type from file extension
- `readImageAsBase64(path)` - Read image file as base64 string
- `convertImagesToContentBlocks(images)` - Convert images to content blocks
- `formatImagePathsForPrompt(paths)` - Format image paths for prompt injection

Prompt building:

- `buildPromptWithImages(text, images?)` - Build prompt with optional image content blocks; returns `PromptWithImages`

File system:

- `mkdirSafe(path)` - Create directory, ignoring EEXIST
- `existsSafe(path)` - Check file existence without throwing
- `atomicWriteJson(path, data, options?)` - Atomic JSON file write
- `readJsonFile(path)` - Read and parse JSON file
- `updateJsonAtomically(path, updater)` - Read-modify-write JSON atomically
- `readJsonWithRecovery(path, options?)` - Read JSON with backup recovery
- `rotateBackups(path, count?)` - Rotate backup files

Path utilities:

- `normalizePath(path)` - Normalize path separators
- `pathsEqual(a, b)` - Compare paths platform-independently
- `sanitizeFilename(name)` - Strip unsafe characters from filenames

Context & memory:

- `loadContextFiles(options)` - Load context files from `.pegasus/context/`; returns `ContextFilesResult`
- `getContextFilesSummary(result)` - Summarize loaded context files
- `loadRelevantMemory(options)` - Load relevant memory files
- `initializeMemoryFolder(dir)` - Initialize memory directory structure
- `appendLearning(dir, entry)` - Append a learning entry to memory
- `recordMemoryUsage(dir, filename, terms)` - Record memory access stats
- `getMemoryDir(projectPath)` - Get memory directory path

Debounce/throttle:

- `debounce(fn, wait, options?)` - Debounce a function
- `throttle(fn, wait, options?)` - Throttle a function

Git validation:

- `isValidBranchName(name)` - Validate a git branch name
- `isValidRemoteName(name)` - Validate a git remote name
- `MAX_BRANCH_NAME_LENGTH` - Max allowed branch name length

**Example:**

```typescript
import { createLogger, classifyError } from "@pegasus/utils";

const logger = createLogger("FeatureExecutor");

try {
  await runAgent(featureDir, options);
  logger.info(`Feature completed`);
} catch (error) {
  const errorInfo = classifyError(error);
  logger.error(`Feature failed: ${errorInfo.message}`);
}
```

**Never import from:** `lib/logger`, `lib/error-handler`, `lib/prompt-builder`, `lib/image-handler`

### @pegasus/git-utils

**Use when:** You need git operations, status parsing, or diff generation.

**Depends on:** `@pegasus/platform`, `@pegasus/types`, `@pegasus/utils`

**Import for:**

- `isGitRepo(path)` - Check if path is a git repository
- `parseGitStatus(output)` - Parse `git status --porcelain` output
- `detectMergeState(path)` - Detect current merge state
- `detectMergeCommit(path)` - Detect if a merge commit exists
- `getGitRepositoryDiffs(path)` - Get complete diffs (tracked + untracked)
- `generateSyntheticDiffForNewFile(path, content)` - Create diff for untracked file
- `appendUntrackedFileDiffs(path, baseDiff)` - Append diffs for untracked files
- `listAllFilesInDirectory(path)` - List files excluding build artifacts
- `generateDiffsForNonGitDirectory(path)` - Generate diffs for non-git directories
- `getConflictFiles(path)` - List files with merge conflicts
- `getCurrentBranch(path)` - Get current git branch name
- `execGitCommand(args, cwd)` - Execute a git command
- `BINARY_EXTENSIONS`, `GIT_STATUS_MAP` - Constants for file type detection

**Example:**

```typescript
import { isGitRepo, getGitRepositoryDiffs } from "@pegasus/git-utils";

if (await isGitRepo(projectPath)) {
  const { diff, files, hasChanges } = await getGitRepositoryDiffs(projectPath);
  console.log(`Found ${files.length} changed files`);
}
```

**Never import from:** `routes/common`

**Handles:**

- Binary file detection
- Large file handling (>1MB)
- Untracked file diffs
- Non-git directory support

### @pegasus/chat-ui

**Use when:** You need to render a chat interface in a React component. This package provides headless, transport-agnostic React primitives.

**Note:** This package has React as a peer dependency (>=18). It does not depend on other `@pegasus/*` packages — it is standalone for UI reuse.

**Import for:**

Types:

- `ChatRole`, `ChatMessage`, `ChatStreamEvent` - Core chat data types
- `ChatTransport`, `ChatStatus` - Transport and status types
- `GroupedItem` - Grouped message item type
- `ChatPanelProps`, `MessageListProps`, `MessageBubbleProps`, `ToolGroupProps`, `InputBarProps`, `EmptyStateProps` - Component prop types

Components:

- `ChatPanel` - Top-level chat panel component (composes all other components)
- `MessageList` - Scrollable list of chat messages
- `MessageBubble` - Individual message bubble
- `ToolGroup` - Grouped tool call display
- `InputBar` - Chat input bar with submit handling
- `EmptyState` - Empty state placeholder

Hooks:

- `useChatStream` - Hook to manage a streaming chat session
- `useAutoScroll` - Hook to auto-scroll a container to the bottom

Utilities:

- `groupMessages(messages)` - Group consecutive messages for display
- `getToolDescription(toolName)` - Human-readable tool description

**Example:**

```typescript
import { ChatPanel, useChatStream } from '@pegasus/chat-ui';

function MyChatView() {
  const { messages, send, status } = useChatStream({ transport });
  return <ChatPanel messages={messages} onSend={send} status={status} />;
}
```

**Never import from:** `components/ChatPanel` (always use the package entry point)

## Common Patterns

### Creating a Feature Executor

```typescript
import type { Feature, ExecuteOptions } from "@pegasus/types";
import { createLogger, classifyError } from "@pegasus/utils";
import { resolveModelString, DEFAULT_MODELS } from "@pegasus/model-resolver";
import { areDependenciesSatisfied } from "@pegasus/dependency-resolver";
import { getFeatureDir } from "@pegasus/platform";

const logger = createLogger("FeatureExecutor");

async function executeFeature(
  feature: Feature,
  allFeatures: Feature[],
  projectPath: string,
) {
  // Check dependencies
  if (!areDependenciesSatisfied(feature, allFeatures)) {
    logger.warn(`Dependencies not satisfied for ${feature.id}`);
    return;
  }

  // Resolve model (use DEFAULT_MODELS.claude — not autoMode)
  const model = resolveModelString(feature.model, DEFAULT_MODELS.claude);

  // Get feature directory
  const featureDir = getFeatureDir(projectPath, feature.id);

  try {
    const options: ExecuteOptions = {
      model,
      temperature: 0.7,
    };

    await runAgent(featureDir, options);

    logger.info(`Feature ${feature.id} completed`);
  } catch (error) {
    const errorInfo = classifyError(error);
    logger.error(`Feature ${feature.id} failed:`, errorInfo.message);
  }
}
```

### Analyzing Git Changes

```typescript
import { getGitRepositoryDiffs, parseGitStatus } from "@pegasus/git-utils";
import { createLogger } from "@pegasus/utils";

const logger = createLogger("GitAnalyzer");

async function analyzeChanges(projectPath: string) {
  const { diff, files, hasChanges } = await getGitRepositoryDiffs(projectPath);

  if (!hasChanges) {
    logger.info("No changes detected");
    return;
  }

  // Group by status
  const modified = files.filter((f) => f.status === "M");
  const added = files.filter((f) => f.status === "A");
  const deleted = files.filter((f) => f.status === "D");
  const untracked = files.filter((f) => f.status === "?");

  logger.info(
    `Changes: ${modified.length}M ${added.length}A ${deleted.length}D ${untracked.length}U`,
  );

  return diff;
}
```

### Ordering Features for Execution

```typescript
import type { Feature } from "@pegasus/types";
import {
  resolveDependencies,
  getBlockingDependencies,
} from "@pegasus/dependency-resolver";
import { createLogger } from "@pegasus/utils";

const logger = createLogger("FeatureOrdering");

function orderAndFilterFeatures(features: Feature[]): Feature[] {
  const { orderedFeatures, circularDependencies } =
    resolveDependencies(features);

  if (circularDependencies.length > 0) {
    const cycle = circularDependencies[0].join(" → ");
    logger.error(`Circular dependency detected: ${cycle}`);
    throw new Error("Cannot execute features with circular dependencies");
  }

  // Filter to only ready features
  const readyFeatures = orderedFeatures.filter((feature) => {
    const blocking = getBlockingDependencies(feature, features);
    if (blocking.length > 0) {
      logger.debug(`${feature.id} blocked by: ${blocking.join(", ")}`);
      return false;
    }
    return true;
  });

  logger.info(`${readyFeatures.length} of ${features.length} features ready`);
  return readyFeatures;
}
```

### Parsing and Validating an App Spec

```typescript
import { xmlToSpec, validateSpec, specToXml } from "@pegasus/spec-parser";
import { createLogger } from "@pegasus/utils";

const logger = createLogger("SpecParser");

async function processSpec(rawXml: string): Promise<string> {
  const result = xmlToSpec(rawXml);
  if (!result.success) {
    logger.error(`Failed to parse spec: ${result.error}`);
    throw new Error(result.error);
  }

  const { errors } = validateSpec(result.spec);
  if (errors.length > 0) {
    logger.warn(`Spec validation warnings: ${errors.join(", ")}`);
  }

  return specToXml(result.spec);
}
```

## Import Rules for LLMs

### DO

```typescript
// Import types from @pegasus/types
import type { Feature, ExecuteOptions } from "@pegasus/types";

// Import constants from @pegasus/types
import { CLAUDE_MODEL_MAP, DEFAULT_MODELS } from "@pegasus/types";

// Import utilities from @pegasus/utils
import { createLogger, classifyError } from "@pegasus/utils";

// Import prompts from @pegasus/prompts
import { getEnhancementPrompt, isValidEnhancementMode } from "@pegasus/prompts";

// Import platform utils from @pegasus/platform
import { getFeatureDir, ensurePegasusDir } from "@pegasus/platform";

// Import model resolution from @pegasus/model-resolver
import { resolveModelString } from "@pegasus/model-resolver";

// Import dependency resolution from @pegasus/dependency-resolver
import { resolveDependencies } from "@pegasus/dependency-resolver";

// Import git utils from @pegasus/git-utils
import { getGitRepositoryDiffs } from "@pegasus/git-utils";

// Import spec parsing from @pegasus/spec-parser
import { xmlToSpec, specToXml } from "@pegasus/spec-parser";

// Import chat UI primitives from @pegasus/chat-ui
import { ChatPanel, useChatStream } from "@pegasus/chat-ui";
```

### DON'T

```typescript
// DON'T import from old paths
import { Feature } from '../services/feature-loader';           // ❌
import { ExecuteOptions } from '../providers/types';            // ❌
import { createLogger } from '../lib/logger';                   // ❌
import { resolveModelString } from '../lib/model-resolver';     // ❌
import { isGitRepo } from '../routes/common';                   // ❌
import { resolveDependencies } from '../lib/dependency-resolver'; // ❌
import { getEnhancementPrompt } from '../lib/enhancement-prompts'; // ❌

// DON'T import from old lib/ paths
import { getFeatureDir } from '../lib/pegasus-paths';         // ❌
import { classifyError } from '../lib/error-handler';           // ❌

// DON'T define types that exist in @pegasus/types
interface Feature { ... }  // ❌ Use: import type { Feature } from '@pegasus/types';

// DON'T use wrong API signatures
const { systemPrompt, userPrompt } = getEnhancementPrompt('improve', description); // ❌
// Correct: getEnhancementPrompt takes ONE arg and returns { systemPrompt, description }
const { systemPrompt, description } = getEnhancementPrompt('improve'); // ✅

// DON'T use wrong buildUserPrompt arg order
buildUserPrompt(description, 'improve');  // ❌
// Correct: (mode, text, includeExamples?)
buildUserPrompt('improve', description); // ✅

// DON'T use wrong resolveDependencies return shape
const { hasCycle, cyclicFeatures } = resolveDependencies(features); // ❌
// Correct:
const { orderedFeatures, circularDependencies, missingDependencies, blockedFeatures } =
  resolveDependencies(features); // ✅

// DON'T access DEFAULT_MODELS.autoMode — it doesn't exist
const model = DEFAULT_MODELS.autoMode; // ❌
// Correct: use .claude, .cursor, or .codex
const model = DEFAULT_MODELS.claude; // ✅
```

## Migration Checklist

When refactoring server code, check:

- [ ] All `Feature` imports use `@pegasus/types`
- [ ] All `ExecuteOptions` imports use `@pegasus/types`
- [ ] All logger usage uses `@pegasus/utils`
- [ ] All prompt templates use `@pegasus/prompts`
- [ ] All path operations use `@pegasus/platform`
- [ ] All model resolution uses `@pegasus/model-resolver`
- [ ] All dependency checks use `@pegasus/dependency-resolver`
- [ ] All git operations use `@pegasus/git-utils`
- [ ] All spec parsing uses `@pegasus/spec-parser`
- [ ] Chat UI components use `@pegasus/chat-ui`
- [ ] No imports from old `lib/` paths
- [ ] No imports from `services/feature-loader` (for types)
- [ ] No imports from `providers/types`

## Package Dependencies

Understanding the dependency chain helps prevent circular dependencies:

```
Level 0: @pegasus/types (no dependencies)
    ↓
Level 1: @pegasus/platform
         @pegasus/prompts
         @pegasus/model-resolver
         @pegasus/dependency-resolver
         @pegasus/spec-parser
    ↓
Level 2: @pegasus/utils  (depends on @pegasus/platform + @pegasus/types)
    ↓
Level 3: @pegasus/git-utils  (depends on @pegasus/utils + @pegasus/platform + @pegasus/types)
         @pegasus/chat-ui    (peer deps: react >=18; no @pegasus/* runtime deps)
    ↓
@pegasus/server, @pegasus/ui
```

**Rule:** Packages can only depend on packages at a lower level in the chain.

## Building Packages

All packages must be built before use:

```bash
# Build all packages from workspace
pnpm build:packages

# Or from root
pnpm install  # Installs and links workspace packages
```

## Module Format

All packages use ES modules (`type: "module"`) with NodeNext module resolution:

- Requires explicit `.js` extensions in import statements
- Compatible with both Node.js (server) and Vite (UI)
- Centralized ESM configuration in `libs/tsconfig.base.json`

## Testing

When writing tests:

```typescript
// ✅ Import from packages
import type { Feature } from "@pegasus/types";
import { createLogger } from "@pegasus/utils";

// ❌ Don't import from src
import { Feature } from "../../../src/services/feature-loader";
```

## Summary for LLMs

**Quick reference:**

- Types → `@pegasus/types`
- Platform paths/security/process → `@pegasus/platform`
- AI Prompts → `@pegasus/prompts`
- Model Resolution → `@pegasus/model-resolver`
- Dependency Ordering → `@pegasus/dependency-resolver`
- XML Spec Parsing → `@pegasus/spec-parser`
- Logging/Errors/Utils → `@pegasus/utils`
- Git Operations → `@pegasus/git-utils`
- React Chat UI → `@pegasus/chat-ui`

**Never import from:** `lib/*`, `services/feature-loader` (for types), `providers/types`, `routes/common`

**Always:** Use the shared packages instead of local implementations.
