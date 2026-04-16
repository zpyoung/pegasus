/**
 * GET /claude-cli-status endpoint - Get Claude Code CLI installation and
 * three-state auth status backed by ProviderFactory (design ADR-3 / ADR-G1).
 *
 * This route is distinct from /claude-status (which serves the Claude SDK
 * provider). Do not merge or repoint the legacy route.
 */

import type { Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { ProviderFactory } from "../../../providers/provider-factory.js";
import { ClaudeCodeCliProvider } from "../../../providers/claude-cli-provider.js";
import { getErrorMessage, logError } from "../common.js";

const DISCONNECTED_MARKER_FILE = ".claude-cli-disconnected";

function isClaudeCliDisconnectedFromApp(): boolean {
  try {
    const projectRoot = process.cwd();
    const markerPath = path.join(
      projectRoot,
      ".pegasus",
      DISCONNECTED_MARKER_FILE,
    );
    return fs.existsSync(markerPath);
  } catch {
    return false;
  }
}

/**
 * Creates handler for GET /api/setup/claude-cli-status
 *
 * Returns the full InstallationStatus including the tri-state `authStatus`
 * field so the settings UI can render authenticated / not_authenticated /
 * unknown without transformation logic.
 */
export function createClaudeCliStatusHandler() {
  const installCommand = "npm install -g @anthropic-ai/claude-code";
  const loginCommand = "claude auth login";

  return async (_req: Request, res: Response): Promise<void> => {
    try {
      if (isClaudeCliDisconnectedFromApp()) {
        res.json({
          success: true,
          installed: true,
          version: null,
          path: null,
          method: "cli",
          authenticated: false,
          authStatus: "not_authenticated" as const,
          auth: {
            authenticated: false,
            method: "none",
          },
          installCommand,
          loginCommand,
        });
        return;
      }

      const provider = ProviderFactory.getProviderByName("claude-cli");
      if (!(provider instanceof ClaudeCodeCliProvider)) {
        res.status(500).json({
          success: false,
          error: "Claude CLI provider is not registered",
        });
        return;
      }

      const status = await provider.detectInstallation();

      res.json({
        success: true,
        installed: status.installed,
        version: status.version ?? null,
        path: status.path ?? null,
        method: status.method ?? "cli",
        authenticated: status.authenticated ?? false,
        authStatus: status.authStatus ?? "unknown",
        auth: {
          authenticated: status.authenticated ?? false,
          method: status.authenticated ? "cli" : "none",
        },
        error: status.error,
        installCommand,
        loginCommand,
      });
    } catch (error) {
      logError(error, "Get Claude CLI status failed");
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
