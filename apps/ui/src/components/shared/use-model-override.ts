import { useState, useCallback, useMemo, useRef } from "react";
import { useAppStore } from "@/store/app-store";
import type { ModelId, PhaseModelKey, PhaseModelEntry } from "@pegasus/types";
import { DEFAULT_PHASE_MODELS } from "@pegasus/types";

export interface UseModelOverrideOptions {
  /** Which phase this override is for */
  phase: PhaseModelKey;
  /** Initial override value (optional) */
  initialOverride?: PhaseModelEntry | null;
}

export interface UseModelOverrideResult {
  /** The effective model entry (override or global default) */
  effectiveModelEntry: PhaseModelEntry;
  /** The effective model string (for backward compatibility with APIs that only accept strings) */
  effectiveModel: ModelId;
  /** Whether the model is currently overridden */
  isOverridden: boolean;
  /** Set a model override */
  setOverride: (entry: PhaseModelEntry | null) => void;
  /** Clear the override and use global default */
  clearOverride: () => void;
  /** The global default for this phase */
  globalDefault: PhaseModelEntry;
  /** The current override value (null if not overridden) */
  override: PhaseModelEntry | null;
}

/**
 * Normalize PhaseModelEntry or string to PhaseModelEntry
 * Handles undefined/null gracefully (e.g., when phaseModels from server settings
 * is missing a recently-added phase key)
 */
function normalizeEntry(
  entry: PhaseModelEntry | string | undefined | null,
): PhaseModelEntry {
  if (!entry) {
    return { model: "claude-sonnet" as ModelId };
  }
  if (typeof entry === "string") {
    return { model: entry as ModelId };
  }
  return entry;
}

/**
 * Hook for managing model overrides per phase
 *
 * Provides a simple way to allow users to override the global phase model
 * for a specific run or context. Supports PhaseModelEntry with thinking levels.
 *
 * **Persistence:** All overrides are automatically persisted to the Zustand store
 * (and synced to the server via the settings sync pipeline). When a component
 * mounts, it hydrates from the last-used override if no explicit initialOverride
 * is provided.
 *
 * @example
 * ```tsx
 * function EnhanceDialog() {
 *   const { effectiveModelEntry, isOverridden, setOverride, clearOverride } = useModelOverride({
 *     phase: 'enhancementModel',
 *   });
 *
 *   return (
 *     <ModelOverrideTrigger
 *       currentModelEntry={effectiveModelEntry}
 *       onModelChange={setOverride}
 *       phase="enhancementModel"
 *       isOverridden={isOverridden}
 *     />
 *   );
 * }
 * ```
 */
export function useModelOverride({
  phase,
  initialOverride = null,
}: UseModelOverrideOptions): UseModelOverrideResult {
  const {
    phaseModels,
    lastUsedPhaseOverrides,
    setLastUsedPhaseOverride,
    clearLastUsedPhaseOverride,
  } = useAppStore();

  // Hydrate initial state: prefer explicit initialOverride, then persisted last-used, then null
  const hydratedRef = useRef(false);
  const [override, setOverrideState] = useState<PhaseModelEntry | null>(() => {
    if (initialOverride) {
      return normalizeEntry(initialOverride);
    }
    // Hydrate from persisted last-used override
    const persisted = lastUsedPhaseOverrides[phase];
    if (persisted) {
      hydratedRef.current = true;
      return normalizeEntry(persisted);
    }
    return null;
  });

  // Normalize global default to PhaseModelEntry, with fallback to DEFAULT_PHASE_MODELS
  // This handles cases where settings haven't been migrated to include new phase models
  const globalDefault = normalizeEntry(
    phaseModels[phase] ?? DEFAULT_PHASE_MODELS[phase],
  );

  const effectiveModelEntry = useMemo(() => {
    return override ?? globalDefault;
  }, [override, globalDefault]);

  const effectiveModel = useMemo(() => {
    return effectiveModelEntry.model;
  }, [effectiveModelEntry]);

  const isOverridden = override !== null;

  const setOverride = useCallback(
    (entry: PhaseModelEntry | null) => {
      const normalized = entry ? normalizeEntry(entry) : null;
      setOverrideState(normalized);

      // Persist to store (which triggers settings sync to server)
      if (normalized) {
        setLastUsedPhaseOverride(phase, normalized);
      } else {
        clearLastUsedPhaseOverride(phase);
      }
    },
    [phase, setLastUsedPhaseOverride, clearLastUsedPhaseOverride],
  );

  const clearOverride = useCallback(() => {
    setOverrideState(null);
    clearLastUsedPhaseOverride(phase);
  }, [phase, clearLastUsedPhaseOverride]);

  return {
    effectiveModelEntry,
    effectiveModel,
    isOverridden,
    setOverride,
    clearOverride,
    globalDefault,
    override,
  };
}
