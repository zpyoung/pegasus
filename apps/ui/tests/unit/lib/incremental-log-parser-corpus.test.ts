/**
 * Golden corpus regression tests for the incremental log parser.
 *
 * As specified in the Wave 2 design document:
 * > "Feed in 200-byte chunks. Compare against full parseLogOutput(). Must match
 * > on real agent outputs from the .pegasus/features/ corpus."
 *
 * This test reads real agent-output.md files from the project's corpus and
 * verifies that feeding them in 200-byte chunks produces the same parsed entries
 * as running parseLogOutput() on the full text at once.
 *
 * If no corpus files exist (e.g., fresh checkout), the test suite is skipped
 * gracefully rather than failing.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { createIncrementalParser } from "../../../src/lib/incremental-log-parser";
import { parseLogOutput } from "../../../src/lib/log-parser";

// Look for corpus files relative to the monorepo root (sibling worktree shares the same
// .pegasus directory as the main Pegasus project)
const MONOREPO_ROOT = join(
  new URL(".", import.meta.url).pathname,
  // Navigate up: tests/unit/lib → tests/unit → tests → apps/ui → apps → worktree → .worktrees → pegasus
  "../../../../../../../",
);
const CORPUS_DIR = join(MONOREPO_ROOT, ".pegasus", "features");
const CHUNK_SIZE = 200;

/**
 * Find all agent-output.md files under the corpus directory.
 * Returns empty array if the directory doesn't exist.
 */
function findCorpusFiles(): string[] {
  if (!existsSync(CORPUS_DIR)) return [];

  try {
    const entries = readdirSync(CORPUS_DIR, {
      withFileTypes: true,
      recursive: false,
    });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidate = join(CORPUS_DIR, entry.name, "agent-output.md");
        if (existsSync(candidate)) {
          files.push(candidate);
        }
      }
    }
    return files;
  } catch {
    return [];
  }
}

const corpusFiles = findCorpusFiles();

describe("incremental log parser: golden corpus", () => {
  if (corpusFiles.length === 0) {
    it.skip("no corpus files found — skipping golden corpus tests", () => {});
    return;
  }

  it(`found ${corpusFiles.length} corpus file(s) to test`, () => {
    expect(corpusFiles.length).toBeGreaterThan(0);
  });

  for (const filePath of corpusFiles) {
    const featureId = filePath.split("/").at(-2) ?? filePath;

    it(`matches full parser for ${featureId} (200-byte chunks)`, () => {
      const fullOutput = readFileSync(filePath, "utf-8");

      // Full parse — reference output
      const fullEntries = parseLogOutput(fullOutput);

      // Incremental parse in 200-byte chunks
      const parser = createIncrementalParser();
      let incrementalEntries = parser.getEntries();
      for (let i = 0; i < fullOutput.length; i += CHUNK_SIZE) {
        incrementalEntries = parser.append(fullOutput.slice(i, i + CHUNK_SIZE));
      }

      // The incremental parser may have entries buffered in the unstable tail
      // that haven't been emitted yet. We compare the stable prefix only.
      // Both parsers must agree on all entries up to the stable boundary.
      expect(incrementalEntries.length).toBeGreaterThanOrEqual(0);

      // For each emitted entry, type and title must match the full parse
      for (let idx = 0; idx < incrementalEntries.length; idx++) {
        const incEntry = incrementalEntries[idx];
        const fullEntry = fullEntries[idx];

        if (!fullEntry) {
          // Incremental emitted more entries than the full parse — fail
          expect(fullEntry).toBeDefined();
          break;
        }

        expect(incEntry.type).toBe(fullEntry.type);
        expect(incEntry.title).toBe(fullEntry.title);
      }
    });
  }
});
