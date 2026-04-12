# Ideation System

The Ideation System is Pegasus's built-in brainstorming tool. It gives both users and AI agents a structured space to capture, refine, and promote ideas before they enter the main feature development pipeline.

## Overview

The Ideation System implements a three-column Kanban board where ideas progress through a lifecycle before being promoted to features. This separation prevents raw, unvalidated ideas from going directly into the AI agent execution queue. Ideas must be explicitly reviewed and marked ready before they can become features.

The system has three major capabilities:

- **Manual idea capture** — type a title directly into the Raw column
- **AI-powered suggestion generation** — select a guided prompt and receive structured suggestions
- **Interactive brainstorming sessions** — multi-turn AI conversation linked to a project's context

All data is stored per-project under `.pegasus/ideation/`.

---

## Idea Lifecycle

Ideas move through four statuses:

| Status     | Meaning                                                  |
| ---------- | -------------------------------------------------------- |
| `raw`      | Newly captured, unrefined; the default for all new ideas |
| `refined`  | Being shaped — more details added, user stories written  |
| `ready`    | Approved for promotion to a feature                      |
| `archived` | Removed from active consideration but not deleted        |

Only ideas with status `ready` can be converted to features. Attempting to convert an idea in any other status returns HTTP 422 with error code `IDEA_NOT_READY`.

Ideas are dragged between columns directly in the UI. A drag that lands on a column header or empty column area changes the idea's status to match the target column.

### Idea data model

```typescript
interface Idea {
  id: string;
  title: string;
  description: string;
  category: IdeaCategory;
  status: IdeaStatus; // 'raw' | 'refined' | 'ready' | 'archived'
  impact: ImpactLevel; // 'low' | 'medium' | 'high'
  effort: EffortLevel; // 'low' | 'medium' | 'high'

  conversationId?: string; // links back to the ideation session that generated it
  sourcePromptId?: string; // which guided prompt produced it

  attachments?: IdeaAttachment[];
  userStories?: string[];
  notes?: string;

  createdAt: string; // ISO 8601
  updatedAt: string;
  archivedAt?: string;
}
```

Ideas belong to one of nine categories: `feature`, `ux-ui`, `dx`, `growth`, `technical`, `security`, `performance`, `accessibility`, `analytics`.

---

## Data Storage

All ideation data is written to the project's `.pegasus/ideation/` directory. This directory is always created in the main worktree, not in a feature worktree.

```
.pegasus/ideation/
├── ideas/
│   └── {ideaId}/
│       ├── idea.json          # Idea metadata
│       └── attachments/       # Images and other attachments
├── sessions/
│   └── {sessionId}.json       # Conversation history per session
├── drafts/                    # Unsaved drafts
└── analysis.json              # Cached project analysis result
```

---

## AI-Powered Suggestion Generation

The fastest way to fill the board with ideas is the **Generate Ideas** button in the board header. Clicking it opens a searchable command palette grouped by category. Each entry is a guided prompt.

### Guided prompts

Prompts are defined server-side in `IdeationService.getAllPrompts()` and served via `GET /api/ideation/prompts`. There are 35 built-in prompts across all nine categories. Examples:

| Category      | Prompt ID              | Title                     |
| ------------- | ---------------------- | ------------------------- |
| feature       | `feature-missing`      | Missing Features          |
| feature       | `feature-automation`   | Automation Opportunities  |
| feature       | `feature-integrations` | Integration Ideas         |
| ux-ui         | `ux-friction`          | Friction Points           |
| ux-ui         | `ux-empty-states`      | Empty States              |
| dx            | `dx-documentation`     | Documentation Gaps        |
| dx            | `dx-testing`           | Testing Improvements      |
| growth        | `growth-onboarding`    | Onboarding Flow           |
| technical     | `tech-performance`     | Performance Optimization  |
| security      | `security-auth`        | Authentication Security   |
| performance   | `perf-frontend`        | Frontend Performance      |
| accessibility | `a11y-keyboard`        | Keyboard Navigation       |
| analytics     | _(analytics prompts)_  | Various analytics prompts |

Prompts can also be fetched by category:

```
GET /api/ideation/prompts
GET /api/ideation/prompts/:category
```

### How suggestion generation works

When the user selects a prompt:

1. The frontend creates a generation job in `useIdeationStore` with status `generating`.
2. `POST /api/ideation/suggestions/generate` is called with `promptId`, `category`, and optional `count` (1–20, default 10).
3. The server builds a system prompt combining the guided prompt text, project context files (`.pegasus/context/`), memory files (`.pegasus/memory/`), existing features, existing ideas, and the app spec (`.pegasus/app_spec.txt`). Context sources are individually toggleable per-project.
4. The AI response is parsed from JSON array format (with text fallback) into an array of `AnalysisSuggestion` objects.
5. The frontend job transitions to `ready` and the suggestions are drained into individual `Idea` records with status `raw`.

