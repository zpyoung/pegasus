/**
 * Anthropic provider adapter
 * Queries GET /v1/models using ANTHROPIC_API_KEY
 */

import type { ProviderAdapter, ModelEntry } from "../types.js";

interface AnthropicModel {
  id: string;
  display_name?: string;
  created_at?: string;
  type?: string;
}

interface AnthropicModelsResponse {
  data: AnthropicModel[];
  has_more?: boolean;
  first_id?: string;
  last_id?: string;
}

function mapAnthropicModel(m: AnthropicModel): ModelEntry {
  const id = m.id;
  const name = m.display_name ?? formatDisplayName(id);
  return {
    id,
    name,
    provider: "anthropic",
    supportsVision: true,
    supportsTools: true,
    supportsThinking: id.includes("sonnet") || id.includes("opus"),
    reasoningCapable: false,
    stabilityTier:
      id.includes("preview") || id.includes("beta") ? "preview" : "ga",
  };
}

function formatDisplayName(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export const anthropicAdapter: ProviderAdapter = {
  name: "anthropic",
  tier: "ci",

  async fetchModels(): Promise<ModelEntry[]> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }

    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as AnthropicModelsResponse;

    if (!data.data || data.data.length === 0) {
      throw new Error(
        "Anthropic API returned empty model list (possible auth failure)",
      );
    }

    return data.data.map(mapAnthropicModel);
  },
};
