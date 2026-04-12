/**
 * PromoteModal — Confirmation dialog for promoting a ready Idea to a Feature.
 * Exposes all options of the existing convertToFeature API.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ArrowUpRight } from "lucide-react";
import type { Idea, ConvertToFeatureOptions } from "@pegasus/types";

interface PromoteModalProps {
  idea: Idea | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPromote: (ideaId: string, options: ConvertToFeatureOptions) => void;
  isConverting: boolean;
}

const COLUMN_OPTIONS = [
  { value: "backlog", label: "Backlog" },
  { value: "in_progress", label: "In Progress" },
] as const;

export function PromoteModal({
  idea,
  open,
  onOpenChange,
  onPromote,
  isConverting,
}: PromoteModalProps) {
  const [column, setColumn] = useState<string>("backlog");
  const [keepIdea, setKeepIdea] = useState(false);
  const [tagsInput, setTagsInput] = useState("");

  if (!idea) return null;

  const handleConfirm = () => {
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    onPromote(idea.id, {
      column,
      keepIdea,
      tags: tags.length > 0 ? tags : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpRight className="h-5 w-5 text-emerald-400" />
            Promote to Feature
          </DialogTitle>
          <DialogDescription>
            This will create a new Feature from &ldquo;{idea.title}&rdquo; and
            add it to the Task Board.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Target Column</label>
            <select
              className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={column}
              onChange={(e) => setColumn(e.target.value)}
            >
              {COLUMN_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">
              Tags (comma-separated, optional)
            </label>
            <input
              className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="e.g. auth, mvp"
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={keepIdea}
              onChange={(e) => setKeepIdea(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm">Keep idea after promoting</span>
          </label>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isConverting}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isConverting}>
            {isConverting ? "Promoting…" : "Promote to Feature"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
