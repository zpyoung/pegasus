/**
 * Unit tests for the showAllWorktrees option in useBoardColumnFeatures.
 * Verifies that toggling showAllWorktrees bypasses per-worktree filtering so
 * features from every branch appear simultaneously on the board.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBoardColumnFeatures } from '../../../src/components/views/board-view/hooks/use-board-column-features';
import { useAppStore } from '../../../src/store/app-store';
import type { Feature } from '@pegasus/types';

function makeFeature(id: string, status: string, branchName?: string): Feature {
  return {
    id,
    title: `Feature ${id}`,
    category: 'test',
    description: '',
    status,
    ...(branchName !== undefined && { branchName }),
  };
}

const PRIMARY_WORKTREE = { path: null, branch: null };
const WORKTREE_A = { path: '/wt/feat-a', branch: 'feature/a' };
const WORKTREE_B = { path: '/wt/feat-b', branch: 'feature/b' };
const PROJECT_PATH = '/projects/my-app';

const baseProps = {
  runningAutoTasks: [] as string[],
  runningAutoTasksAllWorktrees: [] as string[],
  searchQuery: '',
  projectPath: PROJECT_PATH,
};

describe('useBoardColumnFeatures — showAllWorktrees', () => {
  beforeEach(() => {
    useAppStore.setState({ recentlyCompletedFeatures: new Set<string>() });
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  // ─── default behaviour (showAllWorktrees=false) ──────────────────────────

  describe('default filtering (showAllWorktrees=false)', () => {
    it('shows primary-worktree features when viewing primary worktree', () => {
      const features = [
        makeFeature('feat-primary', 'backlog'), // no branchName → primary only
        makeFeature('feat-a', 'backlog', 'feature/a'),
      ];

      const { result } = renderHook(() =>
        useBoardColumnFeatures({
          ...baseProps,
          features,
          currentWorktreePath: PRIMARY_WORKTREE.path,
          currentWorktreeBranch: PRIMARY_WORKTREE.branch,
          showAllWorktrees: false,
        })
      );

      const backlog = result.current.columnFeaturesMap.backlog;
      const ids = backlog.map((f) => f.id);
      expect(ids).toContain('feat-primary');
      expect(ids).not.toContain('feat-a');
    });

    it('shows only features matching the selected worktree branch', () => {
      const features = [
        makeFeature('feat-primary', 'backlog'), // no branch → primary
        makeFeature('feat-a', 'backlog', 'feature/a'),
        makeFeature('feat-b', 'backlog', 'feature/b'),
      ];

      const { result } = renderHook(() =>
        useBoardColumnFeatures({
          ...baseProps,
          features,
          currentWorktreePath: WORKTREE_A.path,
          currentWorktreeBranch: WORKTREE_A.branch,
          showAllWorktrees: false,
        })
      );

      const backlog = result.current.columnFeaturesMap.backlog;
      const ids = backlog.map((f) => f.id);
      expect(ids).toContain('feat-a');
      expect(ids).not.toContain('feat-b');
      expect(ids).not.toContain('feat-primary');
    });

    it('hides features from a different branch when viewing worktree A', () => {
      const features = [
        makeFeature('feat-b', 'in_progress', 'feature/b'),
      ];

      const { result } = renderHook(() =>
        useBoardColumnFeatures({
          ...baseProps,
          features,
          currentWorktreePath: WORKTREE_A.path,
          currentWorktreeBranch: WORKTREE_A.branch,
          showAllWorktrees: false,
        })
      );

      const allFeatures = Object.values(result.current.columnFeaturesMap).flat();
      expect(allFeatures.find((f) => f.id === 'feat-b')).toBeUndefined();
    });
  });

  // ─── all-worktrees mode (showAllWorktrees=true) ──────────────────────────

  describe('all-worktrees mode (showAllWorktrees=true)', () => {
    it('shows ALL features regardless of branch when viewing primary worktree', () => {
      const features = [
        makeFeature('feat-primary', 'backlog'),
        makeFeature('feat-a', 'backlog', 'feature/a'),
        makeFeature('feat-b', 'backlog', 'feature/b'),
      ];

      const { result } = renderHook(() =>
        useBoardColumnFeatures({
          ...baseProps,
          features,
          currentWorktreePath: PRIMARY_WORKTREE.path,
          currentWorktreeBranch: PRIMARY_WORKTREE.branch,
          showAllWorktrees: true,
        })
      );

      const backlog = result.current.columnFeaturesMap.backlog;
      const ids = backlog.map((f) => f.id);
      expect(ids).toContain('feat-primary');
      expect(ids).toContain('feat-a');
      expect(ids).toContain('feat-b');
    });

    it('shows ALL features regardless of branch when viewing a feature worktree', () => {
      const features = [
        makeFeature('feat-primary', 'backlog'),
        makeFeature('feat-a', 'backlog', 'feature/a'),
        makeFeature('feat-b', 'backlog', 'feature/b'),
      ];

      const { result } = renderHook(() =>
        useBoardColumnFeatures({
          ...baseProps,
          features,
          currentWorktreePath: WORKTREE_A.path,
          currentWorktreeBranch: WORKTREE_A.branch,
          showAllWorktrees: true,
        })
      );

      const backlog = result.current.columnFeaturesMap.backlog;
      const ids = backlog.map((f) => f.id);
      expect(ids).toContain('feat-primary');
      expect(ids).toContain('feat-a');
      expect(ids).toContain('feat-b');
    });

    it('includes no-branch features even when not viewing primary worktree', () => {
      const features = [
        makeFeature('feat-primary', 'in_progress'), // no branch → normally hidden on worktree B
      ];

      const { result } = renderHook(() =>
        useBoardColumnFeatures({
          ...baseProps,
          features,
          currentWorktreePath: WORKTREE_B.path,
          currentWorktreeBranch: WORKTREE_B.branch,
          showAllWorktrees: true,
        })
      );

      const inProgress = result.current.columnFeaturesMap.in_progress;
      expect(inProgress.find((f) => f.id === 'feat-primary')).toBeDefined();
    });

    it('includes features from a completely different branch', () => {
      const features = [makeFeature('feat-b', 'verified', 'feature/b')];

      const { result } = renderHook(() =>
        useBoardColumnFeatures({
          ...baseProps,
          features,
          currentWorktreePath: WORKTREE_A.path,
          currentWorktreeBranch: WORKTREE_A.branch,
          showAllWorktrees: true,
        })
      );

      const verified = result.current.columnFeaturesMap.verified;
      expect(verified.find((f) => f.id === 'feat-b')).toBeDefined();
    });

    it('total feature count equals input feature count (no filtering)', () => {
      const features = [
        makeFeature('f1', 'backlog'),
        makeFeature('f2', 'backlog', 'feature/a'),
        makeFeature('f3', 'in_progress', 'feature/b'),
        makeFeature('f4', 'verified', 'feature/c'),
      ];

      const { result } = renderHook(() =>
        useBoardColumnFeatures({
          ...baseProps,
          features,
          currentWorktreePath: WORKTREE_A.path,
          currentWorktreeBranch: WORKTREE_A.branch,
          showAllWorktrees: true,
        })
      );

      // All 4 features should be visible across their respective columns
      const allDisplayed = Object.values(result.current.columnFeaturesMap).flat();
      expect(allDisplayed).toHaveLength(4);
    });
  });

  // ─── toggling showAllWorktrees dynamically ────────────────────────────────

  describe('dynamic toggle', () => {
    it('re-runs filtering when showAllWorktrees changes from false to true', () => {
      const features = [
        makeFeature('feat-a', 'backlog', 'feature/a'),
        makeFeature('feat-b', 'backlog', 'feature/b'),
      ];

      let showAll = false;
      const { result, rerender } = renderHook(
        ({ show }) =>
          useBoardColumnFeatures({
            ...baseProps,
            features,
            currentWorktreePath: WORKTREE_A.path,
            currentWorktreeBranch: WORKTREE_A.branch,
            showAllWorktrees: show,
          }),
        { initialProps: { show: false } }
      );

      // Filtered: only feat-a visible
      expect(result.current.columnFeaturesMap.backlog.map((f) => f.id)).toEqual(['feat-a']);

      // Toggle on
      act(() => {
        rerender({ show: true });
      });

      // Now both visible
      const ids = result.current.columnFeaturesMap.backlog.map((f) => f.id);
      expect(ids).toContain('feat-a');
      expect(ids).toContain('feat-b');
    });

    it('re-runs filtering when showAllWorktrees changes from true to false', () => {
      const features = [
        makeFeature('feat-a', 'backlog', 'feature/a'),
        makeFeature('feat-b', 'backlog', 'feature/b'),
      ];

      const { result, rerender } = renderHook(
        ({ show }) =>
          useBoardColumnFeatures({
            ...baseProps,
            features,
            currentWorktreePath: WORKTREE_A.path,
            currentWorktreeBranch: WORKTREE_A.branch,
            showAllWorktrees: show,
          }),
        { initialProps: { show: true } }
      );

      // Both visible in all-worktrees mode
      expect(result.current.columnFeaturesMap.backlog).toHaveLength(2);

      // Toggle off — back to filtered mode
      act(() => {
        rerender({ show: false });
      });

      const ids = result.current.columnFeaturesMap.backlog.map((f) => f.id);
      expect(ids).toContain('feat-a');
      expect(ids).not.toContain('feat-b');
    });
  });

  // ─── interaction with other protections ──────────────────────────────────

  describe('interaction with running-task protection', () => {
    it('running-task override still applies in all-worktrees mode', () => {
      const features = [makeFeature('feat-a', 'backlog', 'feature/a')];

      const { result } = renderHook(() =>
        useBoardColumnFeatures({
          ...baseProps,
          features,
          runningAutoTasksAllWorktrees: ['feat-a'],
          currentWorktreePath: PRIMARY_WORKTREE.path,
          currentWorktreeBranch: PRIMARY_WORKTREE.branch,
          showAllWorktrees: true,
        })
      );

      // Still promoted to in_progress even in all-worktrees mode
      expect(result.current.columnFeaturesMap.in_progress.map((f) => f.id)).toContain('feat-a');
      expect(result.current.columnFeaturesMap.backlog).toHaveLength(0);
    });

    it('recently-completed protection still applies in all-worktrees mode', () => {
      const features = [makeFeature('feat-stale', 'backlog', 'feature/a')];

      useAppStore.setState({
        recentlyCompletedFeatures: new Set(['feat-stale']),
      });

      const { result } = renderHook(() =>
        useBoardColumnFeatures({
          ...baseProps,
          features,
          runningAutoTasksAllWorktrees: [],
          currentWorktreePath: PRIMARY_WORKTREE.path,
          currentWorktreeBranch: PRIMARY_WORKTREE.branch,
          showAllWorktrees: true,
        })
      );

      // Should still be suppressed from backlog
      expect(result.current.columnFeaturesMap.backlog).toHaveLength(0);
    });
  });
});
