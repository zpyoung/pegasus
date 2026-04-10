/**
 * MergeService - Direct merge operations without HTTP
 *
 * Extracted from worktree merge route to allow internal service calls.
 */

import { createLogger, isValidBranchName, isValidRemoteName } from '@pegasus/utils';
import { type EventEmitter } from '../lib/events.js';
import { execGitCommand } from '@pegasus/git-utils';
const logger = createLogger('MergeService');

export interface MergeOptions {
  squash?: boolean;
  message?: string;
  deleteWorktreeAndBranch?: boolean;
  /** Remote name to fetch from before merging (defaults to 'origin') */
  remote?: string;
}

export interface MergeServiceResult {
  success: boolean;
  error?: string;
  hasConflicts?: boolean;
  conflictFiles?: string[];
  mergedBranch?: string;
  targetBranch?: string;
  deleted?: {
    worktreeDeleted: boolean;
    branchDeleted: boolean;
  };
}

/**
 * Perform a git merge operation directly without HTTP.
 *
 * @param projectPath - Path to the git repository
 * @param branchName - Source branch to merge
 * @param worktreePath - Path to the worktree (used for deletion if requested)
 * @param targetBranch - Branch to merge into (defaults to 'main')
 * @param options - Merge options
 * @param options.squash - If true, perform a squash merge
 * @param options.message - Custom merge commit message
 * @param options.deleteWorktreeAndBranch - If true, delete worktree and branch after merge
 * @param options.remote - Remote name to fetch from before merging (defaults to 'origin')
 */
export async function performMerge(
  projectPath: string,
  branchName: string,
  worktreePath: string,
  targetBranch: string = 'main',
  options?: MergeOptions,
  emitter?: EventEmitter
): Promise<MergeServiceResult> {
  if (!projectPath || !branchName || !worktreePath) {
    return {
      success: false,
      error: 'projectPath, branchName, and worktreePath are required',
    };
  }

  const mergeTo = targetBranch || 'main';

  // Validate branch names early to reject invalid input before any git operations
  if (!isValidBranchName(branchName)) {
    return {
      success: false,
      error: `Invalid source branch name: "${branchName}"`,
    };
  }
  if (!isValidBranchName(mergeTo)) {
    return {
      success: false,
      error: `Invalid target branch name: "${mergeTo}"`,
    };
  }

  // Validate source branch exists (using safe array-based command)
  try {
    await execGitCommand(['rev-parse', '--verify', branchName], projectPath);
  } catch {
    return {
      success: false,
      error: `Branch "${branchName}" does not exist`,
    };
  }

  // Validate target branch exists (using safe array-based command)
  try {
    await execGitCommand(['rev-parse', '--verify', mergeTo], projectPath);
  } catch {
    return {
      success: false,
      error: `Target branch "${mergeTo}" does not exist`,
    };
  }

  // Validate the remote name to prevent git option injection.
  // Reject invalid remote names so the caller knows their input was wrong,
  // consistent with how invalid branch names are handled above.
  const remote = options?.remote || 'origin';
  if (!isValidRemoteName(remote)) {
    logger.warn('Invalid remote name supplied to merge-service', {
      remote,
      projectPath,
    });
    return {
      success: false,
      error: `Invalid remote name: "${remote}"`,
    };
  }

  // Fetch latest from remote before merging to ensure we have up-to-date refs
  try {
    await execGitCommand(['fetch', remote], projectPath);
  } catch (fetchError) {
    logger.warn('Failed to fetch from remote before merge; proceeding with local refs', {
      remote,
      projectPath,
      error: (fetchError as Error).message,
    });
    // Non-fatal: proceed with local refs if fetch fails (e.g. offline)
  }

  // Emit merge:start after validating inputs
  emitter?.emit('merge:start', { branchName, targetBranch: mergeTo, worktreePath });

  // Find which worktree (if any) has the target branch checked out.
  // Two merge strategies:
  //   1. Target is in a worktree → run `git merge` there directly.
  //   2. Target is NOT checked out → use `git merge-tree` plumbing to merge
  //      entirely in git's object store (no checkout/worktree needed).
  let targetWorktreeDir: string | null = null;

  try {
    const worktreeListOutput = await execGitCommand(
      ['worktree', 'list', '--porcelain'],
      projectPath
    );
    // Parse porcelain output: blocks separated by blank lines, each with
    // "worktree <path>" and "branch refs/heads/<name>" lines.
    let currentWorktreePath: string | null = null;
    for (const line of worktreeListOutput.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentWorktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('branch refs/heads/') && currentWorktreePath) {
        const branch = line.slice('branch refs/heads/'.length);
        if (branch === mergeTo) {
          targetWorktreeDir = currentWorktreePath;
          break;
        }
      } else if (line.trim() === '') {
        currentWorktreePath = null;
      }
    }
  } catch (wtError) {
    logger.warn('Failed to list worktrees; falling back to projectPath', {
      error: (wtError as Error).message,
    });
  }

  // ── Strategy 1: Target branch is checked out in a worktree ──
  // Run `git merge` directly in that worktree.
  if (targetWorktreeDir) {
    return mergeInWorktree(
      projectPath,
      targetWorktreeDir,
      branchName,
      worktreePath,
      mergeTo,
      options,
      emitter
    );
  }

  // ── Strategy 2: Target branch is NOT checked out anywhere ──
  // Use git plumbing (merge-tree + commit-tree + update-ref) to merge
  // entirely in the object store — no checkout or temp worktree needed.
  return mergeWithPlumbing(
    projectPath,
    branchName,
    worktreePath,
    mergeTo,
    options,
    emitter
  );
}

