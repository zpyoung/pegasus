// @ts-nocheck - Claude settings form with CLI status and authentication state
import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Cpu,
  Terminal,
  Info,
  Shield,
  ShieldOff,
  ShieldQuestion,
} from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { useSetupStore } from "@/store/setup-store";
import { useCliStatus } from "../hooks/use-cli-status";
import { useClaudeCliStatus } from "@/hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import { ClaudeCliStatus } from "../cli-status/claude-cli-status";
import { CliStatusCard } from "../cli-status/cli-status-card";
import { ClaudeMdSettings } from "../claude/claude-md-settings";
import { ClaudeUsageSection } from "../api-keys/claude-usage-section";
import { SkillsSection } from "./claude-settings-tab/skills-section";
import { SubagentsSection } from "./claude-settings-tab/subagents-section";
import { ApiProfilesSection } from "./claude-settings-tab/api-profiles-section";
import { ProviderToggle } from "./provider-toggle";
import { AnthropicIcon } from "@/components/ui/provider-icon";
import type { CliStatus as SharedCliStatus } from "../shared/types";
import { cn } from "@/lib/utils";

export function ClaudeSettingsTab() {
  const {
    apiKeys,
    autoLoadClaudeMd,
    setAutoLoadClaudeMd,
    useClaudeCodeSystemPrompt,
    setUseClaudeCodeSystemPrompt,
    claudeBackendMode,
    setClaudeBackendMode,
  } = useAppStore();
  const { claudeAuthStatus } = useSetupStore();

  // Legacy CLI status (for the "SDK uses CLI auth" indicator) — kept since
  // SDK mode can also pick up auth from a working CLI install.
  const { claudeCliStatus, isCheckingClaudeCli, handleRefreshClaudeCli } =
    useCliStatus();

  // Provider-subprocess CLI status (drives CLI mode availability + auth)
  const queryClient = useQueryClient();
  const {
    data: cliStatusData,
    isLoading: isCheckingCli,
    refetch: refetchCliStatus,
  } = useClaudeCliStatus();

  const cliInstalled = !!cliStatusData?.installed;
  const sdkAvailable =
    !!apiKeys.anthropic ||
    !!claudeAuthStatus?.hasEnvApiKey ||
    !!claudeAuthStatus?.hasEnvOAuthToken;

  // Hide usage tracking when using API key (only show for Claude Code CLI users)
  // Also hide on Windows for now (CLI usage command not supported)
  const isWindows =
    typeof navigator !== "undefined" &&
    navigator.platform?.toLowerCase().includes("win");
  const showUsageTracking = !apiKeys.anthropic && !isWindows;

  const cliStatusCard = useMemo((): SharedCliStatus | null => {
    if (!cliStatusData) return null;
    return {
      success: cliStatusData.success ?? false,
      status: cliStatusData.installed ? "installed" : "not_installed",
      version: cliStatusData.version ?? undefined,
      path: cliStatusData.path ?? undefined,
      installCommands: {
        npm: "npm install -g @anthropic-ai/claude-code",
        macos: "brew install anthropic/claude/claude-code",
        linux: "npm install -g @anthropic-ai/claude-code",
      },
    };
  }, [cliStatusData]);

  const cliAuthStatus: "authenticated" | "not_authenticated" | "unknown" =
    cliStatusData?.authStatus ?? "unknown";

  const handleRefreshCli = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.cli.claudeCli(),
    });
    await refetchCliStatus();
    toast.success("Claude CLI status refreshed");
  }, [queryClient, refetchCliStatus]);

  const handleModeChange = useCallback(
    async (next: "sdk" | "cli") => {
      if (next === claudeBackendMode) return;
      if (next === "sdk" && !sdkAvailable) {
        toast.error("Add an Anthropic API key to enable the SDK backend.");
        return;
      }
      if (next === "cli" && !cliInstalled) {
        toast.error("Install the Claude Code CLI to enable the CLI backend.");
        return;
      }
      await setClaudeBackendMode(next);
      toast.success(
        next === "cli"
          ? "Claude models will run via the CLI subprocess."
          : "Claude models will run via the Anthropic SDK.",
      );
    },
    [claudeBackendMode, sdkAvailable, cliInstalled, setClaudeBackendMode],
  );

  return (
    <div className="space-y-6">
      {/* Provider Visibility Toggle */}
      <ProviderToggle provider="claude" providerLabel="Claude" />

      {/* Backend Mode Selector */}
      <BackendModeSelector
        mode={claudeBackendMode}
        sdkAvailable={sdkAvailable}
        cliAvailable={cliInstalled}
        onChange={handleModeChange}
      />

      {/* Usage Info */}
      <div className="flex items-start gap-3 p-4 rounded-xl bg-blue-500/10 border border-blue-500/20">
        <Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
        <div className="text-sm text-blue-400/90">
          <span className="font-medium">Primary Provider</span>
          <p className="text-xs text-blue-400/70 mt-1">
            Claude is used throughout the app including chat, analysis, and
            agent tasks.
          </p>
        </div>
      </div>

      {claudeBackendMode === "cli" ? (
        <>
          <CliStatusCard
            title="Claude Code CLI"
            description="Runs claude -p as a provider subprocess. Uses your existing Claude Code authentication."
            status={cliStatusCard}
            isChecking={isCheckingCli}
            onRefresh={handleRefreshCli}
            refreshTestId="refresh-claude-cli-status"
            icon={AnthropicIcon}
            fallbackRecommendation="Install with: npm install -g @anthropic-ai/claude-code"
          />
          {cliStatusData?.installed && <CliAuthCard status={cliAuthStatus} />}
        </>
      ) : (
        <>
          <ClaudeCliStatus
            status={claudeCliStatus}
            authStatus={claudeAuthStatus}
            isChecking={isCheckingClaudeCli}
            onRefresh={handleRefreshClaudeCli}
          />

          {/* Claude-compatible providers (SDK only) */}
          <ApiProfilesSection />
        </>
      )}

      <ClaudeMdSettings
        autoLoadClaudeMd={autoLoadClaudeMd}
        onAutoLoadClaudeMdChange={setAutoLoadClaudeMd}
        useClaudeCodeSystemPrompt={useClaudeCodeSystemPrompt}
        onUseClaudeCodeSystemPromptChange={setUseClaudeCodeSystemPrompt}
      />

      {/* Skills Configuration */}
      <SkillsSection />

      {/* Custom Subagents */}
      <SubagentsSection />

      {showUsageTracking && <ClaudeUsageSection />}
    </div>
  );
}

