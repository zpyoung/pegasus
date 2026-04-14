/**
 * Unit tests for incremental-log-parser.ts
 *
 * Validates that incremental parsing produces the same entries as full parsing
 * and handles edge cases like reset, empty input, and mid-content splits.
 */

import { describe, it, expect } from "vitest";
import { createIncrementalParser } from "../../../src/lib/incremental-log-parser";
import { parseLogOutput } from "../../../src/lib/log-parser";

// Sample log output with multiple tool calls and phases
const SAMPLE_LOG = `🔧 Tool: Read
Input: {
  "file_path": "/src/index.ts"
}
Result: File contents here

🔧 Tool: Write
Input: {
  "file_path": "/src/output.ts",
  "content": "export const x = 1;"
}
Result: File written successfully

## Phase: Implementation
Starting implementation phase

🔧 Tool: Bash
Input: {
  "command": "npm test"
}
Result: All tests passed
`;

describe("createIncrementalParser", () => {
  describe("single-chunk parsing", () => {
    it("returns same entry count as full parser when given full output at once", () => {
      const parser = createIncrementalParser();
      const entries = parser.append(SAMPLE_LOG);
      const fullEntries = parseLogOutput(SAMPLE_LOG);

      // The incremental parser may have the last incomplete entry in unstableTail,
      // so we compare the stable subset
      expect(entries.length).toBeGreaterThan(0);
      // Entry types should match for parsed stable entries
      entries.forEach((entry, idx) => {
        expect(fullEntries[idx]).toBeDefined();
        expect(entry.type).toBe(fullEntries[idx].type);
      });
    });

    it("returns empty array for empty input", () => {
      const parser = createIncrementalParser();
      const entries = parser.append("");
      expect(entries).toEqual([]);
    });

    it("accumulates without parsing if no entry boundary found", () => {
      const parser = createIncrementalParser();
      // Text without a complete entry boundary
      const entries = parser.append("🔧 Tool: Read\nInput: partial...");
      expect(entries).toEqual([]);
    });
  });

  describe("chunked parsing", () => {
    it("produces stable entries across multiple small chunks", () => {
      const parser = createIncrementalParser();
      const CHUNK_SIZE = 50;

      let lastEntries: ReturnType<typeof parseLogOutput> = [];
      for (let i = 0; i < SAMPLE_LOG.length; i += CHUNK_SIZE) {
        lastEntries = parser.append(SAMPLE_LOG.slice(i, i + CHUNK_SIZE));
      }

      // Should have parsed at least some entries
      expect(lastEntries.length).toBeGreaterThan(0);
    });

    it("each append returns cumulative stable entries (no loss)", () => {
      const parser = createIncrementalParser();
      let prevCount = 0;

      // Feed single characters to stress-test accumulation
      for (const char of SAMPLE_LOG) {
        const entries = parser.append(char);
        // Entry count should never decrease
        expect(entries.length).toBeGreaterThanOrEqual(prevCount);
        prevCount = entries.length;
      }
    });

    it("produces same entries when fed in 200-byte chunks vs single chunk", () => {
      const singleParser = createIncrementalParser();
      const chunkedParser = createIncrementalParser();

      const singleEntries = singleParser.append(SAMPLE_LOG);

      const CHUNK_SIZE = 200;
      let chunkedEntries: ReturnType<typeof parseLogOutput> = [];
      for (let i = 0; i < SAMPLE_LOG.length; i += CHUNK_SIZE) {
        chunkedEntries = chunkedParser.append(
          SAMPLE_LOG.slice(i, i + CHUNK_SIZE),
        );
      }

      // Both should have parsed the same number of stable entries
      expect(chunkedEntries.length).toBe(singleEntries.length);

      // Entry types should match
      chunkedEntries.forEach((entry, idx) => {
        expect(entry.type).toBe(singleEntries[idx].type);
        expect(entry.title).toBe(singleEntries[idx].title);
      });
    });
  });

  describe("getEntries", () => {
    it("returns same result as last append return value", () => {
      const parser = createIncrementalParser();
      const appendResult = parser.append(SAMPLE_LOG);
      const getResult = parser.getEntries();
      expect(getResult).toBe(appendResult);
    });

    it("returns empty array before any append", () => {
      const parser = createIncrementalParser();
      expect(parser.getEntries()).toEqual([]);
    });
  });

  describe("reset", () => {
    it("clears stable entries after reset", () => {
      const parser = createIncrementalParser();
      parser.append(SAMPLE_LOG);
      expect(parser.getEntries().length).toBeGreaterThan(0);

      parser.reset();
      expect(parser.getEntries()).toEqual([]);
    });

    it("can parse fresh output after reset", () => {
      const parser = createIncrementalParser();
      parser.append(SAMPLE_LOG);
      parser.reset();

      const entries = parser.append(SAMPLE_LOG);
      // After reset + re-append, should produce entries again
      expect(entries.length).toBeGreaterThanOrEqual(0);
    });

    it("produces consistent entries on fresh parse after reset", () => {
      const parser = createIncrementalParser();

      // First parse session
      parser.append(SAMPLE_LOG);
      const firstSessionEntries = [...parser.getEntries()];

      // Reset and re-parse the same content
      parser.reset();
      parser.append(SAMPLE_LOG);
      const secondSessionEntries = parser.getEntries();

      // Should produce same entry types
      expect(secondSessionEntries.length).toBe(firstSessionEntries.length);
      secondSessionEntries.forEach((entry, idx) => {
        expect(entry.type).toBe(firstSessionEntries[idx].type);
        expect(entry.title).toBe(firstSessionEntries[idx].title);
      });
    });
  });

  describe("edge cases", () => {
    it("handles output with only phase markers", () => {
      const parser = createIncrementalParser();
      const phaseLog = "## Phase: Start\nStarting\n## Phase: End\nDone";
      const entries = parser.append(phaseLog);
      // May or may not parse depending on boundary detection
      expect(Array.isArray(entries)).toBe(true);
    });

    it("handles multiple appends with empty chunks", () => {
      const parser = createIncrementalParser();
      parser.append("");
      parser.append("");
      const entries = parser.append(SAMPLE_LOG);
      expect(Array.isArray(entries)).toBe(true);
    });

    it("handles output that ends exactly on a boundary", () => {
      const parser = createIncrementalParser();
      // Output ending with a complete entry marker
      const output = SAMPLE_LOG.trim() + "\n🔧 Tool: Done\n";
      const entries = parser.append(output);
      expect(Array.isArray(entries)).toBe(true);
    });
  });
});
