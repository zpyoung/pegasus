import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { googleAdapter } from "../../adapters/google.js";

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(global, "fetch").mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : `HTTP ${status}`,
    json: () => Promise.resolve(body),
  } as Response);
}

const VALID_RESPONSE = {
  models: [
    {
      name: "models/gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      inputTokenLimit: 1000000,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    },
    {
      name: "models/gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      inputTokenLimit: 1000000,
      outputTokenLimit: 8192,
    },
    // Non-gemini model that should be filtered out
    {
      name: "models/text-embedding-004",
      displayName: "Text Embedding 004",
      inputTokenLimit: 2048,
    },
  ],
};

describe("googleAdapter", () => {
  const originalKey = process.env.GOOGLE_API_KEY;

  beforeEach(() => {
    process.env.GOOGLE_API_KEY = "test-api-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.GOOGLE_API_KEY;
    } else {
      process.env.GOOGLE_API_KEY = originalKey;
    }
  });

  it("has correct name and tier", () => {
    expect(googleAdapter.name).toBe("google");
    expect(googleAdapter.tier).toBe("ci");
  });

  it("returns only gemini models", async () => {
    mockFetch(200, VALID_RESPONSE);

    const models = await googleAdapter.fetchModels();

    expect(models).toHaveLength(2);
    expect(models.map((m) => m.id)).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
  });

  it('strips "models/" prefix from ID', async () => {
    mockFetch(200, VALID_RESPONSE);

    const models = await googleAdapter.fetchModels();

    for (const m of models) {
      expect(m.id).not.toMatch(/^models\//);
    }
  });

  it("maps contextWindow and maxOutputTokens", async () => {
    mockFetch(200, VALID_RESPONSE);

    const models = await googleAdapter.fetchModels();
    const pro = models.find((m) => m.id === "gemini-2.5-pro")!;

    expect(pro.contextWindow).toBe(1000000);
    expect(pro.maxOutputTokens).toBe(8192);
  });

  it("sets provider to google", async () => {
    mockFetch(200, VALID_RESPONSE);

    const models = await googleAdapter.fetchModels();

    for (const m of models) {
      expect(m.provider).toBe("google");
    }
  });

  it("marks pro models as supportsThinking", async () => {
    mockFetch(200, VALID_RESPONSE);

    const models = await googleAdapter.fetchModels();
    const pro = models.find((m) => m.id === "gemini-2.5-pro")!;

    expect(pro.supportsThinking).toBe(true);
  });

  it("marks preview/exp models as preview stability", async () => {
    mockFetch(200, {
      models: [
        {
          name: "models/gemini-2.5-pro-preview",
          displayName: "Gemini 2.5 Pro Preview",
        },
      ],
    });

    const models = await googleAdapter.fetchModels();
    expect(models[0].stabilityTier).toBe("preview");
  });

  it("throws when GOOGLE_API_KEY is not set", async () => {
    delete process.env.GOOGLE_API_KEY;

    await expect(googleAdapter.fetchModels()).rejects.toThrow(
      "GOOGLE_API_KEY environment variable is not set",
    );
  });

  it("throws on 403 auth failure", async () => {
    mockFetch(403, { error: { message: "Forbidden" } });

    await expect(googleAdapter.fetchModels()).rejects.toThrow(
      "Google API error: 403",
    );
  });

  it("throws on 429 rate limit", async () => {
    mockFetch(429, { error: { message: "Rate limit exceeded" } });

    await expect(googleAdapter.fetchModels()).rejects.toThrow(
      "Google API error: 429",
    );
  });

  it("throws on empty models array", async () => {
    mockFetch(200, { models: [] });

    await expect(googleAdapter.fetchModels()).rejects.toThrow(
      "Google API returned empty model list",
    );
  });

  it("throws when no Gemini models after filtering", async () => {
    mockFetch(200, {
      models: [
        {
          name: "models/text-embedding-004",
          displayName: "Text Embedding 004",
        },
      ],
    });

    await expect(googleAdapter.fetchModels()).rejects.toThrow(
      "Google API returned no Gemini models after filtering",
    );
  });
});
