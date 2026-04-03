/**
 * Dialog shown when uncommitted changes are detected before a branch operation.
 * Presents the user with options to:
 * 1. Stash and proceed - stash changes, perform the operation, then restore
 * 2. Proceed without stashing - discard local changes and proceed
 * 3. Cancel - abort the operation
 *
 * Displays a summary of affected files (staged, unstaged, untracked) so the
 * user can make an informed decision.
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
import { AlertTriangle, Archive, XCircle, FileEdit, FilePlus, FileQuestion } from 'lucide-react';

export interface UncommittedChangesInfo {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  totalFiles: number;
}

export type StashConfirmAction = 'stash-and-proceed' | 'proceed-without-stash' | 'cancel';

interface StashConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The branch operation being attempted (e.g., "switch to feature/xyz" or "create feature/xyz") */
  operationDescription: string;
  /** Summary of uncommitted changes */
  changesInfo: UncommittedChangesInfo | null;
  /** Called with the user's decision */
  onConfirm: (action: StashConfirmAction) => void;
  /** Whether the operation is currently in progress */
  isLoading?: boolean;
}

export function StashConfirmDialog({
  open,
  onOpenChange,
  operationDescription,
  changesInfo,
  onConfirm,
  isLoading = false,
}: StashConfirmDialogProps) {
  const handleStashAndProceed = useCallback(() => {
    onConfirm('stash-and-proceed');
  }, [onConfirm]);

  const handleProceedWithoutStash = useCallback(() => {
    onConfirm('proceed-without-stash');
  }, [onConfirm]);

  const handleCancel = useCallback(() => {
    onConfirm('cancel');
    onOpenChange(false);
  }, [onConfirm, onOpenChange]);

  if (!changesInfo) return null;

  const { staged, unstaged, untracked } = changesInfo;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isLoading && onOpenChange(isOpen)}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            Uncommitted Changes Detected
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3">
              <span className="block">
                You have uncommitted changes that may be affected when you{' '}
                <strong>{operationDescription}</strong>.
              </span>

              {/* File summary */}
              <div className="space-y-2">
                {staged.length > 0 && (
                  <FileSection
                    icon={<FileEdit className="w-3.5 h-3.5 text-green-500" />}
                    label="Staged"
                    files={staged}
                  />
                )}
                {unstaged.length > 0 && (
                  <FileSection
                    icon={<XCircle className="w-3.5 h-3.5 text-orange-500" />}
                    label="Unstaged"
                    files={unstaged}
                  />
                )}
                {untracked.length > 0 && (
                  <FileSection
                    icon={<FilePlus className="w-3.5 h-3.5 text-blue-500" />}
                    label="Untracked"
                    files={untracked}
                  />
                )}
              </div>

              <div className="mt-2 p-3 rounded-md bg-muted/50 border border-border">
                <p className="text-sm text-muted-foreground font-medium mb-2">
                  Choose how to proceed:
                </p>
                <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
                  <li>
                    <strong>Stash & Proceed</strong> &mdash; Saves your changes, performs the
                    operation, then restores them
                  </li>
                  <li>
                    <strong>Proceed Without Stashing</strong> &mdash; Carries your uncommitted
                    changes into the new branch as-is
                  </li>
                </ul>
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={handleCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={handleProceedWithoutStash} disabled={isLoading}>
            <FileQuestion className="w-4 h-4 mr-2" />
            Proceed Without Stashing
          </Button>
          <Button onClick={handleStashAndProceed} disabled={isLoading}>
            <Archive className="w-4 h-4 mr-2" />
            Stash & Proceed
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Renders a collapsible section of files with a category label */
function FileSection({
  icon,
  label,
  files,
}: {
  icon: React.ReactNode;
  label: string;
  files: string[];
}) {
  const maxDisplay = 5;
  const displayFiles = files.slice(0, maxDisplay);
  const remaining = files.length - maxDisplay;

  return (
    <div className="space-y-1">
      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        {icon}
        {label} ({files.length})
      </span>
      <div className="border border-border rounded-lg overflow-hidden max-h-[120px] overflow-y-auto scrollbar-visible">
        {displayFiles.map((file) => (
          <div
            key={file}
            className="flex items-center px-3 py-1 text-xs font-mono border-b border-border last:border-b-0 hover:bg-accent/30"
          >
            <span className="truncate">{file}</span>
          </div>
        ))}
        {remaining > 0 && (
          <div className="px-3 py-1 text-xs text-muted-foreground border-b border-border last:border-b-0">
            ...and {remaining} more {remaining === 1 ? 'file' : 'files'}
          </div>
        )}
      </div>
    </div>
  );
}
