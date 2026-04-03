/**
 * POST /abort-operation endpoint - Abort an in-progress merge, rebase, or cherry-pick
 *
 * Detects which operation (merge, rebase, or cherry-pick) is in progress
 * and aborts it, returning the repository to a clean state.
 */

import type { Request, Response } from 'express';
import path from 'path';
import * as fs from 'fs/promises';
import { getErrorMessage, logError, execAsync } from '../common.js';
import type { EventEmitter } from '../../../lib/events.js';

/**
 * Detect what type of conflict operation is currently in progress
 */
async function detectOperation(
  worktreePath: string
): Promise<'merge' | 'rebase' | 'cherry-pick' | null> {
  try {
    const { stdout: gitDirRaw } = await execAsync('git rev-parse --git-dir', {
      cwd: worktreePath,
    });
    const gitDir = path.resolve(worktreePath, gitDirRaw.trim());

    const [rebaseMergeExists, rebaseApplyExists, mergeHeadExists, cherryPickHeadExists] =
      await Promise.all([
        fs
          .access(path.join(gitDir, 'rebase-merge'))
          .then(() => true)
          .catch(() => false),
        fs
          .access(path.join(gitDir, 'rebase-apply'))
          .then(() => true)
          .catch(() => false),
        fs
          .access(path.join(gitDir, 'MERGE_HEAD'))
          .then(() => true)
          .catch(() => false),
        fs
          .access(path.join(gitDir, 'CHERRY_PICK_HEAD'))
          .then(() => true)
          .catch(() => false),
      ]);

    if (rebaseMergeExists || rebaseApplyExists) return 'rebase';
    if (mergeHeadExists) return 'merge';
    if (cherryPickHeadExists) return 'cherry-pick';
    return null;
  } catch {
    return null;
  }
}

export function createAbortOperationHandler(events: EventEmitter) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { worktreePath } = req.body as {
        worktreePath: string;
      };

      if (!worktreePath) {
        res.status(400).json({
          success: false,
          error: 'worktreePath is required',
        });
        return;
      }

      const resolvedWorktreePath = path.resolve(worktreePath);

      // Detect what operation is in progress
      const operation = await detectOperation(resolvedWorktreePath);

      if (!operation) {
        res.status(400).json({
          success: false,
          error: 'No merge, rebase, or cherry-pick in progress',
        });
        return;
      }

      // Abort the operation
      let abortCommand: string;
      switch (operation) {
        case 'merge':
          abortCommand = 'git merge --abort';
          break;
        case 'rebase':
          abortCommand = 'git rebase --abort';
          break;
        case 'cherry-pick':
          abortCommand = 'git cherry-pick --abort';
          break;
      }

      await execAsync(abortCommand, { cwd: resolvedWorktreePath });

      // Emit event
      events.emit('conflict:aborted', {
        worktreePath: resolvedWorktreePath,
        operation,
      });

      res.json({
        success: true,
        result: {
          operation,
          message: `${operation.charAt(0).toUpperCase() + operation.slice(1)} aborted successfully`,
        },
      });
    } catch (error) {
      logError(error, 'Abort operation failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
