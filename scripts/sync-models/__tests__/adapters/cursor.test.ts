import { describe, it, expect, vi } from 'vitest';
import { cursorAdapter } from '../../adapters/cursor.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

const VALID_MODELS = [
  { id: 'auto', label: 'Auto (Recommended)' },
  { id: 'sonnet-4.6', label: 'Claude Sonnet 4.6' },
  { id: 'opus-4.5', label: 'Claude Opus 4.5', hasThinking: true },
];

describe('cursorAdapter', () => {
  it('has correct name and tier', () => {
    expect(cursorAdapter.name).toBe('cursor');
    expect(cursorAdapter.tier).toBe('local');
  });

  it('returns ModelEntry[] from cursor CLI JSON array output', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify(VALID_MODELS));

    const models = await cursorAdapter.fetchModels();

    expect(models).toHaveLength(3);
    expect(mockExecFileSync).toHaveBeenCalledWith('cursor', ['models', 'list', '--json'], expect.any(Object));
  });

  it('handles wrapped { models: [...] } shape', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ models: VALID_MODELS }));

    const models = await cursorAdapter.fetchModels();

    expect(models).toHaveLength(3);
  });

  it('applies cursor- prefix to IDs', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify(VALID_MODELS));

    const models = await cursorAdapter.fetchModels();

    for (const m of models) {
      expect(m.id).toMatch(/^cursor-/);
    }
  });

  it('does not double-prefix already prefixed IDs', async () => {
    const already = [{ id: 'cursor-auto', label: 'Auto' }];
    mockExecFileSync.mockReturnValue(JSON.stringify(already));

    const models = await cursorAdapter.fetchModels();

    expect(models[0].id).toBe('cursor-auto');
  });

  it('sets provider to cursor', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify(VALID_MODELS));

    const models = await cursorAdapter.fetchModels();

    for (const m of models) {
      expect(m.provider).toBe('cursor');
    }
  });

  it('maps hasThinking to supportsThinking', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify(VALID_MODELS));

    const models = await cursorAdapter.fetchModels();
    const opus = models.find((m) => m.id === 'cursor-opus-4.5')!;

    expect(opus.supportsThinking).toBe(true);
  });

  it('throws when cursor CLI is not found', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('spawn cursor ENOENT');
    });

    await expect(cursorAdapter.fetchModels()).rejects.toThrow('Failed to run cursor CLI');
  });

  it('throws on non-JSON output', async () => {
    mockExecFileSync.mockReturnValue('not valid json at all');

    await expect(cursorAdapter.fetchModels()).rejects.toThrow(
      'cursor models list --json returned non-JSON output'
    );
  });

  it('throws on empty model list', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([]));

    await expect(cursorAdapter.fetchModels()).rejects.toThrow(
      'cursor models list returned empty model list'
    );
  });
});
