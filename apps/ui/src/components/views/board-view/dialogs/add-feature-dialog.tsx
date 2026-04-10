// @ts-nocheck - feature data building with conditional fields and model type inference
import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { HotkeyButton } from '@/components/ui/hotkey-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { CategoryAutocomplete } from '@/components/ui/category-autocomplete';
import { DependencySelector } from '@/components/ui/dependency-selector';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DescriptionImageDropZone,
  FeatureImagePath as DescriptionImagePath,
  FeatureTextFilePath as DescriptionTextFilePath,
  ImagePreviewMap,
} from '@/components/ui/description-image-dropzone';
import { Play, Cpu, FolderKanban, Settings2, Workflow } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { cn, normalizeModelEntry } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';
import type { ThinkingLevel, PlanningMode, Feature, FeatureImage } from '@/store/types';
import type { ReasoningEffort, PhaseModelEntry, AgentModel } from '@pegasus/types';
import { normalizeThinkingLevelForModel, getThinkingLevelsForModel } from '@pegasus/types';
import {
  PrioritySelector,
  WorkModeSelector,
  PlanningModeSelect,
  AncestorContextSection,
  EnhanceWithAI,
  EnhancementHistoryButton,
  PipelineExclusionControls,
  type BaseHistoryEntry,
} from '../shared';
import type { WorkMode } from '../shared';
import { PhaseModelSelector } from '@/components/views/settings-view/model-defaults/phase-model-selector';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  getAncestors,
  formatAncestorContextForPrompt,
  type AncestorContext,
} from '@pegasus/dependency-resolver';
import { useDiscoverPipelines } from '@/hooks/queries/use-pipeline';

/**
 * Regex pattern to extract Handlebars variable references from a template string.
 * Matches simple `{{variable.path}}` expressions.
 */
const TEMPLATE_VARIABLE_REGEX = /\{\{\{?\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}?\}\}/g;

/**
 * Extract `inputs.*` variable names from all stages' prompt templates in a pipeline.
 * Returns deduplicated, sorted array of input variable names (without the `inputs.` prefix).
 *
 * @example
 * extractPipelineInputVariables(stages) → ["target_module", "test_framework"]
 */
function extractPipelineInputVariables(
  stages: Array<{ prompt: string }>
): string[] {
  const inputVars = new Set<string>();
  for (const stage of stages) {
    TEMPLATE_VARIABLE_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TEMPLATE_VARIABLE_REGEX.exec(stage.prompt)) !== null) {
      const varPath = match[1];
      if (varPath.startsWith('inputs.')) {
        inputVars.add(varPath.slice('inputs.'.length));
      }
    }
  }
  return [...inputVars].sort();
}

/**
 * Format a variable name into a human-readable label.
 * Converts snake_case/kebab-case to Title Case.
 *
 * @example formatInputLabel("target_module") → "Target Module"
 */
