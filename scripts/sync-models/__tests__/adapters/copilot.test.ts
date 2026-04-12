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

// The adapter expects a bare GitHubModel[] array from the GitHub Models catalog API
const VALID_MODELS = [
  {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    capabilities: ["tool_calls"],
    limits: { max_input_tokens: 200000, max_output_tokens: 4096 },
    supported_input_modalities: ["text", "image"],
  },
  {
    id: "gpt-5.2",
    name: "GPT-5.2",
    capabilities: ["tool_calls"],
    limits: { max_input_tokens: 128000 },
    supported_input_modalities: ["text"],
  },
];

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

  it("returns ModelEntry[] from bare array response", async () => {
    mockFetch(200, VALID_MODELS);

    const models = await copilotAdapter.fetchModels();

    expect(models).toHaveLength(2);
  });

  it("applies copilot- prefix to IDs", async () => {
    mockFetch(200, VALID_MODELS);

    const models = await copilotAdapter.fetchModels();

    for (const m of models) {
      expect(m.id).toMatch(/^copilot-/);
    }
  });

  it("sets provider to copilot", async () => {
    mockFetch(200, VALID_MODELS);

    const models = await copilotAdapter.fetchModels();

    for (const m of models) {
      expect(m.provider).toBe("copilot");
    }
  });

  it("maps context window from limits", async () => {
    mockFetch(200, VALID_MODELS);

    const models = await copilotAdapter.fetchModels();
    const sonnet = models.find((m) => m.id === "copilot-claude-sonnet-4.6")!;

    expect(sonnet.contextWindow).toBe(200000);
    expect(sonnet.maxOutputTokens).toBe(4096);
  });

  it("maps vision support from input modalities", async () => {
    mockFetch(200, VALID_MODELS);

    const models = await copilotAdapter.fetchModels();
    const sonnet = models.find((m) => m.id === "copilot-claude-sonnet-4.6")!;
    const gpt = models.find((m) => m.id === "copilot-gpt-5.2")!;

    expect(sonnet.supportsVision).toBe(true);
    expect(gpt.supportsVision).toBe(false);
  });

  it("maps tool support from capabilities", async () => {
    mockFetch(200, VALID_MODELS);

    const models = await copilotAdapter.fetchModels();
    const sonnet = models.find((m) => m.id === "copilot-claude-sonnet-4.6")!;

    expect(sonnet.supportsTools).toBe(true);
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
      "GitHub Models API error: 401",
    );
  });

  it("throws on 429 rate limit", async () => {
    mockFetch(429, { message: "Too Many Requests" });

    await expect(copilotAdapter.fetchModels()).rejects.toThrow(
      "GitHub Models API error: 429",
    );
  });

  it("throws on empty model list", async () => {
    mockFetch(200, []);

    await expect(copilotAdapter.fetchModels()).rejects.toThrow(
      "GitHub Models API returned empty or invalid response",
    );
  });

  it("throws on non-array response", async () => {
    mockFetch(200, { models: VALID_MODELS });

    await expect(copilotAdapter.fetchModels()).rejects.toThrow(
      "GitHub Models API returned empty or invalid response",
    );
  });
});
