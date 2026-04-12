// @ts-nocheck - form state management with partial feature updates and validation
import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HotkeyButton } from "@/components/ui/hotkey-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { CategoryAutocomplete } from "@/components/ui/category-autocomplete";
import { DependencySelector } from "@/components/ui/dependency-selector";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DescriptionImageDropZone,
  FeatureImagePath as DescriptionImagePath,
  FeatureTextFilePath as DescriptionTextFilePath,
  ImagePreviewMap,
} from "@/components/ui/description-image-dropzone";
import {
  GitBranch,
  Cpu,
  FolderKanban,
  Settings2,
  Workflow,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { cn, migrateModelId, normalizeModelEntry } from "@/lib/utils";
import {
  Feature,
  ModelAlias,
  ThinkingLevel,
  PlanningMode,
} from "@/store/app-store";
import type {
  ReasoningEffort,
  PhaseModelEntry,
  DescriptionHistoryEntry,
} from "@pegasus/types";
import {
  PrioritySelector,
  WorkModeSelector,
  PlanningModeSelect,
  EnhanceWithAI,
  EnhancementHistoryButton,
  PipelineExclusionControls,
  type EnhancementMode,
} from "../shared";
import type { WorkMode } from "../shared";
import { PhaseModelSelector } from "@/components/views/settings-view/model-defaults/phase-model-selector";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DependencyTreeDialog } from "./dependency-tree-dialog";
import { useDiscoverPipelines } from "@/hooks/queries/use-pipeline";

/**
 * Regex pattern to extract Handlebars variable references from a template string.
 * Matches simple `{{variable.path}}` expressions.
 */
const TEMPLATE_VARIABLE_REGEX =
  /\{\{\{?\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}?\}\}/g;

/**
 * Extract `inputs.*` variable names from all stages' prompt templates in a pipeline.
 * Returns deduplicated, sorted array of input variable names (without the `inputs.` prefix).
 */
function extractPipelineInputVariables(
  stages: Array<{ prompt: string }>,
): string[] {
  const inputVars = new Set<string>();
  for (const stage of stages) {
    TEMPLATE_VARIABLE_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TEMPLATE_VARIABLE_REGEX.exec(stage.prompt)) !== null) {
      const varPath = match[1];
      if (varPath.startsWith("inputs.")) {
        inputVars.add(varPath.slice("inputs.".length));
      }
    }
  }
  return [...inputVars].sort();
}

/**
 * Format a variable name into a human-readable label.
 * Converts snake_case/kebab-case to Title Case.
 */
function formatInputLabel(varName: string): string {
  return varName.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Convert a feature's stored pipelineInputs (string | number | boolean values)
 * to the form-state shape (string | boolean), so number inputs render as text.
 */
function pipelineInputsToFormState(
  inputs: Record<string, string | number | boolean> | undefined,
): Record<string, string | boolean> {
  if (!inputs) return {};
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(inputs)) {
    out[key] = typeof value === "boolean" ? value : String(value);
  }
  return out;
}

interface EditFeatureDialogProps {
  feature: Feature | null;
  onClose: () => void;
  onUpdate: (
    featureId: string,
    updates: {
      title: string;
      category: string;
      description: string;
      skipTests: boolean;
      model: ModelAlias;
      thinkingLevel: ThinkingLevel;
      reasoningEffort: ReasoningEffort;
      providerId?: string;
      imagePaths: DescriptionImagePath[];
      textFilePaths: DescriptionTextFilePath[];
      branchName: string; // Can be empty string to use current branch
      priority: number;
      planningMode: PlanningMode;
      requirePlanApproval: boolean;
      dependencies?: string[];
      childDependencies?: string[]; // Feature IDs that should depend on this feature
      excludedPipelineSteps?: string[]; // Pipeline step IDs to skip for this feature
      pipeline?: string; // Pipeline slug to use (e.g., "feature", "bug-fix")
      pipelineInputs?: Record<string, string | number | boolean>; // Pipeline template input values
    },
    descriptionHistorySource?: "enhance" | "edit",
    enhancementMode?: EnhancementMode,
    preEnhancementDescription?: string,
  ) => void;
  categorySuggestions: string[];
  branchSuggestions: string[];
  branchCardCounts?: Record<string, number>; // Map of branch name to unarchived card count
  currentBranch?: string;
  isMaximized: boolean;
  allFeatures: Feature[];
  projectPath?: string;
}