interface BackendModeSelectorProps {
  mode: "sdk" | "cli";
  sdkAvailable: boolean;
  cliAvailable: boolean;
  onChange: (mode: "sdk" | "cli") => void;
}

function BackendModeSelector({
  mode,
  sdkAvailable,
  cliAvailable,
  onChange,
}: BackendModeSelectorProps) {
  return (
    <div
      className={cn(
        "rounded-2xl overflow-hidden border border-border/50",
        "bg-gradient-to-br from-card/90 via-card/70 to-card/80 backdrop-blur-xl",
        "shadow-sm shadow-black/5",
      )}
    >
      <div className="p-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground tracking-tight">
            Backend
          </h3>
          <p className="text-xs text-muted-foreground/80 mt-1">
            Choose how Claude models execute. The CLI subprocess uses your
            existing Claude Code authentication; the SDK requires an Anthropic
            API key or OAuth token.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="Claude backend"
          className="grid grid-cols-2 gap-3"
        >
          <BackendOption
            icon={Cpu}
            label="Anthropic SDK"
            description="Direct API. Requires ANTHROPIC_API_KEY or OAuth token."
            selected={mode === "sdk"}
            disabled={!sdkAvailable}
            disabledReason="Add an Anthropic API key to enable."
            onSelect={() => onChange("sdk")}
            testId="claude-backend-mode-sdk"
          />
          <BackendOption
            icon={Terminal}
            label="Claude Code CLI"
            description="Subprocess. Uses your installed claude CLI auth."
            selected={mode === "cli"}
            disabled={!cliAvailable}
            disabledReason="Install the Claude Code CLI to enable."
            onSelect={() => onChange("cli")}
            testId="claude-backend-mode-cli"
          />
        </div>
      </div>
    </div>
  );
}

