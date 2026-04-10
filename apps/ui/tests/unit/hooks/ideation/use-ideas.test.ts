/**
 * Unit tests for useIdeas hook
 *
 * Tests:
 *  - listIdeas is called with correct projectPath
 *  - createIdea mutation calls createIdea API
 *  - updateIdea applies optimistic update immediately (D-4 / FC-3)
 *  - updateIdea rolls back cache on error (snap-back)
 *  - deleteIdea mutation calls deleteIdea API
 *  - query is disabled when projectPath is empty
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useIdeas } from '../../../../src/components/views/ideation-view/hooks/use-ideas';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockIdeationAPI = {
  listIdeas: vi.fn(),
  createIdea: vi.fn(),
  updateIdea: vi.fn(),
  deleteIdea: vi.fn(),
  convertToFeature: vi.fn(),
};

vi.mock('@/lib/electron', () => ({
  getElectronAPI: () => ({ ideation: mockIdeationAPI }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_PROJECT = '/test/project';

const makeIdea = (id: string, status = 'raw') => ({
  id,
  title: `Idea ${id}`,
  description: '',
  category: 'feature',
  status,
  impact: 'medium',
  effort: 'medium',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, queryClient };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useIdeas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('query', () => {
    it('calls listIdeas with the correct projectPath', async () => {
      mockIdeationAPI.listIdeas.mockResolvedValue({ success: true, ideas: [] });
      const { wrapper } = createWrapper();

      renderHook(() => useIdeas(TEST_PROJECT), { wrapper });

      await waitFor(() => {
        expect(mockIdeationAPI.listIdeas).toHaveBeenCalledWith(TEST_PROJECT);
      });
    });

    it('returns ideas from the API', async () => {
      const ideas = [makeIdea('idea-1'), makeIdea('idea-2')];
      mockIdeationAPI.listIdeas.mockResolvedValue({ success: true, ideas });
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useIdeas(TEST_PROJECT), { wrapper });

      await waitFor(() => expect(result.current.ideas).toHaveLength(2));
      expect(result.current.ideas[0].id).toBe('idea-1');
    });

    it('does NOT call listIdeas when projectPath is empty (query disabled)', () => {
      mockIdeationAPI.listIdeas.mockResolvedValue({ success: true, ideas: [] });
      const { wrapper } = createWrapper();

      renderHook(() => useIdeas(''), { wrapper });

      expect(mockIdeationAPI.listIdeas).not.toHaveBeenCalled();
    });
  });

  describe('createIdea', () => {
    it('calls createIdea API with the correct input', async () => {
      const created = makeIdea('new-1');
      mockIdeationAPI.listIdeas.mockResolvedValue({ success: true, ideas: [] });
      mockIdeationAPI.createIdea.mockResolvedValue({ success: true, idea: created });
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useIdeas(TEST_PROJECT), { wrapper });

      await act(async () => {
        await result.current.createIdea.mutateAsync({ title: 'Quick idea' });
      });

      expect(mockIdeationAPI.createIdea).toHaveBeenCalledWith(TEST_PROJECT, {
        title: 'Quick idea',
      });
    });

    it('throws when the API returns success: false', async () => {
      mockIdeationAPI.listIdeas.mockResolvedValue({ success: true, ideas: [] });
      mockIdeationAPI.createIdea.mockResolvedValue({ success: false, error: 'Disk full' });
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useIdeas(TEST_PROJECT), { wrapper });

      await expect(
        act(async () => {
          await result.current.createIdea.mutateAsync({ title: 'Quick idea' });
        })
      ).rejects.toThrow('Disk full');
    });
  });

  describe('updateIdea — optimistic updates (D-4 / FC-3)', () => {
    it('optimistically updates the cache before the API responds', async () => {
      const ideas = [makeIdea('idea-1', 'raw'), makeIdea('idea-2', 'raw')];
      mockIdeationAPI.listIdeas.mockResolvedValue({ success: true, ideas });
      // Make the API hang so we can inspect the optimistic state
      let resolveUpdate: (val: unknown) => void;
      mockIdeationAPI.updateIdea.mockReturnValue(
        new Promise((res) => {
          resolveUpdate = res;
        })
      );

      const { wrapper, queryClient } = createWrapper();
      const { result } = renderHook(() => useIdeas(TEST_PROJECT), { wrapper });

      // Wait for initial data load
      await waitFor(() => expect(result.current.ideas).toHaveLength(2));

      // Trigger mutation (don't await — it's hanging)
      act(() => {
        result.current.updateIdea.mutate({ ideaId: 'idea-1', updates: { status: 'refined' } });
      });

      // Cache should be updated immediately (optimistic)
      await waitFor(() => {
        const cached = queryClient.getQueryData<{ id: string; status: string }[]>([
          'ideation',
          'ideas',
          TEST_PROJECT,
        ]);
        expect(cached?.find((i) => i.id === 'idea-1')?.status).toBe('refined');
      });

      // Resolve the hanging API call
      resolveUpdate!({ success: true, idea: { ...ideas[0], status: 'refined' } });
    });

    it('rolls back cache to original value when API fails (snap-back)', async () => {
      const ideas = [makeIdea('idea-1', 'raw')];
      mockIdeationAPI.listIdeas.mockResolvedValue({ success: true, ideas });
      mockIdeationAPI.updateIdea.mockResolvedValue({ success: false, error: 'Network error' });

      const { wrapper, queryClient } = createWrapper();
      const { result } = renderHook(() => useIdeas(TEST_PROJECT), { wrapper });

      await waitFor(() => expect(result.current.ideas).toHaveLength(1));

      // Attempt to move to 'refined' — this will fail
      await act(async () => {
        result.current.updateIdea.mutate({ ideaId: 'idea-1', updates: { status: 'refined' } });
      });

      // After failure, cache should have rolled back to 'raw'
      await waitFor(() => {
        const cached = queryClient.getQueryData<{ id: string; status: string }[]>([
          'ideation',
          'ideas',
          TEST_PROJECT,
        ]);
        expect(cached?.find((i) => i.id === 'idea-1')?.status).toBe('raw');
      });
    });
  });

  describe('deleteIdea', () => {
    it('calls deleteIdea API with the correct ideaId', async () => {
      mockIdeationAPI.listIdeas.mockResolvedValue({ success: true, ideas: [] });
      mockIdeationAPI.deleteIdea.mockResolvedValue({ success: true });
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useIdeas(TEST_PROJECT), { wrapper });

      await act(async () => {
        await result.current.deleteIdea.mutateAsync('idea-1');
      });

      expect(mockIdeationAPI.deleteIdea).toHaveBeenCalledWith(TEST_PROJECT, 'idea-1');
    });
  });
});
