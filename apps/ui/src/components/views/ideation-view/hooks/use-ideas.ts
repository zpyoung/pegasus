/**
 * useIdeas — React Query hook for idea CRUD operations
 *
 * Wraps the existing HTTP/Electron API client with React Query caching.
 * Refetches on focus and on mutation success.
 *
 * updateIdea uses optimistic updates so drag-drop columns snap back
 * immediately on failure (FC-3 / D-4).
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getElectronAPI } from '@/lib/electron';
import { queryKeys } from '@/lib/query-keys';
import { STALE_TIMES } from '@/lib/query-client';
import type { CreateIdeaInput, Idea, UpdateIdeaInput } from '@pegasus/types';

export function useIdeas(projectPath: string) {
  const queryClient = useQueryClient();
  const ideasKey = queryKeys.ideation.ideas(projectPath);

  const query = useQuery({
    queryKey: ideasKey,
    queryFn: async () => {
      const api = getElectronAPI();
      if (!api.ideation?.listIdeas) throw new Error('Ideation API not available');
      const result = await api.ideation.listIdeas(projectPath);
      if (!result.success) throw new Error(result.error || 'Failed to fetch ideas');
      return result.ideas ?? [];
    },
    enabled: !!projectPath,
    staleTime: STALE_TIMES.FEATURES,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ideasKey });

  const createIdea = useMutation({
    mutationFn: async (input: CreateIdeaInput) => {
      const api = getElectronAPI();
      if (!api.ideation?.createIdea) throw new Error('Ideation API not available');
      const result = await api.ideation.createIdea(projectPath, input);
      if (!result.success) throw new Error(result.error || 'Failed to create idea');
      return result.idea!;
    },
    onSuccess: invalidate,
    retry: false,
  });

  const updateIdea = useMutation({
    mutationFn: async ({ ideaId, updates }: { ideaId: string; updates: UpdateIdeaInput }) => {
      const api = getElectronAPI();
      if (!api.ideation?.updateIdea) throw new Error('Ideation API not available');
      const result = await api.ideation.updateIdea(projectPath, ideaId, updates);
      if (!result.success) throw new Error(result.error || 'Failed to update idea');
      return result.idea!;
    },
    // Optimistic update: apply change immediately so drag-drop is instant (FC-3)
    onMutate: async ({ ideaId, updates }) => {
      await queryClient.cancelQueries({ queryKey: ideasKey });
      const previous = queryClient.getQueryData<Idea[]>(ideasKey);
      queryClient.setQueryData<Idea[]>(ideasKey, (old) =>
        (old ?? []).map((idea) => (idea.id === ideaId ? { ...idea, ...updates } : idea))
      );
      return { previous };
    },
    // Rollback to previous value on error (snap-back)
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(ideasKey, context.previous);
      }
    },
    onSuccess: invalidate,
    retry: false,
  });

  const deleteIdea = useMutation({
    mutationFn: async (ideaId: string) => {
      const api = getElectronAPI();
      if (!api.ideation?.deleteIdea) throw new Error('Ideation API not available');
      const result = await api.ideation.deleteIdea(projectPath, ideaId);
      if (!result.success) throw new Error(result.error || 'Failed to delete idea');
    },
    onSuccess: invalidate,
    retry: false,
  });

  return {
    ideas: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    createIdea,
    updateIdea,
    deleteIdea,
  };
}
