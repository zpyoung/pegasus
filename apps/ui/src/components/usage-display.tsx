/**
 * UsageDisplay component
 *
 * Renders provider usage statistics from a completed agent turn:
 * token counts, cache hit rate, total cost, duration, and turn count.
 *
 * Accepts a ProviderUsageInfo object (or undefined) as props and renders
 * nothing when no data is available. This component is intentionally
 * stateless — all values come from props.
 */

import type { ProviderUsageInfo } from "@pegasus/types";
import { cn } from "@/lib/utils";

export interface UsageDisplayProps {
  usage: ProviderUsageInfo | undefined | null;
  className?: string;
}

/**
 * Format a token count with K/M suffixes for readability.
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

/**
 * Format a cost in USD, showing more decimal places for small amounts.
 */
function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.001) return `$${usd.toFixed(6)}`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Format duration in milliseconds as a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const secs = ms / 1_000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remainingSecs = Math.round(secs % 60);
  return `${mins}m ${remainingSecs}s`;
}

/**
 * Calculate cache hit rate as a percentage.
 * cacheHitRate = cacheReadTokens / (inputTokens + cacheReadTokens) * 100
 */
function calcCacheHitRate(
  inputTokens: number,
  cacheReadTokens: number,
): number {
  const total = inputTokens + cacheReadTokens;
  if (total === 0) return 0;
  return (cacheReadTokens / total) * 100;
}

interface StatRowProps {
  label: string;
  value: string;
  className?: string;
}

function StatRow({ label, value, className }: StatRowProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 text-xs",
        className,
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Displays a summary of provider usage info from a completed agent turn.
 * Renders nothing when `usage` is undefined or null.
 */
export function UsageDisplay({ usage, className }: UsageDisplayProps) {
  if (!usage) return null;

  const {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalCostUsd,
    durationMs,
    numTurns,
  } = usage;

  const hasAnyData =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    cacheReadTokens !== undefined ||
    cacheCreationTokens !== undefined ||
    totalCostUsd !== undefined ||
    durationMs !== undefined ||
    numTurns !== undefined;

  if (!hasAnyData) return null;

  const cacheHitRate =
    inputTokens !== undefined && cacheReadTokens !== undefined
      ? calcCacheHitRate(inputTokens, cacheReadTokens)
      : undefined;

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1",
        className,
      )}
      data-testid="usage-display"
    >
      {inputTokens !== undefined && (
        <StatRow label="Input tokens" value={formatTokens(inputTokens)} />
      )}
      {outputTokens !== undefined && (
        <StatRow label="Output tokens" value={formatTokens(outputTokens)} />
      )}
      {cacheReadTokens !== undefined && (
        <StatRow
          label="Cache read tokens"
          value={formatTokens(cacheReadTokens)}
        />
      )}
      {cacheCreationTokens !== undefined && (
        <StatRow
          label="Cache creation tokens"
          value={formatTokens(cacheCreationTokens)}
        />
      )}
      {cacheHitRate !== undefined && (
        <StatRow label="Cache hit rate" value={`${cacheHitRate.toFixed(1)}%`} />
      )}
      {totalCostUsd !== undefined && (
        <StatRow label="Total cost" value={formatCost(totalCostUsd)} />
      )}
      {durationMs !== undefined && (
        <StatRow label="Duration" value={formatDuration(durationMs)} />
      )}
      {numTurns !== undefined && (
        <StatRow label="Turns" value={numTurns.toString()} />
      )}
    </div>
  );
}
