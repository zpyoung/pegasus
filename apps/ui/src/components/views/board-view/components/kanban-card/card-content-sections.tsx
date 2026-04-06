// @ts-nocheck - content section prop typing with feature data extraction
import { memo } from 'react';
import { Feature } from '@/store/app-store';
import { GitBranch, GitPullRequest, ExternalLink } from 'lucide-react';

/** Deterministic branch-to-hue mapping for per-branch badge coloring. */
function branchToHue(branch: string): number {
  let hash = 0;
  for (let i = 0; i < branch.length; i++) {
    hash = (hash * 31 + branch.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

interface CardContentSectionsProps {
  feature: Feature;
  useWorktrees: boolean;
  showAllWorktrees?: boolean;
  mainBranch?: string | null;
}

export const CardContentSections = memo(function CardContentSections({
  feature,
  useWorktrees,
  showAllWorktrees = false,
  mainBranch,
}: CardContentSectionsProps) {
  // In all-worktrees mode, show branch for every feature (normalizing null to mainBranch)
  const displayBranch = showAllWorktrees
    ? (feature.branchName ?? mainBranch ?? 'main')
    : feature.branchName;
  const showBranchBadge = useWorktrees && (showAllWorktrees ? true : !!feature.branchName);

  return (
    <>
      {/* Target Branch Display */}
      {showBranchBadge && (
        showAllWorktrees ? (
          // Pill badge with per-branch hash-to-hue coloring (all-worktrees mode)
          <div className="mb-2">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
              style={{
                backgroundColor: `hsl(${branchToHue(displayBranch ?? 'main')} 55% 20%)`,
                color: `hsl(${branchToHue(displayBranch ?? 'main')} 80% 75%)`,
              }}
              title={displayBranch}
              data-testid="branch-badge-pill"
            >
              <GitBranch className="w-2.5 h-2.5 shrink-0" />
              <span className="font-mono truncate max-w-[120px]">{displayBranch}</span>
            </span>
          </div>
        ) : (
          // Simple inline display for worktree-scoped mode (single worktree view)
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <GitBranch className="w-3 h-3 shrink-0" />
            <span className="font-mono truncate" title={displayBranch}>
              {displayBranch}
            </span>
          </div>
        )
      )}

      {/* PR URL Display */}
      {typeof feature.prUrl === 'string' &&
        /^https?:\/\//i.test(feature.prUrl) &&
        (() => {
          const prNumber = feature.prUrl.split('/').pop();
          return (
            <div className="mb-2">
              <a
                href={feature.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1.5 text-[11px] text-purple-500 hover:text-purple-400 transition-colors"
                title={feature.prUrl}
                data-testid={`pr-url-${feature.id}`}
              >
                <GitPullRequest className="w-3 h-3 shrink-0" />
                <span className="truncate max-w-[150px]">
                  {prNumber ? `Pull Request #${prNumber}` : 'Pull Request'}
                </span>
                <ExternalLink className="w-2.5 h-2.5 shrink-0" />
              </a>
            </div>
          );
        })()}
    </>
  );
});
