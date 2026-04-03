/**
 * Dialog shown when a stash apply/pop operation results in merge conflicts.
 * Presents the user with two options:
 * 1. Resolve Manually - leaves conflict markers in place
 * 2. Resolve with AI - creates a feature task for AI-powered conflict resolution
 */

import { useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, XCircle, Wrench, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { StashApplyConflictInfo } from '../worktree-panel/types';

interface StashApplyConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conflictInfo: StashApplyConflictInfo | null;
  onResolveWithAI?: (conflictInfo: StashApplyConflictInfo) => void;
}

export function StashApplyConflictDialog({
  open,
  onOpenChange,
  conflictInfo,
  onResolveWithAI,
}: StashApplyConflictDialogProps) {
  const handleResolveManually = useCallback(() => {
    toast.info('Conflict markers left in place', {
      description: 'Edit the conflicting files to resolve conflicts manually.',
      duration: 6000,
    });
    onOpenChange(false);
  }, [onOpenChange]);

  const handleResolveWithAI = useCallback(() => {
    if (!conflictInfo || !onResolveWithAI) return;

    onResolveWithAI(conflictInfo);
    onOpenChange(false);
  }, [conflictInfo, onResolveWithAI, onOpenChange]);

  if (!conflictInfo) return null;

  const operationLabel = conflictInfo.operation === 'pop' ? 'popped' : 'applied';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-orange-500" />
            Merge Conflicts Detected
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3">
              <span className="block">
                Stash{' '}
                <code className="font-mono bg-muted px-1 rounded">{conflictInfo.stashRef}</code> was{' '}
                {operationLabel} on branch{' '}
                <code className="font-mono bg-muted px-1 rounded">{conflictInfo.branchName}</code>{' '}
                but resulted in merge conflicts.
              </span>

              {conflictInfo.conflictFiles.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium text-foreground">
                    Conflicting files ({conflictInfo.conflictFiles.length}):
                  </span>
                  <div className="border border-border rounded-lg overflow-hidden max-h-[200px] overflow-y-auto scrollbar-visible">
                    {conflictInfo.conflictFiles.map((file) => (
                      <div
                        key={file}
                        className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono border-b border-border last:border-b-0 hover:bg-accent/30"
                      >
                        <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                        <span className="truncate">{file}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-2 p-3 rounded-md bg-muted/50 border border-border">
                <p className="text-sm text-muted-foreground font-medium mb-2">
                  Choose how to resolve:
                </p>
                <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
                  <li>
                    <strong>Resolve with AI</strong> &mdash; Creates a task to analyze and resolve
                    conflicts automatically
                  </li>
                  <li>
                    <strong>Resolve Manually</strong> &mdash; Leaves conflict markers in place for
                    you to edit directly
                  </li>
                </ul>
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={handleResolveManually}>
            <Wrench className="w-4 h-4 mr-2" />
            Resolve Manually
          </Button>
          {onResolveWithAI && (
            <Button
              onClick={handleResolveWithAI}
              className="bg-purple-600 hover:bg-purple-700 text-white"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Resolve with AI
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
