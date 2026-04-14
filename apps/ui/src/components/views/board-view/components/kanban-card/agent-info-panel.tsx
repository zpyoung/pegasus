import { memo, useEffect, useState, useMemo } from "react";
import {
  Feature,
  ThinkingLevel,
  ReasoningEffort,
  ParsedTask,
} from "@/store/app-store";
import { getProviderFromModel } from "@/lib/utils";
import {
  parseAgentContext,
  formatModelName,
  DEFAULT_MODEL,
} from "@/lib/agent-context-parser";
import { cn } from "@/lib/utils";
import type { AutoModeEvent } from "@/types/electron";
import {
  Brain,
  ListTodo,
  Sparkles,
  Expand,
  CheckCircle2,
  Circle,
  Wrench,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { getElectronAPI } from "@/lib/electron";
import { SummaryDialog } from "./summary-dialog";
import { getProviderIconForModel } from "@/components/ui/provider-icon";
import { useBulkFeatureStatus } from "@/hooks/queries";
import { getFirstNonEmptySummary } from "@/lib/summary-selection";
import { useAppStore } from "@/store/app-store";

/**
 * Formats thinking level for compact display
 */
function formatThinkingLevel(level: ThinkingLevel | undefined): string {
  if (!level || level === "none") return "";
  const labels: Record<ThinkingLevel, string> = {
    none: "",
    low: "Low",
    medium: "Med",
    high: "High",
    ultrathink: "Ultra",
    adaptive: "Adaptive",
  };
  return labels[level];
}

/**
 * Formats reasoning effort for compact display
 */
function formatReasoningEffort(effort: ReasoningEffort | undefined): string {
  if (!effort || effort === "none") return "";
  const labels: Record<ReasoningEffort, string> = {
    none: "",
    minimal: "Min",
    low: "Low",
    medium: "Med",
    high: "High",
    xhigh: "XHigh",
  };
  return labels[effort];
}

interface AgentInfoPanelProps {
  feature: Feature;
  projectPath: string;
  contextContent?: string;
  summary?: string;
  isActivelyRunning?: boolean;
}

export const AgentInfoPanel = memo(function AgentInfoPanel({
  feature,
  projectPath,
  contextContent,
  summary,
  isActivelyRunning,
}: AgentInfoPanelProps) {
  const [isSummaryDialogOpen, setIsSummaryDialogOpen] = useState(false);
  const [isTodosExpanded, setIsTodosExpanded] = useState(false);

  // Get providers from store for provider-aware model name display
  // This allows formatModelName to show provider-specific model names (e.g., "GLM 4.7" instead of "Sonnet 4.5")
  // when a feature was executed using a Claude-compatible provider
  const claudeCompatibleProviders = useAppStore(
    (state) => state.claudeCompatibleProviders,
  );

  // Memoize the format options to avoid recreating the object on every render
  const modelFormatOptions = useMemo(
    () => ({
      providerId: feature.providerId,
      claudeCompatibleProviders,
    }),
    [feature.providerId, claudeCompatibleProviders],
  );

  // Track real-time task status updates from WebSocket events
  const [taskStatusMap, setTaskStatusMap] = useState<
    Map<string, "pending" | "in_progress" | "completed">
  >(new Map());
  // Track real-time task summary updates from WebSocket events
  const [taskSummaryMap, setTaskSummaryMap] = useState<
    Map<string, string | null>
  >(new Map());

  // Single bulk query replaces per-card useFeature() + useAgentOutput() polling.
  // React Query deduplicates — only one HTTP request fires regardless of how
  // many AgentInfoPanel instances are mounted across the board.
  // The feature prop is updated when the board view consumes useBulkFeatureStatus.
  useBulkFeatureStatus(projectPath);

  // Parse agent context — only from contextContent when provided
  // (per-card agentOutput polling removed; output is fetched on-demand when modal opens)
  const agentInfo = useMemo(() => {
    if (contextContent) {
      return parseAgentContext(contextContent);
    }
    return null;
  }, [contextContent]);

  // Summary from feature prop (kept fresh by useFeatures list polling + WebSocket invalidation)
  const effectiveSummary =
    getFirstNonEmptySummary(feature.summary, summary, agentInfo?.summary) ??
    undefined;

  // planSpec from feature prop — updated via useFeatures list polling and WebSocket events
  const freshPlanSpec = useMemo(() => {
    if (!feature.planSpec) return null;
    return {
      tasks: feature.planSpec.tasks,
      tasksCompleted: feature.planSpec.tasksCompleted || 0,
      currentTaskId: feature.planSpec.currentTaskId,
    };
  }, [feature.planSpec]);

  // Derive effective todos from planSpec.tasks when available, fallback to agentInfo.todos
  // Uses freshPlanSpec (from API) for accurate progress, with taskStatusMap for real-time updates
  const isFeatureFinished =
    feature.status === "waiting_approval" || feature.status === "verified";
  const effectiveTodos = useMemo((): {
    content: string;
    status: "pending" | "in_progress" | "completed";
    summary?: string | null;
  }[] => {
    // Use freshPlanSpec if available (fetched from API), fallback to store's feature.planSpec
    const planSpec = freshPlanSpec?.tasks?.length
      ? freshPlanSpec
      : feature.planSpec;

    // First priority: use planSpec.tasks if available (modern approach)
    if (planSpec?.tasks && planSpec.tasks.length > 0) {
      const completedCount = planSpec.tasksCompleted || 0;
      const currentTaskId = planSpec.currentTaskId;

      return planSpec.tasks.map((task: ParsedTask, index: number) => {
        // When feature is finished (waiting_approval/verified), finalize task display:
        // - in_progress tasks → completed (agent was working on them when it finished)
        // - pending tasks stay pending (they were never started)
        // - completed tasks stay completed
        // This matches server-side behavior in feature-state-manager.ts
        if (isFeatureFinished) {
          const finalStatus =
            task.status === "in_progress" || task.status === "failed"
              ? "completed"
              : task.status;
          return {
            content: task.description,
            status: (finalStatus || "completed") as
              | "pending"
              | "in_progress"
              | "completed",
            summary: task.summary,
          };
        }

        // Use real-time status from WebSocket events if available
        const realtimeStatus = taskStatusMap.get(task.id);
        const realtimeSummary = taskSummaryMap.get(task.id);

        // Calculate status: WebSocket status > index-based status > task.status
        let effectiveStatus: "pending" | "in_progress" | "completed";
        if (realtimeStatus) {
          effectiveStatus = realtimeStatus;
        } else if (index < completedCount) {
          effectiveStatus = "completed";
        } else if (task.id === currentTaskId) {
          effectiveStatus = "in_progress";
        } else {
          // Fallback to task.status if available, otherwise pending
          effectiveStatus =
            task.status === "completed"
              ? "completed"
              : task.status === "in_progress"
                ? "in_progress"
                : "pending";
        }

        return {
          content: task.description,
          status: effectiveStatus,
          summary: taskSummaryMap.has(task.id) ? realtimeSummary : task.summary,
        };
      });
    }
    // Fallback: use parsed agentInfo.todos from agent-output.md
    return agentInfo?.todos || [];
  }, [
    freshPlanSpec,
    feature.planSpec,
    agentInfo?.todos,
    taskStatusMap,
    taskSummaryMap,
    isFeatureFinished,
  ]);

  // Listen to WebSocket events for real-time task status updates
  // This ensures the Kanban card shows the same progress as the Agent Output modal
  // Listen for ANY in-progress feature with planSpec tasks, not just isCurrentAutoTask
  const hasPlanSpecTasks = (freshPlanSpec?.tasks?.length ?? 0) > 0;
  const shouldListenToEvents =
    feature.status === "in_progress" && hasPlanSpecTasks;

  useEffect(() => {
    if (!shouldListenToEvents) return;

    const api = getElectronAPI();
    if (!api?.autoMode) return;

    const unsubscribe = api.autoMode.onEvent((event: AutoModeEvent) => {
      // Only handle events for this feature
      if (!("featureId" in event) || event.featureId !== feature.id) return;

      switch (event.type) {
        case "auto_mode_task_started":
          if ("taskId" in event) {
            const taskEvent = event as Extract<
              AutoModeEvent,
              { type: "auto_mode_task_started" }
            >;
            setTaskStatusMap((prev) => {
              const newMap = new Map(prev);
              // Mark current task as in_progress
              newMap.set(taskEvent.taskId, "in_progress");
              return newMap;
            });
          }
          break;

        case "auto_mode_task_complete":
          if ("taskId" in event) {
            const taskEvent = event as Extract<
              AutoModeEvent,
              { type: "auto_mode_task_complete" }
            >;
            setTaskStatusMap((prev) => {
              const newMap = new Map(prev);
              newMap.set(taskEvent.taskId, "completed");
              return newMap;
            });

            if ("summary" in event) {
              setTaskSummaryMap((prev) => {
                const newMap = new Map(prev);
                // Allow empty string (reset) or non-empty string to be set
                const summary =
                  typeof event.summary === "string" &&
                  event.summary.trim().length > 0
                    ? event.summary
                    : null;
                newMap.set(taskEvent.taskId, summary);
                return newMap;
              });
            }
          }
          break;
      }
    });

    return unsubscribe;
  }, [feature.id, shouldListenToEvents]);

  // Model/Preset Info for Backlog Cards
  if (feature.status === "backlog" || feature.status === "merge_conflict") {
    const provider = getProviderFromModel(feature.model);
    const isCodex = provider === "codex";
    const isClaude = provider === "claude";

    return (
      <div className="mb-3 space-y-2 overflow-hidden">
        <div className="flex items-center gap-2 text-[11px] flex-wrap">
          <div className="flex items-center gap-1 text-[var(--status-info)]">
            {(() => {
              const ProviderIcon = getProviderIconForModel(feature.model);
              return <ProviderIcon className="w-3 h-3" />;
            })()}
            <span className="font-medium">
              {formatModelName(
                feature.model ?? DEFAULT_MODEL,
                modelFormatOptions,
              )}
            </span>
          </div>
          {isClaude &&
          feature.thinkingLevel &&
          feature.thinkingLevel !== "none" ? (
            <div className="flex items-center gap-1 text-purple-400">
              <Brain className="w-3 h-3" />
              <span className="font-medium">
                {formatThinkingLevel(feature.thinkingLevel as ThinkingLevel)}
              </span>
            </div>
          ) : null}
          {isCodex &&
          feature.reasoningEffort &&
          feature.reasoningEffort !== "none" ? (
            <div className="flex items-center gap-1 text-purple-400">
              <Brain className="w-3 h-3" />
              <span className="font-medium">
                {formatReasoningEffort(
                  feature.reasoningEffort as ReasoningEffort,
                )}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // Agent Info Panel for non-backlog cards
  // Show panel if we have agentInfo OR planSpec.tasks (for spec/full mode)
  // OR if the feature has effective todos from any source (handles initial mount after worktree switch)
  // OR if the feature is actively running (ensures panel stays visible during execution)
  // Note: hasPlanSpecTasks is already defined above and includes freshPlanSpec
  // (The backlog case was already handled above and returned early)
  if (
    agentInfo ||
    hasPlanSpecTasks ||
    effectiveTodos.length > 0 ||
    isActivelyRunning ||
    effectiveSummary
  ) {
    return (
      <>
        <div className="mb-3 space-y-2 overflow-hidden">
          {/* Model & Phase */}
          <div className="flex items-center gap-2 text-[11px] flex-wrap">
            <div className="flex items-center gap-1 text-[var(--status-info)]">
              {(() => {
                const ProviderIcon = getProviderIconForModel(feature.model);
                return <ProviderIcon className="w-3 h-3" />;
              })()}
              <span className="font-medium">
                {formatModelName(
                  feature.model ?? DEFAULT_MODEL,
                  modelFormatOptions,
                )}
              </span>
            </div>
            {agentInfo?.currentPhase && (
              <div
                className={cn(
                  "px-1.5 py-0.5 rounded-md text-[10px] font-medium",
                  agentInfo.currentPhase === "planning" &&
                    "bg-[var(--status-info-bg)] text-[var(--status-info)]",
                  agentInfo.currentPhase === "action" &&
                    "bg-[var(--status-warning-bg)] text-[var(--status-warning)]",
                  agentInfo.currentPhase === "verification" &&
                    "bg-[var(--status-success-bg)] text-[var(--status-success)]",
                )}
              >
                {agentInfo.currentPhase}
              </div>
            )}
          </div>

          {/* Task List Progress */}
          {effectiveTodos.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
                <ListTodo className="w-3 h-3" />
                <span>
                  {
                    effectiveTodos.filter((t) => t.status === "completed")
                      .length
                  }
                  /{effectiveTodos.length} tasks
                </span>
              </div>
              <div
                className={cn(
                  "space-y-0.5 overflow-y-auto",
                  isTodosExpanded ? "max-h-40" : "max-h-16",
                )}
              >
                {(isTodosExpanded
                  ? effectiveTodos
                  : effectiveTodos.slice(0, 3)
                ).map((todo, idx) => (
                  <div key={idx} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 text-[10px]">
                      {todo.status === "completed" ? (
                        <CheckCircle2 className="w-2.5 h-2.5 text-[var(--status-success)] shrink-0" />
                      ) : todo.status === "in_progress" ? (
                        <Spinner size="xs" className="w-2.5 h-2.5 shrink-0" />
                      ) : (
                        <Circle className="w-2.5 h-2.5 text-muted-foreground/50 shrink-0" />
                      )}
                      <span
                        className={cn(
                          "break-words hyphens-auto line-clamp-2 leading-relaxed",
                          todo.status === "completed" &&
                            "text-muted-foreground/60 line-through",
                          todo.status === "in_progress" &&
                            "text-[var(--status-warning)]",
                          todo.status === "pending" &&
                            "text-muted-foreground/80",
                        )}
                      >
                        {todo.content}
                      </span>
                    </div>
                    {todo.summary && isTodosExpanded && (
                      <div className="pl-4 text-[9px] text-muted-foreground/50 italic break-words line-clamp-2">
                        {todo.summary}
                      </div>
                    )}
                  </div>
                ))}
                {effectiveTodos.length > 3 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsTodosExpanded(!isTodosExpanded);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="text-[10px] text-muted-foreground/60 pl-4 hover:text-muted-foreground transition-colors cursor-pointer"
                  >
                    {isTodosExpanded
                      ? "Show less"
                      : `+${effectiveTodos.length - 3} more`}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Summary for waiting_approval, verified, and pipeline steps */}
          {(feature.status === "waiting_approval" ||
            feature.status === "verified" ||
            (typeof feature.status === "string" &&
              feature.status.startsWith("pipeline_"))) && (
            <div className="space-y-1.5">
              {effectiveSummary && (
                <div className="space-y-1.5 pt-2 border-t border-border/30 overflow-hidden">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsSummaryDialogOpen(true);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="flex items-center gap-1 text-[10px] text-[var(--status-success)] min-w-0 hover:opacity-80 transition-opacity cursor-pointer"
                      title="View full summary"
                    >
                      <Sparkles className="w-3 h-3 shrink-0" />
                      <span className="truncate font-medium">Summary</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsSummaryDialogOpen(true);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="p-0.5 rounded-md hover:bg-muted/80 transition-colors text-muted-foreground/60 hover:text-muted-foreground shrink-0"
                      title="View full summary"
                      data-testid={`expand-summary-${feature.id}`}
                    >
                      <Expand className="w-3 h-3" />
                    </button>
                  </div>
                  <p
                    className="text-[10px] text-muted-foreground/70 line-clamp-3 break-words hyphens-auto leading-relaxed overflow-hidden select-text cursor-text"
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    {effectiveSummary}
                  </p>
                </div>
              )}
              {!effectiveSummary && (agentInfo?.toolCallCount ?? 0) > 0 && (
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60 pt-2 border-t border-border/30">
                  <span className="flex items-center gap-1">
                    <Wrench className="w-2.5 h-2.5" />
                    {agentInfo?.toolCallCount ?? 0} tool calls
                  </span>
                  {effectiveTodos.length > 0 && (
                    <span className="flex items-center gap-1">
                      <CheckCircle2 className="w-2.5 h-2.5 text-[var(--status-success)]" />
                      {
                        effectiveTodos.filter((t) => t.status === "completed")
                          .length
                      }{" "}
                      tasks done
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        {/* SummaryDialog must be rendered alongside the expand button */}
        <SummaryDialog
          feature={feature}
          agentInfo={agentInfo}
          summary={effectiveSummary}
          isOpen={isSummaryDialogOpen}
          onOpenChange={setIsSummaryDialogOpen}
          projectPath={projectPath}
        />
      </>
    );
  }

  // Always render SummaryDialog (even if no agentInfo yet)
  // This ensures the dialog can be opened from the expand button
  return (
    <SummaryDialog
      feature={feature}
      agentInfo={agentInfo}
      summary={effectiveSummary}
      isOpen={isSummaryDialogOpen}
      onOpenChange={setIsSummaryDialogOpen}
      projectPath={projectPath}
    />
  );
});
