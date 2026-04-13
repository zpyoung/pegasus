import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMockExpressContext } from '../../utils/mocks.js';
import { createDetailedHandler } from '@/routes/health/routes/detailed.js';
import { createIndexHandler } from '@/routes/health/routes/index.js';
import { getRuntimeInstanceMetadata } from '@/lib/version.js';

vi.mock('@/lib/version.js', () => ({
  getRuntimeInstanceMetadata: vi.fn(() => ({
    version: '1.2.3',
    gitBranch: 'feature/runtime-banner',
    bannerVersion: '1.2.3',
    bannerBranch: 'feature/runtime-banner',
    isPackagedRelease: false,
    runtimeChannel: 'development',
  })),
}));

const mockGetRuntimeInstanceMetadata = vi.mocked(getRuntimeInstanceMetadata);

vi.mock('@/lib/auth.js', () => ({
  getAuthStatus: vi.fn(() => ({
    authenticated: true,
  })),
}));

describe('health routes', () => {
  let req: Request;
  let res: Response;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T15:30:00.000Z'));

    const context = createMockExpressContext();
    req = context.req;
    res = context.res;
  });

  describe('GET / (index handler)', () => {
    it('includes runtime banner metadata for UI consumption', () => {
      const handler = createIndexHandler();

      handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        timestamp: '2026-04-12T15:30:00.000Z',
        version: '1.2.3',
        runtime: {
          bannerVersion: '1.2.3',
          bannerBranch: 'feature/runtime-banner',
          runtimeChannel: 'development',
          isPackagedRelease: false,
        },
      });
    });
  });

  describe('GET /detailed (detailed handler)', () => {
    it('includes runtime banner metadata alongside detailed health information', () => {
      const handler = createDetailedHandler();

      handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          timestamp: '2026-04-12T15:30:00.000Z',
          version: '1.2.3',
          dataDir: './data',
          auth: {
            authenticated: true,
          },
          runtime: {
            bannerVersion: '1.2.3',
            bannerBranch: 'feature/runtime-banner',
            runtimeChannel: 'development',
            isPackagedRelease: false,
          },
          env: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
          },
        })
      );
    });

    it('reports packaged releases with the suppressed release branch metadata', () => {
      mockGetRuntimeInstanceMetadata.mockReturnValueOnce({
        version: '2.0.0',
        gitBranch: null,
        bannerVersion: '2.0.0',
        bannerBranch: 'release',
        isPackagedRelease: true,
        runtimeChannel: 'packaged',
      });

      const handler = createDetailedHandler();

      handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          version: '2.0.0',
          runtime: {
            bannerVersion: '2.0.0',
            bannerBranch: 'release',
            runtimeChannel: 'packaged',
            isPackagedRelease: true,
          },
        })
      );
    });
  });
});
