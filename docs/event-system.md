# Event System and WebSocket Architecture

This document describes how Pegasus streams real-time events from the server to the frontend and how those events trigger side effects such as hook execution, history storage, and React Query cache invalidation.

## Overview

Pegasus uses an in-process publish/subscribe event bus on the server. When something interesting happens (an agent starts, a feature completes, a pipeline step finishes, etc.) the relevant service calls `events.emit(type, payload)`. A WebSocket bridge subscribes to every event and forwards each one as a JSON message to all connected clients. The frontend parses these messages and routes them to registered callbacks, which drive UI updates, React Query invalidations, and Electron IPC handlers.

```
Server service
    └─ events.emit(type, payload)           # in-process EventEmitter
           └─ WebSocket bridge              # index.ts wss handler
                   └─ ws.send(JSON)         # to every connected browser tab
                           └─ HttpApiClient.onmessage
                                   └─ eventCallbacks.get(type).forEach(cb)
                                           └─ React hook callbacks
                                               └─ useQueryInvalidation / Zustand store / UI state
```

---

## Core Primitives (`apps/server/src/lib/events.ts`)

### `EventEmitter`

```ts
export interface EventEmitter {
  emit: (type: EventType, payload: unknown) => void;
  subscribe: (callback: EventCallback) => () => void;
}
```

`subscribe` returns an unsubscribe function. All subscribers receive every event—there is no per-type filtering inside the emitter itself; callers filter by `type` inside their callback.

### `createEventEmitter()`

Creates a lightweight, synchronous, in-memory pub/sub bus backed by a `Set<EventCallback>`. Errors thrown by individual subscribers are caught and logged so one bad subscriber cannot silence others.

```ts
const events = createEventEmitter();

// Emit
events.emit('feature:started', { featureId, projectPath });

// Subscribe
const unsubscribe = events.subscribe((type, payload) => {
  if (type === 'feature:started') { ... }
});

// Later
unsubscribe();
```

One shared `EventEmitter` instance is created at server startup in `apps/server/src/index.ts` and injected into every service and route that needs it.

---

## Event Types (`libs/types/src/event.ts`)

`EventType` is a string union that covers every event the system can emit. Groups include:

| Prefix | What it covers |
|---|---|
| `agent:` | AI agent streaming output |
| `auto-mode:` | Auto-mode lifecycle (started, stopped, idle, error) and sub-events |
| `feature:` | Feature lifecycle (created, started, completed, stopped, error, progress, tool-use, committed, …) |
| `project:` | Project analysis progress |
| `spec-regeneration:` | Spec regeneration events |
| `issue-validation:` | GitHub issue validation |
| `ideation:` | Ideation session and idea events |
| `worktree:` | Worktree copy/symlink/init progress |
| `dev-server:` | Dev server start, output, URL detection, stop |
| `test-runner:` | Test suite progress and results |
| `cherry-pick:`, `rebase:`, `stash:`, `merge:`, `conflict:` | Git operation events |
| `commitLog:`, `branchCommitLog:`, `switch:` | Git log and branch-switch events |
| `notification:` | In-app notification created |
| `helper_chat_event` | Helper chat streaming |

`EventCallback` is `(type: EventType, payload: unknown) => void`.

---

## TypedEventBus (`apps/server/src/services/typed-event-bus.ts`)

`TypedEventBus` wraps a raw `EventEmitter` to provide type-safe emission of auto-mode events.

### Key method: `emitAutoModeEvent`

All auto-mode sub-events are sent as a single `auto-mode:event` wire message. The actual event type is embedded in the payload so the frontend can dispatch on it without needing a new `EventType` entry for every auto-mode state.

```ts
bus.emitAutoModeEvent('auto_mode_feature_complete', {
  featureId,
  projectPath,
  passes: true,
  executionMode: 'auto',
});
// Equivalent to:
events.emit('auto-mode:event', {
  type: 'auto_mode_feature_complete',
  featureId,
  projectPath,
  passes: true,
  executionMode: 'auto',
});
```

### `AutoModeEventType`

The full list of valid inner event types includes:

