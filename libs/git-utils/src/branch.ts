/**
 * Git branch utilities
 */

import { execGitCommand } from './exec.js';

/**
 * Get the current branch name for a given worktree path.
 *
 * @param worktreePath - Path to the git worktree
 * @returns Promise resolving to the current branch name (trimmed)
 * @throws Error if the git command fails
 *
 * @example
 * ```typescript
 * const branch = await getCurrentBranch('/path/to/worktree');
 * console.log(branch); // 'main'
 * ```
 */
export async function getCurrentBranch(worktreePath: string): Promise<string> {
  const branchOutput = await execGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  return branchOutput.trim();
}
