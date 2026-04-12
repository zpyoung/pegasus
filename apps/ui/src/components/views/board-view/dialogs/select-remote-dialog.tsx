import { useState, useEffect, useCallback } from "react";
import { createLogger } from "@pegasus/utils/logger";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getHttpApiClient } from "@/lib/http-api-client";
import { getErrorMessage } from "@/lib/utils";
import { Download, Upload, RefreshCw, AlertTriangle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { WorktreeInfo } from "../worktree-panel/types";

interface RemoteInfo {
  name: string;
  url: string;
}

const logger = createLogger("SelectRemoteDialog");

export type SelectRemoteOperation = "pull" | "push";

interface SelectRemoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worktree: WorktreeInfo | null;
  operation: SelectRemoteOperation;
  onConfirm: (worktree: WorktreeInfo, remote: string) => void;
}

export function SelectRemoteDialog({
  open,
  onOpenChange,
  worktree,
  operation,
  onConfirm,
}: SelectRemoteDialogProps) {
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [selectedRemote, setSelectedRemote] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRemotes = useCallback(async () => {
    if (!worktree) return;

    setIsLoading(true);
    setError(null);

    try {
      const api = getHttpApiClient();
      const result = await api.worktree.listRemotes(worktree.path);

      if (result.success && result.result) {
        const remoteInfos = result.result.remotes.map(
          (r: { name: string; url: string }) => ({
            name: r.name,
            url: r.url,
          }),
        );
        setRemotes(remoteInfos);
        setSelectedRemote((prev) => {
          if (prev && remoteInfos.some((r) => r.name === prev)) {
            return prev;
          }
          return (
            remoteInfos.find((r) => r.name === "origin")?.name ??
            remoteInfos[0]?.name ??
            ""
          );
        });
      } else {
        setError(result.error || "Failed to fetch remotes");
      }
    } catch (err) {
      logger.error("Failed to fetch remotes:", err);
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, [worktree]);

  // Fetch remotes when dialog opens
  useEffect(() => {
    if (open && worktree) {
      fetchRemotes();
    }
  }, [open, worktree, fetchRemotes]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedRemote("");
      setError(null);
    }
  }, [open]);

  // Auto-select default remote when remotes are loaded
  useEffect(() => {
    if (remotes.length > 0 && !selectedRemote) {
      // Default to 'origin' if available, otherwise first remote
      const defaultRemote =
        remotes.find((r) => r.name === "origin") || remotes[0];
      setSelectedRemote(defaultRemote.name);
    }
  }, [remotes, selectedRemote]);

  const handleRefresh = async () => {
    if (!worktree) return;

    setIsRefreshing(true);
    setError(null);

    try {
      const api = getHttpApiClient();
      const result = await api.worktree.listRemotes(worktree.path);

      if (result.success && result.result) {
        const remoteInfos = result.result.remotes.map(
          (r: { name: string; url: string }) => ({
            name: r.name,
            url: r.url,
          }),
        );
        setRemotes(remoteInfos);
        setSelectedRemote((prev) => {
          if (prev && remoteInfos.some((r) => r.name === prev)) {
            return prev;
          }
          return (
            remoteInfos.find((r) => r.name === "origin")?.name ??
            remoteInfos[0]?.name ??
            ""
          );
        });
      } else {
        setError(result.error || "Failed to refresh remotes");
      }
    } catch (err) {
      logger.error("Failed to refresh remotes:", err);
      setError(getErrorMessage(err));
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleConfirm = () => {
    if (!worktree || !selectedRemote) return;
    onConfirm(worktree, selectedRemote);
    onOpenChange(false);
  };

  const isPull = operation === "pull";
  const Icon = isPull ? Download : Upload;
  const title = isPull ? "Pull from Remote" : "Push to Remote";
  const actionLabel = isPull
    ? `Pull from ${selectedRemote || "Remote"}`
    : `Push to ${selectedRemote || "Remote"}`;
  const description = isPull ? (
    <>
      Select a remote to pull changes into{" "}
      <span className="font-mono text-foreground">
        {worktree?.branch || "current branch"}
      </span>
    </>
  ) : (
    <>
      Select a remote to push{" "}
      <span className="font-mono text-foreground">
        {worktree?.branch || "current branch"}
      </span>{" "}
      to
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="w-5 h-5 text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              <span className="text-sm">{error}</span>
            </div>
            <Button variant="outline" size="sm" onClick={fetchRemotes}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Retry
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="remote-select">Select Remote</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  className="h-6 px-2 text-xs"
                >
                  {isRefreshing ? (
                    <Spinner size="xs" className="mr-1" />
                  ) : (
                    <RefreshCw className="w-3 h-3 mr-1" />
                  )}
                  Refresh
                </Button>
              </div>
              <Select value={selectedRemote} onValueChange={setSelectedRemote}>
                <SelectTrigger id="remote-select">
                  <SelectValue placeholder="Select a remote" />
                </SelectTrigger>
                <SelectContent>
                  {remotes.map((remote) => (
                    <SelectItem
                      key={remote.name}
                      value={remote.name}
                      description={
                        <span className="text-xs text-muted-foreground truncate max-w-[300px]">
                          {remote.url}
                        </span>
                      }
                    >
                      <span className="font-medium">{remote.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedRemote && (
              <div className="mt-2 p-3 rounded-md bg-muted/50 border border-border">
                <p className="text-sm text-muted-foreground">
                  {isPull ? (
                    <>
                      This will pull changes from{" "}
                      <span className="font-mono text-foreground">
                        {selectedRemote}/{worktree?.branch}
                      </span>{" "}
                      into your local branch.
                    </>
                  ) : (
                    <>
                      This will push your local changes to{" "}
                      <span className="font-mono text-foreground">
                        {selectedRemote}/{worktree?.branch}
                      </span>
                      .
                    </>
                  )}
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!selectedRemote || isLoading}
          >
            <Icon className="w-4 h-4 mr-2" />
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
