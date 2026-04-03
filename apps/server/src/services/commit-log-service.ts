/**
 * Service for fetching commit log data from a worktree.
 *
 * Extracts the heavy Git command execution and parsing logic from the
 * commit-log route handler so the handler only validates input,
 * invokes this service, streams lifecycle events, and sends the response.
 *
 * Follows the same approach as branch-commit-log-service: a single
 * `git log --name-only` call with custom separators to fetch both
 * commit metadata and file lists, avoiding N+1 git invocations.
 */

import { execGitCommand } from '../lib/git.js';

// ============================================================================
// Types
// ============================================================================

export interface CommitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  files: string[];
}

export interface CommitLogResult {
  branch: string;
  commits: CommitLogEntry[];
  total: number;
}

// ============================================================================
// Service
// ============================================================================

/**
 * Fetch the commit log for a worktree (HEAD).
 *
 * Runs a single `git log --name-only` invocation plus `git rev-parse`
 * inside the given worktree path and returns a structured result.
 *
 * @param worktreePath - Absolute path to the worktree / repository
 * @param limit        - Maximum number of commits to return (clamped 1-100)
 */
export async function getCommitLog(worktreePath: string, limit: number): Promise<CommitLogResult> {
  // Clamp limit to a reasonable range
  const parsedLimit = Number(limit);
  const commitLimit = Math.min(Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 20), 100);

  // Use custom separators to parse both metadata and file lists from
  // a single git log invocation (same approach as branch-commit-log-service).
  //
  // -m causes merge commits to be diffed against each parent so all
  // files touched by the merge are listed (without -m, --name-only
  // produces no file output for merge commits because they have 2+ parents).
  // This means merge commits appear multiple times in the output (once per
  // parent), so we deduplicate by hash below and merge their file lists.
  // We over-fetch (2x the limit) to compensate for -m duplicating merge
  // commit entries, then trim the result to the requested limit.
  // Use ASCII control characters as record separators – these cannot appear in
  // git commit messages, so these delimiters are safe regardless of commit
  // body content.  %x00 and %x01 in git's format string emit literal NUL /
  // SOH bytes respectively.
  //
  // COMMIT_SEP (\x00) – marks the start of each commit record.
  // META_END   (\x01) – separates commit metadata from the --name-only file list.
  //
  // Full per-commit layout emitted by git:
  //   \x00\n<hash>\n<shorthash>\n...\n<subject>\n<body>\x01<files...>
  const COMMIT_SEP = '\x00';
  const META_END = '\x01';
  const fetchLimit = commitLimit * 2;

  const logOutput = await execGitCommand(
    [
      'log',
      `--max-count=${fetchLimit}`,
      '-m',
      '--name-only',
      `--format=%x00%n%H%n%h%n%an%n%ae%n%aI%n%s%n%b%x01`,
    ],
    worktreePath
  );

  // Split output into per-commit blocks and drop the empty first chunk
  // (the output starts with a NUL commit separator).
  const commitBlocks = logOutput.split(COMMIT_SEP).filter((block) => block.trim());

  // Use a Map to deduplicate merge commit entries (which appear once per
  // parent when -m is used) while preserving insertion order.
  const commitMap = new Map<string, CommitLogEntry>();

  for (const block of commitBlocks) {
    const metaEndIdx = block.indexOf(META_END);
    if (metaEndIdx === -1) continue; // malformed block, skip

    // --- Parse metadata (everything before the META_END delimiter) ---
    const metaRaw = block.substring(0, metaEndIdx);
    const metaLines = metaRaw.split('\n');

    // The first line may be empty (newline right after COMMIT_SEP), skip it
    const nonEmptyStart = metaLines.findIndex((l) => l.trim() !== '');
    if (nonEmptyStart === -1) continue;

    const fields = metaLines.slice(nonEmptyStart);
    if (fields.length < 6) continue; // need at least hash..subject

    const hash = fields[0].trim();
    if (!hash) continue; // defensive: skip if hash is empty
    const shortHash = fields[1]?.trim() ?? '';
    const author = fields[2]?.trim() ?? '';
    const authorEmail = fields[3]?.trim() ?? '';
    const date = fields[4]?.trim() ?? '';
    const subject = fields[5]?.trim() ?? '';
    const body = fields.slice(6).join('\n').trim();

    // --- Parse file list (everything after the META_END delimiter) ---
    const filesRaw = block.substring(metaEndIdx + META_END.length);
    const blockFiles = filesRaw
      .trim()
      .split('\n')
      .filter((f) => f.trim());

    // Merge file lists for duplicate entries (merge commits with -m)
    const existing = commitMap.get(hash);
    if (existing) {
      // Add new files to the existing entry's file set
      const fileSet = new Set(existing.files);
      for (const f of blockFiles) fileSet.add(f);
      existing.files = [...fileSet];
    } else {
      commitMap.set(hash, {
        hash,
        shortHash,
        author,
        authorEmail,
        date,
        subject,
        body,
        files: [...new Set(blockFiles)],
      });
    }
  }

  // Trim to the requested limit (we over-fetched to account for -m duplicates)
  const commits = [...commitMap.values()].slice(0, commitLimit);

  // Get current branch name
  const branchOutput = await execGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  const branch = branchOutput.trim();

  return {
    branch,
    commits,
    total: commits.length,
  };
}
