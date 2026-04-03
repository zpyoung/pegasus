/**
 * CherryPickService - Cherry-pick git operations without HTTP
 *
 * Extracted from worktree cherry-pick route to encapsulate all git
 * cherry-pick business logic in a single service. Follows the same
 * pattern as merge-service.ts.
 */

import { createLogger } from '@pegasus/utils';
import { execGitCommand, getCurrentBranch } from '../lib/git.js';
import { type EventEmitter } from '../lib/events.js';

const logger = createLogger('CherryPickService');

// ============================================================================
// Types
// ============================================================================

export interface CherryPickOptions {
  noCommit?: boolean;
}

export interface CherryPickResult {
  success: boolean;
  error?: string;
  hasConflicts?: boolean;
  aborted?: boolean;
  cherryPicked?: boolean;
  commitHashes?: string[];
  branch?: string;
  message?: string;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Verify that each commit hash exists in the repository.
 *
 * @param worktreePath - Path to the git worktree
 * @param commitHashes - Array of commit hashes to verify
 * @param emitter - Optional event emitter for lifecycle events
 * @returns The first invalid commit hash, or null if all are valid
 */
export async function verifyCommits(
  worktreePath: string,
  commitHashes: string[],
  emitter?: EventEmitter
): Promise<string | null> {
  for (const hash of commitHashes) {
    try {
      await execGitCommand(['rev-parse', '--verify', hash], worktreePath);
    } catch {
      emitter?.emit('cherry-pick:verify-failed', { worktreePath, hash });
      return hash;
    }
  }
  return null;
}

/**
 * Run the cherry-pick operation on the given worktree.
 *
 * @param worktreePath - Path to the git worktree
 * @param commitHashes - Array of commit hashes to cherry-pick (in order)
 * @param options - Cherry-pick options (e.g., noCommit)
 * @param emitter - Optional event emitter for lifecycle events
 * @returns CherryPickResult with success/failure information
 */
export async function runCherryPick(
  worktreePath: string,
  commitHashes: string[],
  options?: CherryPickOptions,
  emitter?: EventEmitter
): Promise<CherryPickResult> {
  const args = ['cherry-pick'];
  if (options?.noCommit) {
    args.push('--no-commit');
  }
  args.push(...commitHashes);

  emitter?.emit('cherry-pick:started', { worktreePath, commitHashes });

  try {
    await execGitCommand(args, worktreePath);

    const branch = await getCurrentBranch(worktreePath);

    if (options?.noCommit) {
      const result: CherryPickResult = {
        success: true,
        cherryPicked: false,
        commitHashes,
        branch,
        message: `Staged changes from ${commitHashes.length} commit(s); no commit created due to --no-commit`,
      };
      emitter?.emit('cherry-pick:success', { worktreePath, commitHashes, branch });
      return result;
    }

    const result: CherryPickResult = {
      success: true,
      cherryPicked: true,
      commitHashes,
      branch,
      message: `Successfully cherry-picked ${commitHashes.length} commit(s)`,
    };
    emitter?.emit('cherry-pick:success', { worktreePath, commitHashes, branch });
    return result;
  } catch (cherryPickError: unknown) {
    // Check if this is a cherry-pick conflict
    const err = cherryPickError as { stdout?: string; stderr?: string; message?: string };
    const output = `${err.stdout || ''} ${err.stderr || ''} ${err.message || ''}`;
    const hasConflicts =
      output.includes('CONFLICT') ||
      output.includes('cherry-pick failed') ||
      output.includes('could not apply');

    if (hasConflicts) {
      // Abort the cherry-pick to leave the repo in a clean state
      const aborted = await abortCherryPick(worktreePath, emitter);

      if (!aborted) {
        logger.error(
          'Failed to abort cherry-pick after conflict; repository may be in a dirty state',
          { worktreePath }
        );
      }

      emitter?.emit('cherry-pick:conflict', {
        worktreePath,
        commitHashes,
        aborted,
        stdout: err.stdout,
        stderr: err.stderr,
      });

      return {
        success: false,
        error: aborted
          ? 'Cherry-pick aborted due to conflicts; no changes were applied.'
          : 'Cherry-pick failed due to conflicts and the abort also failed; repository may be in a dirty state.',
        hasConflicts: true,
        aborted,
      };
    }

    // Non-conflict error - propagate
    throw cherryPickError;
  }
}

/**
 * Abort an in-progress cherry-pick operation.
 *
 * @param worktreePath - Path to the git worktree
 * @param emitter - Optional event emitter for lifecycle events
 * @returns true if abort succeeded, false if it failed (logged as warning)
 */
export async function abortCherryPick(
  worktreePath: string,
  emitter?: EventEmitter
): Promise<boolean> {
  try {
    await execGitCommand(['cherry-pick', '--abort'], worktreePath);
    emitter?.emit('cherry-pick:abort', { worktreePath, aborted: true });
    return true;
  } catch (err: unknown) {
    const error = err as { message?: string };
    logger.warn('Failed to abort cherry-pick after conflict');
    emitter?.emit('cherry-pick:abort', {
      worktreePath,
      aborted: false,
      error: error.message ?? 'Unknown error during cherry-pick abort',
    });
    return false;
  }
}
