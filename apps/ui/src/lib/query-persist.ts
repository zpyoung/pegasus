/**
 * React Query Cache Persistence
 *
 * Persists the React Query cache to IndexedDB so that after a tab discard
 * or page reload, the user sees cached data instantly while fresh data
 * loads in the background.
 *
 * Uses @tanstack/react-query-persist-client with idb-keyval for IndexedDB storage.
 * Cached data is treated as stale on restore and silently refetched.
 */

import { get, set, del } from "idb-keyval";
import type {
  PersistedClient,
  Persister,
} from "@tanstack/react-query-persist-client";
import { createLogger } from "@pegasus/utils/logger";

const logger = createLogger("QueryPersist");

const IDB_KEY = "pegasus-react-query-cache";

/**
 * Maximum age of persisted cache before it's discarded (24 hours).
 * After this time, the cache is considered too old and will be removed.
 */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Throttle time for persisting cache to IndexedDB.
 * Prevents excessive writes during rapid query updates.
 */
export const PERSIST_THROTTLE_MS = 2000;

/**
 * Query key prefixes that should NOT be persisted.
 * Auth-related and volatile data should always be fetched fresh.
 */
const EXCLUDED_QUERY_KEY_PREFIXES = ["auth", "health", "wsToken", "sandbox"];

/**
 * Check if a query key should be excluded from persistence
 */
function shouldExcludeQuery(queryKey: readonly unknown[]): boolean {
  if (queryKey.length === 0) return false;
  const firstKey = String(queryKey[0]);
  return EXCLUDED_QUERY_KEY_PREFIXES.some((prefix) =>
    firstKey.startsWith(prefix),
  );
}

/**
 * Check whether there is a recent enough React Query cache in IndexedDB
 * to consider the app "warm" (i.e., safe to skip blocking on the server
 * health check and show the UI immediately).
 *
 * Returns true only if:
 * 1. The cache exists and is recent (within maxAgeMs)
 * 2. The cache buster matches the current build hash
 *
 * If the buster doesn't match, PersistQueryClientProvider will wipe the
 * cache on restore — so we must NOT skip the server wait in that case,
 * otherwise the board renders with empty queries and no data.
 *
 * This is a read-only probe — it does not restore the cache (that is
 * handled by PersistQueryClientProvider automatically).
 */
export async function hasWarmIDBCache(
  currentBuster: string,
  maxAgeMs = PERSIST_MAX_AGE_MS,
): Promise<boolean> {
  try {
    const client = await get<PersistedClient>(IDB_KEY);
    if (!client) return false;
    // PersistedClient stores a `timestamp` (ms) when it was last persisted
    const age = Date.now() - (client.timestamp ?? 0);
    if (age >= maxAgeMs) return false;
    // If the buster doesn't match, PersistQueryClientProvider will wipe the cache.
    // Treat this as a cold start — we need fresh data from the server.
    if (currentBuster && client.buster !== currentBuster) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an IndexedDB-based persister for React Query.
 *
 * This persister:
 * - Stores the full query cache in IndexedDB under a single key
 * - Filters out auth/health queries that shouldn't be persisted
 * - Handles errors gracefully (cache persistence is best-effort)
 */
export function createIDBPersister(): Persister {
  return {
    persistClient: async (client: PersistedClient) => {
      try {
        // Filter out excluded queries before persisting
        const filteredClient: PersistedClient = {
          ...client,
          clientState: {
            ...client.clientState,
            queries: client.clientState.queries.filter(
              (query) => !shouldExcludeQuery(query.queryKey),
            ),
            // Don't persist mutations (they should be re-triggered, not replayed)
            mutations: [],
          },
        };
        await set(IDB_KEY, filteredClient);
      } catch (error) {
        logger.warn("Failed to persist query cache to IndexedDB:", error);
      }
    },

    restoreClient: async () => {
      try {
        const client = await get<PersistedClient>(IDB_KEY);
        if (client) {
          logger.info("Restored React Query cache from IndexedDB");
        }
        return client ?? undefined;
      } catch (error) {
        logger.warn("Failed to restore query cache from IndexedDB:", error);
        return undefined;
      }
    },

    removeClient: async () => {
      try {
        await del(IDB_KEY);
      } catch (error) {
        logger.warn("Failed to remove query cache from IndexedDB:", error);
      }
    },
  };
}
