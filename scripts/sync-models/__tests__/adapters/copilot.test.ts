import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copilotAdapter } from "../../adapters/copilot.js";

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(global, "fetch").mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : `HTTP ${status}`,
    json: () => Promise.resolve(body),
  } as Response);
}

const VALID_RESPONSE_MODELS = {
  models: [
    {
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      vendor: "anthropic",
      capabilities: {
        supports: { tool_calls: true },
        limits: { max_context_window_tokens: 200000, max_output_tokens: 4096 },
      },
      is_chat_default: true,
    },
    {
      id: "gpt-5.2",
      name: "GPT-5.2",
      vendor: "openai",
      capabilities: {
        supports: { tool_calls: true },
        limits: { max_context_window_tokens: 128000 },
      },
    },
  ],
};

const VALID_RESPONSE_DATA = {
  data: VALID_RESPONSE_MODELS.models,
};

describe("copilotAdapter", () => {
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it("has correct name and tier", () => {
    expect(copilotAdapter.name).toBe("copilot");
    expect(copilotAdapter.tier).toBe("ci");
  });

  it("returns ModelEntry[] from models field", async () => {
    mockFetch(200, VALID_RESPONSE_MODELS);

    const models = await copilotAdapter.fetchModels();

    expect(models).toHaveLength(2);
  });

  it("also handles data field (OpenAI-compatible shape)", async () => {
    mockFetch(200, VALID_RESPONSE_DATA);

    const models = await copilotAdapter.fetchModels();

    expect(models).toHaveLength(2);
  });

  it("applies copilot- prefix to IDs", async () => {
    mockFetch(200, VALID_RESPONSE_MODELS);

    const models = await copilotAdapter.fetchModels();

    for (const m of models) {
      expect(m.id).toMatch(/^copilot-/);
    }
  });

  it("sets provider to copilot", async () => {
    mockFetch(200, VALID_RESPONSE_MODELS);

    const models = await copilotAdapter.fetchModels();

    for (const m of models) {
      expect(m.provider).toBe("copilot");
    }
  });

  it("maps context window from capabilities", async () => {
    mockFetch(200, VALID_RESPONSE_MODELS);

    const models = await copilotAdapter.fetchModels();
    const sonnet = models.find((m) => m.id === "copilot-claude-sonnet-4.6")!;

    expect(sonnet.contextWindow).toBe(200000);
    expect(sonnet.maxOutputTokens).toBe(4096);
  });

  it("sets defaultFor on the default model", async () => {
    mockFetch(200, VALID_RESPONSE_MODELS);

    const models = await copilotAdapter.fetchModels();
    const defaultModel = models.find((m) => m.defaultFor === "copilot");

    expect(defaultModel?.id).toBe("copilot-claude-sonnet-4.6");
  });

  it("throws when GITHUB_TOKEN is not set", async () => {
    delete process.env.GITHUB_TOKEN;

    await expect(copilotAdapter.fetchModels()).rejects.toThrow(
      "GITHUB_TOKEN environment variable is not set",
    );
  });

  it("throws on 401 auth failure", async () => {
    mockFetch(401, { message: "Bad credentials" });

    await expect(copilotAdapter.fetchModels()).rejects.toThrow(
      "Copilot API error: 401",
    );
  });

  it("throws on 429 rate limit", async () => {
    mockFetch(429, { message: "Too Many Requests" });

    await expect(copilotAdapter.fetchModels()).rejects.toThrow(
      "Copilot API error: 429",
    );
  });

  it("throws on empty model list", async () => {
    mockFetch(200, { models: [] });

    await expect(copilotAdapter.fetchModels()).rejects.toThrow(
      "Copilot API returned empty model list",
    );
  });
});
