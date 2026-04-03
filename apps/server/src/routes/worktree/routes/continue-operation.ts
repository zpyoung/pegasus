/**
 * POST /continue-operation endpoint - Continue an in-progress merge, rebase, or cherry-pick
 *
 * After conflicts have been resolved, this endpoint continues the operation.
 * For merge: performs git commit (merge is auto-committed after conflict resolution)
 * For rebase: runs git rebase --continue
 * For cherry-pick: runs git cherry-pick --continue
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

/**
 * Check if there are still unmerged paths (unresolved conflicts)
 */
async function hasUnmergedPaths(worktreePath: string): Promise<boolean> {
  try {
    const { stdout: statusOutput } = await execAsync('git status --porcelain', {
      cwd: worktreePath,
    });
    return statusOutput.split('\n').some((line) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(line));
  } catch {
    return false;
  }
}

export function createContinueOperationHandler(events: EventEmitter) {
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

      // Check for unresolved conflicts
      if (await hasUnmergedPaths(resolvedWorktreePath)) {
        res.status(409).json({
          success: false,
          error:
            'There are still unresolved conflicts. Please resolve all conflicts before continuing.',
          hasUnresolvedConflicts: true,
        });
        return;
      }

      // Stage all resolved files first
      await execAsync('git add -A', { cwd: resolvedWorktreePath });

      // Continue the operation
      let continueCommand: string;
      switch (operation) {
        case 'merge':
          // For merge, we need to commit after resolving conflicts
          continueCommand = 'git commit --no-edit';
          break;
        case 'rebase':
          continueCommand = 'git rebase --continue';
          break;
        case 'cherry-pick':
          continueCommand = 'git cherry-pick --continue';
          break;
      }

      await execAsync(continueCommand, {
        cwd: resolvedWorktreePath,
        env: { ...process.env, GIT_EDITOR: 'true' }, // Prevent editor from opening
      });

      // Emit event
      events.emit('conflict:resolved', {
        worktreePath: resolvedWorktreePath,
        operation,
      });

      res.json({
        success: true,
        result: {
          operation,
          message: `${operation.charAt(0).toUpperCase() + operation.slice(1)} continued successfully`,
        },
      });
    } catch (error) {
      logError(error, 'Continue operation failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
