/**
 * POST /stash-apply endpoint - Apply or pop a stash in a worktree
 *
 * Applies a specific stash entry to the working directory.
 * Can either "apply" (keep stash) or "pop" (remove stash after applying).
 *
 * All git operations and conflict detection are delegated to StashService.
 *
 * Note: Git repository validation (isGitRepo) is handled by
 * the requireGitRepoOnly middleware in index.ts
 */

import type { Request, Response } from 'express';
import type { EventEmitter } from '../../../lib/events.js';
import { getErrorMessage, logError } from '../common.js';
import { applyOrPop } from '../../../services/stash-service.js';

export function createStashApplyHandler(events: EventEmitter) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { worktreePath, stashIndex, pop } = req.body as {
        worktreePath: string;
        stashIndex: number;
        pop?: boolean;
      };

      if (!worktreePath) {
        res.status(400).json({
          success: false,
          error: 'worktreePath required',
        });
        return;
      }

      if (stashIndex === undefined || stashIndex === null) {
        res.status(400).json({
          success: false,
          error: 'stashIndex required',
        });
        return;
      }

      const idx = typeof stashIndex === 'string' ? Number(stashIndex) : stashIndex;

      if (!Number.isInteger(idx) || idx < 0) {
        res.status(400).json({
          success: false,
          error: 'stashIndex must be a non-negative integer',
        });
        return;
      }

      // Delegate all stash apply/pop logic to the service
      const result = await applyOrPop(worktreePath, idx, { pop }, events);

      if (!result.success) {
        // applyOrPop already logs the error internally via logError — no need to double-log here
        res.status(500).json({ success: false, error: result.error });
        return;
      }

      res.json({
        success: true,
        result: {
          applied: result.applied,
          hasConflicts: result.hasConflicts,
          conflictFiles: result.conflictFiles,
          operation: result.operation,
          stashIndex: result.stashIndex,
          message: result.message,
        },
      });
    } catch (error) {
      logError(error, 'Stash apply failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
