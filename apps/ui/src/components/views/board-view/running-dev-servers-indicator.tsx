import { useState, useEffect, useCallback, useRef } from "react";
import { Globe, Square, ChevronDown, ChevronUp, Server } from "lucide-react";
import { cn, normalizePath } from "@/lib/utils";
import { getElectronAPI } from "@/lib/electron";
import { toast } from "sonner";
import { createLogger } from "@pegasus/utils/logger";

const logger = createLogger("RunningDevServersIndicator");

/** Interval for polling running dev servers (ms) */
const POLL_INTERVAL_MS = 30_000;

interface RunningServer {
  worktreePath: string;
  port: number;
  url: string;
  urlDetected: boolean;
}

/**
 * Extract branch name from a worktree path.
 * Worktree paths follow the pattern: .../.worktrees/<branch-name>
 * Falls back to the last path segment.
 */
function extractBranchName(worktreePath: string): string {
  const normalized = normalizePath(worktreePath);
  const worktreesSeg = "/.worktrees/";
  const idx = normalized.lastIndexOf(worktreesSeg);
  if (idx !== -1) {
    return normalized.slice(idx + worktreesSeg.length).split("/")[0];
  }
  // Fallback: last segment of path
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? worktreePath;
}

/**
 * Build the browser-accessible dev server URL by rewriting the hostname
 * to match the current window's hostname (supports remote access).
 */
function buildBrowserUrl(serverUrl: string): string | null {
  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    parsed.hostname = window.location.hostname;
    return parsed.toString();
  } catch {
    return null;
  }
}

interface RunningDevServersIndicatorProps {
  projectPath: string;
}

export function RunningDevServersIndicator({
  projectPath: _projectPath,
}: RunningDevServersIndicatorProps) {
  const [servers, setServers] = useState<Map<string, RunningServer>>(new Map());
  const [expanded, setExpanded] = useState(false);
  const [stoppingServers, setStoppingServers] = useState<Set<string>>(
    new Set(),
  );
  const initialFetchDone = useRef(false);

  // Fetch all running dev servers from backend
  const fetchServers = useCallback(async () => {
    try {
      const api = getElectronAPI();
      if (!api?.worktree?.listDevServers) return;

      const result = await api.worktree.listDevServers();
      if (result.success && result.result?.servers) {
        const map = new Map<string, RunningServer>();
        for (const s of result.result.servers) {
          map.set(normalizePath(s.worktreePath), {
            worktreePath: s.worktreePath,
            port: s.port,
            url: s.url,
            urlDetected: s.urlDetected ?? true,
          });
        }
        setServers(map);
      }
      initialFetchDone.current = true;
    } catch (error) {
      logger.error("Failed to fetch dev servers:", error);
      initialFetchDone.current = true;
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  // Periodic polling
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) fetchServers();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchServers]);

  // Subscribe to dev-server WebSocket events for real-time updates
  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.worktree?.onDevServerLogEvent) return;

    const unsubscribe = api.worktree.onDevServerLogEvent((event) => {
      if (event.type === "dev-server:started") {
        const { worktreePath, port, url } = event.payload;
        const key = normalizePath(worktreePath);
        setServers((prev) => {
          const next = new Map(prev);
          next.set(key, { worktreePath, port, url, urlDetected: false });
          return next;
        });
      } else if (event.type === "dev-server:url-detected") {
        const { worktreePath, url, port } = event.payload;
        const key = normalizePath(worktreePath);
        setServers((prev) => {
          const next = new Map(prev);
          const existing = prev.get(key);
          next.set(key, {
            worktreePath,
            port,
            url,
            urlDetected: true,
            ...existing,
          });
          return next;
        });
      } else if (event.type === "dev-server:stopped") {
        const { worktreePath } = event.payload;
        const key = normalizePath(worktreePath);
        setServers((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        setStoppingServers((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    });

    return unsubscribe;
  }, []);

  const handleStop = useCallback(async (worktreePath: string) => {
    const key = normalizePath(worktreePath);
    setStoppingServers((prev) => new Set(prev).add(key));

    try {
      const api = getElectronAPI();
      if (!api?.worktree?.stopDevServer) {
        toast.error("Stop dev server API not available");
        return;
      }

      const result = await api.worktree.stopDevServer(worktreePath);
      if (result.success) {
        setServers((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        toast.success(result.result?.message || "Dev server stopped");
      } else {
        toast.error(result.error || "Failed to stop dev server");
      }
    } catch (error) {
      logger.error("Stop dev server failed:", error);
      toast.error("Failed to stop dev server");
    } finally {
      setStoppingServers((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const handleStopAll = useCallback(async () => {
    const entries = Array.from(servers.values());
    await Promise.allSettled(entries.map((s) => handleStop(s.worktreePath)));
  }, [servers, handleStop]);

  const handleOpenUrl = useCallback((url: string, _port: number) => {
    const browserUrl = buildBrowserUrl(url);
    if (browserUrl) {
      window.open(browserUrl, "_blank", "noopener,noreferrer");
    } else {
      toast.error("Invalid dev server URL");
    }
  }, []);

  // Don't render if no running dev servers
  if (servers.size === 0) return null;

  const serverList = Array.from(servers.entries());

  return (
    <div
      className={cn(
        "fixed bottom-4 left-4 z-50",
        "animate-in slide-in-from-left-5 duration-200",
      )}
    >
      <div
        className={cn(
          "bg-card border border-border rounded-lg shadow-lg",
          "min-w-[280px] max-w-[400px]",
        )}
      >
        {/* Header - always visible */}
        <div
          className="flex items-center justify-between p-2.5 cursor-pointer select-none"
          onClick={() => setExpanded(!expanded)}
        >
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
            </span>
            <Server className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="font-medium text-xs">
              {servers.size} Dev Server{servers.size !== 1 ? "s" : ""} Running
            </span>
          </div>
          <div className="flex items-center gap-1">
            {servers.size > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleStopAll();
                }}
                className="px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/10 rounded transition-colors"
                title="Stop all dev servers"
              >
                Stop All
              </button>
            )}
            <button
              className="p-1 hover:bg-accent rounded transition-colors"
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </button>
          </div>
        </div>

        {/* Expanded server list */}
        {expanded && (
          <div className="border-t border-border/50 max-h-[300px] overflow-y-auto">
            {serverList.map(([key, server]) => {
              const branchName = extractBranchName(server.worktreePath);
              const isStopping = stoppingServers.has(key);
              const browserUrl = server.urlDetected
                ? buildBrowserUrl(server.url)
                : null;

              return (
                <div
                  key={key}
                  className="flex items-center justify-between px-3 py-2 border-b border-border/30 last:border-b-0 hover:bg-accent/50 transition-colors"
                >
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <span
                      className="text-xs font-mono truncate"
                      title={server.worktreePath}
                    >
                      {branchName}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {server.urlDetected
                        ? `Port ${server.port}`
                        : "Detecting port..."}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 ml-2 shrink-0">
                    {browserUrl && (
                      <button
                        onClick={() => handleOpenUrl(server.url, server.port)}
                        className="p-1 hover:bg-accent rounded transition-colors text-green-500"
                        title={`Open in browser (port ${server.port})`}
                      >
                        <Globe className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => handleStop(server.worktreePath)}
                      disabled={isStopping}
                      className={cn(
                        "p-1 hover:bg-destructive/10 rounded transition-colors text-destructive",
                        isStopping && "opacity-50 cursor-not-allowed",
                      )}
                      title="Stop dev server"
                    >
                      <Square className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
