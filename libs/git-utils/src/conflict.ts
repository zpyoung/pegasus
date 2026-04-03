/**
 * Git conflict detection utilities
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Execute a git command with array arguments to prevent command injection.
 *
 * @param args - Array of git command arguments
 * @param cwd - Working directory to execute the command in
 * @returns Promise resolving to stdout output
 * @throws Error if the command fails
 */
async function execGitCommand(args: string[], cwd: string): Promise<string> {
  // Shell-escape each argument to prevent injection
  const escaped = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  const { stdout } = await execAsync(`git ${escaped}`, { cwd });
  return stdout;
}

/**
 * Get the list of files with unresolved merge conflicts.
 *
 * @param worktreePath - Path to the git worktree
 * @returns Array of file paths with conflicts
 */
export async function getConflictFiles(worktreePath: string): Promise<string[]> {
  try {
    const diffOutput = await execGitCommand(
      ['diff', '--name-only', '--diff-filter=U'],
      worktreePath
    );
    return diffOutput
      .trim()
      .split('\n')
      .filter((f) => f.trim().length > 0);
  } catch {
    return [];
  }
}
