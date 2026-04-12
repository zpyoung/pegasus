/**
 * Unit tests for POST /add-suggestion route handler
 *
 * Tests:
 *  - FR-006: AI suggestions are written as Ideas (status=raw) not Features
 *  - featureLoader.create is NEVER called (ADR-003 redirect)
 *  - Input validation
 *  - Description + rationale concatenation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { createAddSuggestionHandler } from "@/routes/ideation/routes/add-suggestion.js";
import type { IdeationService } from "@/services/ideation-service.js";
import type { FeatureLoader } from "@/services/feature-loader.js";
import { createMockExpressContext } from "../../../utils/mocks.js";

vi.mock("@pegasus/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@pegasus/utils")>("@pegasus/utils");
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

const TEST_PROJECT_PATH = "/test/project";

describe("POST /add-suggestion", () => {
  let mockIdeationService: Partial<IdeationService>;
  let mockFeatureLoader: Partial<FeatureLoader>;
  let req: Request;
  let res: Response;

  beforeEach(() => {
    vi.clearAllMocks();

    mockIdeationService = { createIdea: vi.fn() };
    // create should NEVER be called (it's the featureLoader.create that the old code used)
    mockFeatureLoader = { create: vi.fn() };

    const ctx = createMockExpressContext();
    req = ctx.req;
    res = ctx.res;
  });

  // ─── Input validation ─────────────────────────────────────────────────────

  it("returns 400 when projectPath is missing", async () => {
    req.body = {
      suggestion: {
        id: "s1",
        title: "T",
        description: "D",
        rationale: "R",
        category: "feature",
      },
    };
    const handler = createAddSuggestionHandler(
      mockIdeationService as IdeationService,
      mockFeatureLoader as FeatureLoader,
    );
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "projectPath is required",
    });
    expect(mockIdeationService.createIdea).not.toHaveBeenCalled();
  });

  it("returns 400 when suggestion is missing", async () => {
    req.body = { projectPath: TEST_PROJECT_PATH };
    const handler = createAddSuggestionHandler(
      mockIdeationService as IdeationService,
      mockFeatureLoader as FeatureLoader,
    );
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "suggestion is required",
    });
    expect(mockIdeationService.createIdea).not.toHaveBeenCalled();
  });

  it("returns 400 when suggestion.title is missing", async () => {
    req.body = {
      projectPath: TEST_PROJECT_PATH,
      suggestion: {
        id: "s1",
        description: "D",
        rationale: "R",
        category: "feature",
      },
    };
    const handler = createAddSuggestionHandler(
      mockIdeationService as IdeationService,
      mockFeatureLoader as FeatureLoader,
    );
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "suggestion.title is required",
    });
    expect(mockIdeationService.createIdea).not.toHaveBeenCalled();
  });

  // ─── FR-006: Creates an Idea (not a Feature) ─────────────────────────────

  it("calls createIdea with status=raw instead of featureLoader.create (FR-006, ADR-003)", async () => {
    const idea = {
      id: "idea-1",
      title: "Auth redesign",
      description: "Some description",
      category: "feature",
      status: "raw",
      impact: "medium",
      effort: "medium",
      createdAt: "",
      updatedAt: "",
    };
    vi.mocked(mockIdeationService.createIdea!).mockResolvedValue(idea as any);

    req.body = {
      projectPath: TEST_PROJECT_PATH,
      suggestion: {
        id: "s1",
        title: "Auth redesign",
        description: "Some description",
        rationale: "",
        category: "feature",
      },
    };
    const handler = createAddSuggestionHandler(
      mockIdeationService as IdeationService,
      mockFeatureLoader as FeatureLoader,
    );
    await handler(req, res);

    expect(mockIdeationService.createIdea).toHaveBeenCalledWith(
      TEST_PROJECT_PATH,
      expect.objectContaining({ title: "Auth redesign", status: "raw" }),
    );
    // featureLoader.create must NOT be called (ADR-003)
    expect(mockFeatureLoader.create).not.toHaveBeenCalled();
    // Response includes ideaId (not featureId)
    expect(res.json).toHaveBeenCalledWith({ success: true, ideaId: "idea-1" });
  });

  it("appends rationale to description when rationale is provided", async () => {
    const idea = {
      id: "idea-2",
      title: "T",
      description: "",
      category: "feature",
      status: "raw",
      impact: "medium",
      effort: "medium",
      createdAt: "",
      updatedAt: "",
    };
    vi.mocked(mockIdeationService.createIdea!).mockResolvedValue(idea as any);

    req.body = {
      projectPath: TEST_PROJECT_PATH,
      suggestion: {
        id: "s2",
        title: "Auth redesign",
        description: "Base description",
        rationale: "This is important because...",
        category: "feature",
      },
    };
    const handler = createAddSuggestionHandler(
      mockIdeationService as IdeationService,
      mockFeatureLoader as FeatureLoader,
    );
    await handler(req, res);

    const calledWith = vi.mocked(mockIdeationService.createIdea!).mock
      .calls[0][1];
    expect(calledWith.description).toContain("Base description");
    expect(calledWith.description).toContain("**Rationale:**");
    expect(calledWith.description).toContain("This is important because...");
  });

  it("returns 500 when createIdea throws an unexpected error", async () => {
    vi.mocked(mockIdeationService.createIdea!).mockRejectedValue(
      new Error("Write failed"),
    );

    req.body = {
      projectPath: TEST_PROJECT_PATH,
      suggestion: {
        id: "s3",
        title: "T",
        description: "D",
        rationale: "",
        category: "feature",
      },
    };
    const handler = createAddSuggestionHandler(
      mockIdeationService as IdeationService,
      mockFeatureLoader as FeatureLoader,
    );
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Write failed",
    });
  });
});
