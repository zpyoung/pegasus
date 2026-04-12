import type { ReactNode, RefObject } from "react";

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  toolName?: string;
  toolInput?: string;
  toolId?: string;
  toolStatus?: "running" | "completed" | "error";
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export type ChatStreamEvent =
  | { type: "started" }
  | { type: "text_chunk"; text: string }
  | { type: "tool_call"; toolName: string; toolId: string; input: string }
  | { type: "tool_complete"; toolId: string }
  | { type: "message_complete" }
  | { type: "error"; message: string };

export interface ChatTransport {
  sendMessage(text: string): Promise<void>;
  subscribeStream(handler: (event: ChatStreamEvent) => void): () => void;
}

export type ChatStatus = "idle" | "streaming" | "error";

export type GroupedItem =
  | { type: "message"; message: ChatMessage }
  | { type: "tool_group"; messages: ChatMessage[] };

export interface ChatPanelProps {
  transport: ChatTransport;
  initialMessages?: ChatMessage[];
  onMessagesChange?: (messages: ChatMessage[]) => void;
  emptyState?: ReactNode;
  placeholder?: string;
  width?: number | string;
  maxHeight?: number;
  className?: string;
  /**
   * Optional content rendered inside the header bar, to the right of the
   * "Helper Chat" label (e.g. a model selector).
   */
  header?: ReactNode;
}

export interface MessageListProps {
  messages: ChatMessage[];
  className?: string;
}

export interface MessageBubbleProps {
  message: ChatMessage;
}

export interface ToolGroupProps {
  messages: ChatMessage[];
}

export interface InputBarProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export interface EmptyStateProps {
  children?: ReactNode;
}

export interface UseAutoScrollOptions {
  ref: RefObject<HTMLElement | null>;
  deps: unknown[];
}
