# Changelog

All notable changes to this fork of Pegasus (formerly Automaker) are documented
in this file. Format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project was bootstrapped from an open-source upstream and has diverged
substantially. The entries below describe changes relative to that upstream
baseline.

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

[1.0.0]: https://github.com/zpyoung/pegasus/releases/tag/v1.0.0
