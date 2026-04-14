/**
 * Custom hook for handling WebSocket events in AgentOutputModal
 * Centralizes WebSocket event logic to reduce duplication
 */

import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getElectronAPI } from "@/lib/electron";
import { useAgentOutput } from "@/hooks/queries";
import {
  formatAutoModeEventContent,
  formatBacklogPlanEventContent,
} from "@/components/views/board-view/dialogs/event-content-formatter";
import type { AutoModeEvent } from "@/types/electron";
import type { BacklogPlanEvent } from "@pegasus/types";
import { MODAL_CONSTANTS } from "@/components/views/board-view/dialogs/agent-output-modal.constants";
import { useAgentStreamStore } from "@/store/agent-stream-store";
import { queryKeys } from "@/lib/query-keys";

/** Milliseconds to buffer chunks before flushing to the store */
const FLUSH_INTERVAL_MS = 50;

interface UseAgentOutputWebSocketProps {
  open: boolean;
  featureId: string;
  isBacklogPlan: boolean;
  projectPath: string;
  onFeatureComplete?: (passes: boolean) => void;
}

/**
 * Lightweight hook that buffers incoming WebSocket chunks and flushes them
 * to AgentStreamStore in batches every FLUSH_INTERVAL_MS.
 *
 * @param featureId - Feature ID to write chunks to
 * @returns `onChunk` callback to call with each new piece of content
 */
export function useAgentOutputStream(featureId: string): {
  onChunk: (chunk: string) => void;
} {
  const bufferRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appendChunk = useAgentStreamStore((s) => s.appendChunk);

  const flush = useCallback(() => {
    if (bufferRef.current.length === 0) return;
    const combined = bufferRef.current.join("");
    bufferRef.current = [];
    appendChunk(featureId, combined);
  }, [featureId, appendChunk]);

  const onChunk = useCallback(
    (chunk: string) => {
      bufferRef.current.push(chunk);
      if (!timerRef.current) {
        timerRef.current = setTimeout(() => {
          flush();
          timerRef.current = null;
        }, FLUSH_INTERVAL_MS);
      }
    },
    [flush],
  );

  // Flush remaining buffer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      flush();
    };
  }, [flush]);

  return { onChunk };
}

export function useAgentOutputWebSocket({
  open,
  featureId,
  isBacklogPlan,
  projectPath,
  onFeatureComplete,
}: UseAgentOutputWebSocketProps) {
  const queryClient = useQueryClient();
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const appendChunk = useAgentStreamStore((s) => s.appendChunk);
  const markComplete = useAgentStreamStore((s) => s.markComplete);
  const clearStream = useAgentStreamStore((s) => s.clearStream);

  // Buffer refs for 50ms batching
  const bufferRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use React Query for initial output loading (historical/completed features)
  const { data: initialOutput = "", isLoading } = useAgentOutput(
    projectPath,
    featureId,
    {
      enabled: open && !!projectPath,
    },
  );

  // Subscribe to the store for streamed content
  const streamedContent = useAgentStreamStore(
    useCallback((s) => s.getOutput(featureId), [featureId]),
  );

  // Combine initial output with streamed content
  const output = initialOutput + streamedContent;

  const flush = useCallback(() => {
    if (bufferRef.current.length === 0) return;
    const combined = bufferRef.current.join("");
    bufferRef.current = [];
    appendChunk(featureId, combined);
  }, [featureId, appendChunk]);

  // Handle auto mode events
  const handleAutoModeEvent = useCallback(
    (event: AutoModeEvent) => {
      // Filter events for this specific feature only
      if ("featureId" in event && event.featureId !== featureId) {
        return;
      }

      const newContent = formatAutoModeEventContent(event);

      if (newContent) {
        // Buffer the chunk for batched flush to the store
        bufferRef.current.push(newContent);
        if (!timerRef.current) {
          timerRef.current = setTimeout(() => {
            flush();
            timerRef.current = null;
          }, FLUSH_INTERVAL_MS);
        }
      }

      // Handle feature completion
      if (event.type === "auto_mode_feature_complete") {
        // Flush remaining buffer immediately
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        flush();

        // Mark stream complete and write final output to React Query cache
        markComplete(featureId);
        const finalOutput = useAgentStreamStore.getState().getOutput(featureId);
        if (projectPath) {
          queryClient.setQueryData(
            queryKeys.features.agentOutput(projectPath, featureId),
            initialOutput + finalOutput,
          );
        }
        clearStream(featureId);

        if (event.passes && onFeatureComplete) {
          // Clear any existing timeout first
          if (closeTimeoutRef.current) {
            clearTimeout(closeTimeoutRef.current);
          }

          // Set timeout to close modal after delay
          closeTimeoutRef.current = setTimeout(() => {
            onFeatureComplete(true);
          }, MODAL_CONSTANTS.MODAL_CLOSE_DELAY_MS);
        }
      }
    },
    [
      featureId,
      projectPath,
      initialOutput,
      flush,
      markComplete,
      clearStream,
      queryClient,
      onFeatureComplete,
    ],
  );

  // Handle backlog plan events
  const handleBacklogPlanEvent = useCallback(
    (event: BacklogPlanEvent) => {
      const newContent = formatBacklogPlanEventContent(event);

      if (newContent) {
        bufferRef.current.push(newContent);
        if (!timerRef.current) {
          timerRef.current = setTimeout(() => {
            flush();
            timerRef.current = null;
          }, FLUSH_INTERVAL_MS);
        }
      }
    },
    [flush],
  );

  // Set up WebSocket event listeners
  useEffect(() => {
    if (!open) {
      // Clean up timeout when modal closes
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = undefined;
      }
      return;
    }

    const api = getElectronAPI();
    if (!api) return;

    let unsubscribe: (() => void) | undefined;

    if (isBacklogPlan) {
      // Handle backlog plan events
      if (api.backlogPlan) {
        unsubscribe = api.backlogPlan.onEvent((data: unknown) => {
          if (
            data !== null &&
            typeof data === "object" &&
            "type" in data &&
            typeof (data as { type: unknown }).type === "string"
          ) {
            handleBacklogPlanEvent(data as BacklogPlanEvent);
          }
        });
      }
    } else {
      // Handle auto mode events
      if (api.autoMode) {
        unsubscribe = api.autoMode.onEvent(handleAutoModeEvent);
      }
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
      unsubscribe?.();
    };
  }, [
    open,
    featureId,
    isBacklogPlan,
    handleAutoModeEvent,
    handleBacklogPlanEvent,
  ]);

  // Reset stream when modal opens or featureId changes
  useEffect(() => {
    if (open) {
      bufferRef.current = [];
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      clearStream(featureId);
    }
  }, [open, featureId, clearStream]);

  return {
    output,
    isLoading,
    streamedContent,
  };
}
