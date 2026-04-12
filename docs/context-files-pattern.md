# Context Files System

This document describes how context files work in Pegasus and how to use them in agent prompts.

## Overview

Context files are user-defined documents stored in `.pegasus/context/` that provide project-specific rules, conventions, and guidelines for AI agents. Memory files in `.pegasus/memory/` capture learnings from past agent work. Both are automatically loaded and prepended to agent prompts.

## Directory Structure

```
{projectPath}/.pegasus/
├── context/
│   ├── CLAUDE.md              # Project rules and conventions
│   ├── CODE_QUALITY.md        # Code quality guidelines
│   ├── context-metadata.json  # File descriptions
│   └── ... (any .md or .txt files)
└── memory/
    ├── _index.md              # Memory index (auto-managed)
    ├── gotchas.md             # Always-loaded pitfalls and warnings
    ├── decisions.md           # Past architectural decisions
    └── ... (any .md files)
```

## Context Metadata

File descriptions are stored in `context-metadata.json`:

```json
{
  "files": {
    "CLAUDE.md": {
      "description": "Project-specific rules including package manager, commit conventions, and architectural patterns"
    },
    "CODE_QUALITY.md": {
      "description": "Code quality standards, testing requirements, and linting rules"
    }
  }
}
```

## Memory Files

Memory files in `.pegasus/memory/` contain learnings from past agent work (decisions, gotchas, patterns). They use YAML front matter for metadata-driven smart selection:

```markdown
---
summary: Short description of what this file covers
tags: [authentication, jwt, sessions]
relevantTo: [auth-service, login-flow]
importance: 0.9
usageStats:
  loaded: 12
  cited: 4
---

## Content here
```

`gotchas.md` is always loaded (if it exists). Other files are ranked by relevance to the current task context plus importance score.

## Shared Utility

The `loadContextFiles` function from `@pegasus/utils` provides a unified way to load context files and memory files:

```typescript
import { loadContextFiles } from "@pegasus/utils";

// Load context and memory files from a project
const { formattedPrompt, files, memoryFiles } = await loadContextFiles({
  projectPath: "/path/to/project",
});

// formattedPrompt contains the combined formatted system prompt
// files contains metadata about each loaded context file
// memoryFiles contains metadata about each loaded memory file
```

### Options

```typescript
interface LoadContextFilesOptions {
  /** Project path to load context from */
  projectPath: string;
  /** Optional custom secure fs module (for dependency injection) */
  fsModule?: ContextFsModule;
  /** Whether to include context files from .pegasus/context/ (default: true) */
  includeContextFiles?: boolean;
  /** Whether to include memory files from .pegasus/memory/ (default: true) */
  includeMemory?: boolean;
  /** Whether to initialize memory folder if it doesn't exist (default: true) */
  initializeMemory?: boolean;
  /** Task context for smart memory selection - if not provided, only loads high-importance files */
  taskContext?: TaskContext;
  /** Maximum number of memory files to load (default: 5) */
  maxMemoryFiles?: number;
}
```

### Return Value

```typescript
interface ContextFilesResult {
  files: ContextFileInfo[]; // Individual context file info
  memoryFiles: MemoryFileInfo[]; // Individual memory file info
  formattedPrompt: string; // Combined formatted prompt ready to use
}

interface ContextFileInfo {
  name: string; // File name (e.g., "CLAUDE.md")
  path: string; // Full path to file
  content: string; // File contents
  description?: string; // From metadata (explains when/why to use)
}

interface MemoryFileInfo {
  name: string; // File name (e.g., "gotchas.md")
  path: string; // Full path to file
  content: string; // File body (front matter stripped)
  category: string; // Derived from filename without extension
}
```

## Usage in Services

### Auto-Mode Service (Feature Execution)

The auto-mode service is implemented in `apps/server/src/services/auto-mode/facade.ts` and `apps/server/src/services/execution-service.ts`:

```typescript
import { loadContextFiles } from "@pegasus/utils";
import { secureFs } from "@pegasus/platform";

// In executeFeature() or followUpFeature()
const { formattedPrompt: contextFilesPrompt } = await loadContextFiles({
  projectPath,
  fsModule: secureFs as Parameters<typeof loadContextFiles>[0]["fsModule"],
  taskContext: { title: feature.title ?? "", description: feature.description },
});

// Pass as system prompt
await this.runAgent(
  workDir,
  featureId,
  prompt,
  abortController,
  projectPath,
  imagePaths,
  model,
  {
    projectPath,
    systemPrompt: contextFilesPrompt || undefined,
  },
);
```

### Agent Service (Chat Sessions)

```typescript
import { loadContextFiles } from "@pegasus/utils";
import { secureFs } from "@pegasus/platform";

// In sendMessage()
const { formattedPrompt: contextFilesPrompt } = await loadContextFiles({
  projectPath: effectiveWorkDir,
  fsModule: secureFs as Parameters<typeof loadContextFiles>[0]["fsModule"],
});

// Combine with base system prompt
const combinedSystemPrompt = contextFilesPrompt
  ? `${contextFilesPrompt}\n\n${baseSystemPrompt}`
  : baseSystemPrompt;
```

## Formatted Prompt Structure

The formatted prompt includes:

1. **Header** - Emphasizes that these are project-specific rules
2. **File Entries** - Each file with:
   - File name
   - Full path (for agents to read more if needed)
   - Purpose/description (from metadata)
   - Full file content
3. **Reminder** - Reinforces that agents must follow the conventions

Example output:

```markdown
# Project Context Files

The following context files provide project-specific rules, conventions, and guidelines.
Each file serves a specific purpose - use the description to understand when to reference it.
If you need more details about a context file, you can read the full file at the path provided.

**IMPORTANT**: You MUST follow the rules and conventions specified in these files.

- Follow ALL commands exactly as shown (e.g., if the project uses `pnpm`, NEVER use `npm` or `npx`)
- Follow ALL coding conventions, commit message formats, and architectural patterns specified
- Reference these rules before running ANY shell commands or making commits

---

## CLAUDE.md

**Path:** `/path/to/project/.pegasus/context/CLAUDE.md`
**Purpose:** Project-specific rules including package manager, commit conventions, and architectural patterns

[File content here]

---

## CODE_QUALITY.md

**Path:** `/path/to/project/.pegasus/context/CODE_QUALITY.md`
**Purpose:** Code quality standards, testing requirements, and linting rules

[File content here]

---

**REMINDER**: Before taking any action, verify you are following the conventions specified above.
```

## Best Practices

1. **Add descriptions** - Always add descriptions to `context-metadata.json` so agents understand when to reference each file
2. **Be specific** - Context files should contain concrete rules, not general guidelines
3. **Include examples** - Show correct command usage, commit formats, etc.
4. **Keep focused** - Each file should have a single purpose

## File Locations

- **Shared Utility**: `libs/utils/src/context-loader.ts`
- **Auto-Mode Service**: `apps/server/src/services/auto-mode/facade.ts`, `apps/server/src/services/execution-service.ts`
- **Agent Service**: `apps/server/src/services/agent-service.ts`
