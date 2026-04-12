---
allowed-tools:
  - Read
  - Edit
  - Bash(git tag:*)
  - Bash(git log:*)
  - Bash(git show:*)
  - Bash(git describe:*)
  - Bash(git status:*)
  - Bash(date:*)
description: Prepare the next release — auto-detect semver bump from commits since the last tag, update CHANGELOG.md and package.json versions. Does not commit or tag.
argument-hint: "[major|minor|patch]  (optional override)"
---

# /release:bump

You are a release manager preparing the next version of this project. Analyze commits since the last git tag, determine the correct semver bump, and update `CHANGELOG.md` plus the `version` field in `package.json` and `apps/ui/package.json`. **Do not commit, push, or tag** — leave the working tree dirty so the user can review the diff before running `pnpm build:electron:publish`.

## Arguments

- `$ARGUMENTS` (optional): `major` | `minor` | `patch` — forces a specific bump type, overriding auto-detection. Required to bypass the interactive confirmation for a major bump.

## Instructions

<instructions>

### Step 1: Read current state

1. Read `apps/ui/package.json` → record the current version string (e.g. `1.0.0`). This is the canonical version; the root `package.json` should match.
2. Run `git tag --list 'v*' --sort=-v:refname` and take the first line as the latest version tag (e.g. `v1.0.0`).
3. If no tag exists, abort with: `❌ No version tags found. Create an initial v<version> tag before using /release:bump.`
4. Read `CHANGELOG.md` to understand its structure and the location of existing `## [x.y.z]` sections and link references.
5. If `CHANGELOG.md` does not exist, abort with: `❌ CHANGELOG.md not found in the repo root.`

### Step 2: Gather commits since the last tag

Run:

```bash
git log <latest-tag>..HEAD --no-merges --format='%H%x09%s%x09%b%x1e'
```

The `%x1e` (record separator) lets you split commits safely even when bodies contain newlines. Parse each record into `{sha, subject, body}`.

If the commit list is empty, abort with:
`ℹ️  No new commits since <tag>. Nothing to bump.`

### Step 3: Classify commits and determine bump

