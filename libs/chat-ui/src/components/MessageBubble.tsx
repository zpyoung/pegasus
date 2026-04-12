import { memo } from "react";
import type { MessageBubbleProps } from "../types.js";

export const MessageBubble = memo(function MessageBubble({
  message,
}: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg px-3 py-2 bg-primary text-primary-foreground text-sm">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <div className="text-xs text-muted-foreground px-3 py-1 rounded-full bg-muted">
          {message.content}
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-lg px-3 py-2 bg-muted text-foreground text-sm whitespace-pre-wrap">
        {message.content || (
          <span className="text-muted-foreground animate-pulse">▋</span>
        )}
      </div>
    </div>
  );
});
