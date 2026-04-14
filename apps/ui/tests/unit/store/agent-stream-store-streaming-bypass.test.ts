/**
 * Tests for the streaming bypass condition used in use-query-invalidation.ts (Task 4)
 *
 * The bypass logic reads: `useAgentStreamStore.getState().isStreaming(featureId)`
 * and skips React Query invalidation for `auto_mode_progress` events when a
 * feature's stream is active.
 *
 * These tests validate that the `isStreaming` predicate used by the bypass
 * behaves correctly across the full stream lifecycle.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useAgentStreamStore } from "../../../src/store/agent-stream-store";

const FEATURE_ID = "feat-streaming-123";

function getState() {
  return useAgentStreamStore.getState();
}

describe("AgentStreamStore: streaming bypass predicate", () => {
  beforeEach(() => {
    useAgentStreamStore.setState({ streams: {} });
  });

  it("isStreaming returns false before any data arrives (no bypass)", () => {
    // Before a stream starts: progress events should still trigger invalidation
    expect(getState().isStreaming(FEATURE_ID)).toBe(false);
  });

  it("isStreaming returns true once first chunk arrives (bypass active)", () => {
    // As soon as the first WebSocket chunk lands in the store, progress events
    // should be bypassed — the store is already delivering output to the UI.
    getState().appendChunk(FEATURE_ID, "first output chunk...");

    expect(getState().isStreaming(FEATURE_ID)).toBe(true);
  });

  it("isStreaming returns true throughout active streaming (bypass persists)", () => {
    // Multiple chunks simulate a real streaming session
    getState().appendChunk(FEATURE_ID, "chunk 1\n");
    getState().appendChunk(FEATURE_ID, "chunk 2\n");
    getState().appendChunk(FEATURE_ID, "chunk 3\n");

    expect(getState().isStreaming(FEATURE_ID)).toBe(true);
  });

  it("isStreaming returns false after markComplete (bypass ends)", () => {
    // When the feature completes, progress events resume normal invalidation
    getState().appendChunk(FEATURE_ID, "final output");
    getState().markComplete(FEATURE_ID);

    expect(getState().isStreaming(FEATURE_ID)).toBe(false);
  });

  it("isStreaming returns false after clearStream (bypass ends)", () => {
    // When the stream is cleared (e.g., modal closes), bypass is deactivated
    getState().appendChunk(FEATURE_ID, "some output");
    getState().clearStream(FEATURE_ID);

    expect(getState().isStreaming(FEATURE_ID)).toBe(false);
  });

  it("bypass is independent per feature — only streaming feature is bypassed", () => {
    const STREAMING = "feat-active";
    const IDLE = "feat-idle";

    getState().appendChunk(STREAMING, "streaming output");

    // Streaming feature: bypass active
    expect(getState().isStreaming(STREAMING)).toBe(true);
    // Idle feature: no bypass — invalidation proceeds normally
    expect(getState().isStreaming(IDLE)).toBe(false);
  });

  it("bypass deactivates for one feature without affecting another", () => {
    const FEATURE_1 = "feat-one";
    const FEATURE_2 = "feat-two";

    getState().appendChunk(FEATURE_1, "output 1");
    getState().appendChunk(FEATURE_2, "output 2");

    // Both streaming
    expect(getState().isStreaming(FEATURE_1)).toBe(true);
    expect(getState().isStreaming(FEATURE_2)).toBe(true);

    // Complete one stream
    getState().markComplete(FEATURE_1);

    // Only feature 1 deactivated
    expect(getState().isStreaming(FEATURE_1)).toBe(false);
    expect(getState().isStreaming(FEATURE_2)).toBe(true);
  });
});
