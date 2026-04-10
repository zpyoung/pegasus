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
├── features/              # Feature JSON files and images
│   └── {featureId}/
│       ├── feature.json
│       ├── agent-output.md
│       └── images/
├── context/               # Context files for AI agents (CLAUDE.md, etc.)
├── settings.json          # Project-specific settings
├── spec.md               # Project specification
└── analysis.json         # Project structure analysis
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
import type { Feature, ExecuteOptions } from '@pegasus/types';
import { createLogger, classifyError } from '@pegasus/utils';
import { getEnhancementPrompt } from '@pegasus/prompts';
import { getFeatureDir, ensurePegasusDir } from '@pegasus/platform';
import { resolveModelString } from '@pegasus/model-resolver';
import { resolveDependencies } from '@pegasus/dependency-resolver';
import { getGitRepositoryDiffs } from '@pegasus/git-utils';

// ❌ Never import from old paths
import { Feature } from '../services/feature-loader'; // Wrong
import { createLogger } from '../lib/logger'; // Wrong
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

### Frontend
- `PEGASUS_WEB_PORT` - Vite dev server port (default: 3007)
- `VITE_HOSTNAME` - Hostname for frontend API URLs (default: localhost)

### Auth & API Keys
- `ANTHROPIC_API_KEY` - Anthropic API key (or use Claude Code CLI auth)
- `ANTHROPIC_AUTH_TOKEN` - Anthropic OAuth token
- `ANTHROPIC_BASE_URL` - Custom Anthropic API base URL
- `CLAUDE_CODE_OAUTH_TOKEN` - Claude Code OAuth token
- `GEMINI_API_KEY` - Google Gemini API key
- `CURSOR_API_KEY` - Cursor API key
- `GITHUB_TOKEN` - GitHub token (for Copilot provider)
- `Z_AI_API_KEY` - Z.AI API key
- `Z_AI_API_HOST` - Z.AI API host override

### Debug & Development
- `PEGASUS_AUTO_LOGIN=true` - Skip login prompt (disabled when NODE_ENV=production)
- `PEGASUS_MOCK_AGENT=true` - Fake agent responses, no API calls (for UI testing)
- `PEGASUS_DEBUG_RAW_OUTPUT=true` - Log raw agent output streams
- `LOG_LEVEL` - Logger verbosity: error, warn, info, debug (default: info)
- `CORS_ORIGIN` - Comma-separated allowed CORS origins
