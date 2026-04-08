import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatStream } from '../../src/hooks/use-chat-stream.js';
import type { ChatTransport, ChatStreamEvent, ChatMessage } from '../../src/types.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a mock transport with a manually-triggerable stream.
 * Call `emit(event)` to push an event to all active subscribers.
 */
function createMockTransport() {
  const handlers: Array<(e: ChatStreamEvent) => void> = [];
  const sendMessage = vi.fn().mockResolvedValue(undefined);

  const transport: ChatTransport = {
    sendMessage,
    subscribeStream: (handler) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      };
    },
  };

  function emit(event: ChatStreamEvent) {
    handlers.forEach((h) => h(event));
  }

  return { transport, sendMessage, emit, handlers };
}

// ============================================================================
// Tests
// ============================================================================

describe('useChatStream', () => {
  beforeEach(() => {
    // Use fake timers so requestAnimationFrame callbacks run synchronously
    // when we call vi.runAllTimers() / vi.advanceTimersByTime()
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('returns initial messages passed to the hook', () => {
      const initialMessages: ChatMessage[] = [
        { id: 'm1', role: 'user', content: 'Hello', timestamp: 1000 },
      ];
      const { transport } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, initialMessages));

      expect(result.current.messages).toEqual(initialMessages);
    });

    it('starts with status=idle', () => {
      const { transport } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));
      expect(result.current.status).toBe('idle');
    });

    it('starts with empty messages when initial is empty', () => {
      const { transport } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));
      expect(result.current.messages).toHaveLength(0);
    });
  });

  describe('send()', () => {
    it('adds a user message and calls transport.sendMessage', async () => {
      const { transport, sendMessage } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      await act(async () => {
        await result.current.send('Hello world');
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]).toMatchObject({
        role: 'user',
        content: 'Hello world',
      });
      expect(sendMessage).toHaveBeenCalledWith('Hello world');
    });

    it('does not send if status is streaming', async () => {
      const { transport, sendMessage, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      // Put into streaming state
      act(() => {
        emit({ type: 'started' });
      });

      expect(result.current.status).toBe('streaming');

      await act(async () => {
        await result.current.send('Ignored message');
      });

      expect(sendMessage).not.toHaveBeenCalled();
      // No user message added
      expect(result.current.messages.filter((m) => m.role === 'user')).toHaveLength(0);
    });
  });

  describe('started event', () => {
    it('sets status to streaming', () => {
      const { transport, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        emit({ type: 'started' });
      });

      expect(result.current.status).toBe('streaming');
    });

    it('adds an empty assistant message placeholder', () => {
      const { transport, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        emit({ type: 'started' });
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]).toMatchObject({
        role: 'assistant',
        content: '',
      });
    });
  });

  describe('text_chunk event (RAF-batched)', () => {
    it('accumulates text into the streaming assistant message after RAF fires', () => {
      const { transport, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        emit({ type: 'started' });
        emit({ type: 'text_chunk', text: 'Hello' });
        emit({ type: 'text_chunk', text: ' world' });
        // RAF has not fired yet — message should still be empty
      });

      // Before RAF fires
      expect(result.current.messages[0].content).toBe('');

      // Advance RAF
      act(() => {
        vi.runAllTimers();
      });

      expect(result.current.messages[0].content).toBe('Hello world');
    });

    it('batches multiple chunks into a single RAF call', () => {
      const { transport, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        emit({ type: 'started' });
        emit({ type: 'text_chunk', text: 'A' });
        emit({ type: 'text_chunk', text: 'B' });
        emit({ type: 'text_chunk', text: 'C' });
      });

      act(() => {
        vi.runAllTimers();
      });

      expect(result.current.messages[0].content).toBe('ABC');
    });
  });

  describe('tool_call event', () => {
    it('adds a tool message with running status', () => {
      const { transport, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        emit({ type: 'started' });
        emit({ type: 'tool_call', toolName: 'Read', toolId: 'tool-1', input: '{"path":"/foo"}' });
      });

      const toolMsg = result.current.messages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg).toMatchObject({
        role: 'tool',
        toolName: 'Read',
        toolId: 'tool-1',
        toolInput: '{"path":"/foo"}',
        toolStatus: 'running',
      });
    });

    it('flushes pending text buffer before adding tool message', () => {
      const { transport, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        emit({ type: 'started' });
        emit({ type: 'text_chunk', text: 'Thinking...' });
        // tool_call should flush the text before adding itself
        emit({ type: 'tool_call', toolName: 'Grep', toolId: 'tool-2', input: '{}' });
      });

      // Text should be flushed synchronously (not waiting for RAF)
      const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg?.content).toBe('Thinking...');
    });
  });

  describe('tool_complete event', () => {
    it('updates the matching tool message status to completed', () => {
      const { transport, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        emit({ type: 'started' });
        emit({ type: 'tool_call', toolName: 'Read', toolId: 'tid-1', input: '' });
        emit({ type: 'tool_complete', toolId: 'tid-1' });
      });

      const toolMsg = result.current.messages.find((m) => m.toolId === 'tid-1');
      expect(toolMsg?.toolStatus).toBe('completed');
    });

    it('does not affect other tool messages', () => {
      const { transport, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        emit({ type: 'started' });
        emit({ type: 'tool_call', toolName: 'Read', toolId: 'tid-1', input: '' });
        emit({ type: 'tool_call', toolName: 'Grep', toolId: 'tid-2', input: '' });
        emit({ type: 'tool_complete', toolId: 'tid-1' });
      });

      const tool2 = result.current.messages.find((m) => m.toolId === 'tid-2');
      expect(tool2?.toolStatus).toBe('running');
    });
  });

  describe('message_complete event', () => {
    it('sets status back to idle', () => {
      const { transport, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        emit({ type: 'started' });
        emit({ type: 'message_complete' });
      });

      expect(result.current.status).toBe('idle');
    });

    it('flushes pending text before completing', () => {
      const { transport, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        emit({ type: 'started' });
        emit({ type: 'text_chunk', text: 'Final text' });
        emit({ type: 'message_complete' });
      });

      const assistantMsg = result.current.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg?.content).toBe('Final text');
    });
  });

  describe('error event', () => {
    it('sets status to error', () => {
      const { transport, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        emit({ type: 'started' });
        emit({ type: 'error', message: 'Connection lost' });
      });

      expect(result.current.status).toBe('error');
    });

    it('adds a system message with the error text', () => {
      const { transport, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        emit({ type: 'started' });
        emit({ type: 'error', message: 'Connection lost' });
      });

      const errMsg = result.current.messages.find((m) => m.role === 'system');
      expect(errMsg?.content).toBe('Error: Connection lost');
    });
  });

  describe('retry()', () => {
    it('resends the last message after an error', async () => {
      const { transport, sendMessage, emit } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      // Send a message and simulate an error
      await act(async () => {
        await result.current.send('Please help');
      });
      act(() => {
        emit({ type: 'started' });
        emit({ type: 'error', message: 'Network error' });
      });

      expect(result.current.status).toBe('error');

      // Retry
      await act(async () => {
        result.current.retry();
      });

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage).toHaveBeenLastCalledWith('Please help');
    });

    it('does nothing if no message was previously sent', () => {
      const { transport, sendMessage } = createMockTransport();
      const { result } = renderHook(() => useChatStream(transport, []));

      act(() => {
        result.current.retry();
      });

      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('cleanup on unmount', () => {
    it('calls unsubscribe when unmounted', () => {
      const { transport, handlers } = createMockTransport();
      const { unmount } = renderHook(() => useChatStream(transport, []));

      expect(handlers).toHaveLength(1);
      unmount();
      expect(handlers).toHaveLength(0);
    });
  });
});
