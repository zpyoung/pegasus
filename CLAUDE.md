# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pegasus is an autonomous AI development studio built as a pnpm workspace monorepo. It provides a Kanban-based workflow where AI agents (powered by Claude Agent SDK) implement features in isolated git worktrees.

## Common Commands

```bash
# Development
pnpm dev                 # Interactive launcher (choose web or electron)
pnpm dev:web             # Web browser mode (localhost:3007)
pnpm dev:electron        # Desktop app mode
pnpm dev:electron:debug  # Desktop with DevTools open

# Building
pnpm build               # Build web application
pnpm build:packages      # Build all shared packages (required before other builds)
pnpm build:electron      # Build desktop app for current platform
pnpm build:server        # Build server only

# Testing
pnpm test                # E2E tests (Playwright, headless)
pnpm test:headed         # E2E tests with browser visible
pnpm test:server         # Server unit tests (Vitest)
pnpm test:packages       # All shared package tests
pnpm test:all            # All tests (packages + server)

# Single test file
pnpm test:server -- tests/unit/specific.test.ts

# Linting and formatting
pnpm lint                # ESLint
pnpm format              # Prettier write
pnpm format:check        # Prettier check
```

## Architecture

### Monorepo Structure

```
pegasus/
├── apps/
│   ├── ui/           # React + Vite + Electron frontend (port 3007)
│   └── server/       # Express + WebSocket backend (port 3008)
└── libs/             # Shared packages (@pegasus/*)
    ├── types/        # Core TypeScript definitions (no dependencies)
    ├── utils/        # Logging, errors, image processing, context loading
    ├── prompts/      # AI prompt templates
    ├── platform/     # Path management, security, process spawning
    ├── model-resolver/    # Claude model alias resolution
    ├── dependency-resolver/  # Feature dependency ordering
    └── git-utils/    # Git operations & worktree management
```

### Package Dependency Chain

Packages can only depend on packages above them:

```
@pegasus/types (no dependencies)
    ↓
@pegasus/utils, @pegasus/prompts, @pegasus/platform, @pegasus/model-resolver, @pegasus/dependency-resolver
    ↓
@pegasus/git-utils
    ↓
@pegasus/server, @pegasus/ui
```

### Key Technologies

- **Frontend**: React 19, Vite 7, Electron 39, TanStack Router, Zustand 5, Tailwind CSS 4
- **Backend**: Express 5, WebSocket (ws), Claude Agent SDK, node-pty
- **Testing**: Playwright (E2E), Vitest (unit)

### Server Architecture

The server (`apps/server/src/`) follows a modular pattern:

- `routes/` - Express route handlers organized by feature (agent, features, auto-mode, worktree, etc.)
- `services/` - Business logic (AgentService, AutoModeService, FeatureLoader, TerminalService)
- `providers/` - AI provider abstraction (currently Claude via Claude Agent SDK)
- `lib/` - Utilities (events, auth, worktree metadata)

### Frontend Architecture

The UI (`apps/ui/src/`) uses:

- `routes/` - TanStack Router file-based routing
- `components/views/` - Main view components (board, settings, terminal, etc.)
- `store/` - Zustand stores with persistence (app-store.ts, setup-store.ts)
- `hooks/` - Custom React hooks
- `lib/` - Utilities and API client

## Data Storage

### Per-Project Data (`.pegasus/`)

```
.pegasus/
├── features/                    # Feature JSON files, outputs, and images
│   └── {featureId}/
│       ├── feature.json         # Feature metadata and status
│       ├── agent-output.md      # Agent execution log
│       ├── pipeline-state.json  # Pipeline stage completion state (for resume)
│       ├── stage-outputs/       # Per-stage output snapshots for debugging/recovery
│       │   └── {stageId}.md
│       └── images/              # Feature-related screenshots and diagrams
├── ideation/                    # Ideation (idea board) data
│   ├── ideas/                   # Individual ideas, keyed by ideaId
│   │   └── {ideaId}/
│   │       ├── idea.json
│   │       └── attachments/     # Images and other attachments for the idea
│   ├── sessions/                # Ideation conversation histories
│   │   └── {sessionId}.json
│   ├── drafts/                  # Unsaved ideation conversation drafts
│   └── analysis.json            # Cached project analysis for idea generation
├── pipelines/                   # Project-level pipeline YAML definitions
│   └── {pipelineSlug}.yaml      # e.g., feature.yaml, bug-fix.yaml
├── worktrees/                   # Git worktree metadata (per-feature)
├── board/                       # Board customization data (background images, etc.)
├── images/                      # Project-level shared images and assets
├── context/                     # Context files for AI agents (CLAUDE.md, etc.)
├── memory/                      # Project memory files (*.md, loaded into agent prompts)
├── validations/                 # GitHub issue validation results
│   └── {issueNumber}/
│       └── validation.json      # Verdict, analysis, and metadata
├── events/                      # Event history for debugging and replay
│   ├── index.json               # Event index for quick listing
│   └── {eventId}.json
├── settings.json                # Project-specific settings
├── app_spec.txt                 # Application specification (XML format)
├── active-branches.json         # Active git branches and worktrees metadata
├── notifications.json           # Feature status change notifications
└── execution-state.json         # Auto-mode execution state (for recovery on restart)
```

### User-Level Data (`~/.pegasus/`)

```
~/.pegasus/
└── pipelines/                   # User-level pipeline YAML definitions (shared across all projects)
    └── {pipelineSlug}.yaml      # Defaults; overridden by project-level pipelines with same slug
```

### Global Data (`DATA_DIR`, default `./data`)

