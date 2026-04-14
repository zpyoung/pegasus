/**
 * Unit tests for the POST /bulk-status route handler (Task 3: Wave 2)
 *
 * Validates:
 * - Happy path: returns {success, statuses} with projected {id, status, title} fields
 * - Missing projectPath: returns 400
 * - featureLoader.getAll() throws: returns 500
 * - Empty features list: returns empty statuses array
 */

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
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
  createLogError: () => vi.fn(),
}));

vi.mock("@/routes/features/common.js", () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
  logError: vi.fn(),
}));

// Import after mocks
import { createBulkStatusHandler } from "@/routes/features/routes/bulk-status.js";
import type { FeatureLoader } from "@/services/feature-loader.js";

// ============================================================================
// Tests
// ============================================================================

describe("bulk-status route handler", () => {
  let mockFeatureLoader: FeatureLoader;
  let req: Request;
  let res: Response;

  const mockFeatures = [
    {
      id: "feat-001",
      status: "in_progress",
      title: "Feature Alpha",
      description: "Does alpha things",
      model: "claude-sonnet-4-5",
      branch: "feature/alpha",
      worktreePath: "/tmp/alpha",
    },
    {
      id: "feat-002",
      status: "completed",
      title: "Feature Beta",
      description: "Does beta things",
      model: "claude-sonnet-4-5",
      branch: "feature/beta",
      worktreePath: "/tmp/beta",
    },
    {
      id: "feat-003",
      status: "backlog",
      title: "Feature Gamma",
      description: "Does gamma things",
      model: "claude-opus-4-6",
      branch: "feature/gamma",
      worktreePath: null,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    mockFeatureLoader = {
      getAll: vi.fn().mockResolvedValue(mockFeatures),
    } as unknown as FeatureLoader;

    const context = createMockExpressContext();
    req = context.req;
    res = context.res;
  });

  describe("successful request", () => {
    it("returns success=true with projected statuses", async () => {
      req.body = { projectPath: "/test/project" };

      const handler = createBulkStatusHandler(mockFeatureLoader);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        statuses: [
          { id: "feat-001", status: "in_progress", title: "Feature Alpha" },
          { id: "feat-002", status: "completed", title: "Feature Beta" },
          { id: "feat-003", status: "backlog", title: "Feature Gamma" },
        ],
      });
    });

    it("calls featureLoader.getAll with the provided projectPath", async () => {
      req.body = { projectPath: "/my/project" };

      const handler = createBulkStatusHandler(mockFeatureLoader);
      await handler(req, res);

      expect(mockFeatureLoader.getAll).toHaveBeenCalledWith("/my/project");
    });

    it("does not include extraneous fields in the statuses", async () => {
      req.body = { projectPath: "/test/project" };

      const handler = createBulkStatusHandler(mockFeatureLoader);
      await handler(req, res);

      const response = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      for (const entry of response.statuses) {
        // Only id, status, title should be present
        expect(Object.keys(entry).sort()).toEqual(["id", "status", "title"]);
      }
    });

    it("returns empty statuses array when no features exist", async () => {
      (mockFeatureLoader.getAll as ReturnType<typeof vi.fn>).mockResolvedValue(
        [],
      );
      req.body = { projectPath: "/empty/project" };

      const handler = createBulkStatusHandler(mockFeatureLoader);
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        statuses: [],
      });
    });

    it("does not call res.status (defaults to 200)", async () => {
      req.body = { projectPath: "/test/project" };

      const handler = createBulkStatusHandler(mockFeatureLoader);
      await handler(req, res);

      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("missing projectPath", () => {
    it("returns 400 when body has no projectPath", async () => {
      req.body = {};

      const handler = createBulkStatusHandler(mockFeatureLoader);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: "projectPath is required",
      });
    });

    it("does not call featureLoader.getAll when projectPath is missing", async () => {
      req.body = {};

      const handler = createBulkStatusHandler(mockFeatureLoader);
      await handler(req, res);

      expect(mockFeatureLoader.getAll).not.toHaveBeenCalled();
    });

    it("returns 400 when projectPath is explicitly null", async () => {
      req.body = { projectPath: null };

      const handler = createBulkStatusHandler(mockFeatureLoader);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe("error handling", () => {
    it("returns 500 when featureLoader.getAll throws", async () => {
      (mockFeatureLoader.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Disk read failed"),
      );
      req.body = { projectPath: "/test/project" };

      const handler = createBulkStatusHandler(mockFeatureLoader);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: "Disk read failed",
      });
    });

    it("returns 500 with error message string for non-Error throws", async () => {
      (mockFeatureLoader.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(
        "unexpected string error",
      );
      req.body = { projectPath: "/test/project" };

      const handler = createBulkStatusHandler(mockFeatureLoader);
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      const response = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.success).toBe(false);
      expect(typeof response.error).toBe("string");
    });
  });
});
