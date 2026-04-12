import { describe, it, expect } from "vitest";
import { cursorAdapter } from "../../adapters/cursor.js";

describe("cursorAdapter", () => {
  it("has correct name and tier", () => {
    expect(cursorAdapter.name).toBe("cursor");
    expect(cursorAdapter.tier).toBe("local");
  });

  it("returns a non-empty static model list", async () => {
    const models = await cursorAdapter.fetchModels();

    expect(models.length).toBeGreaterThan(0);
  });

  it("all IDs have cursor- prefix", async () => {
    const models = await cursorAdapter.fetchModels();

    for (const m of models) {
      expect(m.id).toMatch(/^cursor-/);
    }
  });

  it("all models have provider set to cursor", async () => {
    const models = await cursorAdapter.fetchModels();

    for (const m of models) {
      expect(m.provider).toBe("cursor");
    }
  });

  it("includes known models", async () => {
    const models = await cursorAdapter.fetchModels();
    const ids = models.map((m) => m.id);

    expect(ids).toContain("cursor-sonnet-4.6");
    expect(ids).toContain("cursor-opus-4.6");
    expect(ids).toContain("cursor-composer-2");
  });

  it("models with supportsThinking set have it as boolean", async () => {
    const models = await cursorAdapter.fetchModels();
    const thinking = models.filter((m) => m.supportsThinking);

    expect(thinking.length).toBeGreaterThan(0);
    for (const m of thinking) {
      expect(typeof m.supportsThinking).toBe("boolean");
    }
  });

  it("all models have stabilityTier set", async () => {
    const models = await cursorAdapter.fetchModels();

    for (const m of models) {
      expect(m.stabilityTier).toBeDefined();
    }
  });

  it("all models have pricing info", async () => {
    const models = await cursorAdapter.fetchModels();

    for (const m of models) {
      expect(m.pricing).toBeDefined();
      expect(m.pricing!.inputPerMToken).toBeGreaterThan(0);
      expect(m.pricing!.outputPerMToken).toBeGreaterThan(0);
    }
  });
});