The model used for suggestions defaults to the project's configured `ideationModel` phase setting, resolved via `resolvePhaseModel`.

### Context source configuration

Each project can independently toggle which sources contribute to suggestion generation:

```typescript
interface IdeationContextSources {
  useContextFiles: boolean; // .pegasus/context/*.md|.txt
  useMemoryFiles: boolean; // .pegasus/memory/*.md
  useExistingFeatures: boolean; // feature board state
  useExistingIdeas: boolean; // ideas already on the board
  useAppSpec: boolean; // .pegasus/app_spec.txt
}
```

All sources default to `true`. Disabling `useExistingFeatures` and `useExistingIdeas` allows the AI to generate suggestions without filtering for duplicates.

---

## Ideation Sessions

An ideation session is a multi-turn AI conversation scoped to a project. Sessions are useful for open-ended brainstorming where you want to iterate on ideas through dialogue rather than receiving a fixed batch of suggestions.

### Session lifecycle

```
startSession  →  sendMessage (repeatable)  →  stopSession
   active                                       completed
```

Sessions are persisted to disk immediately on creation and after each message. A session can be reloaded from disk if the server restarts. Sessions that are `completed` or `abandoned` are no longer active but their history remains on disk.

### Session data model

```typescript
interface IdeationSession {
  id: string;
  projectPath: string;
  promptCategory?: IdeaCategory; // optional category focus
  promptId?: string; // optional guided prompt that started the session
  status: "active" | "completed" | "abandoned";
  createdAt: string;
  updatedAt: string;
}

interface IdeationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  savedAsIdeaId?: string; // if this message was saved as an idea
}
```

### How sessions work

- Each `sendMessage` call adds the user message to the conversation history, then makes a single-turn AI call (`maxTurns: 1`) with the full conversation history as context.
- The AI response streams back to the frontend via WebSocket events (`ideation:stream`).
- The system prompt includes project context files and existing work to help the AI give project-relevant suggestions.
- If a session is already processing a message, additional `sendMessage` calls are rejected until the current turn completes.
- Stopping a session aborts any in-progress AI call via `AbortController`.

WebSocket events emitted during a session:

| Event                      | When                                     |
| -------------------------- | ---------------------------------------- |
| `ideation:session-started` | Session created                          |
| `ideation:stream`          | Per streaming chunk and message complete |
| `ideation:session-ended`   | Session stopped                          |

The `ideation:stream` event carries a `type` field with values: `message`, `stream`, `message-complete`, `aborted`, `error`.

---

## Project Analysis

The analysis feature scans the project directory structure and uses AI to generate improvement suggestions grounded in the actual codebase.

**Starting analysis:** `POST /api/ideation/analyze` initiates the analysis asynchronously. Progress is communicated via WebSocket events.

**Analysis events:**

| Event                        | Description                   |
| ---------------------------- | ----------------------------- |
| `ideation:analysis-started`  | Analysis has begun            |
| `ideation:analysis-progress` | Progress update (0–100%)      |
| `ideation:analysis-complete` | Analysis finished with result |
| `ideation:analysis-error`    | Analysis failed               |

**Getting the result:** `POST /api/ideation/analysis` returns the cached `analysis.json` file synchronously.

The `ProjectAnalysisResult` includes:

- File structure breakdown (routes, components, services)
- Detected tech stack (framework, language, dependencies)
- AI-generated `AnalysisSuggestion[]` ranked by priority
- A plain-language summary

Analysis suggestions land in `.pegasus/ideation/analysis.json` and are not automatically added to the idea board. Users can explicitly add a suggestion to the board via `POST /api/ideation/add-suggestion`, which creates a raw idea from the suggestion's title, description, and rationale.

---

## Converting Ideas to Features

When an idea has status `ready`, it can be promoted to a feature on the main Kanban board. The "Promote to Feature" button (arrow icon) appears on `ready` cards in the UI.

### Promotion flow

1. User clicks the promote button on a ready idea card.
2. A `PromoteModal` dialog opens to optionally configure `column`, `dependencies`, and `tags` for the new feature.
3. On confirm, `POST /api/ideation/convert` is called.
4. The server calls `IdeationService.convertToFeature()`, which builds a `Feature` object from the idea's title, description, user stories, and notes.
5. The feature is written to disk via `FeatureLoader.create()`.
6. The idea is deleted (unless `keepIdea: true` is passed).
7. WebSocket events `ideation:idea-converted` (and optionally `ideation:idea-deleted`) are emitted.

