/**
 * Unit tests for useConvertIdea hook
 *
 * Tests:
 *  - convert() calls convertToFeature with correct args
 *  - retry: 0 — mutation does NOT retry on failure
 *  - On success: invalidates ideas + features query keys; calls toast.success
 *  - On error: calls toast.error with error message
 *  - isConverting reflects pending state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useConvertIdea } from '../../../../src/components/views/ideation-view/hooks/use-convert-idea';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockIdeationAPI = {
  convertToFeature: vi.fn(),
};

vi.mock('@/lib/electron', () => ({
  getElectronAPI: () => ({ ideation: mockIdeationAPI }),
}));

const mockToast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: mockToast }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_PROJECT = '/test/project';
const TEST_IDEA_ID = 'idea-ready';

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

describe('useConvertIdea', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls convertToFeature with correct projectPath and ideaId', async () => {
    mockIdeationAPI.convertToFeature.mockResolvedValue({ success: true, featureId: 'f-1' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useConvertIdea(TEST_PROJECT), { wrapper });

    await act(async () => {
      result.current.convert(TEST_IDEA_ID);
    });

    await waitFor(() =>
      expect(mockIdeationAPI.convertToFeature).toHaveBeenCalledWith(
        TEST_PROJECT,
        TEST_IDEA_ID,
        undefined
      )
    );
  });

  it('passes ConvertToFeatureOptions when provided', async () => {
    mockIdeationAPI.convertToFeature.mockResolvedValue({ success: true, featureId: 'f-1' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useConvertIdea(TEST_PROJECT), { wrapper });

    const options = { column: 'backlog' as const, keepIdea: true, tags: ['mvp'] };

    await act(async () => {
      result.current.convert(TEST_IDEA_ID, options);
    });

    await waitFor(() =>
      expect(mockIdeationAPI.convertToFeature).toHaveBeenCalledWith(
        TEST_PROJECT,
        TEST_IDEA_ID,
        options
      )
    );
  });

  it('calls toast.success on successful conversion', async () => {
    mockIdeationAPI.convertToFeature.mockResolvedValue({ success: true, featureId: 'f-1' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useConvertIdea(TEST_PROJECT), { wrapper });

    await act(async () => {
      result.current.convert(TEST_IDEA_ID);
    });

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Idea promoted to feature'));
  });

  it('calls toast.error with message when conversion fails', async () => {
    mockIdeationAPI.convertToFeature.mockResolvedValue({
      success: false,
      error: "Cannot convert idea: status must be 'ready', got 'raw'",
    });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useConvertIdea(TEST_PROJECT), { wrapper });

    act(() => {
      result.current.convert(TEST_IDEA_ID);
    });

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Failed to promote idea',
        expect.objectContaining({ description: expect.stringContaining("status must be 'ready'") })
      )
    );
  });

  it('invalidates ideas and features query keys on success', async () => {
    mockIdeationAPI.convertToFeature.mockResolvedValue({ success: true, featureId: 'f-1' });
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useConvertIdea(TEST_PROJECT), { wrapper });

    await act(async () => {
      result.current.convert(TEST_IDEA_ID);
    });

    await waitFor(() => {
      const calls = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]));
      const hasIdeasKey = calls.some((c) => c.includes('ideation') && c.includes('ideas'));
      const hasFeaturesKey = calls.some((c) => c.includes('features'));
      expect(hasIdeasKey).toBe(true);
      expect(hasFeaturesKey).toBe(true);
    });
  });

  it('has retry: 0 — does not retry on network failure', async () => {
    // The retry: 0 is set on useMutation. We verify it by confirming
    // that after a rejection the API is called exactly once.
    mockIdeationAPI.convertToFeature.mockRejectedValue(new Error('Network timeout'));
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useConvertIdea(TEST_PROJECT), { wrapper });

    act(() => {
      result.current.convert(TEST_IDEA_ID);
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());

    // Should have been called exactly once (no retries)
    expect(mockIdeationAPI.convertToFeature).toHaveBeenCalledTimes(1);
  });

  it('exposes isConverting=true while mutation is pending', async () => {
    let resolveConvert!: (val: unknown) => void;
    mockIdeationAPI.convertToFeature.mockReturnValue(
      new Promise((res) => {
        resolveConvert = res;
      })
    );
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useConvertIdea(TEST_PROJECT), { wrapper });

    act(() => {
      result.current.convert(TEST_IDEA_ID);
    });

    await waitFor(() => expect(result.current.isConverting).toBe(true));

    // Resolve to clean up
    resolveConvert({ success: true, featureId: 'f-1' });
  });
});
