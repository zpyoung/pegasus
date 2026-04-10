import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { anthropicAdapter } from '../../adapters/anthropic.js';

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: () => Promise.resolve(body),
  } as Response);
}

const VALID_RESPONSE = {
  data: [
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
    { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku' },
  ],
};

describe('anthropicAdapter', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('has correct name and tier', () => {
    expect(anthropicAdapter.name).toBe('anthropic');
    expect(anthropicAdapter.tier).toBe('ci');
  });

  it('returns ModelEntry[] on success', async () => {
    mockFetch(200, VALID_RESPONSE);

    const models = await anthropicAdapter.fetchModels();

    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      provider: 'anthropic',
      supportsVision: true,
      supportsTools: true,
    });
  });

  it('sends correct headers', async () => {
    const spy = mockFetch(200, VALID_RESPONSE);

    await anthropicAdapter.fetchModels();

    expect(spy).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'test-api-key',
          'anthropic-version': '2023-06-01',
        }),
      })
    );
  });

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await expect(anthropicAdapter.fetchModels()).rejects.toThrow(
      'ANTHROPIC_API_KEY environment variable is not set'
    );
  });

  it('throws on 401 auth failure', async () => {
    mockFetch(401, { error: 'Unauthorized' });

    await expect(anthropicAdapter.fetchModels()).rejects.toThrow('Anthropic API error: 401');
  });

  it('throws on 429 rate limit', async () => {
    mockFetch(429, { error: 'Too Many Requests' });

    await expect(anthropicAdapter.fetchModels()).rejects.toThrow('Anthropic API error: 429');
  });

  it('throws on empty model list (silent auth failure)', async () => {
    mockFetch(200, { data: [] });

    await expect(anthropicAdapter.fetchModels()).rejects.toThrow(
      'Anthropic API returned empty model list'
    );
  });

  it('assigns stabilityTier preview for preview models', async () => {
    mockFetch(200, {
      data: [{ id: 'claude-test-preview', display_name: 'Claude Test Preview' }],
    });

    const models = await anthropicAdapter.fetchModels();
    expect(models[0].stabilityTier).toBe('preview');
  });

  it('assigns stabilityTier ga for production models', async () => {
    mockFetch(200, VALID_RESPONSE);

    const models = await anthropicAdapter.fetchModels();
    expect(models[0].stabilityTier).toBe('ga');
  });
});