### What gets mapped

| Idea field    | Feature field                                |
| ------------- | -------------------------------------------- |
| `title`       | `title`                                      |
| `description` | `description` (base)                         |
| `userStories` | appended to description as `## User Stories` |
| `notes`       | appended to description as `## Notes`        |
| `category`    | mapped to feature category                   |

The new feature starts in `backlog` status by default. The `column` option overrides this.

### Error handling

If the idea is not `ready`, the server returns HTTP 422:

```json
{
  "success": false,
  "error": "Cannot convert idea: status must be 'ready', got 'raw'"
}
```

---

## API Reference

All endpoints are prefixed with `/api/ideation`. Every POST body includes `projectPath` (required).

### Sessions

| Method | Path               | Description                            |
| ------ | ------------------ | -------------------------------------- |
| POST   | `/session/start`   | Start a new session                    |
| POST   | `/session/message` | Send a message; response via WebSocket |
| POST   | `/session/stop`    | Stop an active session                 |
| POST   | `/session/get`     | Retrieve session with full history     |

**Start session request:**

```json
{
  "projectPath": "/path/to/project",
  "options": {
    "promptId": "feature-missing",
    "promptCategory": "feature",
    "initialMessage": "What features are we missing?"
  }
}
```

**Send message request:**

```json
{
  "sessionId": "session-abc123",
  "message": "Tell me more about the first suggestion",
  "options": {
    "model": "sonnet"
  }
}
```

### Ideas CRUD

| Method | Path            | Description                  |
| ------ | --------------- | ---------------------------- |
| POST   | `/ideas/list`   | List all ideas for a project |
| POST   | `/ideas/create` | Create a new idea            |
| POST   | `/ideas/get`    | Get a single idea by ID      |
| POST   | `/ideas/update` | Update idea fields or status |
| POST   | `/ideas/delete` | Delete an idea permanently   |

**Create idea request:**

```json
{
  "projectPath": "/path/to/project",
  "idea": {
    "title": "Add dark mode support",
    "description": "Allow users to switch between light and dark themes",
    "category": "ux-ui",
    "status": "raw",
    "impact": "high",
    "effort": "medium"
  }
}
```

**Update idea request (e.g., advance to refined):**

```json
{
  "projectPath": "/path/to/project",
  "ideaId": "idea-abc123",
  "updates": {
    "status": "refined",
    "userStories": [
      "As a user, I want to toggle dark mode from the settings page"
    ]
  }
}
```

### Project Analysis

| Method | Path        | Description                                  |
| ------ | ----------- | -------------------------------------------- |
| POST   | `/analyze`  | Start async analysis; progress via WebSocket |
| POST   | `/analysis` | Get cached analysis result                   |

### Suggestion Generation

| Method | Path                    | Description                                   |
| ------ | ----------------------- | --------------------------------------------- |
| POST   | `/suggestions/generate` | Generate structured suggestions from a prompt |

**Request:**

```json
{
  "projectPath": "/path/to/project",
  "promptId": "feature-missing",
  "category": "feature",
  "count": 10,
  "contextSources": {
    "useContextFiles": true,
    "useMemoryFiles": true,
    "useExistingFeatures": true,
    "useExistingIdeas": true,
    "useAppSpec": true
  }
}
```

**Response:**

```json
{
  "success": true,
  "suggestions": [
    {
      "id": "sug-abc123",
      "category": "feature",
      "title": "Keyboard shortcuts panel",
      "description": "A discoverable panel listing all available keyboard shortcuts",
      "rationale": "Users of power tools expect keyboard-first navigation",
      "priority": "medium",
      "relatedFiles": []
    }
  ]
}
```

### Convert and Add

| Method | Path              | Description                                           |
| ------ | ----------------- | ----------------------------------------------------- |
| POST   | `/convert`        | Promote a ready idea to a feature                     |
| POST   | `/add-suggestion` | Add an analysis suggestion to the board as a raw idea |

**Convert request:**

```json
{
  "projectPath": "/path/to/project",
  "ideaId": "idea-abc123",
  "keepIdea": false,
  "column": "backlog",
  "dependencies": [],
  "tags": ["design"]
}
```

**Add suggestion request:**

```json
{
  "projectPath": "/path/to/project",
  "suggestion": {
    "id": "sug-abc123",
    "category": "ux-ui",
    "title": "Improve empty states",
    "description": "Add helpful prompts when lists are empty",
    "rationale": "Users need guidance when there is no content",
    "priority": "medium"
  }
}
```

