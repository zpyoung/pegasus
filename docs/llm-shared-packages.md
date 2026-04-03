# Pegasus Shared Packages - LLM Guide

This guide helps AI assistants understand how to use Pegasus's shared packages effectively.

## Package Overview

Pegasus uses a monorepo structure with shared packages in `libs/`:

```
libs/
├── types/              # Type definitions (no dependencies)
├── utils/              # Utility functions
├── prompts/            # AI prompt templates
├── platform/           # Platform utilities
├── model-resolver/     # Claude model resolution
├── dependency-resolver/# Feature dependency resolution
└── git-utils/          # Git operations
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
- `DEFAULT_MODELS` - Default model configurations

**Example:**

```typescript
import type { Feature, ExecuteOptions } from '@pegasus/types';
```

**Never import from:** `services/feature-loader`, `providers/types`

### @pegasus/utils

**Use when:** You need common utilities like logging, error handling, or image processing.

**Import for:**

- `createLogger(context)` - Structured logging
- `isAbortError(error)` - Error type checking
- `classifyError(error)` - Error classification
- `buildPromptWithImages()` - Prompt building with images
- `readImageAsBase64()` - Image handling
- `extractTextFromContent()` - Message parsing

**Example:**

```typescript
import { createLogger, classifyError } from '@pegasus/utils';
```

**Never import from:** `lib/logger`, `lib/error-handler`, `lib/prompt-builder`, `lib/image-handler`

### @pegasus/prompts

**Use when:** You need AI prompt templates for text enhancement or other AI-powered features.

**Import for:**

- `getEnhancementPrompt(mode)` - Get complete prompt for enhancement mode
- `getSystemPrompt(mode)` - Get system prompt for specific mode
- `getExamples(mode)` - Get few-shot examples for a mode
- `buildUserPrompt(description, mode)` - Build user prompt with examples
- `isValidEnhancementMode(mode)` - Check if mode is valid
- `IMPROVE_SYSTEM_PROMPT` - System prompt for improving vague descriptions
- `TECHNICAL_SYSTEM_PROMPT` - System prompt for adding technical details
- `SIMPLIFY_SYSTEM_PROMPT` - System prompt for simplifying verbose text
- `ACCEPTANCE_SYSTEM_PROMPT` - System prompt for adding acceptance criteria

**Example:**

```typescript
import { getEnhancementPrompt, isValidEnhancementMode } from '@pegasus/prompts';

if (isValidEnhancementMode('improve')) {
  const { systemPrompt, userPrompt } = getEnhancementPrompt('improve', description);
  const result = await callClaude(systemPrompt, userPrompt);
}
```

**Never import from:** `lib/enhancement-prompts`

**Enhancement modes:**

- `improve` - Transform vague requests into clear, actionable tasks
- `technical` - Add implementation details and technical specifications
- `simplify` - Make verbose descriptions concise and focused
- `acceptance` - Add testable acceptance criteria

### @pegasus/platform

**Use when:** You need to work with Pegasus's directory structure or spawn processes.

**Import for:**

- `getPegasusDir(projectPath)` - Get .pegasus directory
- `getFeaturesDir(projectPath)` - Get features directory
- `getFeatureDir(projectPath, featureId)` - Get specific feature directory
- `ensurePegasusDir(projectPath)` - Create .pegasus if needed
- `spawnJSONLProcess()` - Spawn process with JSONL output
- `initAllowedPaths()` - Security path validation

**Example:**

```typescript
import { getFeatureDir, ensurePegasusDir } from '@pegasus/platform';
```

**Never import from:** `lib/pegasus-paths`, `lib/subprocess-manager`, `lib/security`

### @pegasus/model-resolver

**Use when:** You need to convert model aliases to full model IDs.

**Import for:**

- `resolveModelString(modelOrAlias)` - Convert alias to full ID
- `DEFAULT_MODELS` - Access default models

**Example:**

```typescript
import { resolveModelString, DEFAULT_MODELS } from '@pegasus/model-resolver';

// Convert user input to model ID
const modelId = resolveModelString('sonnet'); // → 'claude-sonnet-4-20250514'
```

**Never import from:** `lib/model-resolver`

**Model aliases:**

- `haiku` → `claude-haiku-4-5` (fast, simple tasks)
- `sonnet` → `claude-sonnet-4-20250514` (balanced, recommended)
- `opus` → `claude-opus-4-6` (maximum capability)

### @pegasus/dependency-resolver

**Use when:** You need to order features by dependencies or check if dependencies are satisfied.

**Import for:**

- `resolveDependencies(features)` - Topological sort with priority
- `areDependenciesSatisfied(feature, allFeatures)` - Check if ready to execute
- `getBlockingDependencies(feature, allFeatures)` - Get incomplete dependencies

**Example:**

```typescript
import { resolveDependencies, areDependenciesSatisfied } from '@pegasus/dependency-resolver';

