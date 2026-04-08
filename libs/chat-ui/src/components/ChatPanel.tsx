import type { ChatPanelProps } from '../types.js';
import { useChatStream } from '../hooks/use-chat-stream.js';
import { MessageList } from './MessageList.js';
import { InputBar } from './InputBar.js';
import { EmptyState } from './EmptyState.js';

export function ChatPanel({
  transport,
  initialMessages = [],
  onMessagesChange,
  emptyState,
  placeholder,
  width,
  maxHeight,
  className,
  header,
}: ChatPanelProps) {
  const { messages, status, send, retry } = useChatStream(transport, initialMessages);

  // Notify parent of message changes
  if (onMessagesChange) {
    onMessagesChange(messages);
  }

  // Build inline style. `maxHeight` is applied to the OUTER container so the
  // panel can be capped in standalone usage. When the consumer provides
  // `h-full` (or any other height) via `className`, the inner flex layout
  // takes over and the InputBar naturally sticks to the bottom.
  const style: React.CSSProperties = {};
  if (width !== undefined) style.width = typeof width === 'number' ? `${width}px` : width;
  if (maxHeight !== undefined)
    style.maxHeight = typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight;

  return (
    <div
      className={`flex flex-col border border-border rounded-lg bg-background overflow-hidden ${className ?? ''}`}
      style={style}
    >
      {/* Header. Optional `header` slot sits to the right of the label so
          consumers can embed controls (e.g. a model selector) without
          restructuring the layout. Panel visibility is controlled by the
          surrounding dialog — this component does not self-collapse. */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30 shrink-0">
        <span className="text-sm font-medium text-foreground shrink-0">Helper Chat</span>
        {header && <div className="flex items-center min-w-0 flex-1 justify-end">{header}</div>}
      </div>

      {/* Message area — flex-1 + min-h-0 so it expands to fill the panel
          and pushes the InputBar to the bottom. min-h-0 is required so
          the flex item can shrink below its content's intrinsic size,
          otherwise overflow-y on MessageList won't engage. */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {messages.length === 0 ? (
          <EmptyState>{emptyState}</EmptyState>
        ) : (
          <MessageList messages={messages} />
        )}
      </div>

      {/* Error retry banner */}
      {status === 'error' && (
        <div className="flex items-center gap-2 px-3 py-2 bg-destructive/10 border-t border-destructive/20 text-xs text-destructive shrink-0">
          <span>Stream interrupted</span>
          <button
            onClick={retry}
            className="underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Input bar (shrink-0 inside InputBar itself ensures it can't
          be squashed by flex distribution) */}
      <InputBar
        onSend={(text) => void send(text)}
        disabled={status === 'streaming'}
        placeholder={placeholder}
      />
    </div>
  );
}