/**
 * Merge using `git merge` in the worktree that has the target branch checked out.
 */
async function mergeInWorktree(
  projectPath: string,
  mergeDir: string,
  branchName: string,
  worktreePath: string,
  mergeTo: string,
  options?: MergeOptions,
  emitter?: EventEmitter
): Promise<MergeServiceResult> {
  const mergeMessage = options?.message || `Merge ${branchName} into ${mergeTo}`;
  const mergeArgs = options?.squash
    ? ['merge', '--squash', branchName]
    : ['merge', branchName, '-m', mergeMessage];

  try {
    // Set LC_ALL=C so git always emits English output regardless of the system
    // locale, making text-based conflict detection reliable.
    await execGitCommand(mergeArgs, mergeDir, { LC_ALL: 'C' });
  } catch (mergeError: unknown) {
    return handleMergeError(mergeError, mergeDir, branchName, mergeTo, emitter);
  }

  // If squash merge, need to commit (using safe array-based command)
  if (options?.squash) {
    const squashMessage = options?.message || `Merge ${branchName} (squash)`;
    try {
      await execGitCommand(['commit', '-m', squashMessage], mergeDir);
    } catch (commitError: unknown) {
      const err = commitError as { message?: string };
      emitter?.emit('merge:error', {
        branchName,
        targetBranch: mergeTo,
        error: err.message || String(commitError),
      });
      throw commitError;
    }
  }

  return postMergeCleanup(projectPath, branchName, worktreePath, mergeTo, options, emitter);
}

/**
 * Merge using git plumbing commands (merge-tree + commit-tree + update-ref).
 * Works entirely in the object store — no working tree or checkout required.
 */
