# Changelog

All notable changes to this fork of Pegasus (formerly Automaker) are documented
in this file. Format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project was bootstrapped from an open-source upstream and has diverged
substantially. The entries below describe changes relative to that upstream
baseline.

## [1.2.0] — 2026-04-13

### ✨ Added

- ✨ Add project templates UI with board integration — templates section in project settings, template mutation hooks, and template selection in the add-feature flow (`3624ca4`)
- ✨ Add project-level feature templates with UI separation (`5d8cc66`)
- ✨ Enhance runtime instance metadata handling and UI integration (`b1b0bf9`)
- ✨ Enhance release process to include commit, tag, push, and publish steps (`dcc8a77`)
- ✨ Add user-level config path for Pegasus in allowed system directories (`a62c2f7`)

### 🐛 Fixed

- 🐛 Improve process termination handling for dev servers by killing entire process tree (`c0144a2`)
- 🐛 Prevent dev server port detection from matching "port in use" lines — added negative lookahead to skip "Port in use" output, and export port env vars from launcher (`d3edc86`)

---

## [1.1.0] — 2026-04-12

### ✨ Added

- ✨ Update formatting scripts, enhance test cases, and add husky hooks for Vite cache management (`532b842`)
- ✨ Enhance pre-commit hook to include TypeScript type checking for staged files (`408f876`)
- ✨ Add helper model management and improve type handling in state (`2d07c73`)

### 🐛 Fixed

- 🐛 Resolve TypeScript errors, add validate command, and fix lint/test issues (`7623094`)
  - Fix duplicate `lastUsedPhaseOverrides` declarations in state types
  - Add missing `helperModelByFeature` store actions and initial state
  - Replace removed `cursor-auto` model ID with `cursor-sonnet-4.6`
  - Add `pnpm validate` command (lint + typecheck + format + test in parallel)
  - Fix all lint warnings (unused vars, imports, directives)

### 🔄 Changed

- 🎨 Apply Prettier formatting across codebase (`df2ac80`)
- 📝 Comprehensive documentation overhaul — add 6 new architecture docs, rewrite 3 outdated docs, fix 8 partially outdated docs, remove 7 irrelevant docs (`e5d6959`)
- 🔧 Update repository links and enhance changelog formatting with emoji sections (`e2b66f4`)
- 🔧 Update contribution guidelines and license information (`93add0f`)

---

## [1.0.0] — 2026-04-10

### ✨ Added

#### 🔌 Multi-provider AI support

- Pluggable provider adapters for **Anthropic**, **GitHub Copilot**, **Cursor**,
  **Google Gemini**, **OpenAI**, and **OpenCode**, each with their own
  model-resolution and authentication paths.
- Model registry sync pipeline:
  - **Cursor** uses a curated static list.
  - **Copilot** queries the GitHub Models API.
  - **OpenCode** uses verbose CLI introspection.
  - Generated `model-registry.gen.ts` / `model-registry.json` trimmed by ~2,700
    lines through normalization.
- Unified credential storage and per-project model selection UI.

#### ⚙️ YAML pipeline execution

- New `StageRunner` executes multi-stage YAML pipelines end-to-end (see
  `libs/types/src/yaml-pipeline.ts`, ~6,800 lines added across the feature).
- When a pipeline is selected for a task, the legacy planning section is hidden.
- Support for stages that `requires_approval`, gated behind explicit user
  confirmation before the next stage runs.
- `merge` strategy enhanced with worktree detection and plumbing-level merges.
- **Squash-commit** option added to the merge worktree dialog.
- Default branch selection in the merge dialog uses the current branch.
- **Pipeline optimizations** for large runs.

#### 💡 Idea Board (ADR-003)

- Ideation dashboard replaced with a 3-column kanban board built on the shared
  `KanbanColumn` infrastructure.
- AI suggestions now create raw ideas (not features). Only ideas with
  `status=ready` can be promoted via `convertToFeature`.
