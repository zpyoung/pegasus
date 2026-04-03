/**
 * POST /stash-push endpoint - Stash changes in a worktree
 *
 * The handler only validates input, invokes the service, streams lifecycle
 * events via the EventEmitter, and sends the final JSON response.
 *
 * Git business logic is delegated to stash-service.ts.
 * Events are emitted at key lifecycle points for WebSocket subscribers.
 *
 * Note: Git repository validation (isGitRepo) is handled by
 * the requireGitRepoOnly middleware in index.ts
 */

import type { Request, Response } from 'express';
import type { EventEmitter } from '../../../lib/events.js';
import { getErrorMessage, logError } from '../common.js';
import { pushStash } from '../../../services/stash-service.js';

export function createStashPushHandler(events: EventEmitter) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { worktreePath, message, files } = req.body as {
        worktreePath: string;
        message?: string;
        files?: string[];
      };

      if (!worktreePath) {
        res.status(400).json({
          success: false,
          error: 'worktreePath required',
        });
        return;
      }

      // Emit start event so the frontend can observe progress
      events.emit('stash:start', {
        worktreePath,
        operation: 'push',
      });

      // Delegate all Git work to the service
      const result = await pushStash(worktreePath, { message, files });

      // Emit progress with stash result
      events.emit('stash:progress', {
        worktreePath,
        operation: 'push',
        stashed: result.stashed,
        branch: result.branch,
      });

      // Emit success event
      events.emit('stash:success', {
        worktreePath,
        operation: 'push',
        stashed: result.stashed,
        branch: result.branch,
      });

      res.json({
        success: true,
        result: {
          stashed: result.stashed,
          branch: result.branch,
          message: result.message,
        },
      });
    } catch (error) {
      // Emit error event so the frontend can react
      events.emit('stash:failure', {
        worktreePath: req.body?.worktreePath,
        operation: 'push',
        error: getErrorMessage(error),
      });

      logError(error, 'Stash push failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
