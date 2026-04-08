import type { ChatMessage, GroupedItem } from '../types.js';

/**
 * Groups consecutive tool messages that appear between assistant messages.
 * Returns a flat array of grouped items: either a single message or a tool group.
 */
export function groupMessages(messages: ChatMessage[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let toolBuffer: ChatMessage[] = [];

  const flushTools = () => {
    if (toolBuffer.length > 0) {
      result.push({ type: 'tool_group', messages: [...toolBuffer] });
      toolBuffer = [];
    }
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      toolBuffer.push(message);
    } else {
      flushTools();
      result.push({ type: 'message', message });
    }
  }

  flushTools();
  return result;
}
