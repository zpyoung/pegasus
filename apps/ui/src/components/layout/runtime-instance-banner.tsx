import { GitBranch, Sparkles } from 'lucide-react';
import { useRuntimeInstance } from '@/hooks/queries';

const HIDDEN_BRANCHES = new Set(['main', 'master', 'release', 'unknown']);

function shouldHideBanner(branch: string, isPackagedRelease: boolean): boolean {
  if (isPackagedRelease) {
    return true;
  }

  return HIDDEN_BRANCHES.has(branch.trim().toLowerCase());
}

export function RuntimeInstanceBanner() {
  const { data } = useRuntimeInstance();

  if (!data || shouldHideBanner(data.bannerBranch, data.isPackagedRelease)) {
    return null;
  }

  return (
    <div
      className="border-b border-emerald-700 bg-gradient-to-r from-emerald-800 via-teal-800 to-green-800 px-4 py-1.5"
      data-testid="runtime-instance-banner"
    >
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm">
        <span className="inline-flex items-center gap-2 font-medium text-emerald-50">
          <Sparkles className="h-4 w-4 text-emerald-300" />
          Non-main Pegasus instance
        </span>
        <span className="inline-flex items-center gap-1.5 text-emerald-50">
          <GitBranch className="h-3.5 w-3.5 text-emerald-200" />
          <span className="font-mono text-xs sm:text-sm">{data.bannerBranch}</span>
        </span>
        <span className="text-emerald-100">v{data.bannerVersion}</span>
      </div>
    </div>
  );
}
