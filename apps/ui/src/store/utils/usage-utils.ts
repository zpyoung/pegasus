import type { ClaudeUsage } from '../types/usage-types';

/**
 * Calculate the expected weekly usage percentage based on how far through the week we are.
 * Claude's weekly usage resets every Thursday. Given the reset time (when the NEXT reset occurs),
 * we can determine how much of the week has elapsed and therefore what percentage of the budget
 * should have been used if usage were evenly distributed.
 *
 * @param weeklyResetTime - ISO date string for when the weekly usage next resets
 * @returns The expected usage percentage (0-100), or null if the reset time is invalid
 */
export function getExpectedWeeklyPacePercentage(
  weeklyResetTime: string | undefined
): number | null {
  if (!weeklyResetTime) return null;

  try {
    const resetDate = new Date(weeklyResetTime);
    if (isNaN(resetDate.getTime())) return null;

    const now = new Date();
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    // The week started 7 days before the reset
    const weekStartDate = new Date(resetDate.getTime() - WEEK_MS);

    // How far through the week are we?
    const elapsed = now.getTime() - weekStartDate.getTime();
    const fractionElapsed = elapsed / WEEK_MS;

    // Clamp to 0-1 range
    const clamped = Math.max(0, Math.min(1, fractionElapsed));

    return clamped * 100;
  } catch {
    return null;
  }
}

/**
 * Get a human-readable label for the pace status (ahead or behind expected usage).
 *
 * @param actualPercentage - The actual usage percentage (0-100)
 * @param expectedPercentage - The expected usage percentage (0-100)
 * @returns A string like "5% ahead of pace" or "10% behind pace", or null
 */
export function getPaceStatusLabel(
  actualPercentage: number,
  expectedPercentage: number | null
): string | null {
  if (expectedPercentage === null) return null;

  const diff = Math.round(actualPercentage - expectedPercentage);

  if (diff === 0) return 'On pace';
  // Using more than expected = behind pace (bad)
  if (diff > 0) return `${Math.abs(diff)}% behind pace`;
  // Using less than expected = ahead of pace (good)
  return `${Math.abs(diff)}% ahead of pace`;
}

/**
 * Calculate the expected pace percentage for a Codex rate limit window based on how far
 * through the window we are. This is a generic version of getExpectedWeeklyPacePercentage
 * that works with any window duration.
 *
 * Only returns a value for windows >= 1 day (1440 minutes) since pace tracking isn't
 * meaningful for short windows.
 *
 * @param resetsAt - Unix timestamp in seconds for when the window resets
 * @param windowDurationMins - Window duration in minutes
 * @returns The expected usage percentage (0-100), or null if not applicable
 */
export function getExpectedCodexPacePercentage(
  resetsAt: number | undefined | null,
  windowDurationMins: number | undefined | null
): number | null {
  // Only show pace for windows >= 1 day (1440 minutes)
  if (!resetsAt || !windowDurationMins || windowDurationMins < 1440) return null;

  try {
    const resetDate = new Date(resetsAt * 1000);
    if (isNaN(resetDate.getTime())) return null;

    const now = new Date();
    const windowMs = windowDurationMins * 60 * 1000;

    // The window started windowDurationMins before the reset
    const windowStartDate = new Date(resetDate.getTime() - windowMs);

    // How far through the window are we?
    const elapsed = now.getTime() - windowStartDate.getTime();
    const fractionElapsed = elapsed / windowMs;

    // Clamp to 0-1 range
    const clamped = Math.max(0, Math.min(1, fractionElapsed));

    return clamped * 100;
  } catch {
    return null;
  }
}

/**
 * Check if Claude usage is at its limit (any of: session >= 100%, weekly >= 100%, OR cost >= limit)
 * Returns true if any limit is reached, meaning auto mode should pause feature pickup.
 */
export function isClaudeUsageAtLimit(claudeUsage: ClaudeUsage | null): boolean {
  if (!claudeUsage) {
    // No usage data available - don't block
    return false;
  }

  // Check session limit (5-hour window)
  if (claudeUsage.sessionPercentage >= 100) {
    return true;
  }

  // Check weekly limit
  if (claudeUsage.weeklyPercentage >= 100) {
    return true;
  }

  // Check cost limit (if configured)
  if (
    claudeUsage.costLimit !== null &&
    claudeUsage.costLimit > 0 &&
    claudeUsage.costUsed !== null &&
    claudeUsage.costUsed >= claudeUsage.costLimit
  ) {
    return true;
  }

  return false;
}
