/**
 * Agent Stream Store - Bounded per-feature streaming state
 *
 * Replaces React Query as the in-flight output store during active streaming.
 * Each feature gets a bounded buffer of chunks that are joined on demand.
 *
 * On completion, the caller is responsible for writing the final output to
 * React Query cache for historical access (see use-agent-output-websocket.ts).
 */

import { create } from "zustand";

// ============================================================================
// Constants
// ============================================================================

/** Maximum bytes retained per stream before oldest chunks are dropped */
const MAX_BYTES_PER_STREAM = 50 * 1024 * 1024; // 50MB

// ============================================================================
// Types
// ============================================================================

interface StreamEntry {
  chunks: string[];
  totalBytes: number;
  isComplete: boolean;
  /** Cached joined output — null means cache is dirty */
  _cachedOutput: string | null;
}

// ============================================================================
// State Interface
// ============================================================================

interface AgentStreamState {
  streams: Record<string, StreamEntry>;
}

// ============================================================================
// Actions Interface
// ============================================================================

interface AgentStreamActions {
  /** Append a new chunk to the stream for a feature */
  appendChunk: (featureId: string, chunk: string) => void;
  /** Mark a feature's stream as complete */
  markComplete: (featureId: string) => void;
  /**
   * Get the full joined output for a feature.
   * Returns cached result if chunks haven't changed.
   */
  getOutput: (featureId: string) => string;
  /** Remove a feature's stream entirely */
  clearStream: (featureId: string) => void;
  /** Check if a feature currently has an active (non-complete) stream */
  isStreaming: (featureId: string) => boolean;
}

// ============================================================================
// Store
// ============================================================================

export const useAgentStreamStore = create<
  AgentStreamState & AgentStreamActions
>((set, get) => ({
  streams: {},

  appendChunk: (featureId, chunk) =>
    set((state) => {
      const existing = state.streams[featureId] ?? {
        chunks: [],
        totalBytes: 0,
        isComplete: false,
        _cachedOutput: null,
      };

      let chunks = [...existing.chunks, chunk];
      let totalBytes = existing.totalBytes + chunk.length;

      // Bounded: drop oldest chunks if we exceed the per-stream cap
      while (totalBytes > MAX_BYTES_PER_STREAM && chunks.length > 1) {
        const dropped = chunks.shift()!;
        totalBytes -= dropped.length;
      }

      return {
        streams: {
          ...state.streams,
          [featureId]: {
            chunks,
            totalBytes,
            isComplete: false,
            _cachedOutput: null, // Invalidate cache on new chunk
          },
        },
      };
    }),

  markComplete: (featureId) =>
    set((state) => {
      const existing = state.streams[featureId];
      if (!existing) return state;
      return {
        streams: {
          ...state.streams,
          [featureId]: {
            ...existing,
            isComplete: true,
          },
        },
      };
    }),

  getOutput: (featureId) => {
    const entry = get().streams[featureId];
    if (!entry) return "";

    // Return cached joined output if available
    if (entry._cachedOutput !== null) {
      return entry._cachedOutput;
    }

    // Join and cache
    const output = entry.chunks.join("");

    // Update cache in place (without triggering re-renders)
    // We mutate the cached field directly since it's a derived value,
    // not observable state. This avoids unnecessary set() calls.
    entry._cachedOutput = output;

    return output;
  },

  clearStream: (featureId) =>
    set((state) => {
      const { [featureId]: _removed, ...rest } = state.streams;
      return { streams: rest };
    }),

  isStreaming: (featureId) => {
    const entry = get().streams[featureId];
    return !!entry && !entry.isComplete;
  },
}));
