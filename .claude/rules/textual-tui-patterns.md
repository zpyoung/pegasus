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
