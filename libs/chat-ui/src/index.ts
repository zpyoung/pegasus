// Types
export type {
  ChatRole,
  ChatMessage,
  ChatStreamEvent,
  ChatTransport,
  ChatStatus,
  GroupedItem,
  ChatPanelProps,
  MessageListProps,
  MessageBubbleProps,
  ToolGroupProps,
  InputBarProps,
  EmptyStateProps,
} from './types.js';

// Components
export { ChatPanel } from './components/ChatPanel.js';
export { MessageList } from './components/MessageList.js';
export { MessageBubble } from './components/MessageBubble.js';
export { ToolGroup } from './components/ToolGroup.js';
export { InputBar } from './components/InputBar.js';
export { EmptyState } from './components/EmptyState.js';

// Hooks
export { useChatStream } from './hooks/use-chat-stream.js';
export { useAutoScroll } from './hooks/use-auto-scroll.js';

// Utilities
export { groupMessages } from './utils/group-messages.js';
export { getToolDescription } from './utils/tool-descriptions.js';