interface BackendOptionProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  disabledReason: string;
  onSelect: () => void;
  testId: string;
}

function BackendOption({
  icon: Icon,
  label,
  description,
  selected,
  disabled,
  disabledReason,
  onSelect,
  testId,
}: BackendOptionProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onSelect}
      data-testid={testId}
      title={disabled ? disabledReason : undefined}
      className={cn(
        "text-left rounded-xl border p-4 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-emerald-500/40 bg-emerald-500/10"
          : "border-border/50 bg-muted/10 hover:bg-muted/20",
        disabled && "opacity-50 cursor-not-allowed hover:bg-muted/10",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
            selected
              ? "bg-emerald-500/15 border border-emerald-500/20"
              : "bg-muted/30 border border-border/40",
          )}
        >
          <Icon
            className={cn(
              "w-4 h-4",
              selected ? "text-emerald-500" : "text-muted-foreground",
            )}
          />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground/80 mt-0.5">
            {description}
          </p>
          {disabled && (
            <p className="text-xs text-amber-400/80 mt-1">{disabledReason}</p>
          )}
        </div>
      </div>
    </button>
  );
}

function CliAuthCard({
  status,
}: {
  status: "authenticated" | "not_authenticated" | "unknown";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl overflow-hidden border border-border/50",
        "bg-gradient-to-br from-card/90 via-card/70 to-card/80 backdrop-blur-xl",
        "shadow-sm shadow-black/5",
      )}
    >
      <div className="p-6 space-y-3">
        <h3 className="text-sm font-semibold text-foreground tracking-tight">
          Authentication
        </h3>

        {status === "authenticated" && (
          <div className="flex items-start gap-3 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 flex items-center justify-center border border-emerald-500/20 shrink-0 mt-0.5">
              <Shield className="w-4 h-4 text-emerald-500" />
            </div>
            <div>
              <p className="text-sm font-medium text-emerald-400">
                Authenticated
              </p>
              <p className="text-xs text-emerald-400/70 mt-0.5">
                Claude Code CLI is authenticated. Provider is ready to use.
              </p>
            </div>
          </div>
        )}

        {status === "not_authenticated" && (
          <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center border border-amber-500/20 shrink-0 mt-0.5">
              <ShieldOff className="w-4 h-4 text-amber-500" />
            </div>
            <div>
              <p className="text-sm font-medium text-amber-400">
                Not Authenticated
              </p>
              <p className="text-xs text-amber-400/70 mt-0.5">
                Run{" "}
                <code className="font-mono bg-amber-500/10 px-1 py-0.5 rounded">
                  claude auth login
                </code>{" "}
                in your terminal to authenticate with Claude Code.
              </p>
            </div>
          </div>
        )}

        {status === "unknown" && (
          <div className="flex items-start gap-3 p-4 rounded-xl bg-muted/20 border border-border/30">
            <div className="w-8 h-8 rounded-lg bg-muted/30 flex items-center justify-center border border-border/40 shrink-0 mt-0.5">
              <ShieldQuestion className="w-4 h-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Auth Status Unknown
              </p>
              <p className="text-xs text-muted-foreground/70 mt-0.5">
                Run{" "}
                <code className="font-mono bg-muted/30 px-1 py-0.5 rounded">
                  claude auth status
                </code>{" "}
                in your terminal to check authentication status.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ClaudeSettingsTab;
