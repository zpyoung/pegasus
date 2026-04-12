import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { writeToClipboard } from "@/lib/clipboard-utils";

interface TaskIdCopyProps {
  taskId: string;
  className?: string;
  compact?: boolean;
}

async function copyTaskId(
  taskId: string,
): Promise<{ ok: boolean; denied: boolean }> {
  if (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(taskId);
      return { ok: true, denied: false };
    } catch (error) {
      if (error instanceof Error && error.name === "NotAllowedError") {
        const fallbackOk = await writeToClipboard(taskId);
        return { ok: fallbackOk, denied: !fallbackOk };
      }
    }
  }

  const ok = await writeToClipboard(taskId);
  return { ok, denied: !ok };
}

export const TaskIdCopy = memo(function TaskIdCopy({
  taskId,
  className,
  compact = false,
}: TaskIdCopyProps) {
  const [copied, setCopied] = useState(false);
  const resetTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current) {
        window.clearTimeout(resetTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();

      const result = await copyTaskId(taskId);

      if (result.ok) {
        setCopied(true);
        if (resetTimeoutRef.current) {
          window.clearTimeout(resetTimeoutRef.current);
        }
        resetTimeoutRef.current = window.setTimeout(() => {
          setCopied(false);
          resetTimeoutRef.current = null;
        }, 1500);
        toast.success("Task ID copied", { description: taskId });
        return;
      }

      toast.error(
        result.denied ? "Clipboard access denied" : "Failed to copy task ID",
        {
          description: result.denied
            ? "Allow clipboard access in your browser, then try again."
            : "Your browser could not copy the task ID.",
        },
      );
    },
    [taskId],
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleCopy}
          onPointerDown={(event) => event.stopPropagation()}
          className={cn(
            "group inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-2 py-1 text-left transition-colors",
            "hover:border-primary/40 hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            compact ? "text-[10px]" : "text-[11px]",
            className,
          )}
          aria-label={`Copy task ID ${taskId}`}
          data-testid={`copy-task-id-${taskId}`}
        >
          {!compact && (
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
              Task ID
            </span>
          )}
          <span className="min-w-0 truncate font-mono text-[0.95em] text-muted-foreground group-hover:text-foreground">
            {taskId}
          </span>
          {copied ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-[var(--status-success)]" />
          ) : (
            <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {copied ? "Copied" : "Copy task ID"}
      </TooltipContent>
    </Tooltip>
  );
});