For each commit, extract the conventional-commit type from the subject (`feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `build`, `ci`, `style`). Detect breaking changes via either:

- A `!` before the colon in the type (e.g. `feat!:`, `fix!:`)
- The string `BREAKING CHANGE` or `BREAKING-CHANGE` anywhere in the body

**Think step-by-step with minimal drafts (≤5 words each):**

1. Scan commits → classify types
2. Any breaking? → major
3. Any `feat:`? → minor
4. Else → patch

Override with `$ARGUMENTS` if it is exactly `major`, `minor`, or `patch`.

### Step 4: Confirm major bumps

If the detected bump is **major** AND `$ARGUMENTS` is not `major`:

1. Print a list of the breaking-change commits (SHA short + subject).
2. Ask explicitly: `⚠️  This will bump to v<NEW_MAJOR>.0.0. Proceed? (yes/no)`
3. Wait for a response. On anything other than `yes` / `y`, abort with no file changes.

### Step 5: Compute the next version

Parse the current version as `MAJOR.MINOR.PATCH`:

- **major** → `(MAJOR+1).0.0`
- **minor** → `MAJOR.(MINOR+1).0`
- **patch** → `MAJOR.MINOR.(PATCH+1)`

### Step 6: Categorize commits for the changelog

Group commits into Keep a Changelog sections, each with an emoji header and per-bullet emojis:

**Section headers:**

| Section          | Header                                                                   |
| ---------------- | ------------------------------------------------------------------------ |
| Added            | `### ✨ Added`                                                           |
| Fixed            | `### 🐛 Fixed`                                                           |
| Changed          | `### 🔄 Changed`                                                         |
| Breaking Changes | `### 💥 Breaking Changes` (only if breaking commits exist; placed first) |

**Per-bullet emoji by commit type:**

| Commit type         | Emoji | Section          |
| ------------------- | ----- | ---------------- |
| `feat:`             | ✨    | Added            |
| `feat!:` / breaking | 💥    | Breaking Changes |
| `fix:`              | 🐛    | Fixed            |
| `perf:`             | ⚡    | Fixed            |
| `refactor:`         | 🔧    | Changed          |
| `docs:`             | 📝    | Changed          |
| `build:`, `ci:`     | 🏗️    | Changed          |
| `style:`            | 🎨    | Changed          |
| `test:`             | 🧪    | Changed          |
| `chore:`            | ⚙️    | Changed          |

**Emoji fallback for non-conventional commits:** If a commit subject doesn't match a conventional-commit prefix, check for a leading emoji in the subject itself (e.g. `✨ Add feature`, `🐛 Fix bug`). Use that emoji and infer the section from the emoji mapping above. If there's no prefix and no emoji, default to ⚙️ Changed.

For each commit, write a user-facing bullet:

1. Strip the `<type>[(scope)]!?:` prefix (or leading emoji if using fallback).
2. Prefix the bullet with the appropriate emoji from the table above.
3. Capitalize the first letter of the remainder.
4. Append the short commit SHA in parentheses: `(abc1234)`.
5. Read the commit body with `git show --format='%b' --no-patch <sha>` only if the subject is too terse to stand alone — then expand the bullet into 1–2 sentences.
6. Omit cryptic internal artifacts (e.g. `loop: iteration N complete`) that wouldn't be meaningful to an external reader — log that you skipped them in the final report.

Omit a section entirely if it would be empty.

### Step 7: Update CHANGELOG.md

Insert the new version block **above** the most recent `## [x.y.z]` heading (and below the file header prose). Match the existing format exactly — em-dash (`—`, not `-`) between version and date:

```markdown
## [NEW_VERSION] — YYYY-MM-DD

### 💥 Breaking Changes

- 💥 ... (abc1234)

### ✨ Added

- ✨ ... (def5678)

### 🐛 Fixed

- 🐛 ... (ghi9012)

### 🔄 Changed

- 🔧 ... (jkl3456)

---
```

Use today's date from `date +%Y-%m-%d`. Then add a new link reference at the bottom of the file, immediately above the existing `[x.y.z]:` lines:

```markdown
[NEW_VERSION]: https://github.com/zpyoung/pegasus/releases/tag/vNEW_VERSION
```

### Step 8: Update version fields

Use `Edit` (not `Write`) to update these files, changing only the `"version"` field:

1. `package.json` (repo root)
2. `apps/ui/package.json`

Do **not** touch `libs/*/package.json` — those are internal workspace packages and their versions are irrelevant to the electron-updater flow.

### Step 9: Report

Print a summary in this exact format:

```
📦 Release prepared: v<OLD> → v<NEW> (<BUMP_TYPE>)

Commits analyzed: <N>
  ✨ Added:   <X> feat(s)
  🐛 Fixed:   <Y> fix(es)
  🔄 Changed: <Z> other

Skipped (not user-facing):
  - <sha> <subject>   [only shown if any were skipped]

Files modified:
  ✓ CHANGELOG.md       (new [<NEW>] section + link reference)
  ✓ package.json       (version: <OLD> → <NEW>)
  ✓ apps/ui/package.json (version: <OLD> → <NEW>)

Next steps:
  1. Review:  git diff CHANGELOG.md package.json apps/ui/package.json
  2. Commit:  git commit -am "chore: release v<NEW>"
  3. Publish: GH_TOKEN="$GITHUB_TOKEN" pnpm build:electron:publish
```

</instructions>

## Requirements

<requirements>
- MUST NOT commit, push, stash, or create tags
- MUST NOT run the build or publish pipeline
- MUST confirm before a major bump unless `$ARGUMENTS` is `major`
- MUST match the existing CHANGELOG.md format (Keep a Changelog, em-dash date separator, `---` section divider)
- MUST update both `package.json` (root) and `apps/ui/package.json` to the same version
- MUST abort cleanly on user rejection, leaving all files unmodified
- MUST NOT modify `libs/*/package.json`
- MUST use `Edit` (targeted edits), never `Write` (overwrite) on existing files
</requirements>

## Error handling

<error_handling>

- **No version tags exist** → abort with a clear error, suggest creating an initial tag
- **No commits since the last tag** → exit cleanly with an informational message, no changes
- **CHANGELOG.md missing** → abort, suggest running the project's doc scaffold
- **Commit subjects not in conventional-commit format** → default unknown types to `patch`, and note the ambiguity in the final report
- **User rejects a major bump** → print "Aborted, no files modified." and exit
- **`$ARGUMENTS` contains an unexpected value** → abort with: `Unknown argument '<value>'. Expected: major | minor | patch`
  </error_handling>

## Example

<example>

**Input**: `/release:bump` (no args), with commits since v1.0.0:

```
abc1234 feat: add telemetry opt-out flag
def5678 fix: resolve race condition in worktree creation
ghi9012 docs: update CHANGELOG for v1.0.0 release
```

**Expected process**:

1. Current version: `1.0.0`, latest tag: `v1.0.0`
2. Classification: 1 feat, 1 fix, 1 docs → **minor bump**
3. Next version: `1.1.0`
4. Insert `## [1.1.0] — 2026-04-12` in CHANGELOG with emoji sections
5. Update `package.json` and `apps/ui/package.json` to `1.1.0`

**Expected CHANGELOG section**:

```markdown
## [1.1.0] — 2026-04-12

### ✨ Added

- ✨ Add telemetry opt-out flag (`abc1234`)

### 🐛 Fixed

- 🐛 Resolve race condition in worktree creation (`def5678`)

### 🔄 Changed

- 📝 Update CHANGELOG for v1.0.0 release (`ghi9012`)
```

**Expected report**:

```
📦 Release prepared: v1.0.0 → v1.1.0 (minor)

Commits analyzed: 3
  ✨ Added:   1 feat(s)
  🐛 Fixed:   1 fix(es)
  🔄 Changed: 1 other

Files modified:
  ✓ CHANGELOG.md       (new [1.1.0] section + link reference)
  ✓ package.json       (version: 1.0.0 → 1.1.0)
  ✓ apps/ui/package.json (version: 1.0.0 → 1.1.0)

Next steps:
  1. Review:  git diff CHANGELOG.md package.json apps/ui/package.json
  2. Commit:  git commit -am "chore: release v1.1.0"
  3. Publish: GH_TOKEN="$GITHUB_TOKEN" pnpm build:electron:publish
```

</example>