- **Lifecycle**: `auto_mode_started`, `auto_mode_stopped`, `auto_mode_idle`, `auto_mode_error`, `auto_mode_paused_failures`
- **Feature execution**: `auto_mode_feature_start`, `auto_mode_feature_complete`, `auto_mode_feature_resuming`, `auto_mode_resuming_features`
- **Progress streaming**: `auto_mode_progress`, `auto_mode_tool`, `auto_mode_summary`
- **Task/phase tracking**: `auto_mode_task_started`, `auto_mode_task_complete`, `auto_mode_task_status`, `auto_mode_phase_complete`
- **Planning**: `planning_started`, `plan_approval_required`, `plan_approved`, `plan_auto_approved`, `plan_rejected`, `plan_revision_requested`, `plan_revision_warning`, `plan_spec_updated`
- **Pipeline**: `pipeline_step_started`, `pipeline_step_complete`, `pipeline_test_failed`, `pipeline_merge_conflict`
- **Feature state**: `feature_status_changed`, `features_reconciled`
- **Questions**: `question_required`, `question_answered`

### Direct `emit` vs `emitAutoModeEvent`

Use `emit` for non-auto-mode events that have their own `EventType` entry (e.g., `feature:created`, `dev-server:output`). Use `emitAutoModeEvent` for everything that belongs to the auto-mode event group.

---

## WebSocket Server (server-side)

### Connection lifecycle

The server runs **two** WebSocket servers in `noServer` mode, sharing a single HTTP server:

| Path | Purpose |
|---|---|
| `/api/events` | General event stream (all system events) |
| `/api/terminal/ws` | Terminal I/O (xterm.js) |

HTTP upgrade requests are routed in the `server.on('upgrade', ...)` handler based on the URL path.

### Authentication

Every WebSocket upgrade is authenticated before the connection is accepted. The server checks, in order:

1. `X-API-Key` header or `apiKey` query parameter
2. Session token header or query parameter
3. Valid session cookie
4. Short-lived `wsToken` query parameter (obtained from `POST /api/auth/token`)

Connections that fail authentication receive `HTTP/1.1 401 Unauthorized` and are destroyed.

### Event forwarding

When a client connects to `/api/events`, the server subscribes to the shared `EventEmitter` and forwards every event as a JSON-serialized message:

```ts
wss.on('connection', (ws) => {
  const unsubscribe = events.subscribe((type, payload) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload }));
    }
  });

  ws.on('close', () => unsubscribe());
  ws.on('error', () => unsubscribe());
});
```

All events are broadcast to all connected clients. There is no per-client event filtering on the server side; clients filter by `type` in their own handlers.

High-frequency events (`dev-server:output`, `test-runner:output`, `feature:progress`) are logged at `debug` level rather than `info` to avoid log spam.

---

## Frontend WebSocket Integration

### `HttpApiClient` (`apps/ui/src/lib/http-api-client.ts`)

`HttpApiClient` is the single WebSocket connection manager for the web/browser mode. It implements the `ElectronAPI` interface so the rest of the codebase can use the same API surface whether running in Electron or a browser.

#### Connection setup

- **Electron mode**: connects as soon as the injected API key is available.
- **Web mode**: defers connection until the first `subscribeToEvent` call to avoid 401s on unauthenticated routes.
- **Visibility-change reconnect**: when a browser tab becomes visible after being discarded, the client immediately reconnects with `silent: true` (a 401 during this reconnect does not trigger a logout).

#### Reconnect backoff

On disconnect, the client retries with exponential backoff: immediate → 500 ms → 1 s → 2 s → 5 s (max).

#### Authentication

- Electron: passes `?apiKey=<key>` in the WebSocket URL.
- Web: fetches a short-lived token from `POST /api/auth/token` and passes `?wsToken=<token>`. Falls back to cookie auth if no token is available.

#### Message dispatch

```ts
this.ws.onmessage = (event) => {
  const data = JSON.parse(event.data);    // { type, payload }
  const callbacks = this.eventCallbacks.get(data.type);
  callbacks?.forEach((cb) => cb(data.payload));
};
```

Callbacks are registered per `EventType`. Multiple callbacks for the same type are held in a `Set` and all called synchronously on each message.

#### Subscribing to events

```ts
private subscribeToEvent(type: EventType, callback: EventCallback): () => void {
  this.eventCallbacks.get(type)?.add(callback) ?? this.eventCallbacks.set(type, new Set([callback]));
  this.connectWebSocket(); // ensures connection is open
  return () => this.eventCallbacks.get(type)?.delete(callback);
}
```

### Frontend event hooks (React)

