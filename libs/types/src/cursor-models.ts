import type { CursorModelId as CursorRegistryModelId } from './model-registry.gen.js';

/**
 * Cursor Model IDs — derived from the generated model registry (run `pnpm sync-models` to update)
 * Reference: https://cursor.com/docs/models-and-pricing
 *
 * All Cursor model IDs use 'cursor-' prefix for consistent provider routing.
 * This prevents naming collisions (e.g., cursor-gpt-5.2-codex vs codex-gpt-5.2-codex).
 */
export type CursorModelId = CursorRegistryModelId;

/**
 * Legacy Cursor model IDs (without prefix) for migration support
 */
export type LegacyCursorModelId =
  | 'auto'
  | 'composer-1'
  | 'sonnet-4.6'
  | 'sonnet-4.6-thinking'
  | 'sonnet-4.5'
  | 'sonnet-4.5-thinking'
  | 'opus-4.5'
  | 'opus-4.5-thinking'
  | 'opus-4.1'
  | 'gemini-3-pro'
  | 'gemini-3-flash'
  | 'grok';

/**
 * Cursor model metadata
 */
export interface CursorModelConfig {
  id: CursorModelId;
  label: string;
  description: string;
  hasThinking: boolean;
  supportsVision: boolean;
}

/**
 * Complete model map for Cursor
 * All keys use 'cursor-' prefix for consistent provider routing.
 */
