import { useState, useRef, useCallback, type KeyboardEvent } from "react";
import type { InputBarProps } from "../types.js";

const MIN_ROWS = 2;
const MAX_ROWS = 6;
const LINE_HEIGHT_PX = 20;
// Vertical padding inside the textarea (Tailwind py-2 = 8px top + 8px bottom).
// Must be added to the row-based height calculation, otherwise the textarea
// box is sized to the bare line content and the rendered height collapses
// to a single line of glyph regardless of `rows`.
const VERTICAL_PADDING_PX = 16;

function heightForRows(rows: number): number {
  return rows * LINE_HEIGHT_PX + VERTICAL_PADDING_PX;
}

export function InputBar({
  onSend,
  disabled = false,
  placeholder,
}: InputBarProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // scrollHeight includes padding, so subtract it before computing rows.
    const contentHeight = Math.max(0, el.scrollHeight - VERTICAL_PADDING_PX);
    const rows = Math.min(
      MAX_ROWS,
      Math.max(MIN_ROWS, Math.ceil(contentHeight / LINE_HEIGHT_PX)),
    );
    el.style.height = `${heightForRows(rows)}px`;
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    adjustHeight();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = `${heightForRows(MIN_ROWS)}px`;
    }
  };

  return (
    <div className="flex items-end gap-2 border-t border-border p-3 shrink-0">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? "Ask a question…"}
        disabled={disabled}
        rows={MIN_ROWS}
        className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 overflow-hidden"
        style={{
          lineHeight: `${LINE_HEIGHT_PX}px`,
          height: `${heightForRows(MIN_ROWS)}px`,
        }}
      />
      <button
        onClick={handleSend}
        disabled={disabled || !text.trim()}
        className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
        aria-label="Send message"
      >
        Send
      </button>
    </div>
  );
}
