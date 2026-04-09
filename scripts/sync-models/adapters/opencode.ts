/**
 * OpenCode CLI provider adapter (local-only tier)
 * Runs `opencode models --json` using local CLI auth/config
 */

import { execFileSync } from 'node:child_process';
import type { ProviderAdapter, ModelEntry } from '../types.js';

interface OpencodeModel {
  id?: string;
  name?: string;
  label?: string;
  description?: string;
  provider?: string;
  contextWindow?: number;
  maxTokens?: number;
}

function mapOpencodeModel(m: OpencodeModel): ModelEntry {
  const bareId = m.id ?? m.name ?? '';
  // Apply opencode- prefix for Pegasus routing if not already prefixed
  const id = bareId.startsWith('opencode-') ? bareId : `opencode-${bareId}`;
  const name = m.label ?? m.name ?? formatDisplayName(bareId);

  return {
    id,
    name,
    provider: 'opencode',
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxTokens,
    supportsVision: false,
    supportsTools: true,
    reasoningCapable: false,
    stabilityTier: 'ga',
  };
}

function formatDisplayName(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export const opencodeAdapter: ProviderAdapter = {
  name: 'opencode',
  tier: 'local',

  async fetchModels(): Promise<ModelEntry[]> {
    let output: string;
    try {
      output = execFileSync('opencode', ['models', '--json'], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
    } catch (err) {
      throw new Error(`Failed to run opencode CLI: ${(err as Error).message}`);
    }

    let models: OpencodeModel[];
    try {
      const parsed = JSON.parse(output) as OpencodeModel[] | { models: OpencodeModel[] };
      models = Array.isArray(parsed) ? parsed : parsed.models ?? [];
    } catch {
      throw new Error('opencode models --json returned non-JSON output');
    }

    if (models.length === 0) {
      throw new Error('opencode models returned empty model list');
    }

    return models.map(mapOpencodeModel);
  },
};