export const CURSOR_MODEL_MAP: Record<CursorModelId, CursorModelConfig> = {
  // ── Anthropic Claude ────────────────────────────────────────────────
  'cursor-sonnet-4': {
    id: 'cursor-sonnet-4',
    label: 'Claude 4 Sonnet',
    description: 'Anthropic Claude 4 Sonnet via Cursor',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-sonnet-4-1m': {
    id: 'cursor-sonnet-4-1m',
    label: 'Claude 4 Sonnet 1M',
    description: 'Claude 4 Sonnet with 1M context window',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-haiku-4.5': {
    id: 'cursor-haiku-4.5',
    label: 'Claude 4.5 Haiku',
    description: 'Anthropic Claude 4.5 Haiku via Cursor',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-opus-4.5': {
    id: 'cursor-opus-4.5',
    label: 'Claude 4.5 Opus',
    description: 'Anthropic Claude 4.5 Opus via Cursor',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-sonnet-4.5': {
    id: 'cursor-sonnet-4.5',
    label: 'Claude 4.5 Sonnet',
    description: 'Anthropic Claude 4.5 Sonnet via Cursor',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-opus-4.6': {
    id: 'cursor-opus-4.6',
    label: 'Claude 4.6 Opus',
    description: 'Anthropic Claude 4.6 Opus via Cursor',
    hasThinking: true,
    supportsVision: true,
  },
  'cursor-opus-4.6-fast': {
    id: 'cursor-opus-4.6-fast',
    label: 'Claude 4.6 Opus (Fast)',
    description: 'Claude 4.6 Opus with faster output',
    hasThinking: true,
    supportsVision: true,
  },
  'cursor-sonnet-4.6': {
    id: 'cursor-sonnet-4.6',
    label: 'Claude 4.6 Sonnet',
    description: 'Anthropic Claude 4.6 Sonnet via Cursor',
    hasThinking: true,
    supportsVision: true,
  },

  // ── Cursor Composer ─────────────────────────────────────────────────
  'cursor-composer-1': {
    id: 'cursor-composer-1',
    label: 'Composer 1',
    description: 'Cursor Composer agent model',
    hasThinking: false,
    supportsVision: false,
  },
  'cursor-composer-1.5': {
    id: 'cursor-composer-1.5',
    label: 'Composer 1.5',
    description: 'Cursor Composer 1.5 agent model',
    hasThinking: false,
    supportsVision: false,
  },
  'cursor-composer-2': {
    id: 'cursor-composer-2',
    label: 'Composer 2',
    description: 'Cursor Composer 2 agent model',
    hasThinking: false,
    supportsVision: false,
  },

  // ── Google Gemini ───────────────────────────────────────────────────
  'cursor-gemini-2.5-flash': {
    id: 'cursor-gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description: 'Google Gemini 2.5 Flash via Cursor',
    hasThinking: true,
    supportsVision: true,
  },
  'cursor-gemini-3-flash': {
    id: 'cursor-gemini-3-flash',
    label: 'Gemini 3 Flash',
    description: 'Google Gemini 3 Flash via Cursor',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-gemini-3-pro': {
    id: 'cursor-gemini-3-pro',
    label: 'Gemini 3 Pro',
    description: 'Google Gemini 3 Pro via Cursor',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-gemini-3-pro-image-preview': {
    id: 'cursor-gemini-3-pro-image-preview',
    label: 'Gemini 3 Pro Image Preview',
    description: 'Gemini 3 Pro with image generation (preview)',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-gemini-3.1-pro': {
    id: 'cursor-gemini-3.1-pro',
    label: 'Gemini 3.1 Pro',
    description: 'Google Gemini 3.1 Pro via Cursor',
    hasThinking: false,
    supportsVision: true,
  },

  // ── OpenAI GPT ──────────────────────────────────────────────────────
  'cursor-gpt-5': {
    id: 'cursor-gpt-5',
    label: 'GPT-5',
    description: 'OpenAI GPT-5 via Cursor',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-gpt-5-fast': {
    id: 'cursor-gpt-5-fast',
    label: 'GPT-5 Fast',
    description: 'OpenAI GPT-5 with faster output',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-gpt-5-mini': {
    id: 'cursor-gpt-5-mini',
    label: 'GPT-5 Mini',
    description: 'OpenAI GPT-5 Mini via Cursor',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-gpt-5-codex': {
    id: 'cursor-gpt-5-codex',
    label: 'GPT-5 Codex',
    description: 'OpenAI GPT-5 Codex for code generation',
    hasThinking: false,
    supportsVision: false,
  },
  'cursor-gpt-5.1-codex': {
    id: 'cursor-gpt-5.1-codex',
    label: 'GPT-5.1 Codex',
    description: 'OpenAI GPT-5.1 Codex for code generation',
    hasThinking: false,
    supportsVision: false,
  },
  'cursor-gpt-5.1-codex-max': {
    id: 'cursor-gpt-5.1-codex-max',
    label: 'GPT-5.1 Codex Max',
    description: 'OpenAI GPT-5.1 Codex Max capacity',
    hasThinking: false,
    supportsVision: false,
  },
  'cursor-gpt-5.1-codex-mini': {
    id: 'cursor-gpt-5.1-codex-mini',
    label: 'GPT-5.1 Codex Mini',
    description: 'OpenAI GPT-5.1 Codex Mini',
    hasThinking: false,
    supportsVision: false,
  },
  'cursor-gpt-5.2': {
    id: 'cursor-gpt-5.2',
    label: 'GPT-5.2',
    description: 'OpenAI GPT-5.2 via Cursor',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-gpt-5.2-codex': {
    id: 'cursor-gpt-5.2-codex',
    label: 'GPT-5.2 Codex',
    description: 'OpenAI GPT-5.2 Codex for code generation',
    hasThinking: false,
    supportsVision: false,
  },
  'cursor-gpt-5.3-codex': {
    id: 'cursor-gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    description: 'OpenAI GPT-5.3 Codex for code generation',
    hasThinking: false,
    supportsVision: false,
  },
  'cursor-gpt-5.4': {
    id: 'cursor-gpt-5.4',
    label: 'GPT-5.4',
    description: 'OpenAI GPT-5.4 via Cursor',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-gpt-5.4-mini': {
    id: 'cursor-gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: 'OpenAI GPT-5.4 Mini via Cursor',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-gpt-5.4-nano': {
    id: 'cursor-gpt-5.4-nano',
    label: 'GPT-5.4 Nano',
    description: 'OpenAI GPT-5.4 Nano via Cursor',
    hasThinking: false,
    supportsVision: false,
  },

  // ── Other providers ─────────────────────────────────────────────────
  'cursor-grok-4.20': {
    id: 'cursor-grok-4.20',
    label: 'Grok 4.20',
    description: 'xAI Grok 4.20 via Cursor',
    hasThinking: false,
    supportsVision: true,
  },
  'cursor-kimi-k2.5': {
    id: 'cursor-kimi-k2.5',
    label: 'Kimi K2.5',
    description: 'Moonshot Kimi K2.5 via Cursor',
    hasThinking: false,
    supportsVision: false,
  },
};

/**
 * Map from legacy model IDs to canonical prefixed IDs.
 * Retired models are mapped to their closest replacement.
 */
export const LEGACY_CURSOR_MODEL_MAP: Record<LegacyCursorModelId, CursorModelId> = {
  auto: 'cursor-sonnet-4.6',
  'composer-1': 'cursor-composer-1',
  'sonnet-4.6': 'cursor-sonnet-4.6',
  'sonnet-4.6-thinking': 'cursor-sonnet-4.6', // thinking variants removed
  'sonnet-4.5': 'cursor-sonnet-4.5',
  'sonnet-4.5-thinking': 'cursor-sonnet-4.5',
  'opus-4.5': 'cursor-opus-4.5',
  'opus-4.5-thinking': 'cursor-opus-4.5',
  'opus-4.1': 'cursor-opus-4.5', // 4.1 retired → 4.5
  'gemini-3-pro': 'cursor-gemini-3-pro',
  'gemini-3-flash': 'cursor-gemini-3-flash',
  grok: 'cursor-grok-4.20',
};

/**
 * Helper: Check if model has thinking capability
 */
export function cursorModelHasThinking(modelId: CursorModelId): boolean {
  return CURSOR_MODEL_MAP[modelId]?.hasThinking ?? false;
}

/**
 * Helper: Get display name for model
 */
export function getCursorModelLabel(modelId: CursorModelId): string {
  return CURSOR_MODEL_MAP[modelId]?.label ?? modelId;
}

/**
 * Helper: Get all cursor model IDs
 */
export function getAllCursorModelIds(): CursorModelId[] {
  return Object.keys(CURSOR_MODEL_MAP) as CursorModelId[];
}

// ============================================================================
// Model Grouping System
// Groups related model variants for UI display
// ============================================================================

/**
 * Type of variant options available for grouped models
 */
export type VariantType = 'compute' | 'thinking' | 'capacity';

/**
 * A single variant option within a grouped model
 */
export interface ModelVariant {
  id: CursorModelId;
  label: string;
  description?: string;
  badge?: string;
}

/**
 * A grouped model that contains multiple variant options
 */
export interface GroupedModel {
  baseId: string;
  label: string;
  description: string;
  variantType: VariantType;
  variants: ModelVariant[];
}

/**
 * Configuration for grouping Cursor models with variants
 */
export const CURSOR_MODEL_GROUPS: GroupedModel[] = [
  // Opus 4.6 group (fast mode variant)
  {
    baseId: 'cursor-opus-4.6-group',
    label: 'Claude 4.6 Opus',
    description: 'Anthropic Claude 4.6 Opus via Cursor',
    variantType: 'compute',
    variants: [
      { id: 'cursor-opus-4.6', label: 'Standard', description: 'Default speed' },
      {
        id: 'cursor-opus-4.6-fast',
        label: 'Fast',
        description: 'Faster output',
        badge: 'Fast',
      },
    ],
  },
  // GPT-5 group (fast variant)
  {
    baseId: 'cursor-gpt-5-group',
    label: 'GPT-5',
    description: 'OpenAI GPT-5 via Cursor',
    variantType: 'compute',
    variants: [
      { id: 'cursor-gpt-5', label: 'Standard', description: 'Default speed' },
      {
        id: 'cursor-gpt-5-fast',
        label: 'Fast',
        description: 'Faster output',
        badge: 'Fast',
      },
    ],
  },
  // Claude 4 Sonnet group (context window variant)
  {
    baseId: 'cursor-sonnet-4-group',
    label: 'Claude 4 Sonnet',
    description: 'Anthropic Claude 4 Sonnet via Cursor',
    variantType: 'capacity',
    variants: [
      { id: 'cursor-sonnet-4', label: 'Standard', description: 'Default context' },
      {
        id: 'cursor-sonnet-4-1m',
        label: '1M Context',
        description: '1M token context window',
        badge: '1M',
      },
    ],
  },
  // GPT-5.1 Codex group (capacity variants)
  {
    baseId: 'cursor-gpt-5.1-codex-group',
    label: 'GPT-5.1 Codex',
    description: 'OpenAI GPT-5.1 Codex for code generation',
    variantType: 'capacity',
    variants: [
      {
        id: 'cursor-gpt-5.1-codex-mini',
        label: 'Mini',
        description: 'Lightweight',
      },
      { id: 'cursor-gpt-5.1-codex', label: 'Standard', description: 'Default capacity' },
      {
        id: 'cursor-gpt-5.1-codex-max',
        label: 'Max',
        description: 'Maximum capacity',
        badge: 'Max',
      },
    ],
  },
];

/**
 * Cursor models that are not part of any group (standalone)
 */
export const STANDALONE_CURSOR_MODELS: CursorModelId[] = [
  'cursor-haiku-4.5',
  'cursor-opus-4.5',
  'cursor-sonnet-4.5',
  'cursor-sonnet-4.6',
  'cursor-composer-1',
  'cursor-composer-1.5',
  'cursor-composer-2',
  'cursor-gemini-2.5-flash',
  'cursor-gemini-3-flash',
  'cursor-gemini-3-pro',
  'cursor-gemini-3-pro-image-preview',
  'cursor-gemini-3.1-pro',
  'cursor-gpt-5-mini',
  'cursor-gpt-5-codex',
  'cursor-gpt-5.2',
  'cursor-gpt-5.2-codex',
  'cursor-gpt-5.3-codex',
  'cursor-gpt-5.4',
  'cursor-gpt-5.4-mini',
  'cursor-gpt-5.4-nano',
  'cursor-grok-4.20',
  'cursor-kimi-k2.5',
];

/**
 * Get the group that a model belongs to (if any)
 */
export function getModelGroup(modelId: CursorModelId): GroupedModel | undefined {
  return CURSOR_MODEL_GROUPS.find((group) => group.variants.some((v) => v.id === modelId));
}

/**
 * Check if any variant in a group is the currently selected model
 */
export function isGroupSelected(
  group: GroupedModel,
  currentModelId: CursorModelId | undefined
): boolean {
  if (!currentModelId) return false;
  return group.variants.some((v) => v.id === currentModelId);
}

/**
 * Get the currently selected variant within a group
 */
export function getSelectedVariant(
  group: GroupedModel,
  currentModelId: CursorModelId | undefined
): ModelVariant | undefined {
  if (!currentModelId) return undefined;
  return group.variants.find((v) => v.id === currentModelId);
}

/**
 * Check if a model ID belongs to a group
 */
export function isGroupedCursorModel(modelId: CursorModelId): boolean {
  return CURSOR_MODEL_GROUPS.some((group) => group.variants.some((v) => v.id === modelId));
}
