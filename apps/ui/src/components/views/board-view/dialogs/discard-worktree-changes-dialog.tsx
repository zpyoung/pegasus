import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Undo2,
  FilePlus,
  FileX,
  FilePen,
  FileText,
  File,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { getElectronAPI } from '@/lib/electron';
import { getHttpApiClient } from '@/lib/http-api-client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { TruncatedFilePath } from '@/components/ui/truncated-file-path';
import type { FileStatus } from '@/types/electron';
import { parseDiff, type ParsedFileDiff } from '@/lib/diff-utils';

interface WorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
  hasChanges?: boolean;
  changedFilesCount?: number;
}

interface DiscardWorktreeChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worktree: WorktreeInfo | null;
  onDiscarded: () => void;
}

const getFileIcon = (status: string) => {
  switch (status) {
    case 'A':
    case '?':
      return <FilePlus className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />;
    case 'D':
      return <FileX className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />;
    case 'M':
    case 'U':
      return <FilePen className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />;
    case 'R':
    case 'C':
      return <File className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />;
    default:
      return <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />;
  }
};

const getStatusLabel = (status: string) => {
  switch (status) {
    case 'A':
      return 'Added';
    case '?':
      return 'Untracked';
    case 'D':
      return 'Deleted';
    case 'M':
      return 'Modified';
    case 'U':
      return 'Updated';
    case 'R':
      return 'Renamed';
    case 'C':
      return 'Copied';
    default:
      return 'Changed';
  }
};