function formatInputLabel(varName: string): string {
  return varName
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Determines the default work mode based on global settings and current worktree selection.
 *
 * Priority:
 * 1. If forceCurrentBranchMode is true, always defaults to 'current' (work on current branch)
 * 2. If a non-main worktree is selected in the board header, defaults to 'custom' (use that branch)
 * 3. If useWorktrees global setting is enabled, defaults to 'auto' (automatic worktree creation)
 * 4. Otherwise, defaults to 'current' (work on current branch without isolation)
 */
const getDefaultWorkMode = (
  useWorktrees: boolean,
  selectedNonMainWorktreeBranch?: string,
  forceCurrentBranchMode?: boolean
): WorkMode => {
  // If force current branch mode is enabled (worktree setting is off), always use 'current'
  if (forceCurrentBranchMode) {
    return 'current';
  }
  // If a non-main worktree is selected, default to 'custom' mode with that branch
  if (selectedNonMainWorktreeBranch) {
    return 'custom';
  }
  // Otherwise, respect the global worktree setting
  return useWorktrees ? 'auto' : 'current';
};

type FeatureData = {
  title: string;
  category: string;
  description: string;
  images: FeatureImage[];
  imagePaths: DescriptionImagePath[];
  textFilePaths: DescriptionTextFilePath[];
  skipTests: boolean;
  model: AgentModel;
  thinkingLevel: ThinkingLevel;
  reasoningEffort: ReasoningEffort;
  providerId?: string;
  branchName: string;
  priority: number;
  planningMode: PlanningMode;
  requirePlanApproval: boolean;
  dependencies?: string[];
  childDependencies?: string[]; // Feature IDs that should depend on this feature
  excludedPipelineSteps?: string[]; // Pipeline step IDs to skip for this feature
  pipeline?: string; // Pipeline slug to use (e.g., "feature", "bug-fix")
  pipelineInputs?: Record<string, string | number | boolean>; // User-provided input values for pipeline template variables
  workMode: WorkMode;
};

interface AddFeatureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (feature: FeatureData) => void;
  onAddAndStart?: (feature: FeatureData) => void;
  categorySuggestions: string[];
  branchSuggestions: string[];
  branchCardCounts?: Record<string, number>;
  defaultSkipTests: boolean;
  defaultBranch?: string;
  currentBranch?: string;
  isMaximized: boolean;
  parentFeature?: Feature | null;
  allFeatures?: Feature[];
  /**
   * Path to the current project for loading pipeline config.
   */
  projectPath?: string;
  /**
   * When a non-main worktree is selected in the board header, this will be set to that worktree's branch.
   * When set, the dialog will default to 'custom' work mode with this branch pre-filled.
   */
  selectedNonMainWorktreeBranch?: string;
  /**
   * When true, forces the dialog to default to 'current' work mode (work on current branch).
   * This is used when the "Default to worktree mode" setting is disabled.
   */
  forceCurrentBranchMode?: boolean;
  /**
   * Pre-filled title for the feature (e.g., from a GitHub issue).
   */
  prefilledTitle?: string;
  /**
   * Pre-filled description for the feature (e.g., from a GitHub issue).
   */
  prefilledDescription?: string;
  /**
   * Pre-filled category for the feature (e.g., 'From GitHub').
   */
  prefilledCategory?: string;
}

/**
 * A single entry in the description history
 */
interface DescriptionHistoryEntry extends BaseHistoryEntry {
  description: string;
}

