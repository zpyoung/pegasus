// @ts-nocheck - dnd-kit draggable/droppable ref combination type incompatibilities
import React, { memo, useLayoutEffect, useState, useCallback } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Feature, useAppStore } from "@/store/app-store";
import { useShallow } from "zustand/react/shallow";
import { getHttpApiClient } from "@/lib/http-api-client";
import { CardBadges, PriorityBadges } from "./card-badges";
import { CardHeaderSection } from "./card-header";
import { CardContentSections } from "./card-content-sections";
import { AgentInfoPanel } from "./agent-info-panel";
import { CardActions } from "./card-actions";

function getCardBorderStyle(
  enabled: boolean,
  opacity: number,
): React.CSSProperties {
  if (!enabled) {
    return { borderWidth: "0px", borderColor: "transparent" };
  }
  if (opacity !== 100) {
    return {
      borderWidth: "1px",
      borderColor: `color-mix(in oklch, var(--border) ${opacity}%, transparent)`,
    };
  }
  return {};
}

function getCursorClass(
  isOverlay: boolean | undefined,
  isDraggable: boolean,
  isSelectionMode: boolean,
): string {
  if (isSelectionMode) return "cursor-pointer";
  if (isOverlay) return "cursor-grabbing";
  // Drag cursor is now only on the drag handle, not the full card
  return "cursor-default";
}

interface KanbanCardProps {
  feature: Feature;
  onEdit: (feature: Feature) => void;
  onDelete: (featureId: string) => void;
  onViewOutput?: (feature: Feature) => void;
  onVerify?: (feature: Feature) => void;
  onResume?: (feature: Feature) => void;
  onForceStop?: (feature: Feature) => void;
  onManualVerify?: (feature: Feature) => void;
  onMoveBackToInProgress?: (feature: Feature) => void;
  onFollowUp?: (feature: Feature) => void;
  onImplement?: (feature: Feature) => void;
  onComplete?: (feature: Feature) => void;
  onViewPlan?: (feature: Feature) => void;
  onApprovePlan?: (feature: Feature) => void;
  onAnswerQuestion?: (feature: Feature) => void;
  onSpawnTask?: (feature: Feature) => void;
  onDuplicate?: (feature: Feature) => void;
  onDuplicateAsChild?: (feature: Feature) => void;
  onDuplicateAsChildMultiple?: (feature: Feature) => void;
  onCommitChanges?: (feature: Feature) => void;
  hasContext?: boolean;
  isCurrentAutoTask?: boolean;
  shortcutKey?: string;
  contextContent?: string;
  summary?: string;
  opacity?: number;
  glassmorphism?: boolean;
  cardBorderEnabled?: boolean;
  cardBorderOpacity?: number;
  isOverlay?: boolean;
  reduceEffects?: boolean;
  // Selection mode props
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (featureId: string) => void;
  selectionTarget?: "backlog" | "waiting_approval" | null;
}

