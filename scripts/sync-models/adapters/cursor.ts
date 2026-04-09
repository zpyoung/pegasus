/**
 * Cursor CLI provider adapter (local-only tier)
 * Runs `cursor models list --json` using local CLI auth state
 */

import { execFileSync } from 'node:child_process';
import type { ProviderAdapter, ModelEntry } from '../types.js';

interface CursorModel {
  id?: string;
  name?: string;
  label?: string;
  description?: string;
  hasThinking?: boolean;
  supportsVision?: boolean;
}

function mapCursorModel(m: CursorModel): ModelEntry {
  const bareId = m.id ?? m.name ?? '';
  // Apply cursor- prefix for Pegasus routing if not already prefixed
  const id = bareId.startsWith('cursor-') ? bareId : `cursor-${bareId}`;
  const name = m.label ?? m.name ?? formatDisplayName(bareId);

  return {
    id,
    name,
    provider: 'cursor',
    supportsVision: m.supportsVision ?? false,
    supportsThinking: m.hasThinking ?? false,
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

export const cursorAdapter: ProviderAdapter = {
  name: 'cursor',
  tier: 'local',

  async fetchModels(): Promise<ModelEntry[]> {
    let output: string;
    try {
      output = execFileSync('cursor', ['models', 'list', '--json'], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
    } catch (err) {
      throw new Error(`Failed to run cursor CLI: ${(err as Error).message}`);
    }

    let models: CursorModel[];
    try {
      const parsed = JSON.parse(output) as CursorModel[] | { models: CursorModel[] };
      models = Array.isArray(parsed) ? parsed : parsed.models ?? [];
    } catch {
      throw new Error('cursor models list --json returned non-JSON output');
    }

    if (models.length === 0) {
      throw new Error('cursor models list returned empty model list');
    }

    return models.map(mapCursorModel);
  },
};
