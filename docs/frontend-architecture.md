# Frontend Architecture

This document describes the architecture of the Pegasus frontend (`apps/ui`). It is intended for contributors who need to understand how the UI is structured, how state is managed, and how the app communicates with the backend.

---

## Technology Stack

| Layer                | Library              | Version |
| -------------------- | -------------------- | ------- |
| UI framework         | React                | 19      |
| Build tool           | Vite                 | 7       |
| Desktop shell        | Electron             | 39      |
| Routing              | TanStack Router      | latest  |
| Server state         | TanStack React Query | latest  |
| Client state         | Zustand              | 5       |
| Styling              | Tailwind CSS         | 4       |
| Component primitives | Radix UI             | latest  |

Additional noteworthy dependencies:

- **@dnd-kit/core** - Drag-and-drop for the Kanban board
- **@xyflow/react** - Dependency graph visualization
- **xterm / @xterm/** - Integrated terminal emulation
- **CodeMirror** - In-app code/spec editor
- **sonner** - Toast notifications
- **zod** - Search param and settings validation

---

## Application Entry Points

There are two entry points, each corresponding to a different runtime mode:

| File               | Purpose                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/renderer.tsx` | Web browser mode entry point. Mounts the React app, registers the service worker (PWA), and sets up the IndexedDB query cache.                         |
| `src/main.ts`      | Electron main process entry point. Starts the embedded backend server, creates the `BrowserWindow`, registers IPC handlers, and manages app lifecycle. |

`src/app.tsx` is the root React component rendered in both modes. It initializes global hooks (settings sync, cursor status, provider auth, mobile visibility) and wraps the router provider with a splash screen component.

---

## File-Based Routing (TanStack Router)

The app uses TanStack Router's file-based routing with automatic code splitting enabled.

**Configuration** (`vite.config.mts`):

```ts
TanStackRouterVite({
  target: "react",
  autoCodeSplitting: true,
  routesDirectory: "./src/routes",
  generatedRouteTree: "./src/routeTree.gen.ts",
});
```

Routes are defined as files under `src/routes/`. The generated route tree (`routeTree.gen.ts`) is committed and updated automatically by the Vite plugin during development.

### Route File Conventions

TanStack Router uses a dual-file pattern for lazy loading:

- `routes/board.tsx` — Declares the route (`createFileRoute`), validates search params with Zod, but contains no component.
- `routes/board.lazy.tsx` — Declares the lazy component (`createLazyFileRoute`) imported by consumers. The Vite plugin automatically splits this into its own chunk.

This pattern keeps the route manifest tiny and only downloads the view when the user navigates to it.

### Route Inventory

| File                                       | Path                | View Component        | Notes                                                                                    |
| ------------------------------------------ | ------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `__root.tsx`                               | (layout)            | `RootLayoutContent`   | Root layout, auth guard, sidebar                                                         |
| `index.tsx`                                | `/`                 | `WelcomeView`         | Landing page                                                                             |
| `board.tsx` + `board.lazy.tsx`             | `/board`            | `BoardView`           | Main Kanban board; supports `featureId` and `projectPath` search params for deep linking |
| `settings.tsx`                             | `/settings`         | `SettingsView`        | Supports `view` search param to jump to a section                                        |
| `terminal.tsx` + `terminal.lazy.tsx`       | `/terminal`         | `TerminalView`        | Embedded xterm terminal                                                                  |
| `spec.tsx` + `spec.lazy.tsx`               | `/spec`             | `SpecView`            | Project spec editor                                                                      |
| `graph.tsx` + `graph.lazy.tsx`             | `/graph`            | `GraphView`           | Feature dependency graph                                                                 |
| `file-editor.tsx` + `file-editor.lazy.tsx` | `/file-editor`      | `FileEditorView`      | In-app code editor                                                                       |
| `agent.tsx`                                | `/agent`            | `AgentView`           | Single agent conversation view                                                           |
| `dashboard.tsx`                            | `/dashboard`        | `DashboardView`       | Multi-project status dashboard                                                           |
| `ideation.tsx`                             | `/ideation`         | `IdeationView`        | Brainstorming / idea board                                                               |
| `overview.tsx`                             | `/overview`         | `OverviewView`        | Project overview                                                                         |
| `context.tsx`                              | `/context`          | `ContextView`         | Context file management                                                                  |
| `github-issues.tsx`                        | `/github-issues`    | `GitHubIssuesView`    | GitHub issue import                                                                      |
| `github-prs.tsx`                           | `/github-prs`       | `GitHubPRsView`       | GitHub PR management                                                                     |
| `memory.tsx`                               | `/memory`           | `MemoryView`          | Agent memory management                                                                  |
| `wiki.tsx`                                 | `/wiki`             | `WikiView`            | Project wiki                                                                             |
| `notifications.tsx`                        | `/notifications`    | `NotificationsView`   | Notification center                                                                      |
| `running-agents.tsx`                       | `/running-agents`   | `RunningAgentsView`   | Live agent monitor                                                                       |
| `interview.tsx`                            | `/interview`        | `InterviewView`       | Feature interview wizard                                                                 |
| `project-settings.tsx`                     | `/project-settings` | `ProjectSettingsView` | Per-project configuration                                                                |
| `setup.tsx`                                | `/setup`            | `SetupView`           | First-run setup wizard                                                                   |
| `login.tsx`                                | `/login`            | `LoginView`           | Authentication screen                                                                    |
| `logged-out.tsx`                           | `/logged-out`       | `LoggedOutView`       | Session expired screen                                                                   |

### Root Layout (`__root.tsx`)

The root layout (`RootLayoutContent`) is responsible for:

1. **Auth guard** — Checks `useAuthStore` for `authChecked` and `isAuthenticated`. Redirects to `/login` if unauthenticated.
2. **Setup guard** — Redirects to `/setup` if `setupComplete` is false in `useSetupStore`.
3. **Auto project open** — Selects the most recently used project from history and calls `initializeProject`.
4. **Theme application** — Reads the theme from `useAppStore` and applies CSS classes to `document.documentElement`. Theme is stored synchronously in localStorage on startup to prevent flash-of-default-theme.
5. **React Query provider** — Wraps children in `PersistQueryClientProvider` with an IndexedDB persister for cross-tab cache survival.
6. **Sidebar layout** — Renders the `<Sidebar>` and `<ProjectSwitcher>` alongside the `<Outlet>`.

---

## State Management (Zustand)

The app uses multiple focused Zustand stores rather than a single monolithic store.

### Store Inventory

| Store                   | File                           | Persistence                                              | Purpose                                                                                              |
| ----------------------- | ------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `useAppStore`           | `store/app-store.ts`           | Server API (see below)                                   | Primary application state — projects, features, settings, theme, terminal state, model config, usage |
| `useSetupStore`         | `store/setup-store.ts`         | None (ephemeral)                                         | First-run wizard state, CLI/auth detection results                                                   |
| `useAuthStore`          | `store/auth-store.ts`          | None (optimistic from localStorage)                      | Web session auth state (`authChecked`, `isAuthenticated`, `settingsLoaded`)                          |
| `useNotificationsStore` | `store/notifications-store.ts` | None                                                     | Project notifications and unread count                                                               |
| `useIdeationStore`      | `store/ideation-store.ts`      | `zustand/persist` (localStorage)                         | Brainstorming session state and generation jobs                                                      |
| `useUICacheStore`       | `store/ui-cache-store.ts`      | `zustand/persist` (localStorage, key `pegasus-ui-cache`) | Fast-restore cache for sidebar state, selected project, collapsed sections                           |

### `useAppStore` — Primary Store

`useAppStore` is the largest store. Its state is split across modular type files under `store/types/`:

- `types/state-types.ts` — `AppState` and `AppActions` interfaces, `InitScriptState`, `AutoModeActivity`
- `types/ui-types.ts` — `ViewMode`, `ThemeMode`, `BoardViewMode`, `KeyboardShortcuts`, `BackgroundSettings`
- `types/settings-types.ts` — `ApiKeys`
- `types/chat-types.ts` — `ChatMessage`, `ChatSession`, `ImageAttachment`, `FeatureImage`
- `types/terminal-types.ts` — `TerminalState`, `TerminalTab`, `TerminalPanelContent`
- `types/project-types.ts` — `Feature`, `FileTreeNode`, `ProjectAnalysis`
- `types/usage-types.ts` — `ClaudeUsage`, `CodexUsage`, `ZaiUsage`, `GeminiUsage`

Default values live in `store/defaults/` and utility functions in `store/utils/`.

**Important**: `useAppStore` does NOT use Zustand's `persist` middleware. Settings are persisted to the server via the `use-settings-sync.ts` hook (see below). The store is hydrated from the server's `settings.json` at startup.

**Selector best practice**: Always use individual selectors instead of subscribing to the entire store to prevent unnecessary re-renders:

```ts
// Good — only re-renders when `currentProject` changes
const currentProject = useAppStore((s) => s.currentProject);

// Avoid — re-renders on any store mutation
const store = useAppStore();
```

### Settings Persistence Flow

Settings are persisted to the server's `settings.json` file. The flow is:

1. **On startup** — `useSettingsMigration` fetches settings from `GET /api/settings` and calls `hydrateStoreFromSettings()` to populate `useAppStore`.
2. **On change** — `useSettingsSync` subscribes to `useAppStore` changes and debounces writes to `POST /api/settings` (1-second debounce).
3. **Fast restore** — On page load, `useAppStore` reads sidebar/theme state from `pegasus-ui-cache` in localStorage synchronously before the first render, eliminating layout shift.
4. **Auth state** — `useAuthStore` optimistically pre-populates from `pegasus-settings-cache` in localStorage so returning users skip the auth spinner.

The fields synced to the server are defined as the `SETTINGS_FIELDS_TO_SYNC` array in `hooks/use-settings-sync.ts`. They cover theme, fonts, sidebar state, model configuration, keyboard shortcuts, MCP servers, and more.

### `useUICacheStore` — Fast UI Restore

A lightweight persisted store (`pegasus-ui-cache`) that saves the sidebar open state, sidebar style, collapsed nav sections, and selected worktree per project. It is written on every relevant change and read synchronously at module load time — before React renders — to prevent layout shift between page loads.

---

## View Component Pattern

View components live under `src/components/views/`. Each view corresponds to a route and is responsible for a full-page feature area.

### Structural Convention

Complex views use a directory-based structure:

```
components/views/board-view/
├── board-view.tsx          # Main view component (entry point)
├── board-header.tsx        # Sub-components specific to this view
├── kanban-board.tsx
├── constants.ts
├── hooks/                  # View-local hooks (useBoardFeatures, useBoardDragDrop, ...)
├── dialogs/                # Dialog components scoped to this view
├── components/             # Smaller presentational components
└── ...
```

Views that are simple enough are single files (e.g., `welcome-view.tsx`, `wiki-view.tsx`).

### Key Views

**`BoardView`** (`components/views/board-view.tsx`)

- Renders the Kanban board with dnd-kit drag-and-drop
- Uses a `DialogAwarePointerSensor` subclass to prevent dragging from inside dialogs
- Delegates state into view-local hooks: `useBoardFeatures`, `useBoardDragDrop`, `useBoardActions`, `useBoardKeyboardShortcuts`, `useBoardEffects`, and others
- Manages the majority of feature lifecycle dialogs (`AddFeatureDialog`, `EditFeatureDialog`, `AgentOutputModal`, `PlanApprovalDialog`, etc.)

**`SettingsView`** (`components/views/settings-view/`)

- Navigation-driven settings panel with sections for API Keys, Model Defaults, Appearance, Keyboard Shortcuts, Providers (Claude, Cursor, Codex, OpenCode, Gemini, Copilot), MCP Servers, and more
- Uses `useSearch` from TanStack Router to support deep-linking to a specific settings section via the `view` search param

**`TerminalView`** (`components/views/terminal-view/`)

- Multi-tab, multi-pane xterm terminal
- Manages its own split/tab state and keyboard shortcut handling

**`SetupView`** (`components/views/setup-view/`)

- Multi-step wizard driven by `useSetupStore.currentStep`
- Steps: `welcome` → `theme` → `providers` → `claude_detect` → `claude_auth` → `cursor` → `codex` → `opencode` → `gemini` → `copilot` → `github` → `complete`

---

## Component Organization

```
src/components/
├── views/          # Full-page view components (one per route)
├── ui/             # Reusable primitive components (shadcn/Radix pattern)
├── layout/         # Layout chrome: sidebar, project switcher
├── dialogs/        # Application-level dialogs shared across views
├── shared/         # Misc shared components (session manager, usage popovers)
└── splash-screen.tsx
```

### `components/ui/` — Component Library

UI primitives follow the [shadcn/ui](https://ui.shadcn.com/) pattern: thin wrappers around Radix UI primitives styled with Tailwind CSS 4. Examples:

- `button.tsx`, `input.tsx`, `label.tsx`, `checkbox.tsx`, `radio-group.tsx`
- `dialog.tsx`, `popover.tsx`, `dropdown-menu.tsx`, `command.tsx`
- `accordion.tsx`, `collapsible.tsx`, `scroll-area.tsx`
- `card.tsx`, `badge.tsx`, `kbd.tsx`

Non-primitive UI components also live here:

- `ansi-output.tsx` — ANSI escape sequence rendering
- `codemirror-diff-view.tsx` — Inline git diff viewer
- `git-diff-panel.tsx` — Full diff panel
- `log-viewer.tsx` — Streaming log display
- `markdown.tsx` — Markdown renderer
- `loading-state.tsx`, `error-state.tsx` — Common status states
- `app-error-boundary.tsx` — React error boundary with friendly UI
- `json-syntax-editor.tsx` — JSON editor using CodeMirror

---

## Custom Hooks

Custom hooks live under `src/hooks/`. They are organized into three groups:

### Data Fetching — `hooks/queries/`

React Query hooks for all API resources. Each file corresponds to a domain:

| File                    | Resources                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `use-features.ts`       | Feature list and agent output; includes LocalStorage-based LRU cache for instant board rendering |
| `use-worktrees.ts`      | Worktree list, status, diffs, branches                                                           |
| `use-github.ts`         | Issues, PRs, validations, comments                                                               |
| `use-settings.ts`       | Global settings, project settings, credentials                                                   |
| `use-models.ts`         | Available models, Codex models, OpenCode models, provider status                                 |
| `use-running-agents.ts` | Live agent status with smart polling                                                             |
| `use-usage.ts`          | Claude, Codex, z.ai, Gemini usage metrics                                                        |
| `use-sessions.ts`       | Chat session list and history                                                                    |
| `use-pipeline.ts`       | Pipeline configuration                                                                           |
| `use-cli-status.ts`     | CLI tool installation and auth status                                                            |
| `use-spec.ts`           | Spec file content                                                                                |
| `use-ideation.ts`       | Ideas and ideation sessions                                                                      |
| `use-workspace.ts`      | Workspace config and directories                                                                 |
| `use-git.ts`            | Git diffs                                                                                        |

### Mutations — `hooks/mutations/`

React Query mutation hooks:

| File                                  | Operations                                              |
| ------------------------------------- | ------------------------------------------------------- |
| `use-feature-mutations.ts`            | Create, update, delete, status transitions for features |
| `use-settings-mutations.ts`           | Update global and project settings                      |
| `use-worktree-mutations.ts`           | Create, delete, commit worktrees                        |
| `use-github-mutations.ts`             | Create PRs, validate issues                             |
| `use-ideation-mutations.ts`           | Create, update, promote ideas                           |
| `use-spec-mutations.ts`               | Update spec content                                     |
| `use-auto-mode-mutations.ts`          | Start/stop auto mode                                    |
| `use-cursor-permissions-mutations.ts` | Manage Cursor permissions                               |

### UI / Behavior Hooks — `hooks/`

| Hook                             | Purpose                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `use-settings-sync.ts`           | Subscribes to `useAppStore` and debounces settings writes to the server                |
| `use-settings-migration.ts`      | On first load, migrates localStorage settings to server and hydrates the store         |
| `use-query-invalidation.ts`      | Connects WebSocket events to React Query cache invalidation                            |
| `use-event-recency.ts`           | Tracks last WebSocket event timestamp to suppress polling when events are flowing      |
| `use-keyboard-shortcuts.ts`      | Global keyboard shortcut handler with input-focus detection                            |
| `use-agent-output-websocket.ts`  | WebSocket subscription for streaming agent output into the AgentOutputModal            |
| `use-auto-mode.ts`               | Auto mode start/stop state management                                                  |
| `use-responsive-kanban.ts`       | Adjusts visible Kanban columns based on viewport width                                 |
| `use-window-state.ts`            | Electron window state (minimized, focused, etc.)                                       |
| `use-os-detection.ts`            | Detects macOS/Windows/Linux for OS-specific behavior                                   |
| `use-media-query.ts`             | Reactive CSS media query matching                                                      |
| `use-mobile-visibility.ts`       | Manages React Query focus/online state on mobile to prevent blank-screen reload cycles |
| `use-project-settings-loader.ts` | Loads per-project settings when the current project changes                            |
| `use-provider-auth-init.ts`      | Fetches provider auth status on startup                                                |
| `use-cursor-status-init.ts`      | Checks Cursor CLI status on startup                                                    |
| `use-electron-agent.ts`          | Electron-specific agent execution wrapper                                              |
| `use-notification-events.ts`     | Subscribes to server notification events via WebSocket                                 |
| `use-init-script-events.ts`      | Subscribes to init script execution events                                             |
| `use-guided-prompts.ts`          | Manages guided prompt suggestions                                                      |
| `use-message-queue.ts`           | Queues messages for sequential delivery                                                |
| `use-scroll-tracking.ts`         | Tracks scroll position for virtual scroll anchoring                                    |
| `use-test-runners.ts`            | Manages test session lifecycle                                                         |
| `use-test-logs.ts`               | Streams test log events                                                                |

---

## API Client and Server Communication

### HTTP API Client (`lib/http-api-client.ts`)

The HTTP client provides the same interface as the Electron IPC bridge, so view components do not need to know which runtime they are in. It communicates with the Express backend at `http://localhost:3008` (proxied through Vite during development).

Internally it handles:

- Session token management (stored in memory, not localStorage)
- `401`/`403` responses — emits a `pegasus:logged-out` custom event to redirect to `/logged-out`
- Server offline detection — emits a `pegasus:server-offline` event on connection failures
- In Electron mode, retrieves the server URL via `window.electronAPI.getServerUrl()` (IPC call to main process)

Usage example:

```ts
const api = getHttpApiClient();
const features = await api.features.list(projectPath);
```

### React Query Integration

Server state is managed exclusively through TanStack React Query. The query client is configured in `lib/query-client.ts` with:

- Mobile-aware stale times (3x longer on mobile)
- Mobile-aware GC times (longer to prevent blank screens on navigation)
- `refetchOnWindowFocus: false` on mobile to avoid refetch storms
- Automatic retry with exponential backoff (shorter delays for connection errors)
- Global error handler that distinguishes auth errors, connection errors, and generic errors

The query cache is persisted to **IndexedDB** via `lib/query-persist.ts` using `@tanstack/react-query-persist-client`. The persister:

- Stores the full cache under the key `pegasus-react-query-cache`
- Excludes auth, health, wsToken, and sandbox queries from persistence
- Does not persist mutations
- Uses a build hash buster to invalidate stale caches after deployments

### Query Keys

All query keys follow a factory pattern in `lib/query-keys.ts`:

```ts
queryKeys.features.all(projectPath); // ['features', projectPath]
queryKeys.features.single(path, id); // ['features', path, id]
queryKeys.features.agentOutput(path, id); // ['features', path, id, 'output']
queryKeys.worktrees.all(projectPath); // ['worktrees', projectPath]
queryKeys.settings.global(); // ['settings', 'global']
// ...
```

### WebSocket Events

The backend pushes events over WebSocket. The `getElectronAPI()` function returns an abstraction that normalizes WebSocket events in both web and Electron modes. Hooks subscribe via:

```ts
const api = getElectronAPI();
const unsubscribe = api.autoMode.onEvent((event: AutoModeEvent) => { ... });
// Call unsubscribe() in effect cleanup
```

`use-query-invalidation.ts` (`useAutoModeQueryInvalidation`) connects WebSocket events to targeted React Query cache invalidations, ensuring the Kanban board and running-agents view update in near real-time without polling.

`use-event-recency.ts` tracks the last WebSocket event timestamp. Query hooks use this to implement smart polling intervals: polling is suppressed when WebSocket events are actively flowing (within `EVENT_RECENCY_THRESHOLD`, 5 seconds desktop / 10 seconds mobile) and resumes when the connection goes quiet.

---

## Electron Integration

### Architecture Overview

```
apps/ui/
├── src/main.ts              # Electron main process entry
├── src/preload.ts           # Preload script (contextBridge)
└── src/electron/            # Main process modules
    ├── constants.ts         # Window sizing, port defaults
    ├── state.ts             # Shared state (ports, window refs)
    ├── auto-updater.ts      # electron-updater integration
    ├── ipc/                 # IPC channel handlers
    │   ├── channels.ts      # IPC_CHANNELS constant definitions
    │   ├── index.ts         # Registers all handlers
    │   ├── app-handlers.ts  # app:getPath, app:getVersion, app:quit, ...
    │   ├── auth-handlers.ts # auth:getApiKey, auth:isExternalServerMode
    │   ├── dialog-handlers.ts  # dialog:openDirectory, openFile, saveFile
    │   ├── shell-handlers.ts   # shell:openExternal, openPath, openInEditor
    │   ├── window-handlers.ts  # window:updateMinWidth
    │   └── server-handlers.ts  # server:getUrl
    ├── security/            # API key management (electron-store)
    ├── server/              # Embedded backend and static file server
    └── windows/             # BrowserWindow creation and bounds persistence
```

### Preload Script (`src/preload.ts`)

The preload script uses Electron's `contextBridge` to expose a minimal `window.electronAPI` surface to the renderer. It exposes only what is necessary for native features:

```ts
window.electronAPI = {
  platform: process.platform,
  isElectron: true,
  ping: () => ipcRenderer.invoke('ping'),
  getServerUrl: () => ipcRenderer.invoke('server:getUrl'),
  getApiKey: () => ipcRenderer.invoke('auth:getApiKey'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  openFile: (options?) => ipcRenderer.invoke('dialog:openFile', options),
  saveFile: (options?) => ipcRenderer.invoke('dialog:saveFile', options),
  openExternalLink: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  openInEditor: (filePath, line?, column?) => ipcRenderer.invoke('shell:openInEditor', ...),
  getPath: (name) => ipcRenderer.invoke('app:getPath', name),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  isPackaged: () => ipcRenderer.invoke('app:isPackaged'),
  updateMinWidth: (sidebarExpanded) => ipcRenderer.invoke('window:updateMinWidth', ...),
  quit: () => ipcRenderer.invoke('app:quit'),
}
```

All business logic (features, worktrees, agents, etc.) goes through the HTTP API. The preload IPC surface is intentionally minimal — only native dialogs, shell operations, and app metadata.

### `lib/electron.ts` — Runtime Detection

`lib/electron.ts` exports `isElectron()` and `getElectronAPI()`. Components use these to detect which runtime they are in and access the API surface:

```ts
if (isElectron()) {
  // Electron-specific behavior
}
const api = getElectronAPI();
// api is the same interface regardless of runtime mode
```

In web mode, `getElectronAPI()` returns a WebSocket-backed implementation that mirrors the Electron IPC interface.

### Main Process

`src/main.ts` orchestrates the Electron app lifecycle:

1. Sets `@pegasus/platform` paths for Electron's userData directory
2. Finds available ports for the backend server and static file server
3. Generates a random API key via `ensureApiKey()` for request authentication
4. Starts the embedded Express backend server (`electron/server/backend-server.ts`)
5. Starts a static file server for production builds (`electron/server/static-server.ts`)
6. Creates the main `BrowserWindow` with window bounds persistence
7. Registers all IPC handlers via `registerAllHandlers()`
8. Initializes the auto-updater (`electron/auto-updater.ts`)

---

## Build Modes

### Web Mode

```bash
pnpm dev:web      # Vite dev server on port 3007 (auto-increment if taken)
pnpm build        # Production build to apps/ui/dist/
```

The Vite dev server proxies `/api` requests to the backend at port 3008. In CI environments (`CI=true` or `VITE_SKIP_ELECTRON=true`), the Electron Vite plugin is skipped.

### Electron Mode

```bash
pnpm dev:electron       # Electron + Vite dev server
pnpm build:electron     # Production Electron build
```

The Vite config includes `vite-plugin-electron/simple` which compiles `src/main.ts` and `src/preload.ts` into `dist-electron/` alongside the renderer bundle.

### Chunk Strategy

The build manually splits vendor dependencies into named chunks for optimal caching and mobile load performance (`vite.config.mts` `manualChunks`):

| Chunk               | Contents                                 | Load strategy                      |
| ------------------- | ---------------------------------------- | ---------------------------------- |
| `vendor-react`      | React, ReactDOM, use-sync-external-store | Eager (critical)                   |
| `vendor-tanstack`   | TanStack Router + Query                  | Eager (critical)                   |
| `vendor-radix`      | Radix UI primitives                      | Eager (used on all pages)          |
| `vendor-state`      | Zustand, Zod                             | Eager                              |
| `vendor-icons`      | lucide-react                             | Prefetch (deferred)                |
| `vendor-codemirror` | CodeMirror, Lezer                        | Prefetch (spec/editor routes only) |
| `vendor-xterm`      | xterm, @xterm/                           | Prefetch (terminal route only)     |
| `vendor-reactflow`  | @xyflow/react                            | Prefetch (graph route only)        |
| `vendor-markdown`   | react-markdown, remark, rehype           | Prefetch (agent view, wiki)        |
| `font-*`            | @fontsource/\*                           | On demand                          |

Deferred chunks use `<link rel="prefetch">` (not `modulepreload`) in production HTML, reducing First Contentful Paint on mobile.

### Service Worker (PWA)

A service worker (`public/sw.js`) is registered in `renderer.tsx` for PWA support in web mode. The `swCacheBuster` Vite plugin injects a git-based build hash into the service worker's `CACHE_NAME` at build time, ensuring users get fresh caches after each deployment.

Mobile-specific behaviors are implemented via `SET_MOBILE_MODE` messages to the service worker, enabling stale-while-revalidate for API responses to prevent blank screens on flaky connections.

---

## Configuration and Path Aliases

`vite.config.mts` defines the `@` alias:

```ts
{ find: '@', replacement: path.resolve(__dirname, './src') }
```

Use `@/` for all imports within `apps/ui/src/`:

```ts
import { useAppStore } from "@/store/app-store";
import { queryKeys } from "@/lib/query-keys";
import { BoardView } from "@/components/views/board-view";
```

In development, `@pegasus/chat-ui` is aliased to its TypeScript source (`libs/chat-ui/src/index.ts`) for native Vite HMR on chat-ui edits. In production builds this alias is absent and pnpm resolves the package normally.

React and ReactDOM are pinned to single instances via explicit aliases and the `dedupe` option to prevent duplicate-React errors from nested dependencies (notably `@xyflow/react` which ships its own zustand@4).

---

## Key Patterns for Contributors

### Adding a New Route

1. Create `src/routes/my-route.tsx` with `createFileRoute('/my-route')`.
2. Create `src/routes/my-route.lazy.tsx` with `createLazyFileRoute('/my-route')` and your component.
3. The route tree is regenerated automatically by the Vite plugin.
4. Add a corresponding view component under `src/components/views/`.

### Adding a New Query Hook

1. Add query keys to `lib/query-keys.ts`.
2. Create a hook in `hooks/queries/use-my-resource.ts` using `useQuery` from TanStack React Query.
3. Use `STALE_TIMES` constants from `lib/query-client.ts` for the `staleTime` option.
4. If the resource receives WebSocket push updates, add invalidation logic to `hooks/use-query-invalidation.ts`.

### Adding a New Store

Follow the existing pattern: separate `State` and `Actions` interfaces, define `initialState` as a constant, and call `create<State & Actions>()`. Avoid Zustand `persist` middleware for settings — instead sync to the server via the settings API. Only use `persist` for local-only UI preferences (as in `ideation-store.ts` and `ui-cache-store.ts`).

### Accessing the Backend API

Always go through `getHttpApiClient()` rather than calling `fetch` directly. This ensures session tokens, error handling, and offline detection work consistently across web and Electron modes.
