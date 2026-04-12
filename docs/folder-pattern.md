# Folder & Naming Pattern Guide

This document defines the folder structure and naming conventions used in this codebase.

## File Naming Convention

**All files use kebab-case** (lowercase with hyphens):

```
✅ add-feature-dialog.tsx
✅ use-board-actions.ts
✅ board-view.tsx

❌ AddFeatureDialog.tsx
❌ useBoardActions.ts
❌ BoardView.tsx
```

## Export Naming Convention

While files use kebab-case, **exports use PascalCase for components and camelCase for hooks/functions**:

```tsx
// File: add-feature-dialog.tsx
export function AddFeatureDialog() { ... }

// File: use-board-actions.ts
export function useBoardActions() { ... }
```

## View Folder Structure

Each complex view should have its own folder with the following structure:

```
components/views/
├── [view-name].tsx              # Entry point (exports the main view)
└── [view-name]/                 # Subfolder for complex views
    ├── components/              # View-specific reusable components
    │   ├── index.ts             # Barrel export
    │   └── [component].tsx      # Individual components
    ├── dialogs/                 # View-specific dialogs and modals
    │   ├── index.ts             # Barrel export
    │   └── [dialog-name].tsx    # Individual dialogs/modals
    ├── hooks/                   # View-specific hooks
    │   ├── index.ts             # Barrel export
    │   └── use-[name].ts        # Individual hooks
    ├── shared/                  # Shared utilities between components
    │   ├── index.ts             # Barrel export
    │   └── [name].ts            # Shared code
    ├── constants.ts             # View constants
    ├── types.ts                 # View-specific types (optional)
    ├── utils.ts                 # View utilities (optional)
    └── [main-component].tsx     # Main view components (e.g., kanban-board.tsx)
```

## Example: board-view

```
components/views/
├── board-view.tsx                           # Entry point
└── board-view/
    ├── components/
    │   ├── index.ts
    │   ├── kanban-card/                     # Folder (not a flat file)
    │   ├── kanban-column.tsx
    │   ├── add-feature-button.tsx
    │   ├── empty-state-card.tsx
    │   ├── list-view/
    │   ├── selection-action-bar.tsx
    │   ├── task-id-copy.tsx
    │   └── view-toggle.tsx
    ├── dialogs/
    │   ├── index.ts
    │   ├── add-feature-dialog.tsx
    │   ├── edit-feature-dialog.tsx
    │   ├── follow-up-dialog.tsx
    │   ├── archive-all-verified-dialog.tsx
    │   ├── delete-all-verified-dialog.tsx
    │   ├── delete-completed-feature-dialog.tsx
    │   ├── completed-features-modal.tsx
    │   ├── agent-output-modal.tsx
    │   └── ... (many more dialogs)
    ├── hooks/
    │   ├── index.ts
    │   ├── use-board-actions.ts
    │   ├── use-board-background.ts
    │   ├── use-board-column-features.ts
    │   ├── use-board-drag-drop.ts
    │   ├── use-board-effects.ts
    │   ├── use-board-features.ts
    │   ├── use-board-keyboard-shortcuts.ts
    │   ├── use-board-persistence.ts
    │   ├── use-follow-up-state.ts
    │   ├── use-list-view-state.ts
    │   └── use-selection-mode.ts
    ├── shared/
    │   ├── index.ts
    │   ├── model-constants.ts
    │   └── model-selector.tsx
    ├── constants.ts
    └── kanban-board.tsx
```

## Global vs View-Specific Code

### Global (`src/hooks/`, `src/lib/`, etc.)

Code that is used across **multiple views**:

- `src/hooks/use-auto-mode.ts` - Used by board-view, agent-view, etc.
- `src/hooks/use-keyboard-shortcuts.ts` - Used across the app
- `src/lib/utils.ts` - Global utilities

### View-Specific (`[view-name]/hooks/`, `[view-name]/components/`)

Code that is **only used within a single view**:

- `board-view/hooks/use-board-actions.ts` - Only used by board-view
- `board-view/components/kanban-card/` - Only used by board-view

## Barrel Exports

Use `index.ts` files to create clean import paths:

```tsx
// board-view/hooks/index.ts
export { useBoardActions } from './use-board-actions';
export { useBoardFeatures } from './use-board-features';

// Usage in board-view.tsx
import { useBoardActions, useBoardFeatures } from './board-view/hooks';
```

## When to Create a Subfolder

Create a subfolder for a view when:

1. The view file exceeds ~500 lines
2. The view has 3+ related components
3. The view has 2+ custom hooks
4. Multiple dialogs/modals are specific to the view

## Dialogs Folder

The `dialogs/` folder contains all dialog and modal components specific to a view:

### What goes in `dialogs/`:

- Confirmation dialogs (e.g., `delete-all-verified-dialog.tsx`)
- Form dialogs (e.g., `add-feature-dialog.tsx`, `edit-feature-dialog.tsx`)
- Modal overlays (e.g., `agent-output-modal.tsx`, `completed-features-modal.tsx`)
- Any component that renders as an overlay/popup

### Naming convention:

- Use `-dialog.tsx` suffix for confirmation/form dialogs
- Use `-modal.tsx` suffix for content-heavy modals

### Barrel export pattern:

```tsx
// dialogs/index.ts
export { AddFeatureDialog } from './add-feature-dialog';
export { EditFeatureDialog } from './edit-feature-dialog';
export { AgentOutputModal } from './agent-output-modal';
// ... etc

// Usage in view entry point
import { AddFeatureDialog, EditFeatureDialog, AgentOutputModal } from './board-view/dialogs';
```

## Quick Reference

| Location   | File Naming                     | Export Naming          |
| ---------- | ------------------------------- | ---------------------- |
| Components | `kebab-case.tsx`                | `PascalCase`           |
| Dialogs    | `*-dialog.tsx` or `*-modal.tsx` | `PascalCase`           |
| Hooks      | `use-kebab-case.ts`             | `camelCase`            |
| Utils/Lib  | `kebab-case.ts`                 | `camelCase`            |
| Types      | `kebab-case.ts`                 | `PascalCase`           |
| Constants  | `constants.ts`                  | `SCREAMING_SNAKE_CASE` |
