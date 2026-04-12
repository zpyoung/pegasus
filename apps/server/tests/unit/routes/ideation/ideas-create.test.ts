/**
 * Unit tests for POST /ideas/create route handler
 *
 * Tests:
 *  - FR-001: only `title` is required (description/category optional)
 *  - NFR-004: old strict payloads still accepted (backward compat)
 *  - Input validation guard-rails
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { createIdeasCreateHandler } from "@/routes/ideation/routes/ideas-create.js";
import type { IdeationService } from "@/services/ideation-service.js";
import type { EventEmitter } from "@/lib/events.js";
import { createMockExpressContext } from "../../../utils/mocks.js";

// Silence logger noise that flows through createLogger('@pegasus/utils')
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

const makeIdea = (overrides: Record<string, unknown> = {}) => ({
  id: "idea-1",
  title: "Test Idea",
  description: "",
  category: "feature",
  status: "raw",
  impact: "medium",
  effort: "medium",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("POST /ideas/create", () => {
  let mockEvents: Partial<EventEmitter>;
  let mockIdeationService: Partial<IdeationService>;
  let req: Request;
  let res: Response;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEvents = { emit: vi.fn() };
    mockIdeationService = { createIdea: vi.fn() };

    const ctx = createMockExpressContext();
    req = ctx.req;
    res = ctx.res;
  });

  // ─── Input validation ─────────────────────────────────────────────────────

  it("returns 400 when projectPath is missing", async () => {
    req.body = { idea: { title: "Test" } };
    const handler = createIdeasCreateHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
    );
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "projectPath is required",
    });
    expect(mockIdeationService.createIdea).not.toHaveBeenCalled();
  });

  it("returns 400 when idea body is missing", async () => {
    req.body = { projectPath: TEST_PROJECT_PATH };
    const handler = createIdeasCreateHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
    );
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "idea is required",
    });
    expect(mockIdeationService.createIdea).not.toHaveBeenCalled();
  });

  it("returns 400 when idea.title is missing (FR-001 guard)", async () => {
    req.body = {
      projectPath: TEST_PROJECT_PATH,
      idea: { description: "Some description", category: "feature" },
    };
    const handler = createIdeasCreateHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
    );
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "idea must have a title",
    });
    expect(mockIdeationService.createIdea).not.toHaveBeenCalled();
  });

  // ─── FR-001: title-only (quick-add) ──────────────────────────────────────

  it("accepts title-only payload and returns 200 (FR-001 quick-add)", async () => {
    const created = makeIdea({ title: "Quick idea" });
    vi.mocked(mockIdeationService.createIdea!).mockResolvedValue(
      created as any,
    );

    req.body = {
      projectPath: TEST_PROJECT_PATH,
      idea: { title: "Quick idea" },
    };
    const handler = createIdeasCreateHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
    );
    await handler(req, res);

    expect(mockIdeationService.createIdea).toHaveBeenCalledWith(
      TEST_PROJECT_PATH,
      {
        title: "Quick idea",
      },
    );
    expect(res.json).toHaveBeenCalledWith({ success: true, idea: created });
  });

  // ─── NFR-004: backward compat (full payload still works) ─────────────────

  it("accepts title + description + category payload (NFR-004 backward compat)", async () => {
    const created = makeIdea({
      title: "Full idea",
      description: "A description",
      category: "bug",
    });
    vi.mocked(mockIdeationService.createIdea!).mockResolvedValue(
      created as any,
    );

    req.body = {
      projectPath: TEST_PROJECT_PATH,
      idea: {
        title: "Full idea",
        description: "A description",
        category: "bug",
      },
    };
    const handler = createIdeasCreateHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
    );
    await handler(req, res);

    expect(mockIdeationService.createIdea).toHaveBeenCalledWith(
      TEST_PROJECT_PATH,
      {
        title: "Full idea",
        description: "A description",
        category: "bug",
      },
    );
    expect(res.json).toHaveBeenCalledWith({ success: true, idea: created });
  });

  // ─── Side effects ─────────────────────────────────────────────────────────

  it("emits ideation:idea-created event on successful create", async () => {
    const created = makeIdea();
    vi.mocked(mockIdeationService.createIdea!).mockResolvedValue(
      created as any,
    );

    req.body = { projectPath: TEST_PROJECT_PATH, idea: { title: "Test Idea" } };
    const handler = createIdeasCreateHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
    );
    await handler(req, res);

    expect(mockEvents.emit).toHaveBeenCalledWith("ideation:idea-created", {
      projectPath: TEST_PROJECT_PATH,
      idea: created,
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it("returns 500 when the service throws an unexpected error", async () => {
    vi.mocked(mockIdeationService.createIdea!).mockRejectedValue(
      new Error("Disk full"),
    );

    req.body = { projectPath: TEST_PROJECT_PATH, idea: { title: "Test Idea" } };
    const handler = createIdeasCreateHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
    );
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Disk full",
    });
  });
});
