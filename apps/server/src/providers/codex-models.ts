/**
 * Codex Model Definitions
 *
 * Official Codex CLI models as documented at https://developers.openai.com/codex/models/
 */

import { CODEX_MODEL_MAP } from "@pegasus/types";
import type { ModelDefinition } from "./types.js";

const CONTEXT_WINDOW_256K = 256000;
const CONTEXT_WINDOW_128K = 128000;
const MAX_OUTPUT_32K = 32000;
const MAX_OUTPUT_16K = 16000;

/**
 * All available Codex models with their specifications
 * Based on https://developers.openai.com/codex/models/
 */
export const CODEX_MODELS: ModelDefinition[] = [
  // ========== Recommended Codex Models ==========
  {
    id: CODEX_MODEL_MAP.gpt53Codex,
    name: "GPT-5.3-Codex",
    modelString: CODEX_MODEL_MAP.gpt53Codex,
    provider: "openai",
    description: "Latest frontier agentic coding model.",
    contextWindow: CONTEXT_WINDOW_256K,
    maxOutputTokens: MAX_OUTPUT_32K,
    supportsVision: true,
    supportsTools: true,
    tier: "premium" as const,
    default: true,
    hasReasoning: true,
  },
  {
    id: CODEX_MODEL_MAP.gpt53CodexSpark,
    name: "GPT-5.3-Codex-Spark",
    modelString: CODEX_MODEL_MAP.gpt53CodexSpark,
    provider: "openai",
    description: "Near-instant real-time coding model, 1000+ tokens/sec.",
    contextWindow: CONTEXT_WINDOW_256K,
    maxOutputTokens: MAX_OUTPUT_32K,
    supportsVision: true,
    supportsTools: true,
    tier: "premium" as const,
    hasReasoning: true,
  },
  {
    id: CODEX_MODEL_MAP.gpt52Codex,
    name: "GPT-5.2-Codex",
    modelString: CODEX_MODEL_MAP.gpt52Codex,
    provider: "openai",
    description: "Frontier agentic coding model.",
    contextWindow: CONTEXT_WINDOW_256K,
    maxOutputTokens: MAX_OUTPUT_32K,
    supportsVision: true,
    supportsTools: true,
    tier: "premium" as const,
    hasReasoning: true,
  },
  {
    id: CODEX_MODEL_MAP.gpt51CodexMax,
    name: "GPT-5.1-Codex-Max",
    modelString: CODEX_MODEL_MAP.gpt51CodexMax,
    provider: "openai",
    description: "Codex-optimized flagship for deep and fast reasoning.",
    contextWindow: CONTEXT_WINDOW_256K,
    maxOutputTokens: MAX_OUTPUT_32K,
    supportsVision: true,
    supportsTools: true,
    tier: "premium" as const,
    hasReasoning: true,
  },
  {
    id: CODEX_MODEL_MAP.gpt51CodexMini,
    name: "GPT-5.1-Codex-Mini",
    modelString: CODEX_MODEL_MAP.gpt51CodexMini,
    provider: "openai",
    description: "Optimized for codex. Cheaper, faster, but less capable.",
    contextWindow: CONTEXT_WINDOW_128K,
    maxOutputTokens: MAX_OUTPUT_16K,
    supportsVision: true,
    supportsTools: true,
    tier: "basic" as const,
    hasReasoning: false,
  },
  {
    id: CODEX_MODEL_MAP.gpt51Codex,
    name: "GPT-5.1-Codex",
    modelString: CODEX_MODEL_MAP.gpt51Codex,
    provider: "openai",
    description: "Original GPT-5.1 Codex agentic coding model.",
    contextWindow: CONTEXT_WINDOW_256K,
    maxOutputTokens: MAX_OUTPUT_32K,
    supportsVision: true,
    supportsTools: true,
    tier: "standard" as const,
    hasReasoning: true,
  },
  {
    id: CODEX_MODEL_MAP.gpt5Codex,
    name: "GPT-5-Codex",
    modelString: CODEX_MODEL_MAP.gpt5Codex,
    provider: "openai",
    description: "Original GPT-5 Codex model.",
    contextWindow: CONTEXT_WINDOW_128K,
    maxOutputTokens: MAX_OUTPUT_16K,
    supportsVision: true,
    supportsTools: true,
    tier: "standard" as const,
    hasReasoning: true,
  },
  {
    id: CODEX_MODEL_MAP.gpt5CodexMini,
    name: "GPT-5-Codex-Mini",
    modelString: CODEX_MODEL_MAP.gpt5CodexMini,
    provider: "openai",
    description: "Smaller, cheaper GPT-5 Codex variant.",
    contextWindow: CONTEXT_WINDOW_128K,
    maxOutputTokens: MAX_OUTPUT_16K,
    supportsVision: true,
    supportsTools: true,
    tier: "basic" as const,
    hasReasoning: false,
  },

  // ========== General-Purpose GPT Models ==========
  {
    id: CODEX_MODEL_MAP.gpt52,
    name: "GPT-5.2",
    modelString: CODEX_MODEL_MAP.gpt52,
    provider: "openai",
    description:
      "Latest frontier model with improvements across knowledge, reasoning and coding.",
    contextWindow: CONTEXT_WINDOW_256K,
    maxOutputTokens: MAX_OUTPUT_32K,
    supportsVision: true,
    supportsTools: true,
    tier: "standard" as const,
    hasReasoning: true,
  },
  {
    id: CODEX_MODEL_MAP.gpt51,
    name: "GPT-5.1",
    modelString: CODEX_MODEL_MAP.gpt51,
    provider: "openai",
    description: "Great for coding and agentic tasks across domains.",
    contextWindow: CONTEXT_WINDOW_256K,
    maxOutputTokens: MAX_OUTPUT_32K,
    supportsVision: true,
    supportsTools: true,
    tier: "standard" as const,
    hasReasoning: true,
  },
  {
    id: CODEX_MODEL_MAP.gpt5,
    name: "GPT-5",
    modelString: CODEX_MODEL_MAP.gpt5,
    provider: "openai",
    description: "Base GPT-5 model.",
    contextWindow: CONTEXT_WINDOW_128K,
    maxOutputTokens: MAX_OUTPUT_16K,
    supportsVision: true,
    supportsTools: true,
    tier: "standard" as const,
    hasReasoning: true,
  },
];

/**
 * Get model definition by ID
 */
export function getCodexModelById(
  modelId: string,
): ModelDefinition | undefined {
  return CODEX_MODELS.find(
    (m) => m.id === modelId || m.modelString === modelId,
  );
}

/**
 * Get all models that support reasoning
 */
export function getReasoningModels(): ModelDefinition[] {
  return CODEX_MODELS.filter((m) => m.hasReasoning);
}

/**
 * Get models by tier
 */
export function getModelsByTier(
  tier: "premium" | "standard" | "basic",
): ModelDefinition[] {
  return CODEX_MODELS.filter((m) => m.tier === tier);
}
