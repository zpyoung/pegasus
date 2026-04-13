/**
 * IdeaBoard — Kanban-style board for ideas (Raw → Refined → Ready).
 *
 * Responsibilities:
 * - Render 3 columns by IdeaStatus using @dnd-kit/core + KanbanColumn
 * - QuickAddInput sub-component pinned inside the Raw column
 * - Drag-drop (with DragOverlay) calls updateIdea; on failure snaps back + toasts
 * - On mount, drains legacy generationJobs from useIdeationStore into Idea records
 * - Registers Shift+I keyboard shortcut to focus QuickAddInput
 * - Integrates useBoardBackground theming (column opacity/border, card styling, bg image)
 */

import { useRef, useEffect, useCallback, useState } from "react";
import {
  DndContext,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { toast } from "sonner";
import { Lightbulb, Plus } from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { useIdeationStore } from "@/store/ideation-store";
import { useResponsiveKanban } from "@/hooks/use-responsive-kanban";
import { KanbanColumn } from "../board-view/components/kanban-column";
import { useBoardBackground } from "../board-view/hooks/use-board-background";
import { IdeaCard } from "./idea-card";
import { PromoteModal } from "./promote-modal";
import { GenerationJobsIndicator } from "./generation-jobs-indicator";
import { PromptCommandPopover } from "./prompt-command-popover";
import { useIdeas } from "./hooks/use-ideas";
import { useConvertIdea } from "./hooks/use-convert-idea";
import type {
  Idea,
  IdeaStatus,
  UpdateIdeaInput,
  ConvertToFeatureOptions,
} from "@pegasus/types";

// ============================================================================
// Column definitions
// ============================================================================

const COLUMNS: {
  id: IdeaStatus;
  label: string;
  description: string;
  colorClass: string;
}[] = [
  {
    id: "raw",
    label: "Raw",
    description: "Unrefined ideas",
    colorClass: "bg-yellow-500",
  },
  {
    id: "refined",
    label: "Refined",
    description: "Ideas being shaped",
    colorClass: "bg-blue-500",
  },
  {
    id: "ready",
    label: "Ready",
    description: "Ready to promote",
    colorClass: "bg-emerald-500",
  },
];

// ============================================================================
// QuickAddInput — pinned inside the Raw column content area
// ============================================================================

interface QuickAddInputProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  onAdd: (title: string) => Promise<void>;
}