export function AddFeatureDialog({
  open,
  onOpenChange,
  onAdd,
  onAddAndStart,
  categorySuggestions,
  branchSuggestions,
  branchCardCounts,
  defaultSkipTests,
  defaultBranch = 'main',
  currentBranch,
  isMaximized,
  parentFeature = null,
  allFeatures = [],
  projectPath,
  selectedNonMainWorktreeBranch,
  forceCurrentBranchMode,
  prefilledTitle,
  prefilledDescription,
  prefilledCategory,
}: AddFeatureDialogProps) {
  const isSpawnMode = !!parentFeature;
  const navigate = useNavigate();
  const [workMode, setWorkMode] = useState<WorkMode>('current');

  // Form state
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<FeatureImage[]>([]);
  const [imagePaths, setImagePaths] = useState<DescriptionImagePath[]>([]);
  const [textFilePaths, setTextFilePaths] = useState<DescriptionTextFilePath[]>([]);
  const [skipTests, setSkipTests] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [priority, setPriority] = useState(2);

  // Model selection state
  const [modelEntry, setModelEntry] = useState<PhaseModelEntry>({ model: 'claude-opus' });

  // Planning mode state
  const [planningMode, setPlanningMode] = useState<PlanningMode>('skip');
  const [requirePlanApproval, setRequirePlanApproval] = useState(false);

  // UI state
  const [previewMap, setPreviewMap] = useState<ImagePreviewMap>(() => new Map());
  const [descriptionError, setDescriptionError] = useState(false);

  // Description history state
  const [descriptionHistory, setDescriptionHistory] = useState<DescriptionHistoryEntry[]>([]);

  // Spawn mode state
  const [ancestors, setAncestors] = useState<AncestorContext[]>([]);
  const [selectedAncestorIds, setSelectedAncestorIds] = useState<Set<string>>(new Set());

  // Dependency selection state (not in spawn mode)
  const [parentDependencies, setParentDependencies] = useState<string[]>([]);
  const [childDependencies, setChildDependencies] = useState<string[]>([]);

  // Pipeline exclusion state
  const [excludedPipelineSteps, setExcludedPipelineSteps] = useState<string[]>([]);

  // YAML Pipeline selection state
  const [selectedPipelineSlug, setSelectedPipelineSlug] = useState<string>('');
  const [pipelineInputs, setPipelineInputs] = useState<Record<string, string | boolean>>({});

  // Discover available YAML pipelines
  const { data: discoveredPipelines = [] } = useDiscoverPipelines(projectPath);

  // Compute the selected pipeline
  const selectedPipeline = useMemo(
    () => discoveredPipelines.find((p) => p.slug === selectedPipelineSlug) ?? null,
    [discoveredPipelines, selectedPipelineSlug]
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
    return extractPipelineInputVariables(selectedPipeline.config.stages).map((varName) => ({
      name: varName,
      type: 'string' as const,
      required: false,
      default: undefined,
      description: undefined,
    }));
  }, [selectedPipeline]);

  // Whether any required input fields are empty — blocks form submission when true
  const hasMissingRequiredInputs = useMemo(() => {
    return pipelineInputDefinitions.some((field) => {
      if (!field.required) return false;
      if (field.type === 'boolean') return false; // Checkboxes always have a value
      const value = pipelineInputs[field.name];
      return value === undefined || String(value).trim() === '';
    });
  }, [pipelineInputDefinitions, pipelineInputs]);

  // Get defaults from store
  const {
    defaultPlanningMode,
    defaultRequirePlanApproval,
    useWorktrees,
    defaultFeatureModel,
    defaultThinkingLevel,
    currentProject,
  } = useAppStore();

  // Use project-level default feature model if set, otherwise fall back to global
  const effectiveDefaultFeatureModel = currentProject?.defaultFeatureModel ?? defaultFeatureModel;

  // Track previous open state to detect when dialog opens
  const wasOpenRef = useRef(false);

  // Sync defaults only when dialog opens (transitions from closed to open)
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;

    if (justOpened) {
      // Initialize with prefilled values if provided, otherwise use defaults
      setTitle(prefilledTitle ?? '');
      setDescription(prefilledDescription ?? '');
      setCategory(prefilledCategory ?? '');

      setSkipTests(defaultSkipTests);
      // When a non-main worktree is selected, use its branch name for custom mode
      // Otherwise, use the default branch
      setBranchName(selectedNonMainWorktreeBranch || defaultBranch || '');
      setWorkMode(
        getDefaultWorkMode(useWorktrees, selectedNonMainWorktreeBranch, forceCurrentBranchMode)
      );
      setPlanningMode(defaultPlanningMode);
      setRequirePlanApproval(defaultRequirePlanApproval);

      // Apply defaultThinkingLevel from settings to the model entry.
      // This ensures the "Quick-Select Defaults" thinking level setting is respected
      // even when the user doesn't change the model in the dropdown.
      const modelId =
        typeof effectiveDefaultFeatureModel.model === 'string'
          ? effectiveDefaultFeatureModel.model
          : '';
      const availableLevels = getThinkingLevelsForModel(modelId);
      const effectiveThinkingLevel = availableLevels.includes(defaultThinkingLevel)
        ? defaultThinkingLevel
        : availableLevels[0];
      setModelEntry({
        ...effectiveDefaultFeatureModel,
        thinkingLevel: effectiveThinkingLevel,
      });

      // Initialize description history (empty for new feature)
      setDescriptionHistory([]);

      // Initialize ancestors for spawn mode
      if (parentFeature) {
        const ancestorList = getAncestors(parentFeature, allFeatures);
        setAncestors(ancestorList);
        setSelectedAncestorIds(new Set([parentFeature.id]));
      } else {
        setAncestors([]);
        setSelectedAncestorIds(new Set());
      }

      // Reset dependency selections
      setParentDependencies([]);
      setChildDependencies([]);

      // Reset pipeline exclusions (all pipelines enabled by default)
      setExcludedPipelineSteps([]);

      // Reset YAML pipeline selection
      setSelectedPipelineSlug('');
      setPipelineInputs({});
    }
  }, [
    open,
    defaultSkipTests,
    defaultBranch,
    defaultPlanningMode,
    defaultRequirePlanApproval,
    effectiveDefaultFeatureModel,
    defaultThinkingLevel,
    useWorktrees,
    selectedNonMainWorktreeBranch,
    forceCurrentBranchMode,
    parentFeature,
    allFeatures,
    prefilledTitle,
    prefilledDescription,
    prefilledCategory,
  ]);

  // Clear requirePlanApproval when planning mode is skip (lite supports approval)
  useEffect(() => {
    if (planningMode === 'skip') {
      setRequirePlanApproval(false);
    }
  }, [planningMode]);

  // When a YAML pipeline is selected, planning is handled by the pipeline - reset to skip
  useEffect(() => {
    if (selectedPipelineSlug) {
      setPlanningMode('skip');
      setRequirePlanApproval(false);
    }
  }, [selectedPipelineSlug]);

  const handleModelChange = (entry: PhaseModelEntry) => {
    const modelId = typeof entry.model === 'string' ? entry.model : '';
    const normalizedThinkingLevel = normalizeThinkingLevelForModel(modelId, entry.thinkingLevel);

    setModelEntry({ ...entry, thinkingLevel: normalizedThinkingLevel });
  };

  const buildFeatureData = (): FeatureData | null => {
    if (!description.trim()) {
      setDescriptionError(true);
      return null;
    }

    if (workMode === 'custom' && !branchName.trim()) {
      toast.error('Please select a branch name');
      return null;
    }

    const finalCategory = category || 'Uncategorized';
    const normalizedEntry = normalizeModelEntry(modelEntry);

    // For 'current' mode, use empty string (work on current branch)
    // For 'auto' mode, use empty string (will be auto-generated in use-board-actions)
    // For 'custom' mode, use the specified branch name
    const finalBranchName = workMode === 'custom' ? branchName || '' : '';

    // Build final description with ancestor context in spawn mode
    let finalDescription = description;
    if (isSpawnMode && parentFeature && selectedAncestorIds.size > 0) {
      const parentContext: AncestorContext = {
        id: parentFeature.id,
        title: parentFeature.title,
        description: parentFeature.description,
        spec: parentFeature.spec,
        summary: parentFeature.summary,
        depth: -1,
      };

      const allAncestorsWithParent = [parentContext, ...ancestors];
      const contextText = formatAncestorContextForPrompt(
        allAncestorsWithParent,
        selectedAncestorIds
      );

      if (contextText) {
        finalDescription = `${contextText}\n\n---\n\n## Task Description\n\n${description}`;
      }
    }

    // Determine final dependencies
    // In spawn mode, use parent feature as dependency
    // Otherwise, use manually selected parent dependencies
    const finalDependencies =
      isSpawnMode && parentFeature
        ? [parentFeature.id]
        : parentDependencies.length > 0
          ? parentDependencies
          : undefined;

    // Build pipeline inputs as Record<string, string | number | boolean>
    // Apply type coercion based on declared input types
    const finalPipelineInputs: Record<string, string | number | boolean> = {};
    if (selectedPipelineSlug) {
      for (const field of pipelineInputDefinitions) {
        const rawValue = pipelineInputs[field.name];
        if (field.type === 'boolean') {
          finalPipelineInputs[field.name] = typeof rawValue === 'boolean' ? rawValue : (field.default ?? false);
        } else if (field.type === 'number') {
          const strValue = String(rawValue ?? '').trim();
          if (strValue !== '') {
            const numValue = Number(strValue);
            finalPipelineInputs[field.name] = isNaN(numValue) ? strValue : numValue;
          } else if (field.default !== undefined) {
            finalPipelineInputs[field.name] = field.default;
          }
        } else {
          const strValue = String(rawValue ?? '').trim();
          if (strValue !== '') {
            finalPipelineInputs[field.name] = strValue;
          } else if (field.default !== undefined) {
            finalPipelineInputs[field.name] = String(field.default);
          }
        }
      }
    }

    return {
      title,
      category: finalCategory,
      description: finalDescription,
      images,
      imagePaths,
      textFilePaths,
      skipTests,
      model: normalizedEntry.model,
      thinkingLevel: normalizedEntry.thinkingLevel,
      reasoningEffort: normalizedEntry.reasoningEffort,
      providerId: normalizedEntry.providerId,
      branchName: finalBranchName,
      priority,
      planningMode,
      requirePlanApproval,
      dependencies: finalDependencies,
      childDependencies: childDependencies.length > 0 ? childDependencies : undefined,
      excludedPipelineSteps: excludedPipelineSteps.length > 0 ? excludedPipelineSteps : undefined,
      pipeline: selectedPipelineSlug || undefined,
      pipelineInputs: Object.keys(finalPipelineInputs).length > 0 ? finalPipelineInputs : undefined,
      workMode,
    };
  };

  const resetForm = () => {
    setTitle('');
    setCategory('');
    setDescription('');
    setImages([]);
    setImagePaths([]);
    setTextFilePaths([]);
    setSkipTests(defaultSkipTests);
    // When a non-main worktree is selected, use its branch name for custom mode
    setBranchName(selectedNonMainWorktreeBranch || '');
    setPriority(2);
    // Apply defaultThinkingLevel to the model entry (same logic as dialog open)
    const resetModelId =
      typeof effectiveDefaultFeatureModel.model === 'string'
        ? effectiveDefaultFeatureModel.model
        : '';
    const resetAvailableLevels = getThinkingLevelsForModel(resetModelId);
    const resetThinkingLevel = resetAvailableLevels.includes(defaultThinkingLevel)
      ? defaultThinkingLevel
      : resetAvailableLevels[0];
    setModelEntry({
      ...effectiveDefaultFeatureModel,
      thinkingLevel: resetThinkingLevel,
    });
    setWorkMode(
      getDefaultWorkMode(useWorktrees, selectedNonMainWorktreeBranch, forceCurrentBranchMode)
    );
    setPlanningMode(defaultPlanningMode);
    setRequirePlanApproval(defaultRequirePlanApproval);
    setPreviewMap(new Map());
    setDescriptionError(false);
    setDescriptionHistory([]);
    setParentDependencies([]);
    setChildDependencies([]);
    setExcludedPipelineSteps([]);
    setSelectedPipelineSlug('');
    setPipelineInputs({});
    onOpenChange(false);
  };

  const handleAction = (actionFn?: (data: FeatureData) => void) => {
    if (!actionFn) return;
    const featureData = buildFeatureData();
    if (!featureData) return;
    actionFn(featureData);
    resetForm();
  };

  const handleAdd = () => handleAction(onAdd);
  const handleAddAndStart = () => handleAction(onAddAndStart);

  const handleDialogClose = (open: boolean) => {
    onOpenChange(open);
    if (!open) {
      setPreviewMap(new Map());
      setDescriptionError(false);
    }
  };

  // Shared card styling
  const cardClass = 'rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3';
  const sectionHeaderClass = 'flex items-center gap-2 text-sm font-medium text-foreground';

  return (
    <Dialog open={open} onOpenChange={handleDialogClose}>
      <DialogContent
        compact={!isMaximized}
        data-testid="add-feature-dialog"
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
          <DialogTitle>{isSpawnMode ? 'Spawn Sub-Task' : 'Add New Feature'}</DialogTitle>
          <DialogDescription>
            {isSpawnMode
              ? `Create a sub-task that depends on "${parentFeature?.title || parentFeature?.description.slice(0, 50)}..."`
              : 'Create a new feature card for the Kanban board.'}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          {/* Ancestor Context Section - only in spawn mode */}
          {isSpawnMode && parentFeature && (
            <AncestorContextSection
              parentFeature={{
                id: parentFeature.id,
                title: parentFeature.title,
                description: parentFeature.description,
                spec: parentFeature.spec,
                summary: parentFeature.summary,
              }}
              ancestors={ancestors}
              selectedAncestorIds={selectedAncestorIds}
              onSelectionChange={setSelectedAncestorIds}
            />
          )}

          {/* Task Details Section */}
          <div className={cardClass}>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="description">Description</Label>
                {/* Version History Button */}
                <EnhancementHistoryButton
                  history={descriptionHistory}
                  currentValue={description}
                  onRestore={setDescription}
                  valueAccessor={(entry) => entry.description}
                  title="Version History"
                  restoreMessage="Description restored from history"
                />
              </div>
              <DescriptionImageDropZone
                value={description}
                onChange={(value) => {
                  setDescription(value);
                  if (value.trim()) setDescriptionError(false);
                }}
                images={imagePaths}
                onImagesChange={setImagePaths}
                textFiles={textFilePaths}
                onTextFilesChange={setTextFilePaths}
                placeholder="Describe the feature..."
                previewMap={previewMap}
                onPreviewMapChange={setPreviewMap}
                autoFocus
                error={descriptionError}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="title">Title (optional)</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Leave blank to auto-generate"
              />
            </div>

            {/* Enhancement Section */}
            <EnhanceWithAI
              value={description}
              onChange={setDescription}
              onHistoryAdd={({ mode, originalText, enhancedText }) => {
                const timestamp = new Date().toISOString();
                setDescriptionHistory((prev) => {
                  const newHistory = [...prev];
                  // Add original text first (so user can restore to pre-enhancement state)
                  // Only add if it's different from the last entry to avoid duplicates
                  const lastEntry = prev[prev.length - 1];
                  if (!lastEntry || lastEntry.description !== originalText) {
                    newHistory.push({
                      description: originalText,
                      timestamp,
                      source: prev.length === 0 ? 'initial' : 'edit',
                    });
                  }
                  // Add enhanced text
                  newHistory.push({
                    description: enhancedText,
                    timestamp,
                    source: 'enhance',
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
                      onOpenChange(false);
                      navigate({ to: '/settings', search: { view: 'defaults' } });
                    }}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    <span>Edit Defaults</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Change default model and planning settings for new features</p>
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

            <div className={cn('grid gap-3', selectedPipelineSlug ? 'grid-cols-1' : 'grid-cols-2')}>
              {!selectedPipelineSlug && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Planning</Label>
                  <PlanningModeSelect
                    mode={planningMode}
                    onModeChange={setPlanningMode}
                    testIdPrefix="add-feature-planning"
                    compact
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Options</Label>
                <div className="flex flex-col gap-2 pt-1">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="add-feature-skip-tests"
                      checked={!skipTests}
                      onCheckedChange={(checked) => setSkipTests(!checked)}
                      data-testid="add-feature-skip-tests-checkbox"
                    />
                    <Label
                      htmlFor="add-feature-skip-tests"
                      className="text-xs font-normal cursor-pointer"
                    >
                      Run tests
                    </Label>
                  </div>
                  {!selectedPipelineSlug && (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="add-feature-require-approval"
                        checked={requirePlanApproval}
                        onCheckedChange={(checked) => setRequirePlanApproval(!!checked)}
                        disabled={planningMode === 'skip'}
                        data-testid="add-feature-planning-require-approval-checkbox"
                      />
                      <Label
                        htmlFor="add-feature-require-approval"
                        className={cn(
                          'text-xs font-normal',
                          planningMode === 'skip'
                            ? 'cursor-not-allowed text-muted-foreground'
                            : 'cursor-pointer'
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
                <Label className="text-xs text-muted-foreground">Workflow Pipeline</Label>
                <Select
                  value={selectedPipelineSlug}
                  onValueChange={(value) => {
                    const slug = value === '__none__' ? '' : value;
                    setSelectedPipelineSlug(slug);
                    // Reset inputs and pre-fill defaults when pipeline changes
                    if (slug) {
                      const pipeline = discoveredPipelines.find((p) => p.slug === slug);
                      const declared = pipeline?.config.inputs;
                      if (declared && Object.keys(declared).length > 0) {
                        const defaults: Record<string, string | boolean> = {};
                        for (const [name, input] of Object.entries(declared)) {
                          if (input.type === 'boolean') {
                            defaults[name] = typeof input.default === 'boolean' ? input.default : false;
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
                  <SelectTrigger data-testid="add-feature-pipeline-select">
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
                            {pipeline.config.description} ({pipeline.stageCount} stage{pipeline.stageCount !== 1 ? 's' : ''})
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
                        <span className="text-[10px] font-mono opacity-60">{idx + 1}</span>
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
                      {field.type === 'boolean' ? (
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`pipeline-input-${field.name}`}
                            checked={
                              typeof pipelineInputs[field.name] === 'boolean'
                                ? pipelineInputs[field.name]
                                : false
                            }
                            onCheckedChange={(checked) =>
                              setPipelineInputs((prev) => ({
                                ...prev,
                                [field.name]: !!checked,
                              }))
                            }
                            data-testid={`add-feature-pipeline-input-${field.name}`}
                          />
                          <Label
                            htmlFor={`pipeline-input-${field.name}`}
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
                              htmlFor={`pipeline-input-${field.name}`}
                              className="text-xs font-medium"
                            >
                              {formatInputLabel(field.name)}
                            </Label>
                            {field.required && (
                              <span className="text-xs text-destructive" aria-label="required">
                                *
                              </span>
                            )}
                          </div>
                          <Input
                            id={`pipeline-input-${field.name}`}
                            type={field.type === 'number' ? 'number' : 'text'}
                            value={
                              typeof pipelineInputs[field.name] === 'string'
                                ? pipelineInputs[field.name]
                                : ''
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
                            data-testid={`add-feature-pipeline-input-${field.name}`}
                          />
                          {field.description && (
                            <p className="text-xs text-muted-foreground">{field.description}</p>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    These values will be available as template variables in the pipeline stages.
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
                <Label className="text-xs text-muted-foreground">Category</Label>
                <CategoryAutocomplete
                  value={category}
                  onChange={setCategory}
                  suggestions={categorySuggestions}
                  placeholder="e.g., Core, UI, API"
                  data-testid="feature-category-input"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Priority</Label>
                <PrioritySelector
                  selectedPriority={priority}
                  onPrioritySelect={setPriority}
                  testIdPrefix="priority"
                />
              </div>
            </div>

            {/* Work Mode Selector */}
            <div className="pt-2">
              <WorkModeSelector
                workMode={workMode}
                onWorkModeChange={setWorkMode}
                branchName={branchName}
                onBranchNameChange={setBranchName}
                branchSuggestions={branchSuggestions}
                branchCardCounts={branchCardCounts}
                currentBranch={currentBranch}
                testIdPrefix="feature-work-mode"
              />
            </div>

            {/* Dependencies - only show when not in spawn mode */}
            {!isSpawnMode && allFeatures.length > 0 && (
              <div className="pt-2 space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Parent Dependencies (this feature depends on)
                  </Label>
                  <DependencySelector
                    value={parentDependencies}
                    onChange={setParentDependencies}
                    features={allFeatures}
                    type="parent"
                    placeholder="Select features this depends on..."
                    data-testid="add-feature-parent-deps"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Child Dependencies (features that depend on this)
                  </Label>
                  <DependencySelector
                    value={childDependencies}
                    onChange={setChildDependencies}
                    features={allFeatures}
                    type="child"
                    placeholder="Select features that will depend on this..."
                    data-testid="add-feature-child-deps"
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
                testIdPrefix="add-feature-pipeline"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {onAddAndStart && (
            <Button
              onClick={handleAddAndStart}
              variant="secondary"
              data-testid="confirm-add-and-start-feature"
              disabled={(workMode === 'custom' && !branchName.trim()) || hasMissingRequiredInputs}
            >
              <Play className="w-4 h-4 mr-2" />
              Make
            </Button>
          )}
          <HotkeyButton
            onClick={handleAdd}
            hotkey={{ key: 'Enter', cmdCtrl: true }}
            hotkeyActive={open}
            data-testid="confirm-add-feature"
            disabled={(workMode === 'custom' && !branchName.trim()) || hasMissingRequiredInputs}
          >
            {isSpawnMode ? 'Spawn Task' : 'Add Feature'}
          </HotkeyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
