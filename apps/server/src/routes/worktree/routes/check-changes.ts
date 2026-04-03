/**
 * POST /check-changes endpoint - Check for uncommitted changes in a worktree
 *
 * Returns a summary of staged, unstaged, and untracked files to help
 * the user decide whether to stash before a branch operation.
 *
 * Note: Git repository validation (isGitRepo) is handled by
 * the requireGitRepoOnly middleware in index.ts
 */

import type { Request, Response } from 'express';
import { getErrorMessage, logError } from '../common.js';
import { execGitCommand } from '../../../lib/git.js';

/**
 * Parse `git status --porcelain` output into categorised file lists.
 *
 * Porcelain format gives two status characters per line:
 *   XY filename
 * where X is the index (staged) status and Y is the worktree (unstaged) status.
 *
 *  - '?' in both columns → untracked
 *  - Non-space/non-'?' in X → staged change
 *  - Non-space/non-'?' in Y (when not untracked) → unstaged change
 *
 * A file can appear in both staged and unstaged if it was partially staged.
 */
function parseStatusOutput(stdout: string): {
  staged: string[];
  unstaged: string[];
  untracked: string[];
} {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  const lines = stdout.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    if (line.length < 3) continue;

    const x = line[0]; // index status
    const y = line[1]; // worktree status
    // Handle renames which use " -> " separator
    const rawPath = line.slice(3);
    const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ')[1] : rawPath;

    if (x === '?' && y === '?') {
      untracked.push(filePath);
    } else {
      if (x !== ' ' && x !== '?') {
        staged.push(filePath);
      }
      if (y !== ' ' && y !== '?') {
        unstaged.push(filePath);
      }
    }
  }

  return { staged, unstaged, untracked };
}

export function createCheckChangesHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { worktreePath } = req.body as {
        worktreePath: string;
      };

      if (!worktreePath) {
        res.status(400).json({
          success: false,
          error: 'worktreePath required',
        });
        return;
      }

      // Get porcelain status (includes staged, unstaged, and untracked files)
      const stdout = await execGitCommand(['status', '--porcelain'], worktreePath);

      const { staged, unstaged, untracked } = parseStatusOutput(stdout);

      const hasChanges = staged.length > 0 || unstaged.length > 0 || untracked.length > 0;

      // Deduplicate file paths across staged, unstaged, and untracked arrays
      // to avoid double-counting partially staged files
      const uniqueFilePaths = new Set([...staged, ...unstaged, ...untracked]);

      res.json({
        success: true,
        result: {
          hasChanges,
          staged,
          unstaged,
          untracked,
          totalFiles: uniqueFilePaths.size,
        },
      });
    } catch (error) {
      logError(error, 'Check changes failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
