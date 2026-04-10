/**
 * Google Gemini provider adapter
 * Queries GET generativelanguage.googleapis.com/v1beta/models using GOOGLE_API_KEY
 */

import type { ProviderAdapter, ModelEntry } from '../types.js';

interface GoogleModel {
  name: string; // "models/gemini-2.5-pro"
  displayName?: string;
  description?: string;
  version?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GoogleModelsResponse {
  models: GoogleModel[];
  nextPageToken?: string;
}

function extractModelId(name: string): string {
  // "models/gemini-2.5-pro" -> "gemini-2.5-pro"
  return name.replace(/^models\//, '');
}

function mapGoogleModel(m: GoogleModel): ModelEntry {
  const id = extractModelId(m.name);
  const name = m.displayName ?? formatDisplayName(id);
  const supportsThinking = id.includes('pro') || id.includes('ultra');

  return {
    id,
    name,
    provider: 'google',
    contextWindow: m.inputTokenLimit,
    maxOutputTokens: m.outputTokenLimit,
    supportsVision: true,
    supportsTools: m.supportedGenerationMethods?.includes('generateContent') ?? true,
    supportsThinking,
    reasoningCapable: false,
    stabilityTier: id.includes('preview') || id.includes('exp') ? 'preview' : 'ga',
  };
}

function formatDisplayName(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export const googleAdapter: ProviderAdapter = {
  name: 'google',
  tier: 'ci',

  async fetchModels(): Promise<ModelEntry[]> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY environment variable is not set');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Google API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as GoogleModelsResponse;

    if (!data.models || data.models.length === 0) {
      throw new Error('Google API returned empty model list (possible auth failure)');
    }

    // Only include Gemini models
    const geminiModels = data.models.filter((m) => m.name.includes('gemini'));

    if (geminiModels.length === 0) {
      throw new Error('Google API returned no Gemini models after filtering');
    }

    return geminiModels.map(mapGoogleModel);
  },
};
