/**
 * stageFilesService - Path validation and git staging/unstaging operations
 *
 * Extracted from createStageFilesHandler to centralise path canonicalization,
 * path-traversal validation, and git invocation so they can be tested and
 * reused independently of the HTTP layer.
 */

import path from 'path';
import fs from 'fs/promises';
import { execGitCommand } from '../lib/git.js';

/**
 * Result returned by `stageFiles` on success.
 */
export interface StageFilesResult {
  operation: string;
  filesCount: number;
}

/**
 * Error thrown when one or more file paths fail validation (e.g. absolute
 * paths, path-traversal attempts, or paths that resolve outside the worktree
 * root, or when the worktree path itself does not exist).
 *
 * Handlers can catch this to return an HTTP 400 response instead of 500.
 */
export class StageFilesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageFilesValidationError';
  }
}

/**
 * Resolve the canonical path of the worktree root, validate every file path
 * against it to prevent path-traversal attacks, and then invoke the
 * appropriate git command (`add` or `reset`) to stage or unstage the files.
 *
 * @param worktreePath - Absolute path to the git worktree root directory.
 * @param files        - Relative file paths to stage or unstage.
 * @param operation    - `'stage'` runs `git add`, `'unstage'` runs `git reset HEAD`.
 *
 * @returns An object containing the operation name and the number of files
 *          that were staged/unstaged.
 *
 * @throws {StageFilesValidationError} When `worktreePath` is inaccessible or
 *   any entry in `files` fails the path-traversal checks.
 * @throws {Error} When the underlying git command fails.
 */
export async function stageFiles(
  worktreePath: string,
  files: string[],
  operation: 'stage' | 'unstage'
): Promise<StageFilesResult> {
  // Canonicalize the worktree root by resolving symlinks so that
  // path-traversal checks are reliable even when symlinks are involved.
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(worktreePath);
  } catch {
    throw new StageFilesValidationError('worktreePath does not exist or is not accessible');
  }

  // Validate and sanitize each file path to prevent path traversal attacks.
  // Each file entry is resolved against the canonicalized worktree root and
  // must remain within that root directory.
  const base = canonicalRoot + path.sep;
  const sanitizedFiles: string[] = [];
  for (const file of files) {
    // Reject empty or whitespace-only paths — path.resolve(canonicalRoot, '')
    // returns canonicalRoot itself, so without this guard an empty string would
    // pass all subsequent checks and be forwarded to git unchanged.
    if (file.trim() === '') {
      throw new StageFilesValidationError(
        'Invalid file path (empty or whitespace-only paths not allowed)'
      );
    }
    // Reject absolute paths
    if (path.isAbsolute(file)) {
      throw new StageFilesValidationError(
        `Invalid file path (absolute paths not allowed): ${file}`
      );
    }
    // Reject entries containing '..'
    if (file.includes('..')) {
      throw new StageFilesValidationError(
        `Invalid file path (path traversal not allowed): ${file}`
      );
    }
    // Resolve the file path against the canonicalized worktree root and
    // ensure the result stays within the worktree directory.
    const resolved = path.resolve(canonicalRoot, file);
    if (resolved !== canonicalRoot && !resolved.startsWith(base)) {
      throw new StageFilesValidationError(
        `Invalid file path (outside worktree directory): ${file}`
      );
    }
    // Forward only the original relative path to git — git interprets
    // paths relative to its working directory (canonicalRoot / worktreePath),
    // so we do not need to pass the resolved absolute path.
    sanitizedFiles.push(file);
  }

  if (operation === 'stage') {
    // Stage the specified files
    await execGitCommand(['add', '--', ...sanitizedFiles], worktreePath);
  } else {
    // Unstage the specified files
    await execGitCommand(['reset', 'HEAD', '--', ...sanitizedFiles], worktreePath);
  }

  return {
    operation,
    filesCount: sanitizedFiles.length,
  };
}