const { orderedFeatures, hasCycle } = resolveDependencies(features);
if (!hasCycle) {
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

### @pegasus/git-utils

**Use when:** You need git operations, status parsing, or diff generation.

**Import for:**

- `isGitRepo(path)` - Check if path is a git repository
- `parseGitStatus(output)` - Parse `git status --porcelain` output
- `getGitRepositoryDiffs(path)` - Get complete diffs (tracked + untracked)
- `generateSyntheticDiffForNewFile()` - Create diff for untracked file
- `listAllFilesInDirectory()` - List files excluding build artifacts

**Example:**

```typescript
import { isGitRepo, getGitRepositoryDiffs } from '@pegasus/git-utils';

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

## Common Patterns

### Creating a Feature Executor

```typescript
import type { Feature, ExecuteOptions } from '@pegasus/types';
import { createLogger, classifyError } from '@pegasus/utils';
import { resolveModelString, DEFAULT_MODELS } from '@pegasus/model-resolver';
import { areDependenciesSatisfied } from '@pegasus/dependency-resolver';
import { getFeatureDir } from '@pegasus/platform';

const logger = createLogger('FeatureExecutor');

async function executeFeature(feature: Feature, allFeatures: Feature[], projectPath: string) {
  // Check dependencies
  if (!areDependenciesSatisfied(feature, allFeatures)) {
    logger.warn(`Dependencies not satisfied for ${feature.id}`);
    return;
  }

  // Resolve model
  const model = resolveModelString(feature.model, DEFAULT_MODELS.autoMode);

  // Get feature directory
  const featureDir = getFeatureDir(projectPath, feature.id);

  try {
    // Execute with Claude
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
import { getGitRepositoryDiffs, parseGitStatus } from '@pegasus/git-utils';
import { createLogger } from '@pegasus/utils';

const logger = createLogger('GitAnalyzer');

async function analyzeChanges(projectPath: string) {
  const { diff, files, hasChanges } = await getGitRepositoryDiffs(projectPath);

  if (!hasChanges) {
    logger.info('No changes detected');
    return;
  }

  // Group by status
  const modified = files.filter((f) => f.status === 'M');
  const added = files.filter((f) => f.status === 'A');
  const deleted = files.filter((f) => f.status === 'D');
  const untracked = files.filter((f) => f.status === '?');

  logger.info(
    `Changes: ${modified.length}M ${added.length}A ${deleted.length}D ${untracked.length}U`
  );

  return diff;
}
```

### Ordering Features for Execution

```typescript
import type { Feature } from '@pegasus/types';
import { resolveDependencies, getBlockingDependencies } from '@pegasus/dependency-resolver';
import { createLogger } from '@pegasus/utils';

const logger = createLogger('FeatureOrdering');

function orderAndFilterFeatures(features: Feature[]): Feature[] {
  const { orderedFeatures, hasCycle, cyclicFeatures } = resolveDependencies(features);

  if (hasCycle) {
    logger.error(`Circular dependency detected: ${cyclicFeatures.join(' → ')}`);
    throw new Error('Cannot execute features with circular dependencies');
  }

  // Filter to only ready features
  const readyFeatures = orderedFeatures.filter((feature) => {
    const blocking = getBlockingDependencies(feature, features);
    if (blocking.length > 0) {
      logger.debug(`${feature.id} blocked by: ${blocking.join(', ')}`);
      return false;
    }
    return true;
  });

  logger.info(`${readyFeatures.length} of ${features.length} features ready`);
  return readyFeatures;
}
```

## Import Rules for LLMs

### ✅ DO

```typescript
// Import types from @pegasus/types
import type { Feature, ExecuteOptions } from '@pegasus/types';

// Import constants from @pegasus/types
import { CLAUDE_MODEL_MAP, DEFAULT_MODELS } from '@pegasus/types';

// Import utilities from @pegasus/utils
import { createLogger, classifyError } from '@pegasus/utils';

// Import prompts from @pegasus/prompts
import { getEnhancementPrompt, isValidEnhancementMode } from '@pegasus/prompts';

// Import platform utils from @pegasus/platform
import { getFeatureDir, ensurePegasusDir } from '@pegasus/platform';

// Import model resolution from @pegasus/model-resolver
import { resolveModelString } from '@pegasus/model-resolver';

// Import dependency resolution from @pegasus/dependency-resolver
import { resolveDependencies } from '@pegasus/dependency-resolver';

// Import git utils from @pegasus/git-utils
import { getGitRepositoryDiffs } from '@pegasus/git-utils';
```

### ❌ DON'T

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
- [ ] No imports from old `lib/` paths
- [ ] No imports from `services/feature-loader` for types
- [ ] No imports from `providers/types`

## Package Dependencies

Understanding the dependency chain helps prevent circular dependencies:

```
@pegasus/types (no dependencies)
    ↓
@pegasus/utils
@pegasus/prompts
@pegasus/platform
@pegasus/model-resolver
@pegasus/dependency-resolver
    ↓
@pegasus/git-utils
    ↓
@pegasus/server
@pegasus/ui
```

**Rule:** Packages can only depend on packages above them in the chain.

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
import type { Feature } from '@pegasus/types';
import { createLogger } from '@pegasus/utils';

// ❌ Don't import from src
import { Feature } from '../../../src/services/feature-loader';
```

## Summary for LLMs

**Quick reference:**

- Types → `@pegasus/types`
- Logging/Errors/Utils → `@pegasus/utils`
- AI Prompts → `@pegasus/prompts`
- Paths/Security → `@pegasus/platform`
- Model Resolution → `@pegasus/model-resolver`
- Dependency Ordering → `@pegasus/dependency-resolver`
- Git Operations → `@pegasus/git-utils`

**Never import from:** `lib/*`, `services/feature-loader` (for types), `providers/types`, `routes/common`

**Always:** Use the shared packages instead of local implementations.