export const KanbanCard = memo(function KanbanCard({
  feature,
  onEdit,
  onDelete,
  onViewOutput,
  onVerify,
  onResume,
  onForceStop,
  onManualVerify,
  onMoveBackToInProgress: _onMoveBackToInProgress,
  onFollowUp,
  onImplement,
  onComplete,
  onViewPlan,
  onApprovePlan,
  onAnswerQuestion,
  onSpawnTask,
  onDuplicate,
  onDuplicateAsChild,
  onDuplicateAsChildMultiple,
  onCommitChanges,
  hasContext,
  isCurrentAutoTask,
  shortcutKey,
  contextContent,
  summary,
  opacity = 100,
  glassmorphism = true,
  cardBorderEnabled = true,
  cardBorderOpacity = 100,
  isOverlay,
  reduceEffects = false,
  isSelectionMode = false,
  isSelected = false,
  onToggleSelect,
  selectionTarget = null,
}: KanbanCardProps) {
  // Use project-scoped primitives instead of the full ByProject maps to prevent
  // unnecessary re-renders of every card when a DIFFERENT project's settings change.
  // useShallow compares each property with Object.is; returning boolean primitives
  // means the card only re-renders when the actual value for THIS project changes.
  const {
    useWorktrees,
    currentProject,
    rawShowAllWorktrees,
    isWorktreePanelVisible,
    getPrimaryWorktreeBranch,
  } = useAppStore(
    useShallow((state) => {
      const path = state.currentProject?.path;
      return {
        useWorktrees: state.useWorktrees,
        currentProject: state.currentProject,
        rawShowAllWorktrees: path
          ? (state.showAllWorktreesByProject[path] ?? false)
          : false,
        isWorktreePanelVisible: path
          ? (state.worktreePanelVisibleByProject[path] ?? true)
          : true,
        getPrimaryWorktreeBranch: state.getPrimaryWorktreeBranch,
      };
    }),
  );
  const showAllWorktrees = rawShowAllWorktrees || !isWorktreePanelVisible;
  const mainBranch = currentProject?.path
    ? getPrimaryWorktreeBranch(currentProject.path)
    : null;

  const handleBranchPillClick = useCallback((branchName: string) => {
    const state = useAppStore.getState();
    const projectPath = state.currentProject?.path;
    if (!projectPath) return;

    const worktrees = state.worktreesByProject[projectPath] ?? [];
    const worktree = worktrees.find((w) => w.branch === branchName);
    if (!worktree) return;

    const currentWorktree = state.currentWorktreeByProject[projectPath];
    const rawShowAll = state.showAllWorktreesByProject[projectPath] ?? false;

    // No-op if already on this branch with All mode already off
    if (!rawShowAll && currentWorktree?.path === worktree.path) return;

    state.setCurrentWorktree(projectPath, worktree.path, worktree.branch);

    if (rawShowAll) {
      state.setShowAllWorktrees(projectPath, false);
      getHttpApiClient()
        .settings.updateProject(projectPath, { showAllWorktrees: false })
        .catch(console.error);
    }
  }, []);

  // A card should display as "actively running" if it's in the runningAutoTasks list
  // AND in an execution-compatible status. However, there's a race window where a feature
  // is tracked as running (in runningAutoTasks) but its disk/UI status hasn't caught up yet
  // (still 'backlog', 'ready', or 'interrupted'). In this case, we still want to show
  // running controls (Logs/Stop) and animated border, but not the full "actively running"
  // state that gates all UI behavior.
  const isInExecutionState =
    feature.status === "in_progress" ||
    (typeof feature.status === "string" &&
      feature.status.startsWith("pipeline_"));
  const isActivelyRunning = !!isCurrentAutoTask && isInExecutionState;
  // isRunningWithStaleStatus: feature is tracked as running but status hasn't updated yet.
  // This happens during the timing gap between when the server starts a feature and when
  // the UI receives the status update. Show running UI to prevent "Make" button flash.
  const isRunningWithStaleStatus =
    !!isCurrentAutoTask &&
    !isInExecutionState &&
    (feature.status === "backlog" ||
      feature.status === "merge_conflict" ||
      feature.status === "ready" ||
      feature.status === "interrupted");
  // Show running visual treatment for both fully confirmed and stale-status running tasks
  const showRunningVisuals = isActivelyRunning || isRunningWithStaleStatus;
  const [isLifted, setIsLifted] = useState(false);

  useLayoutEffect(() => {
    if (isOverlay) {
      requestAnimationFrame(() => {
        setIsLifted(true);
      });
    }
  }, [isOverlay]);

  const isDraggable =
    !isSelectionMode &&
    !isRunningWithStaleStatus &&
    (feature.status === "backlog" ||
      feature.status === "merge_conflict" ||
      feature.status === "interrupted" ||
      feature.status === "ready" ||
      feature.status === "waiting_approval" ||
      feature.status === "verified" ||
      feature.status.startsWith("pipeline_") ||
      (feature.status === "in_progress" && !isCurrentAutoTask));
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    isDragging,
  } = useDraggable({
    id: feature.id,
    disabled: !isDraggable || isOverlay || isSelectionMode,
  });

  // Make the card a drop target for creating dependency links
  // All non-completed cards can be link targets to allow flexible dependency creation
  // (completed features are excluded as they're already done)
  const isDroppable =
    !isOverlay && feature.status !== "completed" && !isSelectionMode;
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `card-drop-${feature.id}`,
    disabled: !isDroppable,
    data: {
      type: "card",
      featureId: feature.id,
    },
  });

  // Combine refs for both draggable and droppable
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setDraggableRef(node);
      setDroppableRef(node);
    },
    [setDraggableRef, setDroppableRef],
  );

  // Bind stable callbacks so sub-components (CardActions, CardHeaderSection) receive
  // stable () => void references. KanbanCard re-renders when `feature` changes, so
  // these are correct — they capture the latest feature without requiring inline arrows
  // in the parent (kanban-board), which would break React.memo on every board render.
  const handleEdit = useCallback(() => onEdit(feature), [onEdit, feature]);
  const handleDelete = useCallback(
    () => onDelete(feature.id),
    [onDelete, feature.id],
  );
  const handleViewOutput = useCallback(
    () => onViewOutput?.(feature),
    [onViewOutput, feature],
  );
  const handleVerify = useCallback(
    () => onVerify?.(feature),
    [onVerify, feature],
  );
  const handleResume = useCallback(
    () => onResume?.(feature),
    [onResume, feature],
  );
  const handleForceStop = useCallback(
    () => onForceStop?.(feature),
    [onForceStop, feature],
  );
  const handleManualVerify = useCallback(
    () => onManualVerify?.(feature),
    [onManualVerify, feature],
  );
  const handleFollowUp = useCallback(
    () => onFollowUp?.(feature),
    [onFollowUp, feature],
  );
  const handleImplement = useCallback(
    () => onImplement?.(feature),
    [onImplement, feature],
  );
  const handleComplete = useCallback(
    () => onComplete?.(feature),
    [onComplete, feature],
  );
  const handleViewPlan = useCallback(
    () => onViewPlan?.(feature),
    [onViewPlan, feature],
  );
  const handleApprovePlan = useCallback(
    () => onApprovePlan?.(feature),
    [onApprovePlan, feature],
  );
  const handleAnswerQuestion = useCallback(
    () => onAnswerQuestion?.(feature),
    [onAnswerQuestion, feature],
  );
  const handleSpawnTask = useCallback(
    () => onSpawnTask?.(feature),
    [onSpawnTask, feature],
  );
  const handleDuplicate = useCallback(
    () => onDuplicate?.(feature),
    [onDuplicate, feature],
  );
  const handleDuplicateAsChild = useCallback(
    () => onDuplicateAsChild?.(feature),
    [onDuplicateAsChild, feature],
  );
  const handleDuplicateAsChildMultiple = useCallback(
    () => onDuplicateAsChildMultiple?.(feature),
    [onDuplicateAsChildMultiple, feature],
  );
  const handleCommitChanges = useCallback(
    () => onCommitChanges?.(feature),
    [onCommitChanges, feature],
  );
  const handleToggleSelect = useCallback(
    () => onToggleSelect?.(feature.id),
    [onToggleSelect, feature.id],
  );

  const dndStyle = {
    opacity: isDragging ? 0.5 : undefined,
  };

  const cardStyle = getCardBorderStyle(cardBorderEnabled, cardBorderOpacity);

  // Only allow selection for features matching the selection target
  const isSelectable =
    isSelectionMode &&
    (feature.status === selectionTarget ||
      (selectionTarget === "backlog" && feature.status === "merge_conflict"));

  const wrapperClasses = cn(
    "relative select-none outline-none transition-transform duration-200 ease-out",
    getCursorClass(isOverlay, isDraggable, isSelectable),
    isOverlay && isLifted && "scale-105 rotate-1 z-50",
    // Visual feedback when another card is being dragged over this one
    isOver &&
      !isDragging &&
      "ring-2 ring-primary ring-offset-2 ring-offset-background scale-[1.02]",
  );

  const isInteractive = !isDragging && !isOverlay;
  const hasError = feature.error && !isCurrentAutoTask;

  const innerCardClasses = cn(
    "kanban-card-content h-full relative",
    reduceEffects ? "shadow-none" : "shadow-sm",
    "transition-all duration-200 ease-out",
    // Disable hover translate for running cards to prevent gap showing gradient
    isInteractive &&
      !reduceEffects &&
      !showRunningVisuals &&
      "hover:-translate-y-0.5 hover:shadow-md hover:shadow-black/10 bg-transparent",
    !glassmorphism && "backdrop-blur-[0px]!",
    !showRunningVisuals &&
      cardBorderEnabled &&
      (cardBorderOpacity === 100 ? "border-border/50" : "border"),
    hasError &&
      "border-[var(--status-error)] border-2 shadow-[var(--status-error-bg)] shadow-lg",
    isSelected &&
      isSelectable &&
      "ring-2 ring-brand-500 ring-offset-1 ring-offset-background",
  );

  const handleCardClick = (e: React.MouseEvent) => {
    if (isSelectable && onToggleSelect) {
      e.preventDefault();
      e.stopPropagation();
      handleToggleSelect();
    }
  };

  const renderCardContent = () => (
    <Card
      style={showRunningVisuals ? undefined : cardStyle}
      className={innerCardClasses}
      onDoubleClick={isSelectionMode ? undefined : handleEdit}
      onClick={handleCardClick}
    >
      {/* Background overlay with opacity */}
      {(!isDragging || isOverlay) && (
        <div
          className={cn(
            "absolute inset-0 rounded-xl bg-card -z-10",
            glassmorphism && "backdrop-blur-sm",
          )}
          style={{ opacity: opacity / 100 }}
        />
      )}

      {/* Status Badges Row */}
      <CardBadges feature={feature} />

      {/* Category row with selection checkbox */}
      <div className="px-3 pt-3 flex items-center gap-2">
        {isSelectable && !isOverlay && (
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => handleToggleSelect()}
            className="h-4 w-4 border-2 data-[state=checked]:bg-brand-500 data-[state=checked]:border-brand-500 shrink-0"
            onClick={(e) => e.stopPropagation()}
          />
        )}
        <span className="text-[11px] text-muted-foreground/70 font-medium">
          {feature.category}
        </span>
      </div>

      {/* Priority and Manual Verification badges */}
      <PriorityBadges feature={feature} projectPath={currentProject?.path} />

      {/* Card Header */}
      <CardHeaderSection
        feature={feature}
        isDraggable={isDraggable}
        isCurrentAutoTask={isActivelyRunning}
        isSelectionMode={isSelectionMode}
        hasContext={hasContext}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onViewOutput={handleViewOutput}
        onSpawnTask={handleSpawnTask}
        onDuplicate={handleDuplicate}
        onDuplicateAsChild={handleDuplicateAsChild}
        onDuplicateAsChildMultiple={handleDuplicateAsChildMultiple}
        dragHandleListeners={isDraggable ? listeners : undefined}
        dragHandleAttributes={isDraggable ? attributes : undefined}
      />

      <CardContent className="px-3 pt-0 pb-0">
        {/* Content Sections */}
        <CardContentSections
          feature={feature}
          useWorktrees={useWorktrees}
          showAllWorktrees={showAllWorktrees}
          mainBranch={mainBranch}
          onBranchPillClick={handleBranchPillClick}
        />

        {/* Agent Info Panel */}
        <AgentInfoPanel
          feature={feature}
          projectPath={currentProject?.path ?? ""}
          contextContent={contextContent}
          summary={summary}
          isActivelyRunning={isActivelyRunning}
        />

        {/* Actions */}
        <CardActions
          feature={feature}
          isCurrentAutoTask={isActivelyRunning}
          isRunningTask={!!isCurrentAutoTask}
          hasContext={hasContext}
          shortcutKey={shortcutKey}
          isSelectionMode={isSelectionMode}
          onEdit={handleEdit}
          onViewOutput={handleViewOutput}
          onVerify={handleVerify}
          onResume={handleResume}
          onForceStop={handleForceStop}
          onManualVerify={handleManualVerify}
          onFollowUp={handleFollowUp}
          onImplement={handleImplement}
          onComplete={handleComplete}
          onViewPlan={handleViewPlan}
          onApprovePlan={handleApprovePlan}
          onAnswerQuestion={handleAnswerQuestion}
          onCommitChanges={handleCommitChanges}
        />
      </CardContent>
    </Card>
  );

  return (
    <div
      ref={setNodeRef}
      style={dndStyle}
      className={wrapperClasses}
      data-testid={`kanban-card-${feature.id}`}
    >
      {showRunningVisuals ? (
        <div className="animated-border-wrapper">{renderCardContent()}</div>
      ) : (
        renderCardContent()
      )}
    </div>
  );
});