The `getElectronAPI()` helper returns the `HttpApiClient` instance in web mode or the Electron IPC bridge in Electron mode. All event subscriptions go through it:

```ts
const api = getElectronAPI();
const unsubscribe = api.autoMode.onEvent((event: AutoModeEvent) => {
  // event is already the typed inner payload (auto-mode:event payload)
  if (event.type === 'auto_mode_feature_complete') { ... }
});
// cleanup
return unsubscribe;
```

### Query invalidation (`apps/ui/src/hooks/use-query-invalidation.ts`)

`useQueryInvalidation(projectPath, sessionId)` is a combined hook that wires WebSocket events to React Query cache invalidation. It should be mounted once near the app root.

Key invalidation triggers:

| Event | Queries invalidated |
|---|---|
| `auto_mode_feature_start`, `auto_mode_feature_complete`, `feature_status_changed`, `features_reconciled` | `features.all(projectPath)` |
| `auto_mode_task_status`, `auto_mode_phase_complete`, `auto_mode_summary` | `features.single(projectPath, featureId)` |
| `auto_mode_progress` (debounced 150 ms, max 2 s) | `features.agentOutput(projectPath, featureId)` |
| `auto_mode_feature_complete` | `worktrees.all(projectPath)`, `worktrees.single(...)` |
| `auto_mode_feature_start/complete/error` | `runningAgents.all()` |
| `spec_regeneration_complete` | `features.all`, `specRegeneration.status` |

### Event recency / smart polling (`apps/ui/src/hooks/use-event-recency.ts`)

`useEventRecencyStore` (Zustand) tracks when the last WebSocket event was received. Queries use this to disable polling while events are flowing:

```ts
refetchInterval: createSmartPollingInterval(5000)
// Returns `false` (no polling) within 5 s of a WebSocket event.
// On mobile the threshold extends to 10 s and intervals are multiplied.
```

Call `recordGlobalEvent()` inside any WebSocket handler to register that the connection is healthy.

---

## Event History (`apps/server/src/services/event-history-service.ts`)

Events that match a hook trigger are persisted to disk for debugging and replay.

### Storage layout

```
.pegasus/
└── events/
    ├── index.json               # Index of summaries (max 1000 entries)
    └── evt-<timestamp>-<uuid>.json   # Full event payload per event
```

Writes use an atomic rename pattern (write to `.tmp`, then `rename`) to prevent partial reads.

### `StoredEvent` shape

```ts
{
  id: string;             // evt-<timestamp>-<uuid8>
  trigger: EventHookTrigger;
  timestamp: string;      // ISO 8601
  projectPath: string;
  projectName: string;    // last path segment
  featureId?: string;
  featureName?: string;
  error?: string;
  errorType?: string;
  passes?: boolean;
  metadata?: Record<string, unknown>;
}
```

### Index pruning

When the index exceeds 1000 entries, the oldest entries are removed from the index and their individual files are deleted.

### HTTP API (`/api/event-history`)

