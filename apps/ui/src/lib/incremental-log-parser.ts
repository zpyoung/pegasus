/**
 * Incremental Log Parser
 *
 * Wraps the existing parseLogOutput() to avoid O(n^2) reparsing during streaming.
 * Instead of parsing the entire accumulated output on every chunk, this parser:
 * 1. Keeps a "stable prefix" of already-parsed entries
 * 2. Only parses the portion of text that just became stable (between chunk boundaries)
 *
 * Entry boundaries are lines beginning with emoji/tool markers that signal the
 * start of a new log entry in Pegasus's custom log format.
 */

import { parseLogOutput } from "@/lib/log-parser";
import type { LogEntry } from "@/lib/log-parser";

/**
 * Regex pattern to detect log entry boundaries.
 * A boundary is a newline followed by the start of a new log entry.
 * Pegasus log entries begin with tool emojis, phase markers, or tool headers.
 */
const ENTRY_BOUNDARY_PATTERN = /\n(?=🔧|Tool:|📋|⚡|✅|❌|##\s)/g;

interface IncrementalParseState {
  /** Entries from fully-parsed stable prefix */
  stableEntries: LogEntry[];
  /** The raw tail that may still be incomplete */
  unstableTail: string;
}

/**
 * Find the last stable boundary position in text.
 * Returns the character index of the last entry separator,
 * or -1 if no complete entry boundary is found.
 */
function findLastStableBoundary(text: string): number {
  const pattern = new RegExp(ENTRY_BOUNDARY_PATTERN.source, "g");
  let lastMatch = -1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    lastMatch = match.index;
  }
  return lastMatch;
}

/**
 * Creates an incremental log parser that avoids re-parsing already-processed text.
 *
 * @example
 * ```typescript
 * const parser = createIncrementalParser();
 *
 * // Feed chunks as they arrive
 * for (const chunk of streamChunks) {
 *   const entries = parser.append(chunk);
 *   // entries contains all parsed entries so far
 * }
 *
 * // Reset when starting a new output (modal reopen, new feature)
 * parser.reset();
 * ```
 */
export function createIncrementalParser(): {
  append: (newChunk: string) => LogEntry[];
  getEntries: () => LogEntry[];
  reset: () => void;
} {
  let state: IncrementalParseState = {
    stableEntries: [],
    unstableTail: "",
  };

  function append(newChunk: string): LogEntry[] {
    // Combine the previously unstable tail with the new chunk
    const pending = state.unstableTail + newChunk;

    // Find the last position where a new entry clearly begins
    const lastBoundary = findLastStableBoundary(pending);

    if (lastBoundary === -1) {
      // No complete entry boundary found — accumulate and wait for more data
      state.unstableTail = pending;
      return state.stableEntries;
    }

    // Parse only the portion up to the last stable boundary.
    // This portion starts from the beginning of unstableTail (never previously parsed)
    // and extends to the last clear entry start marker.
    const stablePortion = pending.slice(0, lastBoundary);
    const newEntries = parseLogOutput(stablePortion);

    // Append newly-parsed entries to the stable set
    state.stableEntries = [...state.stableEntries, ...newEntries];
    // Keep the rest as the new unstable tail (may be an incomplete entry)
    state.unstableTail = pending.slice(lastBoundary);

    return state.stableEntries;
  }

  return {
    append,
    getEntries: () => state.stableEntries,
    reset: () => {
      state = { stableEntries: [], unstableTail: "" };
    },
  };
}
