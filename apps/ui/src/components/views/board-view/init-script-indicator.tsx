import { useState, useRef, useEffect, useCallback } from 'react';
import { Terminal, Check, X, ChevronDown, ChevronUp } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import {
  useAppStore,
  type InitScriptState,
  type InitScriptOutputChunk,
} from '@/store/app-store';
import { AnsiOutput } from '@/components/ui/ansi-output';

interface InitScriptIndicatorProps {
  projectPath: string;
}

interface SingleIndicatorProps {
  stateKey: string;
  state: InitScriptState;
  onDismiss: (key: string) => void;
  isOnlyOne: boolean; // Whether this is the only indicator shown
  autoDismiss: boolean; // Whether to auto-dismiss after completion
}

interface OutputSection {
  type: InitScriptOutputChunk['type'];
  text: string;
}

function groupOutputSections(output: InitScriptOutputChunk[]): OutputSection[] {
  return output.reduce<OutputSection[]>((sections, chunk) => {
    const previousSection = sections[sections.length - 1];

    if (previousSection && previousSection.type === chunk.type) {
      previousSection.text += chunk.content;
      return sections;
    }

    sections.push({
      type: chunk.type,
      text: chunk.content,
    });
    return sections;
  }, []);
}

function SingleIndicator({
  stateKey,
  state,
  onDismiss,
  isOnlyOne,
  autoDismiss,
}: SingleIndicatorProps) {
  const [showLogs, setShowLogs] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const { status, output, branch, error } = state;
  const outputSections = groupOutputSections(output);

  // Auto-scroll to bottom when new output arrives
  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [output, showLogs]);

  // Auto-expand logs when script starts (only if it's the only one or running)
  useEffect(() => {
    if (status === 'running' && isOnlyOne) {
      setShowLogs(true);
    }
  }, [status, isOnlyOne]);

  // Auto-dismiss after completion (5 seconds)
  useEffect(() => {
    if (autoDismiss && (status === 'success' || status === 'failed')) {
      const timer = setTimeout(() => {
        onDismiss(stateKey);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [status, autoDismiss, stateKey, onDismiss]);

  if (status === 'idle') return null;

  return (
    <div
      className={cn(
        'bg-card border border-border rounded-lg shadow-lg',
        'min-w-[350px] max-w-[500px]',
        'animate-in slide-in-from-right-5 duration-200'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          {status === 'running' && <Spinner size="sm" />}
          {status === 'success' && <Check className="w-4 h-4 text-green-500" />}
          {status === 'failed' && <X className="w-4 h-4 text-red-500" />}
          <span className="font-medium text-sm">
            Init Script{' '}
            {status === 'running' ? 'Running' : status === 'success' ? 'Completed' : 'Failed'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="p-1 hover:bg-accent rounded transition-colors"
            title={showLogs ? 'Hide logs' : 'Show logs'}
          >
            {showLogs ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
          {status !== 'running' && (
            <button
              onClick={() => onDismiss(stateKey)}
              className="p-1 hover:bg-accent rounded transition-colors"
              title="Dismiss"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* Branch info */}
      <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
        <Terminal className="w-3.5 h-3.5" />
        <span>Branch: {branch}</span>
      </div>

      {/* Logs (collapsible) */}
      {showLogs && (
        <div className="border-t border-border/50">
          <div className="max-h-[360px] overflow-auto p-3">
            {output.length > 0 ? (
              <div className="space-y-3">
                {outputSections.map((section, index) => (
                  <div
                    key={`${section.type}-${index}`}
                    className={cn(
                      'overflow-hidden rounded-md border',
                      section.type === 'stderr'
                        ? 'border-red-500/30 bg-red-500/5'
                        : 'border-border/60 bg-muted/30'
                    )}
                  >
                    <div
                      className={cn(
                        'border-b px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.2em]',
                        section.type === 'stderr'
                          ? 'border-red-500/20 text-red-500'
                          : 'border-border/50 text-muted-foreground'
                      )}
                    >
                      {section.type}
                    </div>
                    <AnsiOutput
                      text={section.text}
                      className="max-w-full overflow-x-auto p-2 text-[11px] leading-5"
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground/60 text-center py-2">
                {status === 'running' ? 'Waiting for output...' : 'No output'}
              </div>
            )}
            {error && <div className="mt-2 text-red-500 text-xs font-medium">Error: {error}</div>}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}

      {/* Status bar for completed states */}
      {status !== 'running' && (
        <div
          className={cn(
            'px-3 py-2 text-xs',
            status === 'success' ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-600'
          )}
        >
          {status === 'success'
            ? 'Initialization completed successfully'
            : 'Initialization failed - worktree is still usable'}
        </div>
      )}
    </div>
  );
}

export function InitScriptIndicator({ projectPath }: InitScriptIndicatorProps) {
  const getInitScriptStatesForProject = useAppStore((s) => s.getInitScriptStatesForProject);
  const clearInitScriptState = useAppStore((s) => s.clearInitScriptState);
  const getAutoDismissInitScriptIndicator = useAppStore((s) => s.getAutoDismissInitScriptIndicator);
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set());

  // Get auto-dismiss setting
  const autoDismiss = getAutoDismissInitScriptIndicator(projectPath);

  // Get all init script states for this project
  const allStates = getInitScriptStatesForProject(projectPath);

  // Filter out dismissed and idle states
  const activeStates = allStates.filter(
    ({ key, state }) => !dismissedKeys.has(key) && state.status !== 'idle'
  );

  // Reset dismissed keys when a new script starts for a branch
  useEffect(() => {
    const runningKeys = allStates
      .filter(({ state }) => state.status === 'running')
      .map(({ key }) => key);

    if (runningKeys.length > 0) {
      setDismissedKeys((prev) => {
        const newSet = new Set(prev);
        runningKeys.forEach((key) => newSet.delete(key));
        return newSet;
      });
    }
  }, [allStates]);

  const handleDismiss = useCallback(
    (key: string) => {
      setDismissedKeys((prev) => new Set(prev).add(key));
      // Extract branch from key (format: "projectPath::branch")
      const branch = key.split('::')[1];
      if (branch) {
        // Clear state after a delay to allow for future scripts
        setTimeout(() => {
          clearInitScriptState(projectPath, branch);
        }, 100);
      }
    },
    [projectPath, clearInitScriptState]
  );

  if (activeStates.length === 0) return null;

  return (
    <div
      className={cn(
        'fixed bottom-4 right-4 z-50 flex flex-col gap-2',
        'max-h-[calc(100dvh-120px)] overflow-y-auto',
        'scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent'
      )}
    >
      {activeStates.map(({ key, state }) => (
        <SingleIndicator
          key={key}
          stateKey={key}
          state={state}
          onDismiss={handleDismiss}
          isOnlyOne={activeStates.length === 1}
          autoDismiss={autoDismiss}
        />
      ))}
    </div>
  );
}