```
data/
├── settings.json          # Global settings, profiles, shortcuts
├── credentials.json       # API keys
├── sessions-metadata.json # Chat session metadata
└── agent-sessions/        # Conversation histories
```

## Import Conventions

Always import from shared packages, never from old paths:

```typescript
// ✅ Correct
import type { Feature, ExecuteOptions } from "@pegasus/types";
import { createLogger, classifyError } from "@pegasus/utils";
import { getEnhancementPrompt } from "@pegasus/prompts";
import { getFeatureDir, ensurePegasusDir } from "@pegasus/platform";
import { resolveModelString } from "@pegasus/model-resolver";
import { resolveDependencies } from "@pegasus/dependency-resolver";
import { getGitRepositoryDiffs } from "@pegasus/git-utils";

// ❌ Never import from old paths
import { Feature } from "../services/feature-loader"; // Wrong
import { createLogger } from "../lib/logger"; // Wrong
```

## Key Patterns

### Event-Driven Architecture

All server operations emit events that stream to the frontend via WebSocket. Events are created using `createEventEmitter()` from `lib/events.ts`.

### Git Worktree Isolation

Each feature executes in an isolated git worktree, created via `@pegasus/git-utils`. This protects the main branch during AI agent execution.

### Context Files

Project-specific rules are stored in `.pegasus/context/` and automatically loaded into agent prompts via `loadContextFiles()` from `@pegasus/utils`.

### Model Resolution

Use `resolveModelString()` from `@pegasus/model-resolver` to convert model aliases:

- `haiku` → `claude-haiku-4-5`
- `sonnet` → `claude-sonnet-4-20250514`
- `opus` → `claude-opus-4-6`

## Environment Variables

### Server

- `PORT` - Server port (default: 3008)
- `HOST` - Host to bind server to (default: 0.0.0.0)
- `HOSTNAME` - Hostname for user-facing URLs (default: localhost)
- `DATA_DIR` - Data storage directory (default: ./data)
- `ALLOWED_ROOT_DIRECTORY` - Restrict file operations to specific directory
- `ENABLE_REQUEST_LOGGING` - HTTP request logging (default: true, set `false` to disable)
- `TERMINAL_MAX_SESSIONS` - Max terminal sessions (default: 1000)
- `TERMINAL_ENABLED` - Enable/disable the terminal feature (default: true, set `false` to disable)
- `TERMINAL_PASSWORD` - Password required to access the terminal (unset = no password required)
- `IS_CONTAINERIZED` - Set `true` when running in a container; suppresses sandbox risk warnings in UI
- `PEGASUS_SKIP_SANDBOX_WARNING` - Set `true` to suppress sandbox risk warnings regardless of container status

### Frontend

- `PEGASUS_WEB_PORT` - Vite dev server port (default: 3007)
- `VITE_HOSTNAME` - Hostname for frontend API URLs (default: localhost)

### Auth & API Keys

- `ANTHROPIC_API_KEY` - Anthropic API key (or use Claude Code CLI auth)
- `ANTHROPIC_AUTH_TOKEN` - Anthropic OAuth token
- `ANTHROPIC_BASE_URL` - Custom Anthropic API base URL
- `CLAUDE_CODE_OAUTH_TOKEN` - Claude Code OAuth token
- `GEMINI_API_KEY` - Google Gemini API key
- `GOOGLE_APPLICATION_CREDENTIALS` - Path to Google service account JSON (for Vertex AI / Gemini ADC auth)
- `GOOGLE_CLOUD_PROJECT` - Google Cloud project ID (for Vertex AI / Gemini ADC auth)
- `OPENAI_API_KEY` - OpenAI API key (used by the Codex provider)
- `OPENCODE_API_KEY` - OpenCode CLI API key (checked to determine if OpenCode is pre-authenticated)
- `CURSOR_API_KEY` - Cursor API key
- `CURSOR_CONFIG_DIR` - Override path to Cursor CLI config directory (default: `~/.cursor`)
- `GITHUB_TOKEN` - GitHub token (for Copilot provider)
- `Z_AI_API_KEY` - Z.AI API key
- `Z_AI_API_HOST` - Z.AI API host override
- `PEGASUS_API_KEY` - Fixed API key for server authentication (auto-generated if unset; Electron passes this automatically)
- `PEGASUS_HIDE_API_KEY` - Set `true` to suppress the API key banner in server logs (used in Electron/production)
- `PEGASUS_DISABLE_AUTH` - Set `true` to disable API authentication entirely (for trusted local/network deployments)

### Model Overrides

- `PEGASUS_MODEL_DEFAULT` - Fallback model for all operations when no use-case-specific override is set
- `PEGASUS_MODEL_AUTO` - Model used for autonomous kanban card implementation (default: opus)
- `PEGASUS_MODEL_SPEC` - Model used for app spec generation (default: haiku)
- `PEGASUS_MODEL_FEATURES` - Model used for feature generation from specs (default: haiku)
- `PEGASUS_MODEL_SUGGESTIONS` - Model used for feature suggestions (default: haiku)
- `PEGASUS_MODEL_CHAT` - Model used for chat interactions (default: haiku)

### Debug & Development

- `PEGASUS_AUTO_LOGIN=true` - Skip login prompt (disabled when NODE_ENV=production)
- `PEGASUS_MOCK_AGENT=true` - Fake agent responses, no API calls (for UI testing)
- `PEGASUS_DEBUG_RAW_OUTPUT=true` - Log raw agent output streams
- `LOG_LEVEL` - Logger verbosity: error, warn, info, debug (default: info)
- `CORS_ORIGIN` - Comma-separated allowed CORS origins
