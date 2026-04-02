---
paths:
  - "src/pegasus/ui.py"
  - "tests/test_ui.py"
---

# Textual TUI Patterns

## Border-box height: never set `height: 1` on bordered widgets

Textual defaults to `border-box` sizing. Input's default `tall` border needs 2 cells, so `height: 1` leaves 0 content area. The widget renders its border (looks normal) but has no interactive text area. Remove explicit height to use the widget's default (Input = 3).

## Use ModalScreen for modal dialogs, not Widget + layer overlay

A `Widget` with `layer: overlay` and `display: none/block` toggling does NOT get focus isolation or binding suppression. The Input inside it will never receive focus reliably. Use `ModalScreen` with `push_screen(screen, callback=...)` instead — it properly isolates focus and suppresses parent app bindings.

## priority=True bindings bypass ModalScreen suppression

ModalScreen only blocks non-priority parent bindings. Never use `priority=True` on app bindings for keys the modal also needs (e.g., Escape). The app binding fires first and consumes the event.

## set_interval timers query the ACTIVE screen's DOM

`self.query_one(...)` on the App searches the currently active screen, not the main screen. When a ModalScreen is pushed, timer callbacks that query main-screen widgets (e.g., `#task-area`) will raise `NoMatches`. Guard with `if isinstance(self.screen, ModalScreen): return`.

**Also skip for Widget-based overlays**: `TaskCreateModal` is a Widget with `layer: overlay`, not a ModalScreen. The `poll_db` timer must also check `_create_visible` — DOM rebuilds from polling close Select dropdowns and steal focus from overlay widgets.

## Textual 8.x: timeout=0 means "expire immediately", not "persist"

`Notification.has_expired` computes `(raised_at + timeout) - time() <= 0`. With `timeout=0`, the toast expires the instant it's created and never renders. Use the `_ERROR_NOTIFY_TIMEOUT` module constant (30s) for error notifications. Never pass `timeout=0`.

## Action handlers must use `_focused_task()`, not `_focused_task_index()`

In detail mode, no `TaskCard` has focus — `_focused_task_index()` falls back to `_focused_idx` which points to the wrong task. The `_focused_task()` helper checks `_detail_mode` and resolves via `_detail_task_id` first. All action handlers that operate on a task (merge, approve, reject, clean) must use `_focused_task()`.
