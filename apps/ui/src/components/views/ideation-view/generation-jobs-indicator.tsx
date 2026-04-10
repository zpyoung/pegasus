import { useIdeationStore } from '@/store/ideation-store';
import { useAppStore } from '@/store/app-store';
import { Spinner } from '@/components/ui/spinner';

export function GenerationJobsIndicator() {
  const projectPath = useAppStore((s) => s.currentProject?.path ?? '');
  const generationJobs = useIdeationStore((s) => s.generationJobs);

  const activeCount = generationJobs.filter(
    (j) => j.projectPath === projectPath && j.status === 'generating'
  ).length;

  if (activeCount === 0) return null;

  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Spinner size="xs" variant="muted" />
      <span>
        Generating {activeCount}
        {activeCount !== 1 ? ' ideas' : ' idea'}…
      </span>
    </div>
  );
}
