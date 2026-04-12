import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { createMockExpressContext } from "../../utils/mocks.js";

// ============================================================================
// Mocks
// ============================================================================

vi.mock("@pegasus/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the common utilities used by the route
vi.mock("@/routes/auto-mode/common.js", () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
  logError: vi.fn(),
}));

// Import after mocks
import { createAnswerQuestionHandler } from "@/routes/auto-mode/routes/answer-question.js";
import type { AutoModeServiceCompat } from "@/services/auto-mode/index.js";

// ============================================================================
// Tests
// ============================================================================

describe("answer-question route", () => {
  let mockAutoModeService: AutoModeServiceCompat;
  let req: Request;
  let res: Response;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAutoModeService = {
      resolveQuestion: vi.fn().mockResolvedValue({ allAnswered: true }),
    } as unknown as AutoModeServiceCompat;

    const context = createMockExpressContext();
    req = context.req;
    res = context.res;
  });

  describe("successful answer submission", () => {
    it("should call resolveQuestion with correct arguments", async () => {
      req.body = {
        featureId: "feat-123",
        questionId: "q-001",
        answer: "Use the existing pattern",
        projectPath: "/test/project",
      };

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      expect(mockAutoModeService.resolveQuestion).toHaveBeenCalledWith(
        "/test/project",
        "feat-123",
        "q-001",
        "Use the existing pattern",
      );
    });

    it("should return success=true with allAnswered=true", async () => {
      vi.mocked(mockAutoModeService.resolveQuestion).mockResolvedValue({
        allAnswered: true,
      });
      req.body = {
        featureId: "feat-123",
        questionId: "q-001",
        answer: "My answer",
        projectPath: "/test/project",
      };

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          allAnswered: true,
        }),
      );
    });

    it("should return allAnswered=false when more questions remain", async () => {
      vi.mocked(mockAutoModeService.resolveQuestion).mockResolvedValue({
        allAnswered: false,
      });
      req.body = {
        featureId: "feat-123",
        questionId: "q-001",
        answer: "My answer",
        projectPath: "/test/project",
      };

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          allAnswered: false,
        }),
      );
    });

    it("should include a human-readable message in response", async () => {
      req.body = {
        featureId: "feat-123",
        questionId: "q-001",
        answer: "My answer",
        projectPath: "/test/project",
      };

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.any(String),
        }),
      );
    });
  });

  describe("validation: missing required fields", () => {
    it("should return 400 when featureId is missing", async () => {
      req.body = {
        questionId: "q-001",
        answer: "answer",
        projectPath: "/test/project",
      };

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "featureId is required",
        }),
      );
      expect(mockAutoModeService.resolveQuestion).not.toHaveBeenCalled();
    });

    it("should return 400 when questionId is missing", async () => {
      req.body = {
        featureId: "feat-123",
        answer: "answer",
        projectPath: "/test/project",
      };

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "questionId is required",
        }),
      );
      expect(mockAutoModeService.resolveQuestion).not.toHaveBeenCalled();
    });

    it("should return 400 when answer is missing (not a string)", async () => {
      req.body = {
        featureId: "feat-123",
        questionId: "q-001",
        projectPath: "/test/project",
        // answer not provided → undefined, not a string
      };

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "answer must be a string",
        }),
      );
      expect(mockAutoModeService.resolveQuestion).not.toHaveBeenCalled();
    });

    it("should return 400 when projectPath is missing", async () => {
      req.body = {
        featureId: "feat-123",
        questionId: "q-001",
        answer: "My answer",
      };

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "projectPath is required",
        }),
      );
      expect(mockAutoModeService.resolveQuestion).not.toHaveBeenCalled();
    });

    it("should return 400 when body is empty", async () => {
      req.body = {};

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockAutoModeService.resolveQuestion).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should return 500 when resolveQuestion throws", async () => {
      vi.mocked(mockAutoModeService.resolveQuestion).mockRejectedValue(
        new Error("Feature not found"),
      );
      req.body = {
        featureId: "feat-999",
        questionId: "q-001",
        answer: "answer",
        projectPath: "/test/project",
      };

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "Feature not found",
        }),
      );
    });

    it("should return 500 when resolveQuestion throws with unknown error", async () => {
      vi.mocked(mockAutoModeService.resolveQuestion).mockRejectedValue(
        "string error",
      );
      req.body = {
        featureId: "feat-123",
        questionId: "q-001",
        answer: "answer",
        projectPath: "/test/project",
      };

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false }),
      );
    });
  });

  describe("edge cases", () => {
    it("should accept an empty string answer", async () => {
      req.body = {
        featureId: "feat-123",
        questionId: "q-001",
        answer: "", // empty string is still a string
        projectPath: "/test/project",
      };

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      // Empty string passes type check (typeof '' === 'string')
      expect(mockAutoModeService.resolveQuestion).toHaveBeenCalledWith(
        "/test/project",
        "feat-123",
        "q-001",
        "",
      );
    });

    it("should accept a multi-line answer", async () => {
      req.body = {
        featureId: "feat-123",
        questionId: "q-001",
        answer: "Option A, Option B\nWith additional context",
        projectPath: "/test/project",
      };

      const handler = createAnswerQuestionHandler(mockAutoModeService);
      await handler(req, res);

      expect(mockAutoModeService.resolveQuestion).toHaveBeenCalledWith(
        "/test/project",
        "feat-123",
        "q-001",
        "Option A, Option B\nWith additional context",
      );
    });
  });
});