function QuickAddInput({ inputRef, onAdd }: QuickAddInputProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = value.trim();
    if (!title) return;

    setIsAdding(true);
    setError(null);
    try {
      await onAdd(title);
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add idea");
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/60"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder="Capture an idea…"
          disabled={isAdding}
          data-testid="quick-add-input"
        />
        <button
          type="submit"
          disabled={!value.trim() || isAdding}
          className="shrink-0 rounded-md border border-border bg-background p-1.5 hover:bg-muted disabled:opacity-40 transition-colors"
          data-testid="quick-add-submit"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

// ============================================================================
// IdeaBoard
// ============================================================================

export function IdeaBoard() {
  const currentProject = useAppStore((s) => s.currentProject);
  const projectPath = currentProject?.path ?? "";

  const { ideas, createIdea, updateIdea, deleteIdea } = useIdeas(projectPath);
  const { convert, isConverting } = useConvertIdea(projectPath);

  const quickAddRef = useRef<HTMLInputElement>(null);
  const [promoteIdea, setPromoteIdea] = useState<Idea | null>(null);
  const [activeIdea, setActiveIdea] = useState<Idea | null>(null);

  // ─── Theming & layout ─────────────────────────────────────────────────────
  const { backgroundSettings, backgroundImageStyle } = useBoardBackground({
    currentProject,
  });
  const { columnWidth, containerStyle } = useResponsiveKanban(COLUMNS.length);

  // ─── DnD setup ───────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const dragged = ideas.find((i) => i.id === event.active.id);
      setActiveIdea(dragged ?? null);
    },
    [ideas],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveIdea(null);
      const { active, over } = event;
      if (!over) return;

      const draggedIdea = ideas.find((i) => i.id === active.id);
      if (!draggedIdea) return;

      // KanbanColumn uses the column id directly as the droppable id,
      // and also registers `column-header-${id}` for the header drop zone.
      let targetStatus: IdeaStatus;
      const overId = String(over.id);

      if (overId === "raw" || overId === "refined" || overId === "ready") {
        targetStatus = overId as IdeaStatus;
      } else if (overId.startsWith("column-header-")) {
        targetStatus = overId.replace("column-header-", "") as IdeaStatus;
      } else {
        // Dropped on a card — use that card's status
        const overIdea = ideas.find((i) => i.id === overId);
        targetStatus = overIdea ? overIdea.status : draggedIdea.status;
      }

      if (targetStatus === draggedIdea.status) return;

      updateIdea.mutate(
        { ideaId: String(active.id), updates: { status: targetStatus } },
        {
          onError: (err) => {
            toast.error("Failed to move idea", { description: err.message });
          },
        },
      );
    },
    [ideas, updateIdea],
  );

  // ─── Legacy generationJobs drain ─────────────────────────────────────────
  const generationJobs = useIdeationStore((s) => s.generationJobs);
  const removeJob = useIdeationStore((s) => s.removeJob);

  useEffect(() => {
    if (!projectPath) return;
    const readyJobs = generationJobs.filter(
      (j) =>
        j.projectPath === projectPath &&
        j.status === "ready" &&
        j.suggestions.length > 0,
    );
    if (readyJobs.length === 0) return;

    const drain = async () => {
      for (const job of readyJobs) {
        try {
          for (const suggestion of job.suggestions) {
            await createIdea.mutateAsync({
              title: suggestion.title,
              description: suggestion.description ?? "",
              category: suggestion.category,
              status: "raw",
            });
          }
          removeJob(job.id);
        } catch (err) {
          console.warn("[IdeaBoard] Legacy drain failed for job", job.id, err);
        }
      }
    };

    drain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]); // run once per project mount

  // ─── Quick add handler ────────────────────────────────────────────────────
  const handleQuickAdd = useCallback(
    async (title: string) => {
      await createIdea.mutateAsync({ title, status: "raw" });
    },
    [createIdea],
  );

  // ─── Delete handler ───────────────────────────────────────────────────────
  const handleDelete = useCallback(
    (idea: Idea) => {
      deleteIdea.mutate(idea.id, {
        onError: (err) =>
          toast.error("Failed to delete idea", { description: err.message }),
      });
    },
    [deleteIdea],
  );

  // ─── Edit handler ─────────────────────────────────────────────────────────
  const handleEdit = useCallback(
    (idea: Idea, updates: UpdateIdeaInput) => {
      updateIdea.mutate(
        { ideaId: idea.id, updates },
        {
          onError: (err) =>
            toast.error("Failed to save idea", { description: err.message }),
        },
      );
    },
    [updateIdea],
  );

  // ─── Promote handler ──────────────────────────────────────────────────────
  const handlePromoteConfirm = useCallback(
    (ideaId: string, options: ConvertToFeatureOptions) => {
      convert(ideaId, options);
      setPromoteIdea(null);
    },
    [convert],
  );

  // ─── No project guard ─────────────────────────────────────────────────────
  if (!currentProject) {
    return (
      <div
        className="flex-1 flex items-center justify-center content-bg"
        data-testid="idea-board"
      >
        <div className="text-center text-muted-foreground">
          <p>Open a project to start capturing ideas</p>
        </div>
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className="flex-1 flex flex-col content-bg min-h-0 overflow-hidden"
      style={backgroundImageStyle}
      data-testid="idea-board"
    >
      {/* Header */}
      <div className="flex items-center gap-2 p-4 border-b border-border bg-glass backdrop-blur-md shrink-0">
        <Lightbulb className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-bold">Idea Board</h1>
        <span className="text-sm text-muted-foreground ml-1">
          {ideas.length} idea{ideas.length !== 1 ? "s" : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <GenerationJobsIndicator projectPath={projectPath} />
          <PromptCommandPopover projectPath={projectPath} />
        </div>
      </div>

      {/* Kanban columns */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-4 min-h-0">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="h-full pt-1 pb-1" style={containerStyle}>
            {COLUMNS.map((col) => {
              const columnIdeas = ideas.filter((i) => i.status === col.id);

              return (
                <KanbanColumn
                  key={col.id}
                  id={col.id}
                  title={col.label}
                  colorClass={col.colorClass}
                  count={columnIdeas.length}
                  width={columnWidth}
                  opacity={backgroundSettings.columnOpacity}
                  showBorder={backgroundSettings.columnBorderEnabled}
                  hideScrollbar={backgroundSettings.hideScrollbar}
                >
                  {col.id === "raw" && (
                    <div className="px-1 pb-2">
                      <QuickAddInput
                        inputRef={quickAddRef}
                        onAdd={handleQuickAdd}
                      />
                    </div>
                  )}
                  <SortableContext
                    items={columnIdeas.map((i) => i.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {columnIdeas.map((idea) => (
                      <IdeaCard
                        key={idea.id}
                        idea={idea}
                        onEdit={handleEdit}
                        onPromote={setPromoteIdea}
                        onDelete={handleDelete}
                        isSaving={updateIdea.isPending}
                        opacity={backgroundSettings.cardOpacity}
                        glassmorphism={backgroundSettings.cardGlassmorphism}
                        cardBorderEnabled={backgroundSettings.cardBorderEnabled}
                        cardBorderOpacity={backgroundSettings.cardBorderOpacity}
                      />
                    ))}
                    {columnIdeas.length === 0 && (
                      <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
                        {col.id === "raw"
                          ? "Type above to add an idea"
                          : "Drag ideas here"}
                      </div>
                    )}
                  </SortableContext>
                </KanbanColumn>
              );
            })}
          </div>

          <DragOverlay
            dropAnimation={{
              duration: 200,
              easing: "cubic-bezier(0.18, 0.67, 0.6, 1.22)",
            }}
          >
            {activeIdea && (
              <IdeaCard
                idea={activeIdea}
                onEdit={() => {}}
                onPromote={() => {}}
                onDelete={() => {}}
                isSaving={false}
                opacity={backgroundSettings.cardOpacity}
                glassmorphism={backgroundSettings.cardGlassmorphism}
                cardBorderEnabled={backgroundSettings.cardBorderEnabled}
                cardBorderOpacity={backgroundSettings.cardBorderOpacity}
              />
            )}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Promote modal */}
      <PromoteModal
        idea={promoteIdea}
        open={promoteIdea !== null}
        onOpenChange={(open) => !open && setPromoteIdea(null)}
        onPromote={handlePromoteConfirm}
        isConverting={isConverting}
      />
    </div>
  );
}
