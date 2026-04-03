import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  FolderOpen,
  Folder,
  FileCode,
  ChevronRight,
  ArrowLeft,
  Check,
  Search,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { useOSDetection } from '@/hooks';
import { apiPost } from '@/lib/api-fetch';
import { cn } from '@/lib/utils';

interface ProjectFileEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  isFile: boolean;
}

interface BrowseResult {
  success: boolean;
  currentRelativePath: string;
  parentRelativePath: string | null;
  entries: ProjectFileEntry[];
  warning?: string;
  error?: string;
}

interface ProjectFileSelectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (paths: string[]) => void;
  projectPath: string;
  existingFiles?: string[];
  title?: string;
  description?: string;
}

export function ProjectFileSelectorDialog({
  open,
  onOpenChange,
  onSelect,
  projectPath,
  existingFiles = [],
  title = 'Select Files to Copy',
  description = 'Browse your project and select files or directories to copy into new worktrees.',
}: ProjectFileSelectorDialogProps) {
  const { isMac } = useOSDetection();
  const [currentRelativePath, setCurrentRelativePath] = useState('');
  const [parentRelativePath, setParentRelativePath] = useState<string | null>(null);
  const [entries, setEntries] = useState<ProjectFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  // Ref to track the current request generation; incremented to cancel stale requests
  const requestGenRef = useRef(0);

  // Track the path segments for breadcrumb navigation
  const breadcrumbs = useMemo(() => {
    if (!currentRelativePath) return [];
    const parts = currentRelativePath.split('/').filter(Boolean);
    return parts.map((part, index) => ({
      name: part,
      path: parts.slice(0, index + 1).join('/'),
    }));
  }, [currentRelativePath]);

  const browseDirectory = useCallback(
    async (relativePath?: string) => {
      // Increment the generation counter so any previously in-flight request
      // knows it has been superseded and should not update state.
      const generation = ++requestGenRef.current;
      const isCancelled = () => requestGenRef.current !== generation;

      setLoading(true);
      setError('');
      setWarning('');
      setSearchQuery('');

      try {
        const result = await apiPost<BrowseResult>('/api/fs/browse-project-files', {
          projectPath,
          relativePath: relativePath || '',
        });

        if (isCancelled()) return;

        if (result.success) {
          setCurrentRelativePath(result.currentRelativePath);
          setParentRelativePath(result.parentRelativePath);
          setEntries(result.entries);
          setWarning(result.warning || '');
        } else {
          setError(result.error || 'Failed to browse directory');
        }
      } catch (err) {
        if (isCancelled()) return;
        setError(err instanceof Error ? err.message : 'Failed to load directory contents');
      } finally {
        if (!isCancelled()) {
          setLoading(false);
        }
      }
    },
    [projectPath]
  );

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setSelectedPaths(new Set());
      setSearchQuery('');
      browseDirectory();
    } else {
      // Invalidate any in-flight request so it won't clobber the cleared state
      requestGenRef.current++;
      setCurrentRelativePath('');
      setParentRelativePath(null);
      setEntries([]);
      setError('');
      setWarning('');
      setSelectedPaths(new Set());
      setSearchQuery('');
    }
  }, [open, browseDirectory]);

  const handleNavigateInto = useCallback(
    (entry: ProjectFileEntry) => {
      if (entry.isDirectory) {
        browseDirectory(entry.relativePath);
      }
    },
    [browseDirectory]
  );

  const handleGoBack = useCallback(() => {
    if (parentRelativePath !== null) {
      browseDirectory(parentRelativePath || undefined);
    }
  }, [parentRelativePath, browseDirectory]);

  const handleGoToRoot = useCallback(() => {
    browseDirectory();
  }, [browseDirectory]);

  const handleBreadcrumbClick = useCallback(
    (path: string) => {
      browseDirectory(path);
    },
    [browseDirectory]
  );

  const handleToggleSelect = useCallback((entry: ProjectFileEntry) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(entry.relativePath)) {
        next.delete(entry.relativePath);
      } else {
        next.add(entry.relativePath);
      }
      return next;
    });
  }, []);

  const handleConfirmSelection = useCallback(() => {
    const paths = Array.from(selectedPaths);
    if (paths.length > 0) {
      onSelect(paths);
      onOpenChange(false);
    }
  }, [selectedPaths, onSelect, onOpenChange]);

  // Check if a path is already configured
  const isAlreadyConfigured = useCallback(
    (relativePath: string) => {
      return existingFiles.includes(relativePath);
    },
    [existingFiles]
  );

  // Filter entries based on search query
  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const query = searchQuery.toLowerCase();
    return entries.filter((entry) => entry.name.toLowerCase().includes(query));
  }, [entries, searchQuery]);

  // Handle Command/Ctrl+Enter keyboard shortcut
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (selectedPaths.size > 0 && !loading) {
          handleConfirmSelection();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, selectedPaths, loading, handleConfirmSelection]);

  const selectedCount = selectedPaths.size;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border max-w-2xl max-h-[80vh] overflow-hidden flex flex-col p-4 focus:outline-none focus-visible:outline-none">
        <DialogHeader className="pb-1">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FolderOpen className="w-4 h-4 text-brand-500" />
            {title}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 min-h-[300px] flex-1 overflow-hidden py-1">
          {/* Navigation bar */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleGoBack}
              className="h-7 w-7 shrink-0"
              disabled={loading || parentRelativePath === null}
              aria-label="Go back"
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>

            {/* Breadcrumb path */}
            <div className="flex items-center gap-1 min-w-0 flex-1 h-8 px-3 rounded-md border border-input bg-background/50 overflow-x-auto scrollbar-none">
              <button
                onClick={handleGoToRoot}
                className={cn(
                  'text-xs font-mono shrink-0 transition-colors',
                  currentRelativePath
                    ? 'text-muted-foreground hover:text-foreground'
                    : 'text-foreground font-medium'
                )}
                disabled={loading}
              >
                Project Root
              </button>
              {breadcrumbs.map((crumb) => (
                <span key={crumb.path} className="flex items-center gap-1 shrink-0">
                  <ChevronRight className="w-3 h-3 text-muted-foreground/50" />
                  <button
                    onClick={() => handleBreadcrumbClick(crumb.path)}
                    className={cn(
                      'text-xs font-mono truncate max-w-[150px] transition-colors',
                      crumb.path === currentRelativePath
                        ? 'text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                    disabled={loading}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* Search filter */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter files and directories..."
              className="h-8 text-xs pl-8 pr-8"
              disabled={loading}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Selected items indicator */}
          {selectedCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-brand-500/10 border border-brand-500/20 text-xs">
              <Check className="w-3.5 h-3.5 text-brand-500" />
              <span className="text-brand-500 font-medium">
                {selectedCount} {selectedCount === 1 ? 'item' : 'items'} selected
              </span>
              <button
                onClick={() => setSelectedPaths(new Set())}
                className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear
              </button>
            </div>
          )}

          {/* File/directory list */}
          <div className="flex-1 overflow-y-auto border border-sidebar-border rounded-md scrollbar-styled">
            {loading && (
              <div className="flex items-center justify-center h-full p-4">
                <div className="text-xs text-muted-foreground">Loading...</div>
              </div>
            )}

            {error && (
              <div className="flex items-center justify-center h-full p-4">
                <div className="text-xs text-destructive">{error}</div>
              </div>
            )}

            {warning && (
              <div className="p-2 bg-yellow-500/10 border border-yellow-500/30 rounded-md mb-1">
                <div className="text-xs text-yellow-500">{warning}</div>
              </div>
            )}

            {!loading && !error && filteredEntries.length === 0 && (
              <div className="flex items-center justify-center h-full p-4">
                <div className="text-xs text-muted-foreground">
                  {searchQuery ? 'No matching files or directories' : 'This directory is empty'}
                </div>
              </div>
            )}

            {!loading && !error && filteredEntries.length > 0 && (
              <div className="divide-y divide-sidebar-border">
                {filteredEntries.map((entry) => {
                  const isSelected = selectedPaths.has(entry.relativePath);
                  const isConfigured = isAlreadyConfigured(entry.relativePath);

                  return (
                    <div
                      key={entry.relativePath}
                      className={cn(
                        'w-full flex items-center gap-2 px-2 py-1.5 transition-colors text-left group',
                        isConfigured
                          ? 'opacity-50'
                          : isSelected
                            ? 'bg-brand-500/10'
                            : 'hover:bg-sidebar-accent/10'
                      )}
                    >
                      {/* Checkbox for selection */}
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => handleToggleSelect(entry)}
                        disabled={isConfigured}
                        className="shrink-0"
                        aria-label={`Select ${entry.name}`}
                      />

                      {/* Icon */}
                      {entry.isDirectory ? (
                        <Folder className="w-4 h-4 text-brand-500 shrink-0" />
                      ) : (
                        <FileCode className="w-4 h-4 text-muted-foreground/60 shrink-0" />
                      )}

                      {/* File/directory name */}
                      <span
                        className="flex-1 truncate text-xs font-mono cursor-pointer"
                        onClick={() => {
                          if (!isConfigured) {
                            handleToggleSelect(entry);
                          }
                        }}
                      >
                        {entry.name}
                      </span>

                      {/* Already configured badge */}
                      {isConfigured && (
                        <span className="text-[10px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded shrink-0">
                          Already added
                        </span>
                      )}

                      {/* Navigate into directory button */}
                      {entry.isDirectory && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleNavigateInto(entry);
                          }}
                          className="opacity-60 sm:opacity-0 sm:group-hover:opacity-100 p-0.5 rounded hover:bg-accent/50 transition-all shrink-0"
                          title={`Open ${entry.name}`}
                        >
                          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="text-[10px] text-muted-foreground">
            Select files or directories to copy into new worktrees. Directories are copied
            recursively. Click the arrow to browse into a directory.
          </div>
        </div>

        <DialogFooter className="border-t border-border pt-3 gap-2 mt-1">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleConfirmSelection}
            disabled={selectedCount === 0 || loading}
            title={`Add ${selectedCount} selected items (${isMac ? '⌘' : 'Ctrl'}+Enter)`}
          >
            <Check className="w-3.5 h-3.5 mr-1.5" />
            Add {selectedCount > 0 ? `${selectedCount} ` : ''}
            {selectedCount === 1 ? 'Item' : 'Items'}
            <KbdGroup className="ml-1">
              <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
              <Kbd>↵</Kbd>
            </KbdGroup>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
