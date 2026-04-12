/**
 * OpenAI provider adapter
 * Queries GET /v1/models using OPENAI_API_KEY
 * Filters for relevant coding/frontier models and applies codex- prefix
 */

import type { ProviderAdapter, ModelEntry } from "../types.js";

interface OpenAIModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface OpenAIModelsResponse {
  object: string;
  data: OpenAIModel[];
}

// Only include models that are relevant for coding/agentic tasks
const RELEVANT_PREFIXES = ["gpt-5", "gpt-4", "o1", "o3", "o4", "codex"];

function isRelevantModel(id: string): boolean {
  return RELEVANT_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function mapOpenAIModel(m: OpenAIModel): ModelEntry {
  // Apply codex- prefix for Pegasus routing if not already prefixed
  const id = m.id.startsWith("codex-") ? m.id : `codex-${m.id}`;
  const name = formatDisplayName(m.id);
  return {
    id,
    name,
    provider: "openai",
    supportsVision: m.id.startsWith("gpt-5") || m.id.startsWith("gpt-4"),
    supportsTools: true,
    reasoningCapable:
      m.id.startsWith("o1") ||
      m.id.startsWith("o3") ||
      m.id.startsWith("o4") ||
      m.id.includes("codex"),
    stabilityTier: m.id.includes("preview") ? "preview" : "ga",
  };
}

function formatDisplayName(id: string): string {
  return id.toUpperCase().replace(/-/g, " ");
}

export const openaiAdapter: ProviderAdapter = {
  name: "openai",
  tier: "ci",

  async fetchModels(): Promise<ModelEntry[]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    const response = await fetch("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as OpenAIModelsResponse;

    if (!data.data || data.data.length === 0) {
      throw new Error(
        "OpenAI API returned empty model list (possible auth failure)",
      );
    }

    const relevant = data.data.filter((m) => isRelevantModel(m.id));

    if (relevant.length === 0) {
      throw new Error("OpenAI API returned no relevant models after filtering");
    }

    return relevant.map(mapOpenAIModel);
  },
};