### Guided Prompts

| Method | Path                 | Description                |
| ------ | -------------------- | -------------------------- |
| GET    | `/prompts`           | All prompts and categories |
| GET    | `/prompts/:category` | Prompts for one category   |

---

## Frontend Architecture

### Route

The Ideation System is mounted at the `/ideation` TanStack Router route (`apps/ui/src/routes/ideation.tsx`), which renders `IdeationView` (an alias for `IdeaBoard`).

### Components

| Component                 | File                                          | Purpose                                               |
| ------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| `IdeaBoard`               | `ideation-view/idea-board.tsx`                | Root component; owns DnD context and column layout    |
| `IdeaCard`                | `ideation-view/idea-card.tsx`                 | Draggable card rendering one idea                     |
| `IdeaEditModal`           | `ideation-view/idea-card.tsx` (co-located)    | Dialog for editing title, description, notes, stories |
| `PromoteModal`            | `ideation-view/promote-modal.tsx`             | Confirmation dialog before converting to feature      |
| `PromptCommandPopover`    | `ideation-view/prompt-command-popover.tsx`    | Searchable command palette for selecting AI prompts   |
| `GenerationJobsIndicator` | `ideation-view/generation-jobs-indicator.tsx` | Spinner showing count of active generation jobs       |
| `QuickAddInput`           | `ideation-view/idea-board.tsx` (inline)       | Pinned input at the top of the Raw column             |

### State management

The `useIdeationStore` (Zustand, persisted as `pegasus-ideation-store`) owns:

- `generationJobs` — tracks concurrent AI generation jobs with status `generating | ready | error`
- `contextSourcesByProject` — per-project context source toggles (persisted)
- `analysisResult` — cached project analysis result
- UI filters (`filterStatus`, `selectedCategory`)

Server data (ideas list, prompts) is managed by TanStack Query hooks:

| Hook                             | File                                        | Description                   |
| -------------------------------- | ------------------------------------------- | ----------------------------- |
| `useIdeas`                       | `hooks/queries/use-ideation.ts`             | Fetch ideas list              |
| `useIdea`                        | `hooks/queries/use-ideation.ts`             | Fetch single idea             |
| `useIdeationPrompts`             | `hooks/queries/use-ideation.ts`             | Fetch all prompts             |
| `useGenerateIdeationSuggestions` | `hooks/mutations/use-ideation-mutations.ts` | Trigger suggestion generation |
| `useConvertIdea`                 | `ideation-view/hooks/use-convert-idea.ts`   | Convert idea to feature       |

### Keyboard shortcut

`Shift+I` focuses the Quick Add input in the Raw column from anywhere on the Idea Board.

### Drag and drop

The board uses `@dnd-kit/core` with a `PointerSensor` (8 px activation distance) and `closestCenter` collision detection. Dropping a card on a column header, the column's empty area, or another card moves the idea to that column's status. If the status update fails, a toast notification appears and the drag snaps back.

### Generation job flow

```
User selects prompt
  → addGenerationJob() creates job with status 'generating'
  → useGenerateIdeationSuggestions mutation fires POST /suggestions/generate
  → On success: job transitions to 'ready', suggestions stored in job
  → IdeaBoard mount effect drains ready jobs into individual Idea records via createIdea
  → job is removed from store after drain
```

This design means generation continues even if the user navigates away mid-generation; the results are picked up the next time the board mounts.

---

## Server Architecture

`IdeationService` is the single server-side class that owns all ideation logic. It is constructed with references to `EventEmitter`, `SettingsService`, and `FeatureLoader`.

Active sessions are held in memory in a `Map<string, ActiveSession>`. Sessions are also persisted to disk after every state change, allowing recovery after restarts.

The service is wired into the Express router via `createIdeationRoutes()` at `apps/server/src/routes/ideation/index.ts`, which registers all endpoints under `/api/ideation`.

---

## Design Notes

- AI-generated suggestions always land as `raw` ideas, never directly as features. This is by design (ADR-003) to ensure human review before AI execution.
- The `keepIdea` option on convert exists for cases where an idea should remain visible on the board after its corresponding feature is created.
- Analysis results are cached in `analysis.json`; re-running analysis overwrites the cache.
- Suggestion generation runs with `allowedTools: []` and `readOnly: true` — the AI is purely generating text, never modifying files.
- Session message turns are single-turn (`maxTurns: 1`) with the full conversation history passed as context, keeping session responses focused.
