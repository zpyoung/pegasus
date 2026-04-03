/**
 * POST /branch-commit-log endpoint - Get recent commit history for a specific branch
 *
 * Similar to commit-log but allows specifying a branch name to get commits from
 * any branch, not just the currently checked out one. Useful for cherry-pick workflows
 * where you need to browse commits from other branches.
 *
 * The handler only validates input, invokes the service, streams lifecycle events
 * via the EventEmitter, and sends the final JSON response.
 *
 * Note: Git repository validation (isGitRepo, hasCommits) is handled by
 * the requireValidWorktree middleware in index.ts
 */

import type { Request, Response } from 'express';
import type { EventEmitter } from '../../../lib/events.js';
import { getErrorMessage, logError } from '../common.js';
import { getBranchCommitLog } from '../../../services/branch-commit-log-service.js';
import { isValidBranchName } from '@pegasus/utils';

export function createBranchCommitLogHandler(events: EventEmitter) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        worktreePath,
        branchName,
        limit = 20,
      } = req.body as {
        worktreePath: string;
        branchName?: string;
        limit?: number;
      };

      if (!worktreePath) {
        res.status(400).json({
          success: false,
          error: 'worktreePath required',
        });
        return;
      }

      // Validate branchName before forwarding to execGitCommand.
      // Reject values that start with '-', contain NUL, contain path-traversal
      // sequences, or include characters outside the safe whitelist.
      // An absent branchName is allowed (the service defaults it to HEAD).
      if (branchName !== undefined && !isValidBranchName(branchName)) {
        res.status(400).json({
          success: false,
          error: 'Invalid branchName: value contains unsafe characters or sequences',
        });
        return;
      }

      // Emit start event so the frontend can observe progress
      events.emit('branchCommitLog:start', {
        worktreePath,
        branchName: branchName || 'HEAD',
        limit,
      });

      // Delegate all Git work to the service
      const result = await getBranchCommitLog(worktreePath, branchName, limit);

      // Emit progress with the number of commits fetched
      events.emit('branchCommitLog:progress', {
        worktreePath,
        branchName: result.branch,
        commitsLoaded: result.total,
      });

      // Emit done event
      events.emit('branchCommitLog:done', {
        worktreePath,
        branchName: result.branch,
        total: result.total,
      });

      res.json({
        success: true,
        result,
      });
    } catch (error) {
      // Emit error event so the frontend can react
      events.emit('branchCommitLog:error', {
        error: getErrorMessage(error),
      });

      logError(error, 'Get branch commit log failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