async function mergeWithPlumbing(
  projectPath: string,
  branchName: string,
  worktreePath: string,
  mergeTo: string,
  options?: MergeOptions,
  emitter?: EventEmitter
): Promise<MergeServiceResult> {
  const mergeMessage = options?.message
    || (options?.squash ? `Merge ${branchName} (squash)` : `Merge ${branchName} into ${mergeTo}`);

  // merge-tree performs the merge without touching any working tree or index.
  // Exit 0 = clean merge, exit 1 = conflicts, other = error.
  try {
    const treeOutput = await execGitCommand(
      ['merge-tree', '--write-tree', mergeTo, branchName],
      projectPath,
      { LC_ALL: 'C' }
    );
    const treeOid = treeOutput.trim().split('\n')[0];

    // Create the merge commit. For squash, single parent (target only).
    // For regular merge, two parents (target + source).
    const commitArgs = ['commit-tree', treeOid, '-m', mergeMessage];
    if (options?.squash) {
      commitArgs.push('-p', mergeTo);
    } else {
      commitArgs.push('-p', mergeTo, '-p', branchName);
    }
    const commitOid = (await execGitCommand(commitArgs, projectPath)).trim();

    // Fast-forward the target branch ref to the new commit
    await execGitCommand(
      ['update-ref', `refs/heads/${mergeTo}`, commitOid],
      projectPath
    );
  } catch (mergeError: unknown) {
    const err = mergeError as { stdout?: string; stderr?: string; message?: string; code?: number };
    const output = `${err.stdout || ''} ${err.stderr || ''} ${err.message || ''}`;

    // merge-tree exit code 1 = conflicts
    const hasConflicts =
      output.includes('CONFLICT') ||
      output.includes('Automatic merge failed') ||
      // merge-tree --write-tree outputs conflict info on stdout when exit 1
      (err.code === 1 && output.length > 0);

    if (hasConflicts) {
      // Parse conflict file names from merge-tree output.
      // merge-tree --name-only would be cleaner, but --write-tree output
      // includes "CONFLICT (<type>): ... <path>" lines we can parse.
      const conflictFiles = output
        .split('\n')
        .filter((line) => line.includes('CONFLICT'))
        .map((line) => {
          // Extract path from e.g. "CONFLICT (content): Merge conflict in <path>"
          const inMatch = line.match(/Merge conflict in (.+)$/);
          if (inMatch) return inMatch[1].trim();
          // "CONFLICT (rename/delete): <path> ..."
          const colonMatch = line.match(/CONFLICT \([^)]+\): (.+?)(?:\s+(?:renamed|deleted|added))/);
          if (colonMatch) return colonMatch[1].trim();
          return null;
        })
        .filter((f): f is string => f !== null);

      emitter?.emit('merge:conflict', { branchName, targetBranch: mergeTo, conflictFiles });

      return {
        success: false,
        error: `Merge CONFLICT: Automatic merge of "${branchName}" into "${mergeTo}" failed. Please resolve conflicts manually.`,
        hasConflicts: true,
        conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
      };
    }

    // Non-conflict error
    emitter?.emit('merge:error', {
      branchName,
      targetBranch: mergeTo,
      error: err.message || String(mergeError),
    });
    throw mergeError;
  }

  return postMergeCleanup(projectPath, branchName, worktreePath, mergeTo, options, emitter);
}

/**
 * Shared post-merge cleanup: optionally delete worktree/branch, emit success.
 */
async function postMergeCleanup(
  projectPath: string,
  branchName: string,
  worktreePath: string,
  mergeTo: string,
  options?: MergeOptions,
  emitter?: EventEmitter
): Promise<MergeServiceResult> {
  let worktreeDeleted = false;
  let branchDeleted = false;

  if (options?.deleteWorktreeAndBranch) {
    // Remove the feature worktree
    try {
      await execGitCommand(['worktree', 'remove', worktreePath, '--force'], projectPath);
      worktreeDeleted = true;
    } catch {
      // Try with prune if remove fails
      try {
        await execGitCommand(['worktree', 'prune'], projectPath);
        worktreeDeleted = true;
      } catch {
        logger.warn(`Failed to remove worktree: ${worktreePath}`);
      }
    }

    // Delete the branch (but not main/master)
    if (branchName !== 'main' && branchName !== 'master') {
      try {
        await execGitCommand(['branch', '-D', branchName], projectPath);
        branchDeleted = true;
      } catch {
        logger.warn(`Failed to delete branch: ${branchName}`);
      }
    }
  }

  // Emit merge:success with merged branch, target branch, and deletion info
  emitter?.emit('merge:success', {
    mergedBranch: branchName,
    targetBranch: mergeTo,
    deleted: options?.deleteWorktreeAndBranch ? { worktreeDeleted, branchDeleted } : undefined,
  });

  return {
    success: true,
    mergedBranch: branchName,
    targetBranch: mergeTo,
    deleted: options?.deleteWorktreeAndBranch ? { worktreeDeleted, branchDeleted } : undefined,
  };
}

/**
 * Handle merge errors from `git merge` in a worktree — detect conflicts vs real errors.
 */
