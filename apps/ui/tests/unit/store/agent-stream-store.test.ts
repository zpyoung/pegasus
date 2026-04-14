/**
 * Unit tests for AgentStreamStore (Task 2: Wave 2 performance optimization)
 *
 * Validates:
 * - appendChunk: accumulates chunks, getOutput returns joined string
 * - markComplete: marks stream as no longer active
 * - clearStream: removes stream entry entirely
 * - isStreaming: reflects active-stream status correctly
 * - 50MB per-stream cap: drops oldest chunks when limit is exceeded
 * - getOutput cache: returns cached result until new chunk arrives
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useAgentStreamStore } from "../../../src/store/agent-stream-store";

const FEATURE_A = "feature-aaa";
const FEATURE_B = "feature-bbb";

function getStore() {
  return useAgentStreamStore.getState();
}

describe("AgentStreamStore", () => {
  beforeEach(() => {
    // Reset all streams between tests
    useAgentStreamStore.setState({ streams: {} });
  });

  // -------------------------------------------------------------------------
  // appendChunk
  // -------------------------------------------------------------------------
  describe("appendChunk", () => {
    it("adds the first chunk and makes output available via getOutput", () => {
      getStore().appendChunk(FEATURE_A, "hello ");

      expect(getStore().getOutput(FEATURE_A)).toBe("hello ");
    });

    it("joins multiple chunks in order", () => {
      getStore().appendChunk(FEATURE_A, "foo");
      getStore().appendChunk(FEATURE_A, "bar");
      getStore().appendChunk(FEATURE_A, "baz");

      expect(getStore().getOutput(FEATURE_A)).toBe("foobarbaz");
    });

    it("handles multiple independent features independently", () => {
      getStore().appendChunk(FEATURE_A, "A1");
      getStore().appendChunk(FEATURE_B, "B1");
      getStore().appendChunk(FEATURE_A, "A2");

      expect(getStore().getOutput(FEATURE_A)).toBe("A1A2");
      expect(getStore().getOutput(FEATURE_B)).toBe("B1");
    });

    it("handles empty string chunk", () => {
      getStore().appendChunk(FEATURE_A, "start");
      getStore().appendChunk(FEATURE_A, "");
      getStore().appendChunk(FEATURE_A, "end");

      expect(getStore().getOutput(FEATURE_A)).toBe("startend");
    });
  });

  // -------------------------------------------------------------------------
  // getOutput — caching
  // -------------------------------------------------------------------------
  describe("getOutput caching", () => {
    it("returns empty string for unknown feature", () => {
      expect(getStore().getOutput("nonexistent")).toBe("");
    });

    it("returns same string reference on repeated calls without new chunks", () => {
      getStore().appendChunk(FEATURE_A, "data");

      const first = getStore().getOutput(FEATURE_A);
      const second = getStore().getOutput(FEATURE_A);

      // Same cached string reference (or at least same value)
      expect(first).toBe(second);
    });

    it("returns updated output after new chunk appended", () => {
      getStore().appendChunk(FEATURE_A, "initial");
      expect(getStore().getOutput(FEATURE_A)).toBe("initial");

      getStore().appendChunk(FEATURE_A, " more");
      expect(getStore().getOutput(FEATURE_A)).toBe("initial more");
    });
  });

  // -------------------------------------------------------------------------
  // markComplete
  // -------------------------------------------------------------------------
  describe("markComplete", () => {
    it("marks an active stream as complete", () => {
      getStore().appendChunk(FEATURE_A, "output");
      expect(getStore().isStreaming(FEATURE_A)).toBe(true);

      getStore().markComplete(FEATURE_A);

      expect(getStore().isStreaming(FEATURE_A)).toBe(false);
    });

    it("preserves output after marking complete", () => {
      getStore().appendChunk(FEATURE_A, "final output");
      getStore().markComplete(FEATURE_A);

      expect(getStore().getOutput(FEATURE_A)).toBe("final output");
    });

    it("is a no-op when feature has no stream", () => {
      // Should not throw
      expect(() => getStore().markComplete("nonexistent")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // clearStream
  // -------------------------------------------------------------------------
  describe("clearStream", () => {
    it("removes the stream entry entirely", () => {
      getStore().appendChunk(FEATURE_A, "data");
      getStore().clearStream(FEATURE_A);

      expect(getStore().getOutput(FEATURE_A)).toBe("");
      expect(getStore().isStreaming(FEATURE_A)).toBe(false);
    });

    it("does not affect other features", () => {
      getStore().appendChunk(FEATURE_A, "A data");
      getStore().appendChunk(FEATURE_B, "B data");
      getStore().clearStream(FEATURE_A);

      expect(getStore().getOutput(FEATURE_B)).toBe("B data");
    });

    it("is a no-op when feature has no stream", () => {
      expect(() => getStore().clearStream("nonexistent")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // isStreaming
  // -------------------------------------------------------------------------
  describe("isStreaming", () => {
    it("returns false when no stream exists", () => {
      expect(getStore().isStreaming(FEATURE_A)).toBe(false);
    });

    it("returns true after first chunk appended", () => {
      getStore().appendChunk(FEATURE_A, "chunk");
      expect(getStore().isStreaming(FEATURE_A)).toBe(true);
    });

    it("returns false after markComplete", () => {
      getStore().appendChunk(FEATURE_A, "chunk");
      getStore().markComplete(FEATURE_A);
      expect(getStore().isStreaming(FEATURE_A)).toBe(false);
    });

    it("returns false after clearStream", () => {
      getStore().appendChunk(FEATURE_A, "chunk");
      getStore().clearStream(FEATURE_A);
      expect(getStore().isStreaming(FEATURE_A)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 50MB per-stream cap
  // -------------------------------------------------------------------------
  describe("50MB per-stream cap", () => {
    it("drops oldest chunks when total bytes exceed 50MB", () => {
      const MB = 1024 * 1024;
      const FIFTY_MB = 50 * MB;

      // Add 30MB in first chunk, then 30MB more — total 60MB exceeds cap
      const firstChunk = "a".repeat(30 * MB);
      const secondChunk = "b".repeat(30 * MB);

      getStore().appendChunk(FEATURE_A, firstChunk);
      getStore().appendChunk(FEATURE_A, secondChunk);

      const output = getStore().getOutput(FEATURE_A);

      // Total output should not exceed the 50MB cap
      expect(output.length).toBeLessThanOrEqual(FIFTY_MB);
      // The most recent chunk should be retained
      expect(output).toContain("b");
    });

    it("retains the most recent chunk when cap is exceeded", () => {
      const LARGE = 51 * 1024 * 1024; // 51MB — exceeds cap by itself
      const largeChunk = "x".repeat(LARGE);

      // A single oversized chunk: can't drop it (it's the only one), so we keep it
      getStore().appendChunk(FEATURE_A, largeChunk);

      // Second chunk triggers cap logic; large original chunk should be dropped
      getStore().appendChunk(FEATURE_A, "new content");

      const output = getStore().getOutput(FEATURE_A);
      // "new content" must be present as the most recently added chunk
      expect(output).toContain("new content");
    });
  });
});