export function EditFeatureDialog({
  feature,
  onClose,
  onUpdate,
  categorySuggestions,
  branchSuggestions,
  branchCardCounts,
  currentBranch,
  isMaximized,
  allFeatures,
  projectPath,
}: EditFeatureDialogProps) {
  const navigate = useNavigate();
  const [editingFeature, setEditingFeature] = useState<Feature | null>(feature);
  // Derive initial workMode from feature's branchName
  const [workMode, setWorkMode] = useState<WorkMode>(() => {
    // If feature has a branchName, it's using 'custom' mode
    // Otherwise, it's on 'current' branch (no worktree isolation)
    return feature?.branchName ? "custom" : "current";
  });
  const [editFeaturePreviewMap, setEditFeaturePreviewMap] =
    useState<ImagePreviewMap>(() => new Map());
  const [showDependencyTree, setShowDependencyTree] = useState(false);
  const [planningMode, setPlanningMode] = useState<PlanningMode>(
    feature?.planningMode ?? "skip",
  );
  const [requirePlanApproval, setRequirePlanApproval] = useState(
    feature?.requirePlanApproval ?? false,
  );

  // Model selection state - migrate legacy model IDs to canonical format
  const [modelEntry, setModelEntry] = useState<PhaseModelEntry>(() =>
    normalizeModelEntry({
      model: migrateModelId(feature?.model) || "claude-opus",
      thinkingLevel: feature?.thinkingLevel || "none",
      reasoningEffort: feature?.reasoningEffort || "none",
      providerId: feature?.providerId,
    }),
  );

  // Track the source of description changes for history
  const [descriptionChangeSource, setDescriptionChangeSource] = useState<
    { source: "enhance"; mode: EnhancementMode } | "edit" | null
  >(null);
  // Track the original description when the dialog opened for comparison
  const [originalDescription, setOriginalDescription] = useState(
    feature?.description ?? "",
  );
  // Track the description before enhancement (so it can be restored)
  const [preEnhancementDescription, setPreEnhancementDescription] = useState<
    string | null
  >(null);
  // Local history state for real-time display (combines persisted + session history)
  const [localHistory, setLocalHistory] = useState<DescriptionHistoryEntry[]>(
    feature?.descriptionHistory ?? [],
  );

  // Dependency state
  const [parentDependencies, setParentDependencies] = useState<string[]>(
    feature?.dependencies ?? [],
  );
  // Child dependencies are features that have this feature in their dependencies
  const [childDependencies, setChildDependencies] = useState<string[]>(() => {
    if (!feature) return [];
    return allFeatures
      .filter((f) => f.dependencies?.includes(feature.id))
      .map((f) => f.id);
  });
  // Track original child dependencies to detect changes
  const [originalChildDependencies, setOriginalChildDependencies] = useState<
    string[]
  >(() => {
    if (!feature) return [];
    return allFeatures
      .filter((f) => f.dependencies?.includes(feature.id))
      .map((f) => f.id);
  });

  // Pipeline exclusion state
  const [excludedPipelineSteps, setExcludedPipelineSteps] = useState<string[]>(
    feature?.excludedPipelineSteps ?? [],
  );

  // YAML Pipeline selection state
  const [selectedPipelineSlug, setSelectedPipelineSlug] = useState<string>(
    feature?.pipeline ?? "",
  );
  const [pipelineInputs, setPipelineInputs] = useState<
    Record<string, string | boolean>
  >(() => pipelineInputsToFormState(feature?.pipelineInputs));

  // Discover available YAML pipelines
  const { data: discoveredPipelines = [] } = useDiscoverPipelines(projectPath);

  // Compute the selected pipeline
  const selectedPipeline = useMemo(
    () =>
      discoveredPipelines.find((p) => p.slug === selectedPipelineSlug) ?? null,
    [discoveredPipelines, selectedPipelineSlug],
  );

  // Compute input field definitions: prefer formally declared inputs, fall back to dynamic extraction
  const pipelineInputDefinitions = useMemo(() => {
    if (!selectedPipeline) return [];
    const declared = selectedPipeline.config.inputs;
    if (declared && Object.keys(declared).length > 0) {
      return Object.entries(declared).map(([name, input]) => ({
        name,
        type: input.type,
        required: input.required ?? false,
        default: input.default,
        description: input.description,
      }));
    }
    // Fall back to dynamically extracting {{inputs.X}} references from stage prompts
    return extractPipelineInputVariables(selectedPipeline.config.stages).map(
      (varName) => ({
        name: varName,
        type: "string" as const,
        required: false,
        default: undefined,
        description: undefined,
      }),
    );
  }, [selectedPipeline]);

  useEffect(() => {
    setEditingFeature(feature);
    if (feature) {
      setPlanningMode(feature.planningMode ?? "skip");
      setRequirePlanApproval(feature.requirePlanApproval ?? false);
      // Derive workMode from feature's branchName
      setWorkMode(feature.branchName ? "custom" : "current");
      // Reset history tracking state
      setOriginalDescription(feature.description ?? "");
      setDescriptionChangeSource(null);
      setPreEnhancementDescription(null);
      setLocalHistory(feature.descriptionHistory ?? []);
      // Reset model entry - migrate legacy model IDs
      setModelEntry(
        normalizeModelEntry({
          model: migrateModelId(feature.model) || "claude-opus",
          thinkingLevel: feature.thinkingLevel || "none",
          reasoningEffort: feature.reasoningEffort || "none",
          providerId: feature.providerId,
        }),
      );
      // Reset dependency state
      setParentDependencies(feature.dependencies ?? []);
      const childDeps = allFeatures
        .filter((f) => f.dependencies?.includes(feature.id))
        .map((f) => f.id);
      setChildDependencies(childDeps);
      setOriginalChildDependencies(childDeps);
      // Reset pipeline exclusion state
      setExcludedPipelineSteps(feature.excludedPipelineSteps ?? []);
      // Reset YAML pipeline selection from feature
      setSelectedPipelineSlug(feature.pipeline ?? "");
      setPipelineInputs(pipelineInputsToFormState(feature.pipelineInputs));
    } else {
      setEditFeaturePreviewMap(new Map());
      setDescriptionChangeSource(null);
      setPreEnhancementDescription(null);
      setLocalHistory([]);
      setParentDependencies([]);
      setChildDependencies([]);
      setOriginalChildDependencies([]);
      setExcludedPipelineSteps([]);
      setSelectedPipelineSlug("");
      setPipelineInputs({});
    }
  }, [feature, allFeatures]);

  // Clear requirePlanApproval when planning mode is skip (lite supports approval)
  useEffect(() => {
    if (planningMode === "skip") {
      setRequirePlanApproval(false);
    }
  }, [planningMode]);

  // When a YAML pipeline is selected, planning is handled by the pipeline - reset to skip
  useEffect(() => {
    if (selectedPipelineSlug) {
      setPlanningMode("skip");
      setRequirePlanApproval(false);
    }
  }, [selectedPipelineSlug]);

  const handleModelChange = (entry: PhaseModelEntry) => {
    setModelEntry(entry);
  };

  const handleUpdate = () => {
    if (!editingFeature) return;

    // Validate branch selection for custom mode
    const isBranchSelectorEnabled =
      editingFeature.status === "backlog" ||
      editingFeature.status === "merge_conflict";
    if (
      isBranchSelectorEnabled &&
      workMode === "custom" &&
      !editingFeature.branchName?.trim()
    ) {
      toast.error("Please select a branch name");
      return;
    }

    const normalizedEntry = normalizeModelEntry(modelEntry);

    // For 'current' mode, use empty string (work on current branch)
    // For 'auto' mode, use empty string (will be auto-generated in use-board-actions)
    // For 'custom' mode, use the specified branch name
    const finalBranchName =
      workMode === "custom" ? editingFeature.branchName || "" : "";

    // Check if child dependencies changed
    const childDepsChanged =
      childDependencies.length !== originalChildDependencies.length ||
      childDependencies.some((id) => !originalChildDependencies.includes(id)) ||
      originalChildDependencies.some((id) => !childDependencies.includes(id));

    // Build pipeline inputs as Record<string, string | number | boolean>
    // Apply type coercion based on declared input types
    const finalPipelineInputs: Record<string, string | number | boolean> = {};
    if (selectedPipelineSlug) {
      for (const field of pipelineInputDefinitions) {
        const rawValue = pipelineInputs[field.name];
        if (field.type === "boolean") {
          finalPipelineInputs[field.name] =
            typeof rawValue === "boolean" ? rawValue : (field.default ?? false);
        } else if (field.type === "number") {
          const strValue = String(rawValue ?? "").trim();
          if (strValue !== "") {
            const numValue = Number(strValue);
            finalPipelineInputs[field.name] = isNaN(numValue)
              ? strValue
              : numValue;
          } else if (field.default !== undefined) {
            finalPipelineInputs[field.name] = field.default;
          }
        } else {
          const strValue = String(rawValue ?? "").trim();
          if (strValue !== "") {
            finalPipelineInputs[field.name] = strValue;
          } else if (field.default !== undefined) {
            finalPipelineInputs[field.name] = String(field.default);
          }
        }
      }
    }

    const updates = {
      title: editingFeature.title ?? "",
      category: editingFeature.category,
      description: editingFeature.description,
      skipTests: editingFeature.skipTests ?? false,
      model: normalizedEntry.model,
      thinkingLevel: normalizedEntry.thinkingLevel,
      reasoningEffort: normalizedEntry.reasoningEffort,
      providerId: normalizedEntry.providerId,
      imagePaths: editingFeature.imagePaths ?? [],
      textFilePaths: editingFeature.textFilePaths ?? [],
      branchName: finalBranchName,
      priority: editingFeature.priority ?? 2,
      planningMode,
      requirePlanApproval,
      workMode,
      dependencies: parentDependencies,
      childDependencies: childDepsChanged ? childDependencies : undefined,
      excludedPipelineSteps:
        excludedPipelineSteps.length > 0 ? excludedPipelineSteps : undefined,
      pipeline: selectedPipelineSlug || undefined,
      pipelineInputs:
        Object.keys(finalPipelineInputs).length > 0
          ? finalPipelineInputs
          : undefined,
    };

    // Determine if description changed and what source to use
    const descriptionChanged =
      editingFeature.description !== originalDescription;
    let historySource: "enhance" | "edit" | undefined;
    let historyEnhancementMode:
      | "improve"
      | "technical"
      | "simplify"
      | "acceptance"
      | undefined;

    if (descriptionChanged && descriptionChangeSource) {
      if (descriptionChangeSource === "edit") {
        historySource = "edit";
      } else {
        historySource = "enhance";
        historyEnhancementMode = descriptionChangeSource.mode;
      }
    }

    onUpdate(
      editingFeature.id,
      updates,
      historySource,
      historyEnhancementMode,
      preEnhancementDescription ?? undefined,
    );
    setEditFeaturePreviewMap(new Map());
    onClose();
  };

  const handleDialogClose = (open: boolean) => {
    if (!open) {
      onClose();
    }
  };

  if (!editingFeature) {
    return null;
  }

  // Shared card styling
  const cardClass =
    "rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3";
  const sectionHeaderClass =
    "flex items-center gap-2 text-sm font-medium text-foreground";

  return (
    <Dialog open={!!editingFeature} onOpenChange={handleDialogClose}>
      <DialogContent
        compact={!isMaximized}
        data-testid="edit-feature-dialog"
        onPointerDownOutside={(e: CustomEvent) => {
          const target = e.target as HTMLElement;
          if (target.closest('[data-testid="category-autocomplete-list"]')) {
            e.preventDefault();
          }
        }}
        onInteractOutside={(e: CustomEvent) => {
          const target = e.target as HTMLElement;
          if (target.closest('[data-testid="category-autocomplete-list"]')) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit Feature</DialogTitle>
          <DialogDescription>Modify the feature details.</DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          {/* Task Details Section */}
          <div className={cardClass}>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="edit-description">Description</Label>
                {/* Version History Button - uses local history for real-time updates */}
                <EnhancementHistoryButton
                  history={localHistory}
                  currentValue={editingFeature.description}
                  onRestore={(description) => {
                    setEditingFeature((prev) =>
                      prev ? { ...prev, description } : prev,
                    );
                    setDescriptionChangeSource("edit");
                  }}
                  valueAccessor={(entry) => entry.description}
                  title="Version History"
                  restoreMessage="Description restored from history"
                />
              </div>
              <DescriptionImageDropZone
                value={editingFeature.description}
                onChange={(value) => {
                  setEditingFeature({
                    ...editingFeature,
                    description: value,
                  });
                  // Track that this change was a manual edit (unless already enhanced)
                  if (
                    !descriptionChangeSource ||
                    descriptionChangeSource === "edit"
                  ) {
                    setDescriptionChangeSource("edit");
                  }
                }}
                images={editingFeature.imagePaths ?? []}
                onImagesChange={(images) =>
                  setEditingFeature({
                    ...editingFeature,
                    imagePaths: images,
                  })
                }
                textFiles={editingFeature.textFilePaths ?? []}
                onTextFilesChange={(textFiles) =>
                  setEditingFeature({
                    ...editingFeature,
                    textFilePaths: textFiles,
                  })
                }
                placeholder="Describe the feature..."
                previewMap={editFeaturePreviewMap}
                onPreviewMapChange={setEditFeaturePreviewMap}
                data-testid="edit-feature-description"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-title">Title (optional)</Label>
              <Input
                id="edit-title"
                value={editingFeature.title ?? ""}
                onChange={(e) =>
                  setEditingFeature({
                    ...editingFeature,
                    title: e.target.value,
                  })
                }
                placeholder="Leave blank to auto-generate"
                data-testid="edit-feature-title"
              />
            </div>

            {/* Enhancement Section */}
            <EnhanceWithAI
              value={editingFeature.description}
              onChange={(enhanced) =>
                setEditingFeature((prev) =>
                  prev ? { ...prev, description: enhanced } : prev,
                )
              }
              onHistoryAdd={({ mode, originalText, enhancedText }) => {
                setDescriptionChangeSource({ source: "enhance", mode });
                setPreEnhancementDescription(originalText);

                // Update local history for real-time display
                const timestamp = new Date().toISOString();
                setLocalHistory((prev) => {
                  const newHistory = [...prev];
                  // Add original text first (so user can restore to pre-enhancement state)
                  const lastEntry = prev[prev.length - 1];
                  if (!lastEntry || lastEntry.description !== originalText) {
                    newHistory.push({
                      description: originalText,
                      timestamp,
                      source: prev.length === 0 ? "initial" : "edit",
                    });
                  }
                  // Add enhanced text
                  newHistory.push({
                    description: enhancedText,
                    timestamp,
                    source: "enhance",
                    enhancementMode: mode,
                  });
                  return newHistory;
                });
              }}
            />
          </div>

          {/* AI & Execution Section */}
          <div className={cardClass}>
            <div className="flex items-center justify-between">
              <div className={sectionHeaderClass}>
                <Cpu className="w-4 h-4 text-muted-foreground" />
                <span>AI & Execution</span>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      navigate({
                        to: "/settings",
                        search: { view: "defaults" },
                      });
                    }}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    <span>Edit Defaults</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    Change default model and planning settings for new features
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Model</Label>
              <PhaseModelSelector
                value={modelEntry}
                onChange={handleModelChange}
                compact
                align="end"
              />
            </div>

            <div
              className={cn(
                "grid gap-3",
                selectedPipelineSlug ? "grid-cols-1" : "grid-cols-2",
              )}
            >
              {!selectedPipelineSlug && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Planning
                  </Label>
                  <PlanningModeSelect
                    mode={planningMode}
                    onModeChange={setPlanningMode}
                    testIdPrefix="edit-feature-planning"
                    compact
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Options</Label>
                <div className="flex flex-col gap-2 pt-1">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="edit-feature-skip-tests"
                      checked={!(editingFeature.skipTests ?? false)}
                      onCheckedChange={(checked) =>
                        setEditingFeature({
                          ...editingFeature,
                          skipTests: !checked,
                        })
                      }
                      data-testid="edit-feature-skip-tests-checkbox"
                    />
                    <Label
                      htmlFor="edit-feature-skip-tests"
                      className="text-xs font-normal cursor-pointer"
                    >
                      Run tests
                    </Label>
                  </div>
                  {!selectedPipelineSlug && (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="edit-feature-require-approval"
                        checked={requirePlanApproval}
                        onCheckedChange={(checked) =>
                          setRequirePlanApproval(!!checked)
                        }
                        disabled={planningMode === "skip"}
                        data-testid="edit-feature-require-approval-checkbox"
                      />
                      <Label
                        htmlFor="edit-feature-require-approval"
                        className={cn(
                          "text-xs font-normal",
                          planningMode === "skip"
                            ? "cursor-not-allowed text-muted-foreground"
                            : "cursor-pointer",
                        )}
                      >
                        Require approval
                      </Label>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Pipeline Selection Section - only show when pipelines are available */}
          {discoveredPipelines.length > 0 && (
            <div className={cardClass}>
              <div className={sectionHeaderClass}>
                <Workflow className="w-4 h-4 text-muted-foreground" />
                <span>Pipeline</span>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Workflow Pipeline
                </Label>
                <Select
                  value={selectedPipelineSlug || "__none__"}
                  onValueChange={(value) => {
                    const slug = value === "__none__" ? "" : value;
                    setSelectedPipelineSlug(slug);
                    // Reset inputs and pre-fill defaults when pipeline changes
                    if (slug) {
                      const pipeline = discoveredPipelines.find(
                        (p) => p.slug === slug,
                      );
                      const declared = pipeline?.config.inputs;
                      if (declared && Object.keys(declared).length > 0) {
                        const defaults: Record<string, string | boolean> = {};
                        for (const [name, input] of Object.entries(declared)) {
                          if (input.type === "boolean") {
                            defaults[name] =
                              typeof input.default === "boolean"
                                ? input.default
                                : false;
                          } else if (input.default !== undefined) {
                            defaults[name] = String(input.default);
                          }
                        }
                        setPipelineInputs(defaults);
                      } else {
                        setPipelineInputs({});
                      }
                    } else {
                      setPipelineInputs({});
                    }
                  }}
                >
                  <SelectTrigger data-testid="edit-feature-pipeline-select">
                    <SelectValue placeholder="Default (no pipeline)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      Default (no pipeline)
                    </SelectItem>
                    {discoveredPipelines.map((pipeline) => (
                      <SelectItem
                        key={pipeline.slug}
                        value={pipeline.slug}
                        description={
                          <span className="text-xs text-muted-foreground">
                            {pipeline.config.description} ({pipeline.stageCount}{" "}
                            stage
                            {pipeline.stageCount !== 1 ? "s" : ""})
                          </span>
                        }
                      >
                        {pipeline.config.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Show pipeline stages preview */}
              {selectedPipeline && (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {selectedPipeline.config.stages.map((stage, idx) => (
                      <span
                        key={stage.id}
                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted border border-border/50 text-muted-foreground"
                      >
                        <span className="text-[10px] font-mono opacity-60">
                          {idx + 1}
                        </span>
                        {stage.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Pipeline input fields - typed widgets for declared inputs, text fields for dynamic */}
              {pipelineInputDefinitions.length > 0 && (
                <div className="space-y-3 pt-1">
                  <Label className="text-xs text-muted-foreground">
                    Pipeline Inputs
                    {pipelineInputDefinitions.some((f) => f.required) && (
                      <span className="text-destructive ml-1">* required</span>
                    )}
                  </Label>
                  {pipelineInputDefinitions.map((field) => (
                    <div key={field.name} className="space-y-1">
                      {field.type === "boolean" ? (
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`edit-pipeline-input-${field.name}`}
                            checked={
                              typeof pipelineInputs[field.name] === "boolean"
                                ? pipelineInputs[field.name]
                                : false
                            }
                            onCheckedChange={(checked) =>
                              setPipelineInputs((prev) => ({
                                ...prev,
                                [field.name]: !!checked,
                              }))
                            }
                            data-testid={`edit-feature-pipeline-input-${field.name}`}
                          />
                          <Label
                            htmlFor={`edit-pipeline-input-${field.name}`}
                            className="text-xs font-medium cursor-pointer"
                          >
                            {formatInputLabel(field.name)}
                          </Label>
                          {field.description && (
                            <span className="text-xs text-muted-foreground">
                              {field.description}
                            </span>
                          )}
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-1">
                            <Label
                              htmlFor={`edit-pipeline-input-${field.name}`}
                              className="text-xs font-medium"
                            >
                              {formatInputLabel(field.name)}
                            </Label>
                            {field.required && (
                              <span
                                className="text-xs text-destructive"
                                aria-label="required"
                              >
                                *
                              </span>
                            )}
                          </div>
                          <Input
                            id={`edit-pipeline-input-${field.name}`}
                            type={field.type === "number" ? "number" : "text"}
                            value={
                              typeof pipelineInputs[field.name] === "string"
                                ? pipelineInputs[field.name]
                                : ""
                            }
                            onChange={(e) =>
                              setPipelineInputs((prev) => ({
                                ...prev,
                                [field.name]: e.target.value,
                              }))
                            }
                            placeholder={
                              field.default !== undefined
                                ? String(field.default)
                                : `Enter ${formatInputLabel(field.name).toLowerCase()}...`
                            }
                            data-testid={`edit-feature-pipeline-input-${field.name}`}
                          />
                          {field.description && (
                            <p className="text-xs text-muted-foreground">
                              {field.description}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    These values will be available as template variables in the
                    pipeline stages.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Organization Section */}
          <div className={cardClass}>
            <div className={sectionHeaderClass}>
              <FolderKanban className="w-4 h-4 text-muted-foreground" />
              <span>Organization</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Category
                </Label>
                <CategoryAutocomplete
                  value={editingFeature.category}
                  onChange={(value) =>
                    setEditingFeature({
                      ...editingFeature,
                      category: value,
                    })
                  }
                  suggestions={categorySuggestions}
                  placeholder="e.g., Core, UI, API"
                  data-testid="edit-feature-category"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Priority
                </Label>
                <PrioritySelector
                  selectedPriority={editingFeature.priority ?? 2}
                  onPrioritySelect={(priority) =>
                    setEditingFeature({
                      ...editingFeature,
                      priority,
                    })
                  }
                  testIdPrefix="edit-priority"
                />
              </div>
            </div>

            {/* Work Mode Selector */}
            <div className="pt-2">
              <WorkModeSelector
                workMode={workMode}
                onWorkModeChange={setWorkMode}
                branchName={editingFeature.branchName ?? ""}
                onBranchNameChange={(value) =>
                  setEditingFeature({
                    ...editingFeature,
                    branchName: value,
                  })
                }
                branchSuggestions={branchSuggestions}
                branchCardCounts={branchCardCounts}
                currentBranch={currentBranch}
                disabled={
                  editingFeature.status !== "backlog" &&
                  editingFeature.status !== "merge_conflict"
                }
                testIdPrefix="edit-feature-work-mode"
              />
            </div>

            {/* Dependencies */}
            {allFeatures.length > 1 && (
              <div className="pt-2 space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Parent Dependencies (this feature depends on)
                  </Label>
                  <DependencySelector
                    currentFeatureId={editingFeature.id}
                    value={parentDependencies}
                    onChange={setParentDependencies}
                    features={allFeatures}
                    type="parent"
                    placeholder="Select features this depends on..."
                    data-testid="edit-feature-parent-deps"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Child Dependencies (features that depend on this)
                  </Label>
                  <DependencySelector
                    currentFeatureId={editingFeature.id}
                    value={childDependencies}
                    onChange={setChildDependencies}
                    features={allFeatures}
                    type="child"
                    placeholder="Select features that depend on this..."
                    data-testid="edit-feature-child-deps"
                  />
                </div>
              </div>
            )}

            {/* Pipeline Exclusion Controls */}
            <div className="pt-2">
              <PipelineExclusionControls
                projectPath={projectPath}
                excludedPipelineSteps={excludedPipelineSteps}
                onExcludedStepsChange={setExcludedPipelineSteps}
                testIdPrefix="edit-feature-pipeline"
              />
            </div>
          </div>
        </div>

        <DialogFooter className="sm:!justify-between">
          <Button
            variant="outline"
            onClick={() => setShowDependencyTree(true)}
            className="gap-2 h-10"
          >
            <GitBranch className="w-4 h-4" />
            View Dependency Tree
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <HotkeyButton
              onClick={handleUpdate}
              hotkey={{ key: "Enter", cmdCtrl: true }}
              hotkeyActive={!!editingFeature}
              data-testid="confirm-edit-feature"
              disabled={
                (editingFeature.status === "backlog" ||
                  editingFeature.status === "merge_conflict") &&
                workMode === "custom" &&
                !editingFeature.branchName?.trim()
              }
            >
              Save Changes
            </HotkeyButton>
          </div>
        </DialogFooter>
      </DialogContent>

      <DependencyTreeDialog
        open={showDependencyTree}
        onClose={() => setShowDependencyTree(false)}
        feature={editingFeature}
        allFeatures={allFeatures}
      />
    </Dialog>
  );
}
