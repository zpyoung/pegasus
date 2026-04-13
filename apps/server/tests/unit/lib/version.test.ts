import { describe, expect, it } from 'vitest';
import { getRuntimeInstanceMetadata, sanitizeBannerValue } from '../../../src/lib/version.js';

describe('version.ts', () => {
  describe('sanitizeBannerValue', () => {
    it('removes control characters and collapses whitespace', () => {
      expect(sanitizeBannerValue(' feature/\nnext\tbranch ', 'fallback')).toBe(
        'feature/ next branch'
      );
    });

    it('falls back when sanitized value is empty', () => {
      expect(sanitizeBannerValue('\n\t', 'fallback')).toBe('fallback');
    });
  });

  describe('getRuntimeInstanceMetadata', () => {
    it('falls back to rev-parse when branch --show-current is empty', () => {
      const existingPaths = new Set([
        '/repo/apps/server/package.json',
        '/repo/package.json',
        '/repo/pnpm-workspace.yaml',
        '/repo/.git',
      ]);
      const calls: string[][] = [];

      const metadata = getRuntimeInstanceMetadata({
        cwd: '/repo/.worktrees/staging',
        moduleDir: '/repo/apps/server/src/lib',
        exists: (candidate) => existingPaths.has(candidate),
        readFile: (candidate) => {
          if (candidate === '/repo/apps/server/package.json') {
            return JSON.stringify({ name: '@pegasus/server', version: '1.2.3' });
          }

          if (candidate === '/repo/package.json') {
            return JSON.stringify({ name: 'pegasus', version: '1.2.3' });
          }

          throw new Error(`Unexpected read: ${candidate}`);
        },
        execFile: (_file, args) => {
          calls.push(args);
          if (args[0] === 'branch') {
            return '\n';
          }

          return 'feature/from-rev-parse\n';
        },
      });

      expect(calls).toEqual([
        ['branch', '--show-current'],
        ['rev-parse', '--abbrev-ref', 'HEAD'],
      ]);
      expect(metadata.gitBranch).toBe('feature/from-rev-parse');
      expect(metadata.bannerBranch).toBe('feature/from-rev-parse');
    });

    it('resolves development metadata from the Pegasus repo root', () => {
      const existingPaths = new Set([
        '/repo/apps/server/package.json',
        '/repo/package.json',
        '/repo/pnpm-workspace.yaml',
        '/repo/.git',
      ]);

      const metadata = getRuntimeInstanceMetadata({
        cwd: '/repo/.worktrees/staging',
        moduleDir: '/repo/apps/server/src/lib',
        exists: (candidate) => existingPaths.has(candidate),
        readFile: (candidate) => {
          if (candidate === '/repo/apps/server/package.json') {
            return JSON.stringify({ name: '@pegasus/server', version: '1.2.3' });
          }

          if (candidate === '/repo/package.json') {
            return JSON.stringify({ name: 'pegasus', version: '1.2.3' });
          }

          throw new Error(`Unexpected read: ${candidate}`);
        },
        execFile: () => 'feature/runtime-banner\n',
      });

      expect(metadata).toEqual({
        version: '1.2.3',
        gitBranch: 'feature/runtime-banner',
        bannerVersion: '1.2.3',
        bannerBranch: 'feature/runtime-banner',
        isPackagedRelease: false,
        runtimeChannel: 'development',
      });
    });

    it('marks packaged builds when no Pegasus repo root can be found', () => {
      const existingPaths = new Set(['/bundle/server/package.json']);

      const metadata = getRuntimeInstanceMetadata({
        cwd: '/bundle/server',
        moduleDir: '/bundle/server/lib',
        exists: (candidate) => existingPaths.has(candidate),
        readFile: (candidate) => {
          if (candidate === '/bundle/server/package.json') {
            return JSON.stringify({ name: '@pegasus/server', version: '2.0.0' });
          }

          throw new Error(`Unexpected read: ${candidate}`);
        },
        execFile: () => {
          throw new Error('git should not run for packaged releases');
        },
      });

      expect(metadata).toEqual({
        version: '2.0.0',
        gitBranch: null,
        bannerVersion: '2.0.0',
        bannerBranch: 'release',
        isPackagedRelease: true,
        runtimeChannel: 'packaged',
      });
    });

    it('returns a banner-safe fallback branch when git resolution fails', () => {
      const existingPaths = new Set([
        '/repo/apps/server/package.json',
        '/repo/package.json',
        '/repo/pnpm-workspace.yaml',
        '/repo/.git',
      ]);

      const metadata = getRuntimeInstanceMetadata({
        cwd: '/repo',
        moduleDir: '/repo/apps/server/src/lib',
        exists: (candidate) => existingPaths.has(candidate),
        readFile: (candidate) => {
          if (candidate === '/repo/apps/server/package.json') {
            return JSON.stringify({ name: '@pegasus/server', version: '1.2.3' });
          }

          if (candidate === '/repo/package.json') {
            return JSON.stringify({ name: 'pegasus', version: '1.2.3' });
          }

          throw new Error(`Unexpected read: ${candidate}`);
        },
        execFile: () => {
          throw new Error('git unavailable');
        },
      });

      expect(metadata.gitBranch).toBeNull();
      expect(metadata.bannerBranch).toBe('unknown');
      expect(metadata.isPackagedRelease).toBe(false);
    });

    it('treats detached HEAD output as unresolved and falls back to unknown', () => {
      const existingPaths = new Set([
        '/repo/apps/server/package.json',
        '/repo/package.json',
        '/repo/pnpm-workspace.yaml',
        '/repo/.git',
      ]);

      const metadata = getRuntimeInstanceMetadata({
        cwd: '/repo',
        moduleDir: '/repo/apps/server/src/lib',
        exists: (candidate) => existingPaths.has(candidate),
        readFile: (candidate) => {
          if (candidate === '/repo/apps/server/package.json') {
            return JSON.stringify({ name: '@pegasus/server', version: '1.2.3' });
          }

          if (candidate === '/repo/package.json') {
            return JSON.stringify({ name: 'pegasus', version: '1.2.3' });
          }

          throw new Error(`Unexpected read: ${candidate}`);
        },
        execFile: () => 'HEAD\n',
      });

      expect(metadata.gitBranch).toBeNull();
      expect(metadata.bannerBranch).toBe('unknown');
      expect(metadata.runtimeChannel).toBe('development');
    });
  });
});
