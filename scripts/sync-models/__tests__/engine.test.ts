import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mergeModels,
  buildProviderMap,
  applyOverrides,
  computeDiff,
  formatSummary,
  filterSnapshotsByTTL,
  runSync,
} from '../engine.js';
import type { ModelEntry, DiffSummary } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeModel = (overrides: Partial<ModelEntry> & { id: string; provider: string }): ModelEntry => ({
  name: overrides.id,
  ...overrides,
});

const MODELS_A: ModelEntry[] = [
  makeModel({ id: 'model-a', provider: 'p1', aliases: ['alias-a'] }),
  makeModel({ id: 'model-b', provider: 'p1' }),
];

const MODELS_B: ModelEntry[] = [
  makeModel({ id: 'model-c', provider: 'p2' }),
];

// ---------------------------------------------------------------------------
// mergeModels
// ---------------------------------------------------------------------------

describe('mergeModels', () => {
  it('deduplicates models by ID (last-write wins)', () => {
    const input: ModelEntry[] = [
      makeModel({ id: 'model-x', provider: 'p1', name: 'First' }),
      makeModel({ id: 'model-x', provider: 'p1', name: 'Second' }),
    ];

    const result = mergeModels(input);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Second');
  });

  it('sorts models alphabetically by ID', () => {
    const input: ModelEntry[] = [
      makeModel({ id: 'z-model', provider: 'p1' }),
      makeModel({ id: 'a-model', provider: 'p1' }),
      makeModel({ id: 'm-model', provider: 'p1' }),
    ];

    const result = mergeModels(input);

    expect(result.map((m) => m.id)).toEqual(['a-model', 'm-model', 'z-model']);
  });

  it('returns empty array for empty input', () => {
    expect(mergeModels([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildProviderMap
// ---------------------------------------------------------------------------

describe('buildProviderMap', () => {
  it('groups models by provider', () => {
    const result = buildProviderMap([...MODELS_A, ...MODELS_B]);

    expect(Object.keys(result)).toEqual(expect.arrayContaining(['p1', 'p2']));
    expect(result.p1).toHaveLength(2);
    expect(result.p2).toHaveLength(1);
  });

  it('returns empty object for empty input', () => {
    expect(buildProviderMap([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// applyOverrides
// ---------------------------------------------------------------------------

describe('applyOverrides', () => {
  it('merges override fields into matching model', () => {
    const models: ModelEntry[] = [
      makeModel({ id: 'model-a', provider: 'p1', name: 'Original Name' }),
    ];
    const overrides = { 'model-a': { name: 'Override Name', supportsVision: true } };

    const result = applyOverrides(models, overrides);

    expect(result[0].name).toBe('Override Name');
    expect(result[0].supportsVision).toBe(true);
  });

  it('leaves models without overrides unchanged', () => {
    const models: ModelEntry[] = [makeModel({ id: 'model-a', provider: 'p1', name: 'Original' })];

    const result = applyOverrides(models, {});

    expect(result[0].name).toBe('Original');
  });

  it('does not mutate original models array', () => {
    const original: ModelEntry[] = [makeModel({ id: 'model-a', provider: 'p1', name: 'Original' })];
    const overrides = { 'model-a': { name: 'Changed' } };

    applyOverrides(original, overrides);

    expect(original[0].name).toBe('Original');
  });

  it('allows override to add aliases', () => {
    const models: ModelEntry[] = [makeModel({ id: 'model-a', provider: 'p1' })];
    const overrides = { 'model-a': { aliases: ['alias1', 'alias2'] } };

    const result = applyOverrides(models, overrides);

    expect(result[0].aliases).toEqual(['alias1', 'alias2']);
  });
});

// ---------------------------------------------------------------------------
// computeDiff
// ---------------------------------------------------------------------------

describe('computeDiff', () => {
  it('identifies added models', () => {
    const diff = computeDiff(
      [makeModel({ id: 'old-model', provider: 'p1' })],
      [makeModel({ id: 'old-model', provider: 'p1' }), makeModel({ id: 'new-model', provider: 'p1' })],
      [],
      []
    );

    expect(diff.added).toContain('new-model');
    expect(diff.added).not.toContain('old-model');
  });

  it('identifies removed models', () => {
    const diff = computeDiff(
      [makeModel({ id: 'model-a', provider: 'p1' }), makeModel({ id: 'model-b', provider: 'p1' })],
      [makeModel({ id: 'model-a', provider: 'p1' })],
      [],
      []
    );

    expect(diff.removed).toContain('model-b');
  });

  it('identifies updated models', () => {
    const diff = computeDiff(
      [makeModel({ id: 'model-a', provider: 'p1', supportsVision: false })],
      [makeModel({ id: 'model-a', provider: 'p1', supportsVision: true })],
      [],
      []
    );

    expect(diff.updated).toContain('model-a');
  });

  it('identifies alias changes', () => {
    const diff = computeDiff(
      [makeModel({ id: 'model-a', provider: 'p1', aliases: ['old-alias'] })],
      [makeModel({ id: 'model-a', provider: 'p1', aliases: ['new-alias'] })],
      [],
      []
    );

    expect(diff.aliasChanges).toHaveLength(1);
    expect(diff.aliasChanges[0]).toMatchObject({
      model: 'model-a',
      before: ['old-alias'],
      after: ['new-alias'],
    });
  });

  it('includes staleProviders and failedProviders in output', () => {
    const diff = computeDiff([], [], ['stale-provider'], [{ provider: 'failed', error: 'oops' }]);

    expect(diff.staleProviders).toContain('stale-provider');
    expect(diff.failedProviders[0].provider).toBe('failed');
  });

  it('returns empty diff for identical registries', () => {
    const models = [makeModel({ id: 'model-a', provider: 'p1' })];
    const diff = computeDiff(models, models, [], []);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.updated).toHaveLength(0);
    expect(diff.aliasChanges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatSummary — FR-005: diff summary output format
// ---------------------------------------------------------------------------

describe('formatSummary', () => {
  const emptyDiff: DiffSummary = {
    added: [],
    removed: [],
    updated: [],
    aliasChanges: [],
    staleProviders: [],
    failedProviders: [],
  };

  it('includes a header', () => {
    const summary = formatSummary(emptyDiff, [], []);

    expect(summary).toContain('# Model Registry Sync Summary');
  });

  it('shows counts for added/removed/updated', () => {
    const diff: DiffSummary = {
      ...emptyDiff,
      added: ['model-new'],
      removed: ['model-old'],
      updated: ['model-changed'],
    };

    const summary = formatSummary(diff, [], []);

    expect(summary).toContain('**Added**: 1 models');
    expect(summary).toContain('**Removed**: 1 models');
    expect(summary).toContain('**Updated**: 1 models');
  });

  it('lists added model IDs when present', () => {
    const diff: DiffSummary = { ...emptyDiff, added: ['gemini-4-ultra'] };

    const summary = formatSummary(diff, [], []);

    expect(summary).toContain('`gemini-4-ultra`');
    expect(summary).toContain('### Added Models');
  });

  it('lists removed model IDs when present', () => {
    const diff: DiffSummary = { ...emptyDiff, removed: ['deprecated-model'] };

    const summary = formatSummary(diff, [], []);

    expect(summary).toContain('`deprecated-model`');
    expect(summary).toContain('### Removed Models');
  });

  it('shows failed providers section when present', () => {
    const failed = [{ provider: 'openai', error: 'API key expired' }];

    const summary = formatSummary(emptyDiff, failed, []);

    expect(summary).toContain('Failed Providers');
    expect(summary).toContain('**openai**: API key expired');
  });

  it('shows stale providers section when present', () => {
    const summary = formatSummary(emptyDiff, [], ['cursor', 'opencode']);

    expect(summary).toContain('Stale Providers');
    expect(summary).toContain('cursor');
    expect(summary).toContain('opencode');
  });

  it('omits failed/stale sections when empty', () => {
    const summary = formatSummary(emptyDiff, [], []);

    expect(summary).not.toContain('Failed Providers');
    expect(summary).not.toContain('Stale Providers');
  });

  it('shows alias change details', () => {
    const diff: DiffSummary = {
      ...emptyDiff,
      aliasChanges: [{ model: 'claude-sonnet-4-6', before: ['sonnet-4'], after: ['sonnet-4', 'sonnet'] }],
    };

    const summary = formatSummary(diff, [], []);

    expect(summary).toContain('### Alias Changes');
    expect(summary).toContain('`claude-sonnet-4-6`');
    expect(summary).toContain('sonnet-4');
    expect(summary).toContain('sonnet');
  });
});

// ---------------------------------------------------------------------------
// filterSnapshotsByTTL — NFR-004: stale provider TTL exclusion
// ---------------------------------------------------------------------------

describe('filterSnapshotsByTTL', () => {
  const cutoff = new Date('2026-04-01T00:00:00Z');

  const fresh = {
    provider: 'anthropic',
    models: [makeModel({ id: 'claude-sonnet-4-6', provider: 'anthropic' })],
    fetchedAt: '2026-04-05T00:00:00Z', // after cutoff — fresh
  };

  const stale = {
    provider: 'openai',
    models: [makeModel({ id: 'codex-gpt-5', provider: 'openai' })],
    fetchedAt: '2026-03-01T00:00:00Z', // before cutoff — stale
  };

  it('separates fresh and stale snapshots', () => {
    const result = filterSnapshotsByTTL([fresh, stale], cutoff);

    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].provider).toBe('anthropic');
    expect(result.stale).toContain('openai');
  });

  it('returns all fresh when none are stale', () => {
    const result = filterSnapshotsByTTL([fresh], cutoff);

    expect(result.valid).toHaveLength(1);
    expect(result.stale).toHaveLength(0);
  });

  it('returns all stale when all are expired', () => {
    const result = filterSnapshotsByTTL([stale], cutoff);

    expect(result.valid).toHaveLength(0);
    expect(result.stale).toHaveLength(1);
  });

  it('excludes stale provider models from valid list (NFR-004)', () => {
    const result = filterSnapshotsByTTL([fresh, stale], cutoff);

    const allValidModels = result.valid.flatMap((s) => s.models);
    const validIds = allValidModels.map((m) => m.id);

    expect(validIds).toContain('claude-sonnet-4-6');
    expect(validIds).not.toContain('codex-gpt-5'); // stale — excluded
  });

  it('handles empty snapshot list', () => {
    const result = filterSnapshotsByTTL([], cutoff);

    expect(result.valid).toHaveLength(0);
    expect(result.stale).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runSync — NFR-003: graceful degradation with mixed adapter results
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// runSync — NFR-003: graceful degradation with mixed adapter results
// Adapters are created fresh inside each test to avoid mockReset clearing implementations
// ---------------------------------------------------------------------------

describe('runSync (NFR-003: mixed pass/fail adapters)', () => {
  function makeTestAdapter(name: string, tier: 'ci' | 'local', resolves: boolean) {
    return {
      name,
      tier,
      fetchModels: resolves
        ? vi.fn().mockResolvedValue([makeModel({ id: `${name}-model-1`, provider: name })])
        : vi.fn().mockRejectedValue(new Error(`${name} adapter failed`)),
    };
  }

  it('does not throw when at least one adapter succeeds (NFR-003)', async () => {
    const adapters = [
      makeTestAdapter('anthropic', 'ci', true),
      makeTestAdapter('openai', 'ci', false), // fails
    ];

    await expect(
      runSync(adapters, { ciOnly: false, dryRun: true, ttlDays: 30 })
    ).resolves.not.toThrow();
  });

  it('throws when ALL adapters fail', async () => {
    const adapters = [
      makeTestAdapter('p1', 'ci', false),
      makeTestAdapter('p2', 'ci', false),
    ];

    await expect(
      runSync(adapters, { ciOnly: false, dryRun: true, ttlDays: 30 })
    ).rejects.toThrow('All adapters failed');
  });

  it('filters ci-tier adapters when ciOnly=true', async () => {
    const ciAdapter = makeTestAdapter('anthropic', 'ci', true);
    const localAdapter = makeTestAdapter('cursor', 'local', true);

    await runSync([ciAdapter, localAdapter], { ciOnly: true, dryRun: true, ttlDays: 30 });

    expect(ciAdapter.fetchModels).toHaveBeenCalled();
    expect(localAdapter.fetchModels).not.toHaveBeenCalled();
  });
});