const getStatusBadgeColor = (status: string) => {
  switch (status) {
    case 'A':
    case '?':
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'D':
      return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'M':
    case 'U':
      return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    case 'R':
    case 'C':
      return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
};

const bgClass = {
  context: 'bg-transparent',
  addition: 'bg-green-500/10',
  deletion: 'bg-red-500/10',
  header: 'bg-blue-500/10',
};

const textClass = {
  context: 'text-foreground-secondary',
  addition: 'text-green-400',
  deletion: 'text-red-400',
  header: 'text-blue-400',
};

const prefix = {
  context: ' ',
  addition: '+',
  deletion: '-',
  header: '',
};

function DiffLine({
  type,
  content,
  lineNumber,
}: {
  type: 'context' | 'addition' | 'deletion' | 'header';
  content: string;
  lineNumber?: { old?: number; new?: number };
}) {
  if (type === 'header') {
    return (
      <div className={cn('px-2 py-1 font-mono text-xs', bgClass[type], textClass[type])}>
        {content}
      </div>
    );
  }

  return (
    <div className={cn('flex font-mono text-xs', bgClass[type])}>
      <span className="w-10 flex-shrink-0 text-right pr-1.5 text-muted-foreground select-none border-r border-border-glass text-[10px]">
        {lineNumber?.old ?? ''}
      </span>
      <span className="w-10 flex-shrink-0 text-right pr-1.5 text-muted-foreground select-none border-r border-border-glass text-[10px]">
        {lineNumber?.new ?? ''}
      </span>
      <span className={cn('w-4 flex-shrink-0 text-center select-none', textClass[type])}>
        {prefix[type]}
      </span>
      <span className={cn('flex-1 px-1.5 whitespace-pre-wrap break-all', textClass[type])}>
        {content || '\u00A0'}
      </span>
    </div>
  );
}

export function DiscardWorktreeChangesDialog({
  open,
  onOpenChange,
  worktree,
  onDiscarded,
}: DiscardWorktreeChangesDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // File selection state
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [diffContent, setDiffContent] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [isLoadingDiffs, setIsLoadingDiffs] = useState(false);

  // Parse diffs
  const parsedDiffs = useMemo(() => parseDiff(diffContent), [diffContent]);

  // Create a map of file path to parsed diff for quick lookup
  const diffsByFile = useMemo(() => {
    const map = new Map<string, ParsedFileDiff>();
    for (const diff of parsedDiffs) {
      map.set(diff.filePath, diff);
    }
    return map;
  }, [parsedDiffs]);

  // Load diffs when dialog opens
  useEffect(() => {
    if (open && worktree) {
      setIsLoadingDiffs(true);
      setFiles([]);
      setDiffContent('');
      setSelectedFiles(new Set());
      setExpandedFile(null);
      setError(null);

      let cancelled = false;

      const loadDiffs = async () => {
        try {
          const api = getElectronAPI();
          if (api?.git?.getDiffs) {
            const result = await api.git.getDiffs(worktree.path);
            if (result.success) {
              const fileList = result.files ?? [];
              if (!cancelled) setError(null);
              if (!cancelled) setFiles(fileList);
              if (!cancelled) setDiffContent(result.diff ?? '');
              if (!cancelled) setSelectedFiles(new Set());
            } else {
              if (!cancelled) setError(result.error || 'Failed to fetch diffs');
            }
          } else {
            if (!cancelled) setError('Diff API unavailable');
          }
        } catch (err) {
          if (cancelled) return;
          console.warn('Failed to load diffs for discard dialog:', err);
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (!cancelled) setIsLoadingDiffs(false);
        }
      };

      loadDiffs();

      return () => {
        cancelled = true;
      };
    }
  }, [open, worktree]);

  const handleToggleFile = useCallback((filePath: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    setSelectedFiles((prev) => {
      if (prev.size === files.length) {
        return new Set();
      }
      return new Set(files.map((f) => f.path));
    });
  }, [files]);

  const handleFileClick = useCallback((filePath: string) => {
    setExpandedFile((prev) => (prev === filePath ? null : filePath));
  }, []);

  const handleDiscard = async () => {
    if (!worktree || selectedFiles.size === 0) return;

    setIsLoading(true);
    setError(null);

    try {
      const api = getHttpApiClient();

      // Pass selected files if not all files are selected
      const filesToDiscard =
        selectedFiles.size === files.length ? undefined : Array.from(selectedFiles);

      const result = await api.worktree.discardChanges(worktree.path, filesToDiscard);

      if (result.success && result.result) {
        if (result.result.discarded) {
          const fileCount = filesToDiscard ? filesToDiscard.length : selectedFiles.size;
          toast.success('Changes discarded', {
            description: `Discarded ${fileCount} ${fileCount === 1 ? 'file' : 'files'} in ${worktree.branch}`,
          });
          onDiscarded();
          onOpenChange(false);
        } else {
          toast.info('No changes to discard', {
            description: result.result.message,
          });
        }
      } else {
        setError(result.error || 'Failed to discard changes');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to discard changes');
    } finally {
      setIsLoading(false);
    }
  };

  if (!worktree) return null;

  const allSelected = selectedFiles.size === files.length && files.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2 className="w-5 h-5 text-destructive" />
            Discard Changes
          </DialogTitle>
          <DialogDescription>
            Select which changes to discard in the{' '}
            <code className="font-mono bg-muted px-1 rounded">{worktree.branch}</code> worktree.
            This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2 min-h-0 flex-1 overflow-hidden">
          {/* File Selection */}
          <div className="flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-1.5">
              <Label className="text-sm font-medium flex items-center gap-2">
                Files to discard
                {isLoadingDiffs ? (
                  <Spinner size="sm" />
                ) : (
                  <span className="text-xs text-muted-foreground font-normal">
                    ({selectedFiles.size}/{files.length} selected)
                  </span>
                )}
              </Label>
              {files.length > 0 && (
                <button
                  type="button"
                  onClick={handleToggleAll}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>

            {isLoadingDiffs ? (
              <div className="flex items-center justify-center py-6 text-muted-foreground border border-border rounded-lg">
                <Spinner size="sm" className="mr-2" />
                <span className="text-sm">Loading changes...</span>
              </div>
            ) : files.length === 0 ? (
              <div className="flex items-center justify-center py-6 text-muted-foreground border border-border rounded-lg">
                <span className="text-sm">No changes detected</span>
              </div>
            ) : (
              <div className="border border-border rounded-lg overflow-hidden max-h-[300px] overflow-y-auto scrollbar-visible">
                {files.map((file) => {
                  const isChecked = selectedFiles.has(file.path);
                  const isExpanded = expandedFile === file.path;
                  const fileDiff = diffsByFile.get(file.path);
                  const additions = fileDiff
                    ? fileDiff.hunks.reduce(
                        (acc, hunk) => acc + hunk.lines.filter((l) => l.type === 'addition').length,
                        0
                      )
                    : 0;
                  const deletions = fileDiff
                    ? fileDiff.hunks.reduce(
                        (acc, hunk) => acc + hunk.lines.filter((l) => l.type === 'deletion').length,
                        0
                      )
                    : 0;

                  const fileButtonId = `file-btn-${file.path.replace(/[^a-zA-Z0-9]/g, '-')}`;

                  return (
                    <div key={file.path} className="border-b border-border last:border-b-0">
                      <div
                        className={cn(
                          'flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 transition-colors group',
                          isExpanded && 'bg-accent/30'
                        )}
                      >
                        {/* Checkbox */}
                        <Checkbox
                          checked={isChecked}
                          onCheckedChange={() => handleToggleFile(file.path)}
                          className="flex-shrink-0"
                          aria-labelledby={fileButtonId}
                        />

                        {/* Clickable file row to show diff */}
                        <button
                          id={fileButtonId}
                          type="button"
                          onClick={() => handleFileClick(file.path)}
                          aria-expanded={isExpanded}
                          className="flex items-center gap-2 flex-1 min-w-0 text-left"
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                          ) : (
                            <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                          )}
                          {getFileIcon(file.status)}
                          <TruncatedFilePath
                            path={file.path}
                            className="text-xs font-mono flex-1 text-foreground"
                          />
                          <span
                            className={cn(
                              'text-[10px] px-1.5 py-0.5 rounded border font-medium flex-shrink-0',
                              getStatusBadgeColor(file.status)
                            )}
                          >
                            {getStatusLabel(file.status)}
                          </span>
                          {additions > 0 && (
                            <span className="text-[10px] text-green-400 flex-shrink-0">
                              +{additions}
                            </span>
                          )}
                          {deletions > 0 && (
                            <span className="text-[10px] text-red-400 flex-shrink-0">
                              -{deletions}
                            </span>
                          )}
                        </button>
                      </div>

                      {/* Expanded diff view */}
                      {isExpanded && fileDiff && (
                        <div className="bg-background border-t border-border max-h-[200px] overflow-y-auto scrollbar-visible">
                          {fileDiff.hunks.map((hunk, hunkIndex) => (
                            <div
                              key={hunkIndex}
                              className="border-b border-border-glass last:border-b-0"
                            >
                              {hunk.lines.map((line, lineIndex) => (
                                <DiffLine
                                  key={lineIndex}
                                  type={line.type}
                                  content={line.content}
                                  lineNumber={line.lineNumber}
                                />
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                      {isExpanded && !fileDiff && (
                        <div className="px-4 py-3 text-xs text-muted-foreground bg-background border-t border-border">
                          {file.status === '?' ? (
                            <span>New file - diff preview not available</span>
                          ) : file.status === 'D' ? (
                            <span>File deleted</span>
                          ) : (
                            <span>Diff content not available</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Warning message */}
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
            <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
            <p className="text-xs text-destructive">
              This will permanently discard the selected changes. Staged changes will be unstaged,
              modifications to tracked files will be reverted, and untracked files will be deleted.
              This action cannot be undone.
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDiscard}
            disabled={isLoading || selectedFiles.size === 0}
          >
            {isLoading ? (
              <>
                <Spinner size="sm" className="mr-2" />
                Discarding...
              </>
            ) : (
              <>
                <Undo2 className="w-4 h-4 mr-2" />
                Discard
                {selectedFiles.size > 0 && selectedFiles.size < files.length
                  ? ` (${selectedFiles.size} file${selectedFiles.size > 1 ? 's' : ''})`
                  : selectedFiles.size > 0
                    ? ` All (${selectedFiles.size} file${selectedFiles.size > 1 ? 's' : ''})`
                    : ''}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