- New idea creation only requires a title.
- Global **Shift+I** shortcut navigates to the Idea Board and focuses the
  quick-add input from any page.

#### 🤖 Agent workflow improvements

- **Plan revisions with file-hash tracking** — uses `git hash-object` per file
  for accurate before/after diffing instead of path-presence sets.
- **Per-task commits** — agent-modified files are tracked per task and
  committed separately rather than bulk-committed per worktree.
- **AskUserQuestion tool** — agents can now block on interactive user prompts
  mid-run.
- **Commit changes action** added directly to task cards.
- **Generation jobs indicator** and prompt-command popover surfaced in the UI.

#### 🌳 Worktree enhancements

- **Symlink support** for worktree files, so shared config can be mirrored
  across feature worktrees.
- **"All worktrees" view** — see tasks from every worktree even when the
  worktree bar is disabled.
- **Running dev scripts** are tracked and terminated cleanly when a worktree is
  removed.
- Automatic `.gitignore` seeding with Pegasus runtime entries during project
  initialization.
- Formatted worktree-init script output.

#### 📦 Distribution & auto-update

- **Electron auto-updater** wired to GitHub Releases.
- **1-click update flow** for unsigned macOS builds: opens the GitHub release
  page in the browser when a new version is detected (Squirrel.Mac doesn't
  accept unsigned updates, so the auto-install path is reserved for
  Windows/Linux).
- **`build:electron:publish`** script builds x64 + arm64 DMG/ZIP, uploads to
  GitHub Releases, and promotes the draft to published in a single command.
- **Preflight release check** fails fast (~1s) if the current version is
  already published, preventing wasted builds.
- **VS Code task** for one-click publishing from the command palette.
- Bundled server dependencies via isolated `pnpm install --ignore-workspace`
  to avoid being absorbed by the parent workspace; nested `@pegasus/*` packages
  have their `workspace:*` refs rewritten to `file:` refs during bundling.
- After-pack hook rebuilds native modules (`node-pty`) for the target
  architecture.

#### 🏗️ Dev & build infrastructure

- **Migration to pnpm workspaces** from npm, with `apps/*` and `libs/*` layout.
- **Rebranded** all package scopes, env vars, directories, and docs from
  `automaker` / `AUTOMAKER_*` / `.automaker` to `pegasus` / `PEGASUS_*` /
  `.pegasus`.
- **Multi-instance session isolation** via port-scoped cookie names.
- **URL detection** for Pegasus dev-server ports (auto, interactive, custom).
- **Docker improvements**: tightened route type safety, new `.dockerignore`.
- **Vite dev-server port auto-increment** and localhost CORS relaxation for
  local development.
- **`.vite/` build cache** added to `.gitignore`.

#### 💾 Persistence

- **Last-used phase overrides** are now remembered across sessions.
- **Last-selected model** persists and is restored on project reopen.

### 🐛 Fixed

- Resolved pnpm phantom dependencies and broken test infrastructure after the
  workspace migration.
- `pnpm` filter syntax corrected to use scoped package names for server/UI
  builds.
- `.gitignore` deduplicated (`.worktrees` entry appeared twice).
- TypeScript error in `question-helper/routes/get-history.ts` — `req.params`
  now cast to `{ featureId: string }` matching the codebase convention for
  Express 5 routes.
- Removed stale `package-lock.json`; the project is pnpm-only.

### 🔄 Changed

- `.automaker/` → `.pegasus/` directory convention, with `.pegasus/` data
  always living in the main worktree (never in staging or feature worktrees).
- GitHub org URLs updated throughout (`AutoMaker-Org` → `zpyoung`).
- `optionalDependencies` pruned in `package.json` / `pnpm-lock.yaml`.
- Start script logo/ASCII art updated.

---

[1.2.0]: https://github.com/zpyoung/pegasus/releases/tag/v1.2.0
[1.1.0]: https://github.com/zpyoung/pegasus/releases/tag/v1.1.0
[1.0.0]: https://github.com/zpyoung/pegasus/releases/tag/v1.0.0
