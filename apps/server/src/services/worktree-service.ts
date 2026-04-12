/**
 * WorktreeService - File-system operations for git worktrees
 *
 * Extracted from the worktree create route to centralise file-copy logic,
 * surface errors through an EventEmitter instead of swallowing them, and
 * make the behaviour testable in isolation.
 */

import path from "path";
import fs from "fs/promises";
import { execGitCommand } from "@pegasus/git-utils";
import type { EventEmitter } from "../lib/events.js";
import type { SettingsService } from "./settings-service.js";

/**
 * Get the list of remote names that have a branch matching the given branch name.
 *
 * Uses `git for-each-ref` to check cached remote refs, returning the names of
 * any remotes that already have a branch with the same name as `currentBranch`.
 * Returns an empty array when `hasAnyRemotes` is false or when no matching
 * remote refs are found.
 *
 * This helps the UI distinguish between "branch exists on the tracking remote"
 * vs "branch was pushed to a different remote".
 *
 * @param worktreePath  - Path to the git worktree
 * @param currentBranch - Branch name to search for on remotes
 * @param hasAnyRemotes - Whether the repository has any remotes configured
 * @returns Array of remote names (e.g. ["origin", "upstream"]) that contain the branch
 */
export async function getRemotesWithBranch(
  worktreePath: string,
  currentBranch: string,
  hasAnyRemotes: boolean,
): Promise<string[]> {
  if (!hasAnyRemotes) {
    return [];
  }

  try {
    const remoteRefsOutput = await execGitCommand(
      [
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/remotes/*/${currentBranch}`,
      ],
      worktreePath,
    );

    if (!remoteRefsOutput.trim()) {
      return [];
    }

    return remoteRefsOutput
      .trim()
      .split("\n")
      .map((ref) => {
        // Extract remote name from "remote/branch" format
        const slashIdx = ref.indexOf("/");
        return slashIdx !== -1 ? ref.slice(0, slashIdx) : ref;
      })
      .filter((name) => name.length > 0);
  } catch {
    // Ignore errors - return empty array
    return [];
  }
}

/**
 * Error thrown when one or more file copy operations fail during
 * `copyConfiguredFiles`.  The caller can inspect `failures` for details.
 */
export class CopyFilesError extends Error {
  constructor(
    public readonly failures: Array<{ path: string; error: string }>,
  ) {
    super(
      `Failed to copy ${failures.length} file(s): ${failures.map((f) => f.path).join(", ")}`,
    );
    this.name = "CopyFilesError";
  }
}

/**
 * Error thrown when one or more symlink operations fail during
 * `symlinkConfiguredFiles`.  The caller can inspect `failures` for details.
 */
export class SymlinkFilesError extends Error {
  constructor(
    public readonly failures: Array<{ path: string; error: string }>,
  ) {
    super(
      `Failed to symlink ${failures.length} file(s): ${failures.map((f) => f.path).join(", ")}`,
    );
    this.name = "SymlinkFilesError";
  }
}

/**
 * WorktreeService encapsulates file-system operations that run against
 * git worktrees (e.g. copying project-configured files into a new worktree).
 *
 * All operations emit typed events so the frontend can stream progress to the
 * user.  Errors are collected and surfaced to the caller rather than silently
 * swallowed.
 */
export class WorktreeService {
  /**
   * Copy files / directories listed in the project's `worktreeCopyFiles`
   * setting from `projectPath` into `worktreePath`.
   *
   * Security: paths containing `..` segments or absolute paths are rejected.
   *
   * Events emitted via `emitter`:
   * - `worktree:copy-files:copied`  – a file or directory was successfully copied
   * - `worktree:copy-files:skipped` – a source file was not found (ENOENT)
   * - `worktree:copy-files:failed`  – an unexpected error occurred copying a file
   *
   * @throws {CopyFilesError} if any copy operation fails for a reason other
   *   than ENOENT (missing source file).
   */
  async copyConfiguredFiles(
    projectPath: string,
    worktreePath: string,
    settingsService: SettingsService | undefined,
    emitter: EventEmitter,
  ): Promise<void> {
    if (!settingsService) return;

    const projectSettings =
      await settingsService.getProjectSettings(projectPath);
    const copyFiles = projectSettings.worktreeCopyFiles;

    if (!copyFiles || copyFiles.length === 0) return;

    const failures: Array<{ path: string; error: string }> = [];

    for (const relativePath of copyFiles) {
      // Security: prevent path traversal
      const normalized = path.normalize(relativePath);
      if (normalized === "" || normalized === ".") {
        const reason = "Suspicious path rejected (empty or current-dir)";
        emitter.emit("worktree:copy-files:skipped", {
          path: relativePath,
          reason,
        });
        continue;
      }
      if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
        const reason = "Suspicious path rejected (traversal or absolute)";
        emitter.emit("worktree:copy-files:skipped", {
          path: relativePath,
          reason,
        });
        continue;
      }

      const sourcePath = path.join(projectPath, normalized);
      const destPath = path.join(worktreePath, normalized);

      try {
        // Check if source exists
        const stat = await fs.stat(sourcePath);

        // Ensure destination directory exists
        const destDir = path.dirname(destPath);
        await fs.mkdir(destDir, { recursive: true });

        if (stat.isDirectory()) {
          // Recursively copy directory
          await fs.cp(sourcePath, destPath, { recursive: true, force: true });
        } else {
          // Copy single file
          await fs.copyFile(sourcePath, destPath);
        }

        emitter.emit("worktree:copy-files:copied", {
          path: normalized,
          type: stat.isDirectory() ? "directory" : "file",
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          emitter.emit("worktree:copy-files:skipped", {
            path: normalized,
            reason: "File not found in project root",
          });
        } else {
          const errorMessage = err instanceof Error ? err.message : String(err);
          emitter.emit("worktree:copy-files:failed", {
            path: normalized,
            error: errorMessage,
          });
          failures.push({ path: normalized, error: errorMessage });
        }
      }
    }

    if (failures.length > 0) {
      throw new CopyFilesError(failures);
    }
  }

  /**
   * Symlink files / directories listed in the project's `worktreeSymlinkFiles`
   * setting from `projectPath` into `worktreePath`.
   *
   * Each symlink uses a **relative** target path so the project remains portable
   * (i.e. moving the parent directory keeps the symlinks valid).
   *
   * If symlink creation fails for any reason other than the source being missing,
   * the method falls back to copying the file and emits
   * `worktree:symlink-files:fallback-copied` so the user is informed.
   *
   * Security: paths containing `..` segments or absolute paths are rejected.
   *
   * Events emitted via `emitter`:
   * - `worktree:symlink-files:linked`         – symlink created successfully
   * - `worktree:symlink-files:skipped`         – source file not found (ENOENT)
   * - `worktree:symlink-files:fallback-copied` – symlink failed; file was copied instead
   * - `worktree:symlink-files:failed`          – both symlink and fallback copy failed
   *
   * @throws {SymlinkFilesError} if any operation fails and the copy fallback also fails.
   */
  async symlinkConfiguredFiles(
    projectPath: string,
    worktreePath: string,
    settingsService: SettingsService | undefined,
    emitter: EventEmitter,
  ): Promise<void> {
    if (!settingsService) return;

    const projectSettings =
      await settingsService.getProjectSettings(projectPath);
    const symlinkFiles = projectSettings.worktreeSymlinkFiles;

    if (!symlinkFiles || symlinkFiles.length === 0) return;

    const failures: Array<{ path: string; error: string }> = [];

    for (const relativePath of symlinkFiles) {
      // Security: prevent path traversal
      const normalized = path.normalize(relativePath);
      if (normalized === "" || normalized === ".") {
        emitter.emit("worktree:symlink-files:skipped", {
          path: relativePath,
          reason: "Suspicious path rejected (empty or current-dir)",
        });
        continue;
      }
      if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
        emitter.emit("worktree:symlink-files:skipped", {
          path: relativePath,
          reason: "Suspicious path rejected (traversal or absolute)",
        });
        continue;
      }

      const sourcePath = path.join(projectPath, normalized);
      const destPath = path.join(worktreePath, normalized);

      try {
        // Check if source exists (throws ENOENT if missing)
        const stat = await fs.stat(sourcePath);

        // Ensure destination directory exists
        const destDir = path.dirname(destPath);
        await fs.mkdir(destDir, { recursive: true });

        // Remove any existing file/symlink at the destination
        await fs.rm(destPath, { force: true, recursive: true });

        // Compute a relative symlink target so the project stays portable
        const symlinkTarget = path.relative(destDir, sourcePath);

        try {
          // Pass 'dir' type on Windows for directory symlinks; ignored on macOS/Linux
          await fs.symlink(
            symlinkTarget,
            destPath,
            stat.isDirectory() ? "dir" : "file",
          );
          emitter.emit("worktree:symlink-files:linked", {
            path: normalized,
            target: symlinkTarget,
            type: stat.isDirectory() ? "directory" : "file",
          });
        } catch (symlinkErr) {
          // Symlink failed — fall back to copying
          const symlinkErrMsg =
            symlinkErr instanceof Error
              ? symlinkErr.message
              : String(symlinkErr);
          try {
            if (stat.isDirectory()) {
              await fs.cp(sourcePath, destPath, {
                recursive: true,
                force: true,
              });
            } else {
              await fs.copyFile(sourcePath, destPath);
            }
            emitter.emit("worktree:symlink-files:fallback-copied", {
              path: normalized,
              type: stat.isDirectory() ? "directory" : "file",
              reason: `Symlink failed (${symlinkErrMsg}); copied instead`,
            });
          } catch (copyErr) {
            const copyErrMsg =
              copyErr instanceof Error ? copyErr.message : String(copyErr);
            emitter.emit("worktree:symlink-files:failed", {
              path: normalized,
              error: copyErrMsg,
            });
            failures.push({ path: normalized, error: copyErrMsg });
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          emitter.emit("worktree:symlink-files:skipped", {
            path: normalized,
            reason: "File not found in project root",
          });
        } else {
          const errorMessage = err instanceof Error ? err.message : String(err);
          emitter.emit("worktree:symlink-files:failed", {
            path: normalized,
            error: errorMessage,
          });
          failures.push({ path: normalized, error: errorMessage });
        }
      }
    }

    if (failures.length > 0) {
      throw new SymlinkFilesError(failures);
    }
  }
}
