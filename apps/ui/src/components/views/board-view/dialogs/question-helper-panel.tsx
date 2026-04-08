'use client';

/**
 * QuestionHelperPanel — transport adapter wiring @pegasus/chat-ui's ChatPanel
 * to the HTTP + WebSocket APIs for the ephemeral helper sub-agent.
 *
 * Responsibility: map HelperChatPayload → ChatStreamEvent and forward user
 * messages via HTTP.  No streaming state or rendering logic lives here.
 */

import { useMemo, useState, useEffect } from 'react';
import { ChatPanel } from '@pegasus/chat-ui';
import type { ChatTransport, ChatStreamEvent, ChatMessage } from '@pegasus/chat-ui';
import type { HelperChatPayload, PhaseModelEntry } from '@pegasus/types';
import { getHttpApiClient } from '@/lib/http-api-client';
import { useAppStore } from '@/store/app-store';
import { AgentModelSelector } from '@/components/views/agent-view/shared/agent-model-selector';

interface QuestionHelperPanelProps {
  featureId: string;
  projectPath: string;
}

/** Fallback model when the user has not yet picked one for this feature. */
const DEFAULT_HELPER_MODEL: PhaseModelEntry = { model: 'claude-sonnet' };

/** Convert server ConversationMessage[] to ChatMessage[] for initialMessages. */
function toInitialMessages(
  history: Array<{ role: string; content: string }>
): ChatMessage[] {
  return history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      id: crypto.randomUUID(),
      role: m.role as 'user' | 'assistant',
      content: m.content,
      timestamp: Date.now(),
    }));
}

/**
 * Map a raw HelperChatPayload (from the WebSocket event bus) to the
 * ChatStreamEvent shape expected by @pegasus/chat-ui's useChatStream hook.
 */
function mapPayloadToStreamEvent(payload: HelperChatPayload): ChatStreamEvent | null {
  switch (payload.kind) {
    case 'started':
      return { type: 'started' };
    case 'delta':
      return { type: 'text_chunk', text: payload.text };
    case 'tool_call':
      return {
        type: 'tool_call',
        toolName: payload.toolName,
        toolId: payload.toolId,
        input: payload.input,
      };
    case 'tool_complete':
      return { type: 'tool_complete', toolId: payload.toolId };
    case 'complete':
      return { type: 'message_complete' };
    case 'error':
      return { type: 'error', message: payload.message };
    case 'session_terminated':
      // No corresponding ChatStreamEvent — silently ignore.
      return null;
    default:
      return null;
  }
}

export function QuestionHelperPanel({ featureId, projectPath }: QuestionHelperPanelProps) {
  const api = getHttpApiClient();

  // Narrow Zustand selectors: read stored model for this feature + the setter.
  // Using separate selectors keeps re-renders scoped — unrelated state changes
  // in the store won't trigger this component.
  const storedModel = useAppStore(
    (state) => state.helperModelByFeature[featureId] ?? null
  );
  const setHelperModelForFeature = useAppStore(
    (state) => state.setHelperModelForFeature
  );
  const effectiveModel: PhaseModelEntry = storedModel ?? DEFAULT_HELPER_MODEL;

  // FR-005: restore in-memory history on mount (e.g. after a React remount
  // within the same open dialog session). Defer rendering ChatPanel until the
  // history fetch completes so useChatStream initializes with correct state.
  // Session is terminated on dialog close (FR-006), so this only helps within
  // a continuous dialog session (not across close/reopen cycles).
  const [initialMessages, setInitialMessages] = useState<ChatMessage[] | null>(null);
  useEffect(() => {
    api.questionHelper.getHistory(featureId).then((res) => {
      if (res.success && res.history && res.history.length > 0) {
        setInitialMessages(toInitialMessages(res.history));
      } else {
        setInitialMessages([]);
      }
    }).catch(() => {
      setInitialMessages([]);
    });
    // Only run on mount (featureId is stable for the lifetime of the panel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Transport is stable across model changes — do NOT add `effectiveModel`
  // to the dep array, otherwise the stream subscription tears down every
  // time the user picks a different model. Instead, read the latest
  // selection from the store *at send time* via getState() so the full
  // PhaseModelEntry (model + thinkingLevel + providerId) is forwarded.
  const transport: ChatTransport = useMemo(
    () => ({
      sendMessage: async (text: string) => {
        const currentEntry =
          useAppStore.getState().helperModelByFeature[featureId] ?? DEFAULT_HELPER_MODEL;
        await api.questionHelper.sendMessage(featureId, text, projectPath, currentEntry);
      },

      subscribeStream: (handler: (event: ChatStreamEvent) => void) => {
        return api.questionHelper.onHelperChatEvent((raw) => {
          const event = raw as { featureId: string; payload: HelperChatPayload };
          // Filter to events for THIS feature only
          if (event.featureId !== featureId) return;
          const mapped = mapPayloadToStreamEvent(event.payload);
          if (mapped) handler(mapped);
        });
      },
    }),
    [api, featureId, projectPath]
  );

  // Don't render until history fetch completes (avoids useChatStream
  // initializing with stale empty state before history arrives).
  if (initialMessages === null) {
    return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">Loading…</div>;
  }

  return (
    <ChatPanel
      transport={transport}
      initialMessages={initialMessages}
      className="h-full"
      header={
        <AgentModelSelector
          value={effectiveModel}
          onChange={(entry) => setHelperModelForFeature(featureId, entry)}
        />
      }
      emptyState={
        <div className="space-y-1">
          <p className="font-medium text-sm">Ask about the codebase</p>
          <p className="text-xs">
            I can read files, search for symbols, and help you understand the code to answer the
            agent&apos;s questions.
          </p>
        </div>
      }
    />
  );
}
