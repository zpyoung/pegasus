/**
 * Git command execution utilities
 */

import { spawnProcess } from "@pegasus/platform";

/**
 * Execute git command with array arguments to prevent command injection.
 * Uses spawnProcess from @pegasus/platform for secure, cross-platform execution.
 *
 * @param args - Array of git command arguments (e.g., ['worktree', 'add', path])
 * @param cwd - Working directory to execute the command in
 * @param env - Optional additional environment variables to pass to the git process.
 *   These are merged on top of the current process environment.  Pass
 *   `{ LC_ALL: 'C' }` to force git to emit English output regardless of the
 *   system locale so that text-based output parsing remains reliable.
 * @param abortController - Optional AbortController to cancel the git process.
 *   When the controller is aborted the underlying process is sent SIGTERM and
 *   the returned promise rejects with an Error whose message is 'Process aborted'.
 * @returns Promise resolving to stdout output
 * @throws Error with stderr/stdout message if command fails. The thrown error
 *   also has `stdout` and `stderr` string properties for structured access.
 *
 * @example
 * ```typescript
 * // Safe: no injection possible
 * await execGitCommand(['branch', '-D', branchName], projectPath);
 *
 * // Force English output for reliable text parsing:
 * await execGitCommand(['rebase', '--', 'main'], worktreePath, { LC_ALL: 'C' });
 *
 * // With a process-level timeout:
 * const controller = new AbortController();
 * const timerId = setTimeout(() => controller.abort(), 30_000);
 * try {
 *   await execGitCommand(['fetch', '--all', '--quiet'], cwd, undefined, controller);
 * } finally {
 *   clearTimeout(timerId);
 * }
 *
 * // Instead of unsafe:
 * // await execAsync(`git branch -D ${branchName}`, { cwd });
 * ```
 */
export async function execGitCommand(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  abortController?: AbortController,
): Promise<string> {
  const result = await spawnProcess({
    command: "git",
    args,
    cwd,
    ...(env !== undefined ? { env } : {}),
    ...(abortController !== undefined ? { abortController } : {}),
  });

  // spawnProcess returns { stdout, stderr, exitCode }
  if (result.exitCode === 0) {
    return result.stdout;
  } else {
    const errorMessage =
      result.stderr ||
      result.stdout ||
      `Git command failed with code ${result.exitCode}`;
    throw Object.assign(new Error(errorMessage), {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
}
