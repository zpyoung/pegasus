import { useRef } from 'react';
import type { MessageListProps } from '../types.js';
import { groupMessages } from '../utils/group-messages.js';
import { useAutoScroll } from '../hooks/use-auto-scroll.js';
import { MessageBubble } from './MessageBubble.js';
import { ToolGroup } from './ToolGroup.js';

export function MessageList({ messages, className }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useAutoScroll(containerRef, [messages]);

  const grouped = groupMessages(messages);

  return (
    <div
      ref={containerRef}
      className={`flex-1 overflow-y-auto space-y-3 p-3 ${className ?? ''}`}
    >
      {grouped.map((item, i) => {
        if (item.type === 'tool_group') {
          return <ToolGroup key={`tg-${i}`} messages={item.messages} />;
        }
        return <MessageBubble key={item.message.id} message={item.message} />;
      })}
    </div>
  );
}
