import { useState } from "react";
import type { ToolGroupProps } from "../types.js";
import { getToolDescription } from "../utils/tool-descriptions.js";

export function ToolGroup({ messages }: ToolGroupProps) {
  const [expanded, setExpanded] = useState(false);

  const allComplete = messages.every((m) => m.toolStatus === "completed");
  const hasRunning = messages.some((m) => m.toolStatus === "running");
  const count = messages.length;

  const summary =
    count === 1
      ? getToolDescription(
          messages[0]?.toolName ?? "Tool",
          messages[0]?.toolInput,
        )
      : `Used ${count} tools`;

  return (
    <div className="my-1 text-xs">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors py-0.5"
      >
        <span
          className="inline-block transition-transform duration-150"
          style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
        <span className="font-mono">{summary}</span>
        {hasRunning && (
          <span className="ml-1 h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
        )}
        {allComplete && !hasRunning && (
          <span className="ml-1 text-green-500">✓</span>
        )}
      </button>

      {expanded && (
        <div className="ml-4 mt-1 space-y-1 border-l border-border pl-3">
          {messages.map((msg) => (
            <div key={msg.id} className="flex items-start gap-1.5">
              <span
                className={
                  msg.toolStatus === "running"
                    ? "text-amber-500"
                    : msg.toolStatus === "error"
                      ? "text-destructive"
                      : "text-green-500"
                }
              >
                {msg.toolStatus === "running"
                  ? "⋯"
                  : msg.toolStatus === "error"
                    ? "✗"
                    : "✓"}
              </span>
              <span className="text-foreground/80 font-mono">
                {getToolDescription(msg.toolName ?? "Tool", msg.toolInput)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
