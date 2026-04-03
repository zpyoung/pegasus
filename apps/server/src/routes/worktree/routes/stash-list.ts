/**
 * POST /stash-list endpoint - List all stashes in a worktree
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
import { listStash } from '../../../services/stash-service.js';

export function createStashListHandler(events: EventEmitter) {
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

      // Emit start event so the frontend can observe progress
      events.emit('stash:start', {
        worktreePath,
        operation: 'list',
      });

      // Delegate all Git work to the service
      const result = await listStash(worktreePath);

      // Emit progress with stash count
      events.emit('stash:progress', {
        worktreePath,
        operation: 'list',
        total: result.total,
      });

      // Emit success event
      events.emit('stash:success', {
        worktreePath,
        operation: 'list',
        total: result.total,
      });

      res.json({
        success: true,
        result: {
          stashes: result.stashes,
          total: result.total,
        },
      });
    } catch (error) {
      // Emit error event so the frontend can react
      events.emit('stash:failure', {
        worktreePath: req.body?.worktreePath,
        operation: 'list',
        error: getErrorMessage(error),
      });

      logError(error, 'Stash list failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
