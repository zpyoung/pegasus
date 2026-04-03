/**
 * Dialog shown when a branch switch or stash-pop operation results in merge conflicts.
 * Presents the user with two options:
 * 1. Resolve Manually - leaves conflict markers in place
 * 2. Resolve with AI - creates a feature task for AI-powered conflict resolution
 *
 * This dialog ensures the user can choose how to handle the conflict instead of
 * automatically creating and starting an AI task.
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
import { AlertTriangle, Wrench, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { BranchSwitchConflictInfo, StashPopConflictInfo } from '../worktree-panel/types';

export type BranchConflictType = 'branch-switch' | 'stash-pop';

export type BranchConflictData =
  | { type: 'branch-switch'; info: BranchSwitchConflictInfo }
  | { type: 'stash-pop'; info: StashPopConflictInfo };

interface BranchConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conflictData: BranchConflictData | null;
  onResolveWithAI?: (conflictData: BranchConflictData) => void;
}

export function BranchConflictDialog({
  open,
  onOpenChange,
  conflictData,
  onResolveWithAI,
}: BranchConflictDialogProps) {
  const handleResolveManually = useCallback(() => {
    toast.info('Conflict markers left in place', {
      description: 'Edit the conflicting files to resolve conflicts manually.',
      duration: 6000,
    });
    onOpenChange(false);
  }, [onOpenChange]);

  const handleResolveWithAI = useCallback(() => {
    if (!conflictData || !onResolveWithAI) return;

    onResolveWithAI(conflictData);
    onOpenChange(false);
  }, [conflictData, onResolveWithAI, onOpenChange]);

  if (!conflictData) return null;

  const isBranchSwitch = conflictData.type === 'branch-switch';
  const branchName = isBranchSwitch ? conflictData.info.branchName : conflictData.info.branchName;

  const description = isBranchSwitch ? (
    <>
      Merge conflicts occurred when switching from{' '}
      <code className="font-mono bg-muted px-1 rounded">
        {(conflictData.info as BranchSwitchConflictInfo).previousBranch}
      </code>{' '}
      to <code className="font-mono bg-muted px-1 rounded">{branchName}</code>. Local changes were
      stashed before switching and reapplying them caused conflicts.
    </>
  ) : (
    <>
      The branch switch to <code className="font-mono bg-muted px-1 rounded">{branchName}</code>{' '}
      failed and restoring the previously stashed local changes resulted in merge conflicts.
    </>
  );

  const title = isBranchSwitch
    ? 'Branch Switch Conflicts Detected'
    : 'Stash Restore Conflicts Detected';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-orange-500" />
            {title}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3">
              <span className="block">{description}</span>

              {!isBranchSwitch &&
                (conflictData.info as StashPopConflictInfo).stashPopConflictMessage && (
                  <div className="flex items-start gap-2 p-3 rounded-md bg-orange-500/10 border border-orange-500/20">
                    <AlertTriangle className="w-4 h-4 text-orange-500 mt-0.5 flex-shrink-0" />
                    <span className="text-orange-500 text-sm">
                      {(conflictData.info as StashPopConflictInfo).stashPopConflictMessage}
                    </span>
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
