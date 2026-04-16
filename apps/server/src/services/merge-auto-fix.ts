/**
 * Merge Auto-Fix - Uses an AI agent to repair pre-commit hook failures
 * encountered during branch integration, then retries the commit.
 *
 * Triggered only when a merge is otherwise clean (no conflicts) but the
 * pre-commit hook rejected the commit — typically typecheck, lint, or
 * stale-generated-artifact failures that a short agent run can resolve.
 */

import { DEFAULT_MODELS } from "@pegasus/types";
import { createLogger } from "@pegasus/utils";
import { streamingQuery } from "../providers/simple-query-service.js";
import type { EventEmitter } from "../lib/events.js";
import { execGitCommand } from "@pegasus/git-utils";

const logger = createLogger("MergeAutoFix");

const SYSTEM_PROMPT = `You are repairing a failed pre-commit hook after a git merge. The merge is already staged in the working directory. The caller will retry the commit after you exit.

STRICT RULES:
- Do NOT run git commit, git merge, git push, git reset, git checkout, git stash, or any command that modifies git refs or the index.
- Do NOT modify the commit message.
- Do NOT delete tracked source files.

Your job: read the pre-commit hook output, diagnose the root cause, and fix it.

Common causes and preferred fixes:
- Stale built artifacts (e.g. dist/*.d.ts missing new exports): rebuild with \`pnpm build:packages\` or the appropriate package build.
- Typecheck errors in source code: fix the source files.
- Lint/format errors: run the relevant fix command (e.g. \`pnpm format\`, \`pnpm lint --fix\`) or edit the source.
- Missing dependencies: \`pnpm install\`.

When the fix is complete, stop. Do not report or summarize — just finish.`;

export interface AutoFixOptions {
  mergeDir: string;
  branchName: string;
  targetBranch: string;
  errorOutput: string;
  mergeMessage: string;
  model?: string;
  maxAttempts?: number;
  emitter?: EventEmitter;
  abortController?: AbortController;
}

export interface AutoFixResult {
  success: boolean;
  attempts: number;
  error?: string;
  finalOutput?: string;
}

/**
 * Detect whether a merge/commit error output was caused by a pre-commit hook
 * (husky, simple-git-hooks, native .git/hooks, etc.) rejecting the commit.
 *
 * Conservative: only returns true for clearly-hook-related text so we do not
 * accidentally invoke the agent on real merge errors.
 */
export function isPreCommitHookFailure(output: string): boolean {
  if (!output) return false;
  const text = output.toLowerCase();
  return (
    /husky\s*-\s*(pre-commit|commit-msg|pre-push).*(script|hook)?\s*failed/.test(
      text,
    ) ||
    text.includes("pre-commit hook failed") ||
    text.includes("pre-commit script failed") ||
    /error:\s*hook\s+declined/.test(text) ||
    // simple-git-hooks pattern
    /hook\s+(?:pre-commit|commit-msg)\s+failed/.test(text)
  );
}

/**
 * Run the agent to fix pre-commit errors, then retry the commit.
 * Loops up to `maxAttempts` times — each iteration runs the agent and retries
 * the commit. Stops when commit succeeds, a non-hook error appears, or attempts
 * are exhausted.
 */
export async function attemptAutoFix(
  options: AutoFixOptions,
): Promise<AutoFixResult> {
  const {
    mergeDir,
    branchName,
    targetBranch,
    mergeMessage,
    emitter,
    abortController,
  } = options;
  const model = options.model || DEFAULT_MODELS.claude;
  const maxAttempts = options.maxAttempts ?? 2;

  let lastError = options.errorOutput;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;

    emitter?.emit("merge:auto-fix-start", {
      branchName,
      targetBranch,
      attempt: attempts,
      maxAttempts,
      errorOutput: lastError,
    });

    const userPrompt = `A pre-commit hook failed while merging branch \`${branchName}\` into \`${targetBranch}\`. The merge is staged in the current working directory (\`${mergeDir}\`). Diagnose and fix so the hook passes. Do not run any git commands.

Pre-commit hook output:
\`\`\`
${lastError}
\`\`\``;

    try {
      await streamingQuery({
        prompt: userPrompt,
        model,
        cwd: mergeDir,
        systemPrompt: SYSTEM_PROMPT,
        maxTurns: 50,
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
        abortController,
        onText: (text) => {
          emitter?.emit("merge:auto-fix-progress", {
            branchName,
            targetBranch,
            attempt: attempts,
            text,
          });
        },
        onToolUse: (tool, input) => {
          emitter?.emit("merge:auto-fix-progress", {
            branchName,
            targetBranch,
            attempt: attempts,
            tool,
            input,
          });
        },
      });
    } catch (agentError) {
      const msg = (agentError as Error).message;
      logger.warn("Auto-fix agent run failed", {
        branchName,
        targetBranch,
        attempt: attempts,
        error: msg,
      });
      emitter?.emit("merge:auto-fix-failed", {
        branchName,
        targetBranch,
        attempt: attempts,
        error: `Agent run failed: ${msg}`,
      });
      return {
        success: false,
        attempts,
        error: `Auto-fix agent failed on attempt ${attempts}: ${msg}`,
        finalOutput: lastError,
      };
    }

    // Retry the merge commit. The merge state (MERGE_HEAD + staged index) is
    // preserved after a pre-commit failure; `git commit -m <msg>` completes it.
    try {
      await execGitCommand(["commit", "-m", mergeMessage], mergeDir, {
        LC_ALL: "C",
      });
      emitter?.emit("merge:auto-fix-success", {
        branchName,
        targetBranch,
        attempts,
      });
      return { success: true, attempts };
    } catch (retryErr) {
      const err = retryErr as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const output = `${err.stdout || ""} ${err.stderr || ""} ${err.message || ""}`;
      lastError = output;

      // Only loop if it's still a pre-commit hook failure. For any other error
      // (nothing to commit, merge state lost, real git error), bail out.
      if (!isPreCommitHookFailure(output)) {
        logger.warn("Commit retry after auto-fix failed with non-hook error", {
          branchName,
          targetBranch,
          attempt: attempts,
          error: err.message,
        });
        emitter?.emit("merge:auto-fix-failed", {
          branchName,
          targetBranch,
          attempt: attempts,
          error: err.message || String(retryErr),
        });
        return {
          success: false,
          attempts,
          error: `Commit retry failed: ${err.message || String(retryErr)}`,
          finalOutput: output,
        };
      }
      // Still a hook failure — loop for another attempt.
    }
  }

  emitter?.emit("merge:auto-fix-failed", {
    branchName,
    targetBranch,
    attempt: attempts,
    error: `Auto-fix exhausted after ${maxAttempts} attempts`,
  });
  return {
    success: false,
    attempts,
    error: `Auto-fix exhausted after ${maxAttempts} attempts`,
    finalOutput: lastError,
  };
}
