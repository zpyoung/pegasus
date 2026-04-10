/**
 * useConvertIdea — React Query mutation for promoting a ready idea to a Feature
 *
 * retry: 0 to avoid creating duplicate features on transient failures.
 * Shows toasts on success/error.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getElectronAPI } from '@/lib/electron';
import { queryKeys } from '@/lib/query-keys';
import { toast } from 'sonner';
import type { ConvertToFeatureOptions } from '@pegasus/types';

interface ConvertInput {
  ideaId: string;
  options?: ConvertToFeatureOptions;
}

export function useConvertIdea(projectPath: string) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async ({ ideaId, options }: ConvertInput) => {
      const api = getElectronAPI();
      if (!api.ideation?.convertToFeature) throw new Error('Ideation API not available');
      const result = await api.ideation.convertToFeature(projectPath, ideaId, options);
      if (!result.success) throw new Error(result.error || 'Failed to convert idea to feature');
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.ideation.ideas(projectPath) });
      queryClient.invalidateQueries({ queryKey: queryKeys.features.all(projectPath) });
      toast.success('Idea promoted to feature');
    },
    onError: (error: Error) => {
      toast.error('Failed to promote idea', { description: error.message });
    },
    retry: 0,
  });

  return {
    convert: (ideaId: string, options?: ConvertToFeatureOptions) =>
      mutation.mutate({ ideaId, options }),
    isConverting: mutation.isPending,
    error: mutation.error,
  };
}
