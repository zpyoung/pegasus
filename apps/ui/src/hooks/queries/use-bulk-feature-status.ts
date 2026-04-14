/**
 * Bulk Feature Status Hook
 *
 * Replaces per-card `useFeature()` polling with a single shared query that
 * returns lightweight `{id, status, title}` for all features in a project.
 *
 * With 40+ kanban cards, each previously firing `useFeature` + `useAgentOutput`
 * every 3-10s, this reduces from 80+ concurrent polling queries to 1 query
 * polling every 5s. React Query deduplicates calls across all card instances.
 */

import { useQuery } from "@tanstack/react-query";
import { getElectronAPI } from "@/lib/electron";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/query-client";
import { createSmartPollingInterval } from "@/hooks/use-event-recency";

/** Bulk polling interval — frequent enough to catch status changes quickly */
const BULK_STATUS_POLLING_INTERVAL = 5000;

export interface BulkFeatureStatusEntry {
  id: string;
  status?: string;
  title?: string;
}

/**
 * Fetch lightweight status+title for all features in a project.
 *
 * This hook is designed to be called from every `AgentInfoPanel` instance.
 * React Query deduplicates the query — only one HTTP request fires regardless
 * of how many panels are mounted.
 *
 * @param projectPath - Path to the project
 */
export function useBulkFeatureStatus(projectPath: string | undefined) {
  return useQuery({
    queryKey: queryKeys.features.bulkStatus(projectPath ?? ""),
    queryFn: async (): Promise<BulkFeatureStatusEntry[]> => {
      if (!projectPath) throw new Error("No project path");
      const api = getElectronAPI();
      const result = await api.features?.getBulkStatus(projectPath);
      if (!result?.success) {
        throw new Error(result?.error || "Failed to fetch bulk status");
      }
      return result.statuses ?? [];
    },
    enabled: !!projectPath,
    staleTime: STALE_TIMES.FEATURES,
    refetchInterval: createSmartPollingInterval(BULK_STATUS_POLLING_INTERVAL),
  });
}
