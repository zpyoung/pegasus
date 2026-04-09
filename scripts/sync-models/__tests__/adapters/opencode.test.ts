import { describe, it, expect, vi } from 'vitest';
import { opencodeAdapter } from '../../adapters/opencode.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

const VALID_MODELS = [
  { id: 'big-pickle', label: 'Big Pickle', contextWindow: 200000 },
  { id: 'glm-5-free', label: 'GLM-5 Free' },
  { id: 'gpt-5-nano', label: 'GPT-5 Nano', maxTokens: 4096 },
];

describe('opencodeAdapter', () => {
  it('has correct name and tier', () => {
    expect(opencodeAdapter.name).toBe('opencode');
    expect(opencodeAdapter.tier).toBe('local');
  });

  it('returns ModelEntry[] from opencode CLI JSON array output', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify(VALID_MODELS));

    const models = await opencodeAdapter.fetchModels();

    expect(models).toHaveLength(3);
    expect(mockExecFileSync).toHaveBeenCalledWith('opencode', ['models', '--json'], expect.any(Object));
  });

  it('handles wrapped { models: [...] } shape', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ models: VALID_MODELS }));

    const models = await opencodeAdapter.fetchModels();

    expect(models).toHaveLength(3);
  });

  it('applies opencode- prefix to IDs', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify(VALID_MODELS));

    const models = await opencodeAdapter.fetchModels();

    for (const m of models) {
      expect(m.id).toMatch(/^opencode-/);
    }
  });

  it('does not double-prefix already prefixed IDs', async () => {
    const already = [{ id: 'opencode-big-pickle', label: 'Big Pickle' }];
    mockExecFileSync.mockReturnValue(JSON.stringify(already));

    const models = await opencodeAdapter.fetchModels();

    expect(models[0].id).toBe('opencode-big-pickle');
  });

  it('sets provider to opencode', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify(VALID_MODELS));

    const models = await opencodeAdapter.fetchModels();

    for (const m of models) {
      expect(m.provider).toBe('opencode');
    }
  });

  it('maps contextWindow and maxTokens', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify(VALID_MODELS));

    const models = await opencodeAdapter.fetchModels();

    const bigPickle = models.find((m) => m.id === 'opencode-big-pickle')!;
    expect(bigPickle.contextWindow).toBe(200000);

    const nano = models.find((m) => m.id === 'opencode-gpt-5-nano')!;
    expect(nano.maxOutputTokens).toBe(4096);
  });

  it('throws when opencode CLI is not found', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('spawn opencode ENOENT');
    });

    await expect(opencodeAdapter.fetchModels()).rejects.toThrow('Failed to run opencode CLI');
  });

  it('throws on non-JSON output', async () => {
    mockExecFileSync.mockReturnValue('something went wrong\nnot json');

    await expect(opencodeAdapter.fetchModels()).rejects.toThrow(
      'opencode models --json returned non-JSON output'
    );
  });

  it('throws on empty model list', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([]));

    await expect(opencodeAdapter.fetchModels()).rejects.toThrow(
      'opencode models returned empty model list'
    );
  });
});
