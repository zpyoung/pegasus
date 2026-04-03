/**
 * POST /push endpoint - Push a worktree branch to remote
 *
 * Git business logic is delegated to push-service.ts.
 *
 * Note: Git repository validation (isGitRepo, hasCommits) is handled by
 * the requireValidWorktree middleware in index.ts
 */

import type { Request, Response } from 'express';
import { getErrorMessage, logError } from '../common.js';
import { performPush } from '../../../services/push-service.js';

export function createPushHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { worktreePath, force, remote, autoResolve } = req.body as {
        worktreePath: string;
        force?: boolean;
        remote?: string;
        autoResolve?: boolean;
      };

      if (!worktreePath) {
        res.status(400).json({
          success: false,
          error: 'worktreePath required',
        });
        return;
      }

      const result = await performPush(worktreePath, { remote, force, autoResolve });

      if (!result.success) {
        const statusCode = isClientError(result.error ?? '') ? 400 : 500;
        res.status(statusCode).json({
          success: false,
          error: result.error,
          diverged: result.diverged,
          hasConflicts: result.hasConflicts,
          conflictFiles: result.conflictFiles,
        });
        return;
      }

      res.json({
        success: true,
        result: {
          branch: result.branch,
          pushed: result.pushed,
          diverged: result.diverged,
          autoResolved: result.autoResolved,
          message: result.message,
        },
      });
    } catch (error) {
      logError(error, 'Push worktree failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}

/**
 * Determine whether an error message represents a client error (400)
 * vs a server error (500).
 */
function isClientError(errorMessage: string): boolean {
  return (
    errorMessage.includes('detached HEAD') ||
    errorMessage.includes('rejected') ||
    errorMessage.includes('diverged')
  );
}