All endpoints accept `projectPath` in the request body.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/event-history/list` | List events. Accepts `filter` (trigger, featureId, since, until, limit, offset). Returns `{ events: StoredEventSummary[], total }`. |
| `POST` | `/api/event-history/get` | Get full event by `eventId`. |
| `POST` | `/api/event-history/delete` | Delete a single event. |
| `POST` | `/api/event-history/clear` | Delete all events for a project. |
| `POST` | `/api/event-history/replay` | Re-execute hooks for a stored event. Optionally filter to specific `hookIds`. Returns `EventReplayResult`. |

---

## Event Hooks (`apps/server/src/services/event-hook-service.ts`)

Event hooks let users run custom side effects when specific events occur. They are configured in global settings under `eventHooks`.

### Hook triggers

`EventHookTrigger` is a subset of application events that users can act on:

| Trigger | When it fires |
|---|---|
| `feature_created` | A new feature is created on the board |
| `feature_success` | A feature completes with passing tests |
| `feature_error` | A feature fails or errors |
| `auto_mode_complete` | Auto mode reaches idle state after processing all features |
| `auto_mode_error` | Auto mode pauses due to a critical error |

### Hook action types

**Shell** — run a command in the server's working directory:

```json
{
  "type": "shell",
  "command": "notify-send '{{featureName}} completed'",
  "timeout": 30000
}
```

**HTTP** — POST/GET/PUT/PATCH to a webhook URL:

```json
{
  "type": "http",
  "url": "https://hooks.slack.com/...",
  "method": "POST",
  "headers": { "Authorization": "Bearer {{token}}" },
  "body": "{\"text\": \"Feature {{featureName}} done\"}"
}
```

**Ntfy** — push notification via ntfy.sh (references a pre-configured endpoint):

```json
{
  "type": "ntfy",
  "endpointId": "my-phone",
  "title": "Feature complete",
  "body": "{{featureName}} passed verification",
  "priority": 3
}
```

### Variable substitution

All string fields in hook actions support `{{variableName}}` placeholders. Available variables:

| Variable | Value |
|---|---|
| `{{featureId}}` | Feature ID |
| `{{featureName}}` | Feature title |
| `{{projectPath}}` | Absolute path to the project |
| `{{projectName}}` | Last segment of the project path |
| `{{error}}` | Error message (error events only) |
| `{{errorType}}` | Error classification (error events only) |
| `{{timestamp}}` | ISO 8601 timestamp |
| `{{eventType}}` | The trigger that fired |

### Deduplication

When auto mode completes a feature it emits both `auto_mode_feature_complete` and a subsequent `feature_status_changed`. `EventHookService` tracks recently-handled feature IDs (30-second window) to prevent double-firing hooks for the same feature completion.

### Hook execution

Matching hooks run in parallel via `Promise.allSettled`. A failure in one hook does not block others. Timeouts apply per action type: 30 s for shell commands, 10 s for HTTP requests.

---

## Adding New Event Types

### 1. Add to `EventType`

Open `libs/types/src/event.ts` and add your new type to the union:

```ts
export type EventType =
  // ...existing types...
  | 'my-feature:my-event';
```

### 2. Emit from server code

Inject the shared `EventEmitter` into your service and call `emit`:

```ts
import type { EventEmitter } from '../lib/events.js';

class MyService {
  constructor(private events: EventEmitter) {}

  doSomething() {
    // ... business logic ...
    this.events.emit('my-feature:my-event', {
      someField: value,
      projectPath,
    });
  }
}
```

### 3. Subscribe in the frontend

Register a callback through `getElectronAPI()`:

```ts
import { getElectronAPI } from '@/lib/electron';
import type { EventType } from '@pegasus/types';

// Inside a React useEffect:
useEffect(() => {
  const api = getElectronAPI();
  // The API surface exposes typed subscription methods by feature area.
  // For new low-level events you can subscribe at the HttpApiClient level:
  const unsubscribe = (api as unknown as { subscribeToEvent: Function })
    .subscribeToEvent('my-feature:my-event', (payload: unknown) => {
      // handle payload
    });
  return unsubscribe;
}, []);
```

For events that should invalidate React Query caches, add the event type to the appropriate list in `use-query-invalidation.ts` (e.g., `FEATURE_LIST_INVALIDATION_EVENTS`).

### 4. (Optional) Add a hook trigger

If the event should be user-actionable via event hooks:

1. Add a new value to `EventHookTrigger` in `libs/types/src/settings.ts`.
2. Add a label in `EVENT_HOOK_TRIGGER_LABELS`.
3. Add a `case` in `EventHookService.handleAutoModeEvent` (or add a new handler method if it's not an auto-mode event) that sets `trigger` to the new value.
4. Store the event in history via `this.eventHistoryService.storeEvent(...)`.

---

## Terminal WebSocket

The terminal uses a separate WebSocket at `/api/terminal/ws?sessionId=<id>&token=<token>`.

### Message protocol (server → client)

| `type` | Payload | Meaning |
|---|---|---|
| `connected` | `{ sessionId, shell, cwd }` | Connection accepted |
| `scrollback` | `{ data: string }` | Historical terminal output buffer |
| `data` | `{ data: string }` | Live terminal output |
| `exit` | `{ exitCode }` | Terminal process exited |
| `error` | `{ message }` | Protocol error |

### Message protocol (client → server)

| `type` | Fields | Meaning |
|---|---|---|
| `input` | `{ data: string }` | User keystroke(s) to write to pty |
| `resize` | `{ cols: number, rows: number }` | Terminal resize (rate-limited to 100 ms) |

Resize operations are deduplicated (same dimensions ignored) and rate-limited (min 100 ms between resizes) to prevent resize storms when the user drags a panel splitter.
