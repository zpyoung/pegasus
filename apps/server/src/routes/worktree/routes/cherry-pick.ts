/**
 * POST /cherry-pick endpoint - Cherry-pick one or more commits into the current branch
 *
 * Applies commits from another branch onto the current branch.
 * Supports single or multiple commit cherry-picks.
 *
 * Git business logic is delegated to cherry-pick-service.ts.
 * Events are emitted at key lifecycle points for WebSocket subscribers.
 * The global event emitter is passed into the service so all lifecycle
 * events (started, success, conflict, abort, verify-failed) are broadcast
 * to WebSocket clients.
 *
 * Note: Git repository validation (isGitRepo, hasCommits) is handled by
 * the requireValidWorktree middleware in index.ts
 */

import type { Request, Response } from 'express';
import path from 'path';
import { getErrorMessage, logError } from '../common.js';
import type { EventEmitter } from '../../../lib/events.js';
import { verifyCommits, runCherryPick } from '../../../services/cherry-pick-service.js';

export function createCherryPickHandler(events: EventEmitter) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { worktreePath, commitHashes, options } = req.body as {
        worktreePath: string;
        commitHashes: string[];
        options?: {
          noCommit?: boolean;
        };
      };

      if (!worktreePath) {
        res.status(400).json({
          success: false,
          error: 'worktreePath is required',
        });
        return;
      }

      // Normalize the path to prevent path traversal and ensure consistent paths
      const resolvedWorktreePath = path.resolve(worktreePath);

      if (!commitHashes || !Array.isArray(commitHashes) || commitHashes.length === 0) {
        res.status(400).json({
          success: false,
          error: 'commitHashes array is required and must contain at least one commit hash',
        });
        return;
      }

      // Validate each commit hash format (should be hex string)
      for (const hash of commitHashes) {
        if (!/^[a-fA-F0-9]+$/.test(hash)) {
          res.status(400).json({
            success: false,
            error: `Invalid commit hash format: "${hash}"`,
          });
          return;
        }
      }

      // Verify each commit exists via the service; emits cherry-pick:verify-failed if any hash is missing
      const invalidHash = await verifyCommits(resolvedWorktreePath, commitHashes, events);
      if (invalidHash !== null) {
        res.status(400).json({
          success: false,
          error: `Commit "${invalidHash}" does not exist`,
        });
        return;
      }

      // Execute the cherry-pick via the service.
      // The service emits: cherry-pick:started, cherry-pick:success, cherry-pick:conflict,
      // and cherry-pick:abort at the appropriate lifecycle points.
      const result = await runCherryPick(resolvedWorktreePath, commitHashes, options, events);

      if (result.success) {
        res.json({
          success: true,
          result: {
            cherryPicked: result.cherryPicked,
            commitHashes: result.commitHashes,
            branch: result.branch,
            message: result.message,
          },
        });
      } else if (result.hasConflicts) {
        res.status(409).json({
          success: false,
          error: result.error,
          hasConflicts: true,
          aborted: result.aborted,
        });
      }
    } catch (error) {
      // Emit failure event for unexpected (non-conflict) errors
      events.emit('cherry-pick:failure', {
        error: getErrorMessage(error),
      });

      logError(error, 'Cherry-pick failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
