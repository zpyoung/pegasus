/**
 * Tests for the question-specific additions to pipeline-compiler:
 * - stageConfigSchema accepts question / question_meta fields
 * - compilePipeline passes question fields through to ResolvedStage
 * - compileStage resolves {{stages.<id>.question_response}} template variables
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";
import type { YamlPipelineConfig, ResolvedStage } from "@pegasus/types";

// ============================================================================
// Mocks (matching existing pipeline-compiler.test.ts patterns)
// ============================================================================

vi.mock("@/lib/secure-fs.js", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock("@pegasus/platform", () => ({
  getPipelinesDir: vi.fn((projectPath: string) =>
    path.join(projectPath, ".pegasus", "pipelines"),
  ),
  getPipelineFilePath: vi.fn((projectPath: string, slug: string) =>
    path.join(projectPath, ".pegasus", "pipelines", `${slug}.yaml`),
  ),
  getUserPipelinesDir: vi.fn(() =>
    path.join(os.homedir(), ".pegasus", "pipelines"),
  ),
  getUserPipelineFilePath: vi.fn((slug: string) =>
    path.join(os.homedir(), ".pegasus", "pipelines", `${slug}.yaml`),
  ),
  systemPaths: {
    systemPathReaddir: vi.fn(),
    systemPathReadFile: vi.fn(),
  },
}));

vi.mock("@pegasus/utils", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Import after mocks
import {
  stageConfigSchema,
  compilePipeline,
  compileStage,
} from "@/services/pipeline-compiler.js";

// ============================================================================
// Test Fixtures
// ============================================================================

function createBaseStage(overrides?: Partial<ResolvedStage>): ResolvedStage {
  return {
    id: "plan",
    name: "Feature Planning",
    prompt: "Plan the feature: {{task.description}}",
    model: "sonnet",
    permission_mode: "plan",
    max_turns: 10,
    requires_approval: false,
    ...overrides,
  };
}

const BASE_COMPILATION_CONTEXT = {
  task: { description: "Build a new feature" },
  project: { language: "TypeScript" },
};

const BASE_PIPELINE_CONFIG: YamlPipelineConfig = {
  name: "Feature",
  description: "Feature pipeline",
  execution: { mode: "session" },
  defaults: { model: "sonnet", max_turns: 10, permission_mode: "plan" },
  stages: [
    {
      id: "plan",
      name: "Feature Planning",
      prompt: "Plan the feature",
    },
  ],
};

// ============================================================================
// Tests: stageConfigSchema question fields
// ============================================================================

describe("stageConfigSchema — question fields", () => {
  const validBase = {
    id: "plan",
    name: "Feature Planning",
    prompt: "Plan the feature",
  };

  it("should accept a stage with a question field", () => {
    const result = stageConfigSchema.safeParse({
      ...validBase,
      question: "What approach should we use?",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.question).toBe("What approach should we use?");
    }
  });

  it("should accept a stage with question_meta (free-text)", () => {
    const result = stageConfigSchema.safeParse({
      ...validBase,
      question: "Describe the approach",
      question_meta: { type: "free-text" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.question_meta?.type).toBe("free-text");
    }
  });

  it("should accept a stage with question_meta (single-select with options)", () => {
    const result = stageConfigSchema.safeParse({
      ...validBase,
      question: "Which approach?",
      question_meta: {
        type: "single-select",
        options: ["Option A", "Option B", "Option C"],
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.question_meta?.type).toBe("single-select");
      expect(result.data.question_meta?.options).toEqual([
        "Option A",
        "Option B",
        "Option C",
      ]);
    }
  });

  it("should accept a stage with question_meta (multi-select)", () => {
    const result = stageConfigSchema.safeParse({
      ...validBase,
      question: "Which features to include?",
      question_meta: { type: "multi-select", options: ["Auth", "API", "UI"] },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.question_meta?.type).toBe("multi-select");
    }
  });

  it("should accept a stage without question (optional)", () => {
    const result = stageConfigSchema.safeParse(validBase);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.question).toBeUndefined();
      expect(result.data.question_meta).toBeUndefined();
    }
  });

  it("should reject an empty question string", () => {
    const result = stageConfigSchema.safeParse({
      ...validBase,
      question: "",
    });

    expect(result.success).toBe(false);
  });

  it("should reject invalid question_meta type", () => {
    const result = stageConfigSchema.safeParse({
      ...validBase,
      question: "Valid question?",
      question_meta: { type: "invalid-type" },
    });

    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Tests: compilePipeline passes question fields through
// ============================================================================

describe("compilePipeline — question field pass-through", () => {
  it("should include question field in ResolvedStage when present", () => {
    const config: YamlPipelineConfig = {
      ...BASE_PIPELINE_CONFIG,
      stages: [
        {
          id: "plan",
          name: "Feature Planning",
          prompt: "Plan the feature",
          question: "What is the preferred approach?",
        },
      ],
    };

    const stages = compilePipeline(config);

    expect(stages[0].question).toBe("What is the preferred approach?");
  });

  it("should include question_meta in ResolvedStage when present", () => {
    const config: YamlPipelineConfig = {
      ...BASE_PIPELINE_CONFIG,
      stages: [
        {
          id: "plan",
          name: "Feature Planning",
          prompt: "Plan the feature",
          question: "Which approach?",
          question_meta: {
            type: "single-select",
            options: ["A", "B"],
          },
        },
      ],
    };

    const stages = compilePipeline(config);

    expect(stages[0].question_meta).toEqual({
      type: "single-select",
      options: ["A", "B"],
    });
  });

  it("should leave question undefined when not set", () => {
    const stages = compilePipeline(BASE_PIPELINE_CONFIG);

    expect(stages[0].question).toBeUndefined();
    expect(stages[0].question_meta).toBeUndefined();
  });

  it("should pass question through alongside requires_approval", () => {
    const config: YamlPipelineConfig = {
      ...BASE_PIPELINE_CONFIG,
      stages: [
        {
          id: "plan",
          name: "Feature Planning",
          prompt: "Plan the feature",
          requires_approval: true,
          question: "Any pre-stage requirements?",
        },
      ],
    };

    const stages = compilePipeline(config);

    expect(stages[0].requires_approval).toBe(true);
    expect(stages[0].question).toBe("Any pre-stage requirements?");
  });
});

// ============================================================================
// Tests: compileStage resolves stages context template variables
// ============================================================================

describe("compileStage — stages context template variables", () => {
  it("should resolve {{stages.plan.question_response}} when provided", () => {
    const stage = createBaseStage({
      prompt:
        'Given the approach "{{stages.plan.question_response}}", implement the feature.',
    });

    const result = compileStage(stage, {
      ...BASE_COMPILATION_CONTEXT,
      stages: {
        plan: { question_response: "Use the factory pattern" },
      },
    });

    expect(result.stage.prompt).toContain("Use the factory pattern");
    expect(result.stage.prompt).not.toContain(
      "{{stages.plan.question_response}}",
    );
  });

  it("should resolve {{stages.plan.question_responses}} when provided", () => {
    const stage = createBaseStage({
      prompt:
        "Context: {{stages.plan.question_responses}}\n\nImplement the feature.",
    });

    const result = compileStage(stage, {
      ...BASE_COMPILATION_CONTEXT,
      stages: {
        plan: { question_responses: "Q: What approach?\nA: Factory pattern" },
      },
    });

    expect(result.stage.prompt).toContain("Q: What approach?");
    expect(result.stage.prompt).toContain("A: Factory pattern");
  });

  it("should handle multiple stage question responses", () => {
    const stage = createBaseStage({
      id: "implement",
      prompt:
        "Plan: {{stages.plan.question_response}}\nReview: {{stages.review.question_response}}",
    });

    const result = compileStage(stage, {
      ...BASE_COMPILATION_CONTEXT,
      stages: {
        plan: { question_response: "Use factory pattern" },
        review: { question_response: "Add unit tests" },
      },
    });

    expect(result.stage.prompt).toContain("Use factory pattern");
    expect(result.stage.prompt).toContain("Add unit tests");
  });

  it("should leave template variables unresolved when stages context is not provided", () => {
    const stage = createBaseStage({
      prompt: "Approach: {{stages.plan.question_response}}",
    });

    const result = compileStage(stage, BASE_COMPILATION_CONTEXT);

    // Handlebars leaves missing variables empty by default
    expect(result.hasMissingVariables).toBe(true);
  });

  it("should not affect other template variables when stages context is empty", () => {
    const stage = createBaseStage({
      prompt: "Implement: {{task.description}} in {{project.language}}",
    });

    const result = compileStage(stage, {
      ...BASE_COMPILATION_CONTEXT,
      stages: {},
    });

    expect(result.stage.prompt).toContain("Build a new feature");
    expect(result.stage.prompt).toContain("TypeScript");
    expect(result.hasMissingVariables).toBe(false);
  });

  it("should work alongside previous_context", () => {
    const stage = createBaseStage({
      prompt:
        "Previous: {{previous_context}}\nApproach: {{stages.plan.question_response}}",
    });

    const result = compileStage(stage, {
      ...BASE_COMPILATION_CONTEXT,
      previous_context: "Stage 1 output here",
      stages: {
        plan: { question_response: "Microservices approach" },
      },
    });

    expect(result.stage.prompt).toContain("Stage 1 output here");
    expect(result.stage.prompt).toContain("Microservices approach");
    expect(result.hasMissingVariables).toBe(false);
  });
});
