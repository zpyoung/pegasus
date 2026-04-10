/**
 * GitHub Models provider adapter
 * Queries the GitHub Models catalog API
 * Reference: https://docs.github.com/en/rest/models/catalog?apiVersion=2026-03-10
 */

import type { ProviderAdapter, ModelEntry } from '../types.js';

interface GitHubModel {
  id: string;
  name: string;
  registry?: string;
  publisher?: string;
  summary?: string;
  rate_limit_tier?: string;
  html_url?: string;
  version?: string;
  capabilities?: string[];
  limits?: {
    max_input_tokens?: number;
    max_output_tokens?: number;
  };
  tags?: string[];
  supported_input_modalities?: string[];
  supported_output_modalities?: string[];
}

function mapGitHubModel(m: GitHubModel): ModelEntry {
  const id = m.id.startsWith('copilot-') ? m.id : `copilot-${m.id}`;
  const name = m.name || formatDisplayName(m.id);

  const inputModalities = m.supported_input_modalities ?? [];
  const capabilities = m.capabilities ?? [];

  return {
    id,
    name,
    provider: 'copilot',
    contextWindow: m.limits?.max_input_tokens,
    maxOutputTokens: m.limits?.max_output_tokens,
    supportsVision: inputModalities.includes('image'),
    supportsTools: capabilities.includes('tool_calls') || capabilities.includes('tools'),
    reasoningCapable: capabilities.includes('reasoning'),
    stabilityTier: 'ga',
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

    const response = await fetch('https://models.github.ai/catalog/models', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub Models API error: ${response.status} ${response.statusText}`);
    }

    const models = (await response.json()) as GitHubModel[];

    if (!Array.isArray(models) || models.length === 0) {
      throw new Error('GitHub Models API returned empty or invalid response');
    }

    return models.map(mapGitHubModel);
  },
};
