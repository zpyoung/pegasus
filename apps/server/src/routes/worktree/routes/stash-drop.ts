/**
 * POST /stash-drop endpoint - Drop (delete) a stash entry
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
import { dropStash } from '../../../services/stash-service.js';

export function createStashDropHandler(events: EventEmitter) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { worktreePath, stashIndex } = req.body as {
        worktreePath: string;
        stashIndex: number;
      };

      if (!worktreePath) {
        res.status(400).json({
          success: false,
          error: 'worktreePath required',
        });
        return;
      }

      if (!Number.isInteger(stashIndex) || stashIndex < 0) {
        res.status(400).json({
          success: false,
          error: 'stashIndex required',
        });
        return;
      }

      // Emit start event so the frontend can observe progress
      events.emit('stash:start', {
        worktreePath,
        stashIndex,
        stashRef: `stash@{${stashIndex}}`,
        operation: 'drop',
      });

      // Delegate all Git work to the service
      const result = await dropStash(worktreePath, stashIndex);

      // Emit success event
      events.emit('stash:success', {
        worktreePath,
        stashIndex,
        operation: 'drop',
        dropped: result.dropped,
      });

      res.json({
        success: true,
        result: {
          dropped: result.dropped,
          stashIndex: result.stashIndex,
          message: result.message,
        },
      });
    } catch (error) {
      // Emit error event so the frontend can react
      events.emit('stash:failure', {
        worktreePath: req.body?.worktreePath,
        stashIndex: req.body?.stashIndex,
        operation: 'drop',
        error: getErrorMessage(error),
      });

      logError(error, 'Stash drop failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
