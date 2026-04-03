import { Folder, LogOut } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { Project } from '@/lib/electron';

interface RemoveFromPegasusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
  onConfirm: (projectId: string) => void;
}

export function RemoveFromPegasusDialog({
  open,
  onOpenChange,
  project,
  onConfirm,
}: RemoveFromPegasusDialogProps) {
  const handleConfirm = () => {
    if (project) {
      onConfirm(project.id);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={handleConfirm}
      title="Remove from Pegasus"
      description="Remove this project from Pegasus? The folder will remain on disk and can be re-added later."
      icon={LogOut}
      iconClassName="text-muted-foreground"
      confirmText="Remove from Pegasus"
      confirmVariant="secondary"
    >
      {project && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-sidebar-accent/10 border border-sidebar-border">
          <div className="w-10 h-10 rounded-lg bg-sidebar-accent/20 border border-sidebar-border flex items-center justify-center shrink-0">
            <Folder className="w-5 h-5 text-brand-500" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-foreground truncate">{project.name}</p>
            <p className="text-xs text-muted-foreground truncate">{project.path}</p>
          </div>
        </div>
      )}
    </ConfirmDialog>
  );
}
