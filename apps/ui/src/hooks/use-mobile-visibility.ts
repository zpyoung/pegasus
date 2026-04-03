/**
 * Mobile Visibility Hook
 *
 * Manages React Query's online/focus state based on page visibility
 * to prevent unnecessary refetching when the mobile app is backgrounded.
 *
 * On mobile devices, switching to another app triggers:
 * 1. visibilitychange → hidden (app goes to background)
 * 2. visibilitychange → visible (app comes back)
 *
 * Without this hook, step 2 triggers refetchOnWindowFocus for ALL active queries,
 * causing a "storm" of network requests that overwhelms the connection and causes
 * blank screens, layout shifts, and perceived reloads.
 *
 * This hook:
 * - Pauses polling intervals while the app is hidden on mobile
 * - Delays query refetching by a short grace period when the app becomes visible again
 * - Prevents the WebSocket reconnection from triggering immediate refetches
 *
 * Desktop behavior is unchanged - this hook is a no-op on non-mobile devices.
 */

import { useEffect } from 'react';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { isMobileDevice } from '@/lib/mobile-detect';
import { queryClient } from '@/lib/query-client';

/**
 * Grace period (ms) after the app becomes visible before allowing refetches.
 * This prevents a burst of refetches when the user quickly switches back to the app.
 * During this time, queries will use their cached data (which may be slightly stale
 * but is far better than showing a blank screen or loading spinner).
 */
const VISIBILITY_GRACE_PERIOD = 1500;

/**
 * Hook to manage query behavior based on mobile page visibility.
 *
 * Call this once at the app root level (e.g., in App.tsx or __root.tsx).
 *
 * @example
 * ```tsx
 * function App() {
 *   useMobileVisibility();
 *   return <RouterProvider router={router} />;
 * }
 * ```
 */
export function useMobileVisibility(): void {
  useEffect(() => {
    // No-op on desktop - default React Query behavior is fine
    if (!isMobileDevice) return;

    let graceTimeout: ReturnType<typeof setTimeout> | null = null;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        // App went to background - tell React Query we've lost focus
        // This prevents any scheduled refetches from firing while backgrounded
        focusManager.setFocused(false);
      } else {
        // App came back to foreground
        // Wait a grace period before signaling focus to prevent refetch storms.
        // During this time, the UI renders with cached data (no blank screen).
        if (graceTimeout) clearTimeout(graceTimeout);
        graceTimeout = setTimeout(() => {
          focusManager.setFocused(true);
          graceTimeout = null;
        }, VISIBILITY_GRACE_PERIOD);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (graceTimeout) clearTimeout(graceTimeout);
      // Restore default focus management
      focusManager.setFocused(undefined);
    };
  }, []);
}

/**
 * Hook to pause online status during extended background periods on mobile.
 * When the app has been in the background for more than the threshold,
 * we mark it as "offline" to prevent React Query from refetching all queries
 * at once when it comes back online. Instead, we let the WebSocket reconnect
 * first and then gradually re-enable queries.
 *
 * Call this once at the app root level alongside useMobileVisibility.
 */
export function useMobileOnlineManager(): void {
  useEffect(() => {
    if (!isMobileDevice) return;

    let backgroundTimestamp: number | null = null;
    // If the app was backgrounded for more than 30 seconds, throttle reconnection
    const BACKGROUND_THRESHOLD = 30 * 1000;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        backgroundTimestamp = Date.now();
      } else if (backgroundTimestamp) {
        const backgroundDuration = Date.now() - backgroundTimestamp;
        backgroundTimestamp = null;

        if (backgroundDuration > BACKGROUND_THRESHOLD) {
          // App was backgrounded for a long time.
          // Briefly mark as offline to prevent all queries from refetching at once,
          // then restore online status after a delay so queries refetch gradually.
          //
          // IMPORTANT: When online is restored, invalidate all stale queries.
          // This fixes a race condition where WebSocket reconnects immediately
          // and fires invalidations during the offline window — those invalidations
          // are silently dropped by React Query because it thinks we're offline.
          // By invalidating stale queries after going online, we catch any updates
          // that were missed during the offline grace period.
          onlineManager.setOnline(false);
          setTimeout(() => {
            onlineManager.setOnline(true);
            // Re-invalidate all stale queries to catch any WebSocket events
            // that were dropped during the offline grace period
            queryClient.invalidateQueries({ stale: true });
          }, 2000);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // Restore online status on cleanup
      onlineManager.setOnline(true);
    };
  }, []);
}
