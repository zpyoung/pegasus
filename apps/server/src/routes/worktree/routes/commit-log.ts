/**
 * POST /commit-log endpoint - Get recent commit history for a worktree
 *
 * The handler only validates input, invokes the service, streams lifecycle
 * events via the EventEmitter, and sends the final JSON response.
 *
 * Git business logic is delegated to commit-log-service.ts.
 * Events are emitted at key lifecycle points for WebSocket subscribers.
 *
 * Note: Git repository validation (isGitRepo, hasCommits) is handled by
 * the requireValidWorktree middleware in index.ts
 */

import type { Request, Response } from 'express';
import type { EventEmitter } from '../../../lib/events.js';
import { getErrorMessage, logError } from '../common.js';
import { getCommitLog } from '../../../services/commit-log-service.js';

export function createCommitLogHandler(events: EventEmitter) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { worktreePath, limit = 20 } = req.body as {
        worktreePath: string;
        limit?: number;
      };

      if (!worktreePath) {
        res.status(400).json({
          success: false,
          error: 'worktreePath required',
        });
        return;
      }

      // Emit start event so the frontend can observe progress
      events.emit('commitLog:start', {
        worktreePath,
        limit,
      });

      // Delegate all Git work to the service
      const result = await getCommitLog(worktreePath, limit);

      // Emit progress with the number of commits fetched
      events.emit('commitLog:progress', {
        worktreePath,
        branch: result.branch,
        commitsLoaded: result.total,
      });

      // Emit complete event
      events.emit('commitLog:complete', {
        worktreePath,
        branch: result.branch,
        total: result.total,
      });

      res.json({
        success: true,
        result,
      });
    } catch (error) {
      // Emit error event so the frontend can react
      events.emit('commitLog:error', {
        error: getErrorMessage(error),
      });

      logError(error, 'Get commit log failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
