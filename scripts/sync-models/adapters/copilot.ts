/**
 * GitHub Copilot provider adapter
 * Queries the GitHub Copilot models API using GITHUB_TOKEN
 */

import type { ProviderAdapter, ModelEntry } from '../types.js';

interface CopilotModel {
  id: string;
  name?: string;
  vendor?: string;
  version?: string;
  family?: string;
  capabilities?: {
    type?: string;
    tokenizer?: string;
    supports?: {
      tool_calls?: boolean;
      parallel_tool_calls?: boolean;
      dimensions?: boolean;
      streaming?: boolean;
    };
    limits?: {
      max_context_window_tokens?: number;
      max_output_tokens?: number;
      max_prompt_tokens?: number;
      max_inputs?: number;
    };
  };
  is_chat_default?: boolean;
}

interface CopilotModelsResponse {
  models?: CopilotModel[];
  data?: CopilotModel[];
}

function mapCopilotModel(m: CopilotModel): ModelEntry {
  // Apply copilot- prefix for Pegasus routing
  const id = m.id.startsWith('copilot-') ? m.id : `copilot-${m.id}`;
  const name = m.name ?? formatDisplayName(m.id);

  return {
    id,
    name,
    provider: 'copilot',
    contextWindow: m.capabilities?.limits?.max_context_window_tokens,
    maxOutputTokens: m.capabilities?.limits?.max_output_tokens,
    supportsVision: true,
    supportsTools: m.capabilities?.supports?.tool_calls ?? true,
    reasoningCapable: false,
    stabilityTier: 'ga',
    defaultFor: m.is_chat_default ? 'copilot' : undefined,
  };
}

function formatDisplayName(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export const copilotAdapter: ProviderAdapter = {
  name: 'copilot',
  tier: 'ci',

  async fetchModels(): Promise<ModelEntry[]> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN environment variable is not set');
    }

    const response = await fetch(
      'https://api.githubcopilot.com/models',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Copilot API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as CopilotModelsResponse;
    const models = data.models ?? data.data ?? [];

    if (models.length === 0) {
      throw new Error('Copilot API returned empty model list (possible auth failure)');
    }

    return models.map(mapCopilotModel);
  },
};
