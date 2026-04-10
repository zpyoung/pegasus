/**
 * Unit tests for POST /convert route handler
 *
 * Tests:
 *  - FR-004: server returns 422 when idea status !== 'ready' (IDEA_NOT_READY code)
 *  - Input validation
 *  - Successful conversion flow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createConvertHandler } from '@/routes/ideation/routes/convert.js';
import type { IdeationService } from '@/services/ideation-service.js';
import type { FeatureLoader } from '@/services/feature-loader.js';
import type { EventEmitter } from '@/lib/events.js';
import { createMockExpressContext } from '../../../utils/mocks.js';

vi.mock('@pegasus/utils', async () => {
  const actual = await vi.importActual<typeof import('@pegasus/utils')>('@pegasus/utils');
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

const TEST_PROJECT_PATH = '/test/project';
const TEST_IDEA_ID = 'idea-123';

/** Create an error with an attached `code` property (mirrors IdeationService throws). */
function makeIdeaNotReadyError(): Error & { code: string } {
  const err = new Error("Cannot convert idea: status must be 'ready', got 'raw'") as Error & {
    code: string;
  };
  err.code = 'IDEA_NOT_READY';
  return err;
}

describe('POST /convert', () => {
  let mockEvents: Partial<EventEmitter>;
  let mockIdeationService: Partial<IdeationService>;
  let mockFeatureLoader: Partial<FeatureLoader>;
  let req: Request;
  let res: Response;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEvents = { emit: vi.fn() };
    mockIdeationService = {
      convertToFeature: vi.fn(),
      deleteIdea: vi.fn().mockResolvedValue(undefined),
    };
    mockFeatureLoader = {
      create: vi.fn(),
    };

    const ctx = createMockExpressContext();
    req = ctx.req;
    res = ctx.res;
  });

  // ─── Input validation ─────────────────────────────────────────────────────

  it('returns 400 when projectPath is missing', async () => {
    req.body = { ideaId: TEST_IDEA_ID };
    const handler = createConvertHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
      mockFeatureLoader as FeatureLoader
    );
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'projectPath is required' });
    expect(mockIdeationService.convertToFeature).not.toHaveBeenCalled();
  });

  it('returns 400 when ideaId is missing', async () => {
    req.body = { projectPath: TEST_PROJECT_PATH };
    const handler = createConvertHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
      mockFeatureLoader as FeatureLoader
    );
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'ideaId is required' });
    expect(mockIdeationService.convertToFeature).not.toHaveBeenCalled();
  });

  // ─── FR-004: ready-gate ───────────────────────────────────────────────────

  it('returns 422 when idea is not ready (IDEA_NOT_READY code)', async () => {
    vi.mocked(mockIdeationService.convertToFeature!).mockRejectedValue(makeIdeaNotReadyError());

    req.body = { projectPath: TEST_PROJECT_PATH, ideaId: TEST_IDEA_ID };
    const handler = createConvertHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
      mockFeatureLoader as FeatureLoader
    );
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: expect.stringContaining("Cannot convert idea"),
    });
    // featureLoader.create should NOT be called
    expect(mockFeatureLoader.create).not.toHaveBeenCalled();
  });

  it('does not return 422 for generic service errors (returns 500 instead)', async () => {
    vi.mocked(mockIdeationService.convertToFeature!).mockRejectedValue(
      new Error('Something unexpected')
    );

    req.body = { projectPath: TEST_PROJECT_PATH, ideaId: TEST_IDEA_ID };
    const handler = createConvertHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
      mockFeatureLoader as FeatureLoader
    );
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Something unexpected',
    });
  });

  // ─── Success path ─────────────────────────────────────────────────────────

  it('returns featureId on successful conversion', async () => {
    const featureData = {
      title: 'Idea Title',
      description: 'Desc',
      category: 'ui',
      status: 'backlog',
    };
    const createdFeature = { id: 'feature-99', ...featureData };

    vi.mocked(mockIdeationService.convertToFeature!).mockResolvedValue(featureData as any);
    vi.mocked(mockFeatureLoader.create!).mockResolvedValue(createdFeature as any);

    req.body = { projectPath: TEST_PROJECT_PATH, ideaId: TEST_IDEA_ID };
    const handler = createConvertHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
      mockFeatureLoader as FeatureLoader
    );
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true, featureId: 'feature-99' });
  });

  it('deletes the source idea after conversion when keepIdea is false (default)', async () => {
    const featureData = { title: 'T', description: '', category: 'ui', status: 'backlog' };
    const createdFeature = { id: 'feature-99', ...featureData };

    vi.mocked(mockIdeationService.convertToFeature!).mockResolvedValue(featureData as any);
    vi.mocked(mockFeatureLoader.create!).mockResolvedValue(createdFeature as any);

    req.body = { projectPath: TEST_PROJECT_PATH, ideaId: TEST_IDEA_ID, keepIdea: false };
    const handler = createConvertHandler(
      mockEvents as EventEmitter,
      mockIdeationService as IdeationService,
      mockFeatureLoader as FeatureLoader
    );
    await handler(req, res);

    expect(mockIdeationService.deleteIdea).toHaveBeenCalledWith(TEST_PROJECT_PATH, TEST_IDEA_ID);
  });
});
