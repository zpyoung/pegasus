# Git Worktree Lifecycle in Pegasus

## Overview

Pegasus uses [git worktrees](https://git-scm.com/docs/git-worktree) to give each feature branch its own isolated working directory. When an AI agent implements a feature, it runs entirely in a separate directory (the worktree) without touching the main working tree. This means multiple features can be in progress simultaneously without conflicts, and the main branch always stays in a clean, usable state.

---

## Why Worktrees?

- **Isolation**: Each feature branch has its own filesystem. File changes in one worktree cannot affect another.
- **No stashing required**: Developers and agents can switch between features instantly without stashing or committing work-in-progress.
- **Parallel development**: Multiple AI agents can execute on different features at the same time in separate worktrees.
- **Main branch integrity**: The main project directory remains on the base branch and is never interrupted by agent execution.

---

## Directory Layout

Worktrees are created inside the project directory under `.worktrees/`:

```
<projectPath>/
├── .worktrees/           # All feature worktrees live here
│   ├── my-feature/       # Worktree for branch "my-feature"
│   └── fix-bug-123/      # Worktree for branch "fix-bug-123"
├── .pegasus/             # Pegasus data (always in the main worktree)
│   ├── features/         # Feature metadata and agent output
│   ├── worktrees/        # Per-worktree metadata (worktree.json files)
│   │   └── my-feature/
│   │       └── worktree.json
│   └── worktree-init.sh  # Optional init script
└── ... (main project files)
```

The `.pegasus/` directory is always written to the **main worktree** (`projectPath`), never to a feature worktree. This avoids symlink loop issues and ensures all features share the same metadata.

---

## Worktree Lifecycle

### 1. Creation

**API endpoint**: `POST /worktrees/create`

The creation flow:

1. **Validate inputs** — branch name characters are checked against `[a-zA-Z0-9._/-]` to prevent injection.
2. **Check for existing worktree** — if a worktree already exists for the branch (from any previous run), it is returned as-is (`isNew: false`). This is idempotent.
3. **Fetch all remotes** — `git fetch --all --quiet` runs with a 30-second timeout to ensure remote refs are current.
4. **Sync the base branch** — the base branch is fast-forwarded from its remote tracking branch before creating the new worktree. If the branch has diverged, creation continues with a warning.
5. **Create the worktree directory** — the path is `<projectPath>/.worktrees/<sanitized-branch-name>` where the sanitized name replaces non-`[a-zA-Z0-9_-]` characters with dashes.
6. **Check if branch exists** — if the branch already exists locally, the worktree uses it (`git worktree add <path> <branch>`). Otherwise a new branch is created from the base (`git worktree add -b <branch> <path> <base>`).
7. **Copy configured files** — files listed in project settings under `worktreeCopyFiles` are copied from the project root into the worktree.
8. **Symlink configured files** — files listed under `worktreeSymlinkFiles` are symlinked into the worktree using relative symlink targets so the project remains portable. If symlink creation fails, a copy is made as fallback.
9. **Track the branch** — the branch is registered so it persists in the UI even after the worktree is removed.
10. **Respond immediately** — the HTTP response is returned before the init script runs.
11. **Run init script** (asynchronous) — if `.pegasus/worktree-init.sh` exists and has not yet run for this branch, it executes in the background.

**Request body:**
```json
{
  "projectPath": "/absolute/path/to/project",
  "branchName": "feature/my-feature",
  "baseBranch": "main"
}
```

**Response:**
```json
{
  "success": true,
  "worktree": {
    "path": "/absolute/path/to/project/.worktrees/feature-my-feature",
    "branch": "feature/my-feature",
    "isNew": true,
    "baseCommitHash": "a1b2c3d",
    "syncResult": {
      "synced": true,
      "remote": "origin",
      "message": "Fast-forwarded main to origin/main"
    }
  }
}
```

---

### 2. Listing Worktrees

**API endpoint**: `POST /worktrees/list`

Returns all active git worktrees for a project.

The list handler:

1. Runs `git worktree list --porcelain` and parses the output.
2. Checks whether each worktree directory actually exists on disk. Missing directories are pruned via `git worktree prune`.
3. Scans `.worktrees/` for directories not registered with git (externally created worktrees or corrupted state).
4. For worktrees in detached HEAD state (e.g., during a rebase), attempts to recover the branch name from git state files (`rebase-merge/head-name`, `rebase-apply/head-name`).
5. When `includeDetails: true` is passed, fetches `git status` for each worktree to report `hasChanges` and `changedFilesCount`, and runs conflict detection to report `hasConflicts`, `conflictType`, and `conflictFiles`.
6. Fetches GitHub PR status via `gh pr list` (cached for 2 minutes) and cross-references with locally stored metadata, preferring explicit user overrides over auto-detected branch PRs.

**Request body:**
```json
{
  "projectPath": "/absolute/path/to/project",
  "includeDetails": true
}
```

---

### 3. Worktree Status

**API endpoint**: `POST /worktrees/status`

Returns the git status for a specific worktree, identified by `featureId`. The `featureId` is sanitized the same way as the branch name during creation (non-`[a-zA-Z0-9_-]` characters replaced with dashes) to derive the worktree path.

**Response fields:**
- `modifiedFiles` — count of changed files
- `files` — list of changed file paths
- `diffStat` — output of `git diff --stat`
- `recentCommits` — last 5 commits from `git log --oneline`

---

### 4. Committing Changes

**API endpoint**: `POST /worktrees/commit`

Stages and commits changes in a worktree.

- If `files` is provided, only those specific files are staged.
- Otherwise all changes are staged with `git add -A`.
- The message is passed as a direct argument to avoid shell injection.

**Request body:**
```json
{
  "worktreePath": "/path/to/worktree",
  "message": "feat: implement user authentication",
  "files": ["src/auth.ts", "src/auth.test.ts"]
}
```

---

### 5. Merging

**API endpoint**: `POST /worktrees/merge`

Merges a feature branch into a target branch (defaults to `main`).

The merge service (`merge-service.ts`) uses two strategies:

**Strategy 1: Target branch is checked out in a worktree**
Runs `git merge` directly in that worktree. Supports `--squash` and custom commit messages.

**Strategy 2: Target branch is not checked out anywhere**
Uses git plumbing commands entirely in the object store without any checkout:
- `git merge-tree --write-tree` to compute the merged tree
- `git commit-tree` to create the merge commit
- `git update-ref` to advance the target branch ref

Both strategies fetch from the remote before merging (`git fetch <remote>`).

**Conflict detection** uses three independent layers:
1. Text matching on error output for `CONFLICT` and `Automatic merge failed` (with `LC_ALL=C` for locale safety).
2. `git diff --name-only --diff-filter=U` to find unmerged paths.
3. `git status --porcelain` checking for unmerged status codes (`UU`, `AA`, `DD`, `AU`, `UA`, `DU`, `UD`).

When `deleteWorktreeAndBranch: true` is passed, the worktree and its branch are removed after a successful merge using `git worktree remove --force` followed by `git branch -D`. Main and master branches are never deleted.

**Request body:**
```json
{
  "projectPath": "/path/to/project",
  "branchName": "feature/my-feature",
  "worktreePath": "/path/to/worktree",
  "targetBranch": "main",
  "options": {
    "squash": false,
    "message": "Merge feature/my-feature into main",
    "deleteWorktreeAndBranch": true,
    "remote": "origin"
  }
}
```

**Conflict response (HTTP 409):**
```json
{
  "success": false,
  "hasConflicts": true,
  "conflictFiles": ["src/api.ts", "src/routes.ts"]
}
```

---

### 6. Rebasing

**API endpoint**: `POST /worktrees/rebase`

Rebases the current branch in a worktree onto a target branch (e.g., `origin/main`).

The rebase service (`rebase-service.ts`):
1. Validates the `ontoBranch` name — rejects empty strings and dash-prefixed names.
2. Fetches from the configured remote before rebasing.
3. Runs `git rebase -- <ontoBranch>` with `LC_ALL=C` for consistent English output.
4. On failure, uses three-layer conflict detection:
   - Text matching for `CONFLICT`, `could not apply`, `fix conflicts`
   - Presence of `.git/rebase-merge` or `.git/rebase-apply` directories
   - `git status --porcelain` checking for unmerged status codes
5. If conflicts are detected, aborts the rebase (`git rebase --abort`) and returns the list of conflicted files. This leaves the repository in a clean state.

**Request body:**
```json
{
  "worktreePath": "/path/to/worktree",
  "ontoBranch": "origin/main",
  "remote": "origin"
}
```

---

### 7. Cherry-Pick

**API endpoint**: `POST /worktrees/cherry-pick`

Applies one or more commits to the current branch of a worktree.

- All commit hashes are verified with `git rev-parse --verify` before the operation begins.
- Supports `noCommit` option to stage changes without creating a commit.
- On conflict, the cherry-pick is aborted (`git cherry-pick --abort`).

**Request body:**
```json
{
  "worktreePath": "/path/to/worktree",
  "commitHashes": ["a1b2c3d", "e4f5g6h"],
  "options": { "noCommit": false }
}
```

---

### 8. Aborting and Continuing Operations

**Abort**: `POST /worktrees/abort-operation`

Detects the type of in-progress operation (merge, rebase, or cherry-pick) by checking for git state files/directories:
- `MERGE_HEAD` → merge in progress
- `rebase-merge/` or `rebase-apply/` → rebase in progress
- `CHERRY_PICK_HEAD` → cherry-pick in progress

Then runs the appropriate abort command (`git merge --abort`, `git rebase --abort`, or `git cherry-pick --abort`).

**Continue**: `POST /worktrees/continue-operation`

After manually resolving conflicts, stages the resolved files and runs the appropriate continue command.

---

### 9. Deletion

**API endpoint**: `POST /worktrees/delete`

Removes a worktree and optionally deletes its branch.

The deletion flow:
1. Records the branch name before removing the directory.
2. Runs `git worktree remove <path> --force`.
3. If that fails (directory already manually deleted or bad state), falls back to `git worktree prune` and verifies the worktree is no longer listed.
4. If `deleteBranch: true` is set and the branch is not `main` or `master`, runs `git branch -D <branch>`.
5. Emits a `worktree:deleted` WebSocket event.
6. Migrates any features associated with the deleted branch back to the main worktree by setting their `branchName` to `null`.

**Request body:**
```json
{
  "projectPath": "/path/to/project",
  "worktreePath": "/path/to/worktree",
  "deleteBranch": true
}
```

---

## Branch Naming

Branch names must match `[a-zA-Z0-9._/-]` (validated by `isValidBranchName`). Forward slashes are allowed for namespacing (e.g., `feature/my-feature`).

When creating a worktree directory, the branch name is further sanitized for filesystem use: all characters outside `[a-zA-Z0-9_-]` are replaced with dashes. So `feature/my-feature` becomes the directory name `feature-my-feature`.

---

## Branch Switching

**API endpoint**: `POST /worktrees/switch-branch`

Switches the branch of an existing worktree with automatic stash management.

The workflow (`worktree-branch-service.ts`):

1. Fetches from all remotes (30-second timeout, non-fatal on failure).
2. Determines if the target is a remote branch (e.g., `origin/feature`) using `git branch -r`.
3. Returns immediately if already on the target branch.
4. Stashes uncommitted changes with the message `pegasus-branch-switch: <from> → <to>`.
5. Checks out the target branch. For remote branches, creates a local tracking branch if one does not exist.
6. Pops the stash. If conflicts occur during stash pop, returns `hasConflicts: true` with a message asking the user to resolve them.
7. On checkout failure, attempts to restore the stash to the original branch state.

---

## Worktree Metadata

Metadata for each worktree is stored at:

```
<projectPath>/.pegasus/worktrees/<sanitized-branch>/worktree.json
```

Branch names are sanitized for filesystem safety:
- Characters `/ \ : * ? " < > |` are replaced with dashes
- Spaces become underscores
- Trailing dots are removed
- Multiple consecutive dashes are collapsed
- Windows reserved names (`CON`, `PRN`, `AUX`, etc.) get a `_` prefix
- Names are truncated to 200 characters

The `WorktreeMetadata` structure:

```typescript
interface WorktreeMetadata {
  branch: string;
  createdAt: string;       // ISO 8601 timestamp
  pr?: WorktreePRInfo;     // Associated GitHub PR info
  initScriptRan?: boolean; // Whether the init script has run
  initScriptStatus?: 'running' | 'success' | 'failed';
  initScriptError?: string;
}
```

Metadata is read/written via the functions in `apps/server/src/lib/worktree-metadata.ts`:
- `readWorktreeMetadata(projectPath, branch)` — reads a single entry
- `writeWorktreeMetadata(projectPath, branch, metadata)` — writes a single entry
- `readAllWorktreeMetadata(projectPath)` — reads all entries into a `Map<string, WorktreeMetadata>`
- `deleteWorktreeMetadata(projectPath, branch)` — removes the metadata directory for a branch
- `updateWorktreePRInfo(projectPath, branch, prInfo)` — updates only the PR fields

---

## Init Scripts

When a worktree is created, Pegasus looks for `.pegasus/worktree-init.sh` in the project root. If the file exists and has not already run for the branch (tracked in `worktree.json`), it executes asynchronously after the HTTP response is returned.

The script runs with the worktree as its working directory and receives these environment variables:

| Variable | Description |
|---|---|
| `PEGASUS_PROJECT_PATH` | Absolute path to the main project root |
| `PEGASUS_WORKTREE_PATH` | Absolute path to the new worktree |
| `PEGASUS_BRANCH` | Branch name for this worktree |
| `PATH`, `HOME`, `USER` | Standard system variables |
| `FORCE_COLOR`, `CLICOLOR_FORCE` | Force color output in terminals |
| `GIT_TERMINAL_PROMPT` | Set to `0` to prevent interactive git prompts |

Sensitive variables such as `ANTHROPIC_API_KEY` are intentionally not passed to the init script.

**Shell selection:**
- On Windows: Git Bash is preferred over WSL bash to avoid compatibility issues.
- On Unix: `/bin/bash` or `/bin/sh` from `getShellPaths()`.

The init script is run only once per branch. Status (`running`, `success`, `failed`) and any error message are written to `worktree.json`. To re-run the script, use:

`POST /worktrees/run-init-script`

with `projectPath`, `worktreePath`, and `branch` in the request body.

**Example init script** (from `docs/worktree-init-script-example.sh`):

```bash
#!/bin/bash
echo "Branch: $(git branch --show-current)"

if [ -f "package.json" ]; then
    pnpm install || exit 1
fi
```

WebSocket events emitted during init script execution:
- `worktree:init-started` — script has begun
- `worktree:init-output` — streaming stdout/stderr lines
- `worktree:init-completed` — script finished (includes `success`, `exitCode`)

---

## Dev Server Management

Each worktree can run its own isolated dev server on a dynamically allocated port.

**Start**: `POST /worktrees/start-dev`
**Stop**: `POST /worktrees/stop-dev`
**List**: `POST /worktrees/list-dev-servers`
**Logs**: `GET /worktrees/dev-server-logs?worktreePath=...`

If `devCommand` is configured in project settings, that command is used. Otherwise Pegasus auto-detects the package manager (`pnpm`, `yarn`, `npm`, `bun`) and runs `<pm> run dev`.

The dev server service (`dev-server-service.ts`) scans process output for a URL using a prioritized pattern list:
1. Vite / Nuxt / SvelteKit / Astro / Angular: `Local: http://...`
2. Next.js: `ready - started server on ..., url: http://...`
3. Generic: `listening at http://...`, `running at http://...`
4. PHP built-in server, Webpack Dev Server, Go/Rust generic formats
5. Any `http://localhost:<port>` or `http://127.0.0.1:<port>` URL

If no URL is detected within 30 seconds, the allocated port is returned as a fallback.

---

## Stash Operations

Four stash endpoints operate within a worktree:

| Endpoint | Description |
|---|---|
| `POST /worktrees/stash-push` | Create a stash; include untracked files by default |
| `POST /worktrees/stash-list` | List all stashes with metadata and file lists |
| `POST /worktrees/stash-apply` | Apply or pop a stash entry; detects conflicts |
| `POST /worktrees/stash-drop` | Delete a stash entry by index |

Stash push uses `execGitCommandWithLockRetry` to handle `index.lock` contention automatically.

Stash apply/pop uses two conflict detection layers: text matching on command output, and an explicit check after the command exits (some git versions exit 0 even when conflicts occur).

---

## Conflict Detection

Conflict detection is used during the `list` endpoint's `includeDetails` pass and during merge/rebase/cherry-pick operations. It checks for git state files in the worktree's `.git` directory:

| File/directory | Operation |
|---|---|
| `MERGE_HEAD` | Merge in progress |
| `rebase-merge/` | Rebase in progress (interactive or otherwise) |
| `rebase-apply/` | Rebase in progress (patch-apply mode) |
| `CHERRY_PICK_HEAD` | Cherry-pick in progress |

The source branch involved in the conflict is resolved:
- **Merge**: `MERGE_HEAD` is looked up with `git name-rev --refs=refs/heads/*`.
- **Rebase**: `rebase-merge/onto-name` or `rebase-apply/onto-name` is read directly.
- **Cherry-pick**: `CHERRY_PICK_HEAD` is looked up with `git name-rev`.

During a rebase, git detaches HEAD. Pegasus recovers the original branch name by reading `rebase-merge/head-name` or `rebase-apply/head-name`, ensuring the worktree remains visible in the UI even while the rebase is paused on conflicts.

---

## Integration with the Feature System

Features in Pegasus have a `branchName` field that associates them with a worktree. When an agent is launched on a feature, Pegasus:

1. Calls `POST /worktrees/create` to ensure the worktree exists.
2. Runs the agent in the worktree directory.
3. The agent commits its changes to the worktree's branch.

When a worktree is deleted, any features whose `branchName` matched are moved back to the main worktree by setting `branchName: null`. This prevents features from being orphaned.

The `.pegasus/` data directory is always in the main worktree. The feature JSON files, agent output, and images under `.pegasus/features/` are never written to a feature worktree.

---

## API Endpoint Reference

All endpoints are mounted under `/worktrees`. All `POST` endpoints accept and return JSON.

| Method | Path | Description |
|---|---|---|
| `POST` | `/worktrees/create` | Create a new worktree for a branch |
| `POST` | `/worktrees/delete` | Remove a worktree and optionally its branch |
| `POST` | `/worktrees/list` | List all active worktrees |
| `POST` | `/worktrees/info` | Get info about a single worktree |
| `POST` | `/worktrees/status` | Get git status for a worktree |
| `POST` | `/worktrees/commit` | Stage and commit changes |
| `POST` | `/worktrees/merge` | Merge a branch into a target branch |
| `POST` | `/worktrees/rebase` | Rebase current branch onto a target |
| `POST` | `/worktrees/cherry-pick` | Cherry-pick commits onto current branch |
| `POST` | `/worktrees/abort-operation` | Abort merge/rebase/cherry-pick |
| `POST` | `/worktrees/continue-operation` | Continue after resolving conflicts |
| `POST` | `/worktrees/push` | Push current branch to remote |
| `POST` | `/worktrees/pull` | Pull latest from remote |
| `POST` | `/worktrees/sync` | Sync branch with remote |
| `POST` | `/worktrees/switch-branch` | Switch branch with auto-stash |
| `POST` | `/worktrees/checkout-branch` | Checkout a branch |
| `POST` | `/worktrees/list-branches` | List local and remote branches |
| `POST` | `/worktrees/set-tracking` | Set remote tracking for a branch |
| `POST` | `/worktrees/diffs` | Get file diffs for a worktree |
| `POST` | `/worktrees/file-diff` | Get diff for a single file |
| `POST` | `/worktrees/stage-files` | Stage or unstage specific files |
| `POST` | `/worktrees/discard-changes` | Discard uncommitted changes |
| `POST` | `/worktrees/check-changes` | Check if there are uncommitted changes |
| `POST` | `/worktrees/commit-log` | Get recent commits for a worktree |
| `POST` | `/worktrees/branch-commit-log` | Get commits for a specific branch |
| `POST` | `/worktrees/generate-commit-message` | AI-generated commit message |
| `POST` | `/worktrees/create-pr` | Create a GitHub pull request |
| `POST` | `/worktrees/pr-info` | Get PR info for a branch |
| `POST` | `/worktrees/update-pr-number` | Manually link a PR number |
| `POST` | `/worktrees/generate-pr-description` | AI-generated PR description |
| `POST` | `/worktrees/stash-push` | Create a stash |
| `POST` | `/worktrees/stash-list` | List stash entries |
| `POST` | `/worktrees/stash-apply` | Apply or pop a stash |
| `POST` | `/worktrees/stash-drop` | Delete a stash entry |
| `POST` | `/worktrees/start-dev` | Start a dev server for a worktree |
| `POST` | `/worktrees/stop-dev` | Stop a dev server |
| `POST` | `/worktrees/list-dev-servers` | List running dev servers |
| `GET` | `/worktrees/dev-server-logs` | Stream dev server logs |
| `POST` | `/worktrees/start-tests` | Start the test runner |
| `POST` | `/worktrees/stop-tests` | Stop the test runner |
| `GET` | `/worktrees/test-logs` | Stream test logs |
| `GET` | `/worktrees/init-script` | Read the init script content |
| `PUT` | `/worktrees/init-script` | Write or update the init script |
| `DELETE` | `/worktrees/init-script` | Delete the init script |
| `POST` | `/worktrees/run-init-script` | Force re-run the init script |
| `POST` | `/worktrees/list-remotes` | List configured remotes |
| `POST` | `/worktrees/add-remote` | Add a remote |
| `POST` | `/worktrees/open-in-editor` | Open worktree in configured editor |
| `POST` | `/worktrees/open-in-terminal` | Open worktree in terminal |
| `POST` | `/worktrees/open-in-external-terminal` | Open in external terminal app |
| `POST` | `/worktrees/init-git` | Initialize a git repository |

---

## WebSocket Events

Server operations emit events to WebSocket subscribers for real-time UI updates.

| Event | Emitted by |
|---|---|
| `worktree:deleted` | Delete handler |
| `worktree:init-started` | Init script service |
| `worktree:init-output` | Init script service (streaming) |
| `worktree:init-completed` | Init script service |
| `worktree:copy-files:copied` | WorktreeService.copyConfiguredFiles |
| `worktree:copy-files:skipped` | WorktreeService.copyConfiguredFiles |
| `worktree:copy-files:failed` | WorktreeService.copyConfiguredFiles |
| `worktree:symlink-files:linked` | WorktreeService.symlinkConfiguredFiles |
| `worktree:symlink-files:skipped` | WorktreeService.symlinkConfiguredFiles |
| `worktree:symlink-files:fallback-copied` | WorktreeService.symlinkConfiguredFiles |
| `worktree:symlink-files:failed` | WorktreeService.symlinkConfiguredFiles |
| `merge:start` | MergeService |
| `merge:success` | MergeService |
| `merge:conflict` | MergeService |
| `merge:error` | MergeService |
| `rebase:started` | Rebase handler |
| `rebase:success` | Rebase handler |
| `rebase:conflict` | Rebase handler |
| `rebase:failure` | Rebase handler |
| `cherry-pick:started` | CherryPickService |
| `cherry-pick:success` | CherryPickService |
| `cherry-pick:conflict` | CherryPickService |
| `cherry-pick:abort` | CherryPickService |
| `conflict:aborted` | Abort handler |
| `switch:start` | WorktreeBranchService |
| `switch:stash` | WorktreeBranchService |
| `switch:checkout` | WorktreeBranchService |
| `switch:pop` | WorktreeBranchService |
| `switch:done` | WorktreeBranchService |
| `switch:error` | WorktreeBranchService |
| `stash:start` | StashService |
| `stash:progress` | StashService |
| `stash:conflicts` | StashService |
| `stash:success` | StashService |
| `stash:failure` | StashService |
| `feature:migrated` | Delete handler |

---

## Security Notes

- All branch names and file paths are validated before use.
- Git commands are called using array arguments (not shell strings) to prevent injection. The `execGitCommand` function from `@pegasus/git-utils` enforces this.
- File operations go through `secure-fs.ts` which enforces `ALLOWED_ROOT_DIRECTORY` restrictions.
- Init scripts run in a sandboxed environment with only safe environment variables. API keys and credentials from the server process are not forwarded.
- Path traversal is rejected: any path starting with `..` or using an absolute path in the `worktreeCopyFiles` or `worktreeSymlinkFiles` settings is skipped with a logged warning.