async function handleMergeError(
  mergeError: unknown,
  mergeDir: string,
  branchName: string,
  mergeTo: string,
  emitter?: EventEmitter
): Promise<MergeServiceResult> {
  // Check if this is a merge conflict.  We use a multi-layer strategy so
  // that detection is reliable even when locale settings vary or git's text
  // output changes across versions:
  //
  //  1. Primary (text-based): scan the error output for well-known English
  //     conflict markers.  Because we pass LC_ALL=C the strings are always
  //     in English, but we keep the check as one layer among several.
  //
  //  2. Unmerged-path check: run `git diff --name-only --diff-filter=U`
  //     (locale-stable) and treat any non-empty output as a conflict
  //     indicator, capturing the file list at the same time.
  //
  //  3. Fallback status check: run `git status --porcelain` and look for
  //     lines whose first two characters indicate an unmerged state
  //     (UU, AA, DD, AU, UA, DU, UD).
  //
  // hasConflicts is true when ANY of the three layers returns positive.
  const err = mergeError as { stdout?: string; stderr?: string; message?: string };
  const output = `${err.stdout || ''} ${err.stderr || ''} ${err.message || ''}`;

  // Layer 1 – text matching (locale-safe because we set LC_ALL=C above).
  const textIndicatesConflict =
    output.includes('CONFLICT') || output.includes('Automatic merge failed');

  // Layers 2 & 3 – repository state inspection (locale-independent).
  // Layer 2: get conflicted files via diff (also locale-stable output).
  let conflictFiles: string[] | undefined;
  let diffIndicatesConflict = false;
  try {
    const diffOutput = await execGitCommand(
      ['diff', '--name-only', '--diff-filter=U'],
      mergeDir,
      { LC_ALL: 'C' }
    );
    const files = diffOutput
      .trim()
      .split('\n')
      .filter((f) => f.trim().length > 0);
    if (files.length > 0) {
      diffIndicatesConflict = true;
      conflictFiles = files;
    }
  } catch {
    // If we can't get the file list, leave conflictFiles undefined so callers
    // can distinguish "no conflicts" (empty array) from "unknown due to diff failure" (undefined)
  }

  // Layer 3: check for unmerged paths via machine-readable git status.
  let hasUnmergedPaths = false;
  try {
    const statusOutput = await execGitCommand(['status', '--porcelain'], mergeDir, {
      LC_ALL: 'C',
    });
    // Unmerged status codes occupy the first two characters of each line.
    // Standard unmerged codes: UU, AA, DD, AU, UA, DU, UD.
    const unmergedLines = statusOutput
      .split('\n')
      .filter((line) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(line));
    hasUnmergedPaths = unmergedLines.length > 0;

    // If Layer 2 did not populate conflictFiles (e.g. diff failed or returned
    // nothing) but Layer 3 does detect unmerged paths, parse the status lines
    // to extract filenames and assign them to conflictFiles so callers always
    // receive an accurate file list when conflicts are present.
    if (hasUnmergedPaths && conflictFiles === undefined) {
      const parsedFiles = unmergedLines
        .map((line) => line.slice(2).trim())
        .filter((f) => f.length > 0);
      // Deduplicate (e.g. rename entries can appear twice)
      conflictFiles = [...new Set(parsedFiles)];
    }
  } catch {
    // git status failing is itself a sign something is wrong; leave
    // hasUnmergedPaths as false and rely on the other layers.
  }

  const hasConflicts = textIndicatesConflict || diffIndicatesConflict || hasUnmergedPaths;

  if (hasConflicts) {
    // Abort the failed merge so the worktree is clean
    try {
      await execGitCommand(['merge', '--abort'], mergeDir);
    } catch {
      // merge --abort can fail if there's nothing to abort; safe to ignore
    }

    // Emit merge:conflict event with conflict details
    emitter?.emit('merge:conflict', { branchName, targetBranch: mergeTo, conflictFiles });

    return {
      success: false,
      error: `Merge CONFLICT: Automatic merge of "${branchName}" into "${mergeTo}" failed. Please resolve conflicts manually.`,
      hasConflicts: true,
      conflictFiles,
    };
  }

  // Emit merge:error for non-conflict errors before re-throwing
  emitter?.emit('merge:error', {
    branchName,
    targetBranch: mergeTo,
    error: err.message || String(mergeError),
  });

  // Re-throw non-conflict errors
  throw mergeError;
}
