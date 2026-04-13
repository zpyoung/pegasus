import { useQuery } from '@tanstack/react-query';
import { getHttpApiClient } from '@/lib/http-api-client';
import { queryKeys } from '@/lib/query-keys';
import { STALE_TIMES } from '@/lib/query-client';

export interface RuntimeInstanceInfo {
  bannerVersion: string;
  bannerBranch: string;
  runtimeChannel: 'development' | 'packaged';
  isPackagedRelease: boolean;
}

export function useRuntimeInstance() {
  return useQuery({
    queryKey: queryKeys.runtime.instance(),
    queryFn: async (): Promise<RuntimeInstanceInfo | null> => {
      const api = getHttpApiClient();
      const result = await api.getRuntimeInstance();
      return result.runtime ?? null;
    },
    staleTime: STALE_TIMES.SETTINGS,
    retry: 1,
  });
}
