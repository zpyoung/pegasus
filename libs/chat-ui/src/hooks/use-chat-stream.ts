import { useState, useRef, useEffect, useCallback } from "react";
import type {
  ChatMessage,
  ChatStatus,
  ChatStreamEvent,
  ChatTransport,
} from "../types.js";

export interface UseChatStreamResult {
  messages: ChatMessage[];
  status: ChatStatus;
  send: (text: string) => Promise<void>;
  retry: () => void;
}

/**
 * RAF-batched chat streaming hook (snapshot-ref pattern).
 *
 * Text chunks from the server are buffered in a ref and flushed to React state
 * via requestAnimationFrame — this keeps rendering at ≤60fps even for streams
 * that arrive at 100+ tokens/sec without dropping frames.
 *
 * Stale closure issues are avoided by:
 *   1. Using setMessages(prev => ...) functional updater (always has latest state)
 *   2. Reading refs (not captured variables) inside the RAF callback
 */
export function useChatStream(
  transport: ChatTransport,
  initial: ChatMessage[],
): UseChatStreamResult {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const [status, setStatus] = useState<ChatStatus>("idle");

  // Refs for RAF-batched text streaming
  const textBufferRef = useRef("");
  const rafHandleRef = useRef<number | null>(null);
  const streamingMsgIdRef = useRef<string | null>(null);

  // Ref for last failed message (for retry)
  const lastSentTextRef = useRef<string | null>(null);

  // Force-flush the text buffer synchronously before non-text events
  const flushTextBuffer = useCallback(() => {
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }
    const text = textBufferRef.current;
    textBufferRef.current = "";
    if (text && streamingMsgIdRef.current) {
      const msgId = streamingMsgIdRef.current;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId ? { ...m, content: m.content + text } : m,
        ),
      );
    }
  }, []);

  // Subscribe to transport stream events
  useEffect(() => {
    const unsubscribe = transport.subscribeStream((event: ChatStreamEvent) => {
      switch (event.type) {
        case "started": {
          const assistantId = crypto.randomUUID();
          streamingMsgIdRef.current = assistantId;
          textBufferRef.current = "";
          setStatus("streaming");
          setMessages((prev) => [
            ...prev,
            {
              id: assistantId,
              role: "assistant",
              content: "",
              timestamp: Date.now(),
            },
          ]);
          break;
        }

        case "text_chunk": {
          textBufferRef.current += event.text;
          if (rafHandleRef.current === null) {
            const msgId = streamingMsgIdRef.current;
            rafHandleRef.current = requestAnimationFrame(() => {
              rafHandleRef.current = null;
              const text = textBufferRef.current;
              textBufferRef.current = "";
              if (!text || !msgId) return;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === msgId ? { ...m, content: m.content + text } : m,
                ),
              );
            });
          }
          break;
        }

        case "tool_call": {
          flushTextBuffer();
          const toolMsgId = `tool-${event.toolId}`;
          setMessages((prev) => [
            ...prev,
            {
              id: toolMsgId,
              role: "tool",
              content: "",
              toolName: event.toolName,
              toolInput: event.input,
              toolId: event.toolId,
              toolStatus: "running",
              timestamp: Date.now(),
            },
          ]);
          break;
        }

        case "tool_complete": {
          setMessages((prev) =>
            prev.map((m) =>
              m.toolId === event.toolId
                ? { ...m, toolStatus: "completed" as const }
                : m,
            ),
          );
          break;
        }

        case "message_complete": {
          flushTextBuffer();
          streamingMsgIdRef.current = null;
          setStatus("idle");
          break;
        }

        case "error": {
          flushTextBuffer();
          streamingMsgIdRef.current = null;
          setStatus("error");
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `Error: ${event.message}`,
              timestamp: Date.now(),
            },
          ]);
          break;
        }
      }
    });

    return () => {
      unsubscribe();
      // Cancel any pending RAF on unmount
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = null;
      }
    };
  }, [transport, flushTextBuffer]);

  const send = useCallback(
    async (text: string) => {
      if (status === "streaming") return;
      lastSentTextRef.current = text;
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: text,
          timestamp: Date.now(),
        },
      ]);
      await transport.sendMessage(text);
    },
    [transport, status],
  );

  const retry = useCallback(() => {
    const lastText = lastSentTextRef.current;
    if (lastText) {
      setStatus("idle");
      void send(lastText);
    }
  }, [send]);

  return { messages, status, send, retry };
}
