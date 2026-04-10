import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openaiAdapter } from '../../adapters/openai.js';

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: () => Promise.resolve(body),
  } as Response);
}

const ALL_MODELS_RESPONSE = {
  object: 'list',
  data: [
    { id: 'gpt-4.1', object: 'model', created: 1000, owned_by: 'openai' },
    { id: 'gpt-5.2-codex', object: 'model', created: 1001, owned_by: 'openai' },
    { id: 'o3-mini', object: 'model', created: 1002, owned_by: 'openai' },
    // Should be filtered out (not relevant for coding)
    { id: 'tts-1', object: 'model', created: 1003, owned_by: 'openai' },
    { id: 'whisper-1', object: 'model', created: 1004, owned_by: 'openai' },
  ],
};

describe('openaiAdapter', () => {
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });

  it('has correct name and tier', () => {
    expect(openaiAdapter.name).toBe('openai');
    expect(openaiAdapter.tier).toBe('ci');
  });

  it('filters only relevant models', async () => {
    mockFetch(200, ALL_MODELS_RESPONSE);

    const models = await openaiAdapter.fetchModels();

    // Should include gpt-4.1, gpt-5.2-codex, o3-mini but not tts-1/whisper-1
    expect(models.length).toBe(3);
    const ids = models.map((m) => m.id);
    expect(ids).not.toContain('tts-1');
    expect(ids).not.toContain('whisper-1');
  });

  it('applies codex- prefix to model IDs', async () => {
    mockFetch(200, ALL_MODELS_RESPONSE);

    const models = await openaiAdapter.fetchModels();

    for (const m of models) {
      expect(m.id).toMatch(/^codex-/);
    }
  });

  it('sets provider to openai', async () => {
    mockFetch(200, ALL_MODELS_RESPONSE);

    const models = await openaiAdapter.fetchModels();

    for (const m of models) {
      expect(m.provider).toBe('openai');
    }
  });

  it('marks o-series models as reasoningCapable', async () => {
    mockFetch(200, {
      object: 'list',
      data: [{ id: 'o3-mini', object: 'model', created: 1000, owned_by: 'openai' }],
    });

    const models = await openaiAdapter.fetchModels();
    expect(models[0].reasoningCapable).toBe(true);
  });

  it('throws when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;

    await expect(openaiAdapter.fetchModels()).rejects.toThrow(
      'OPENAI_API_KEY environment variable is not set'
    );
  });

  it('throws on 401 auth failure', async () => {
    mockFetch(401, { error: { message: 'Unauthorized' } });

    await expect(openaiAdapter.fetchModels()).rejects.toThrow('OpenAI API error: 401');
  });

  it('throws on 429 rate limit', async () => {
    mockFetch(429, { error: { message: 'Rate limit exceeded' } });

    await expect(openaiAdapter.fetchModels()).rejects.toThrow('OpenAI API error: 429');
  });

  it('throws when no relevant models after filtering', async () => {
    mockFetch(200, {
      object: 'list',
      data: [
        { id: 'tts-1', object: 'model', created: 1000, owned_by: 'openai' },
        { id: 'whisper-1', object: 'model', created: 1001, owned_by: 'openai' },
      ],
    });

    await expect(openaiAdapter.fetchModels()).rejects.toThrow(
      'OpenAI API returned no relevant models after filtering'
    );
  });

  it('throws on empty data array', async () => {
    mockFetch(200, { object: 'list', data: [] });

    await expect(openaiAdapter.fetchModels()).rejects.toThrow(
      'OpenAI API returned empty model list'
    );
  });
});
