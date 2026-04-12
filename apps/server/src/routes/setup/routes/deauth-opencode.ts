import type { Request, Response } from "express";
import { logError, getErrorMessage } from "../common.js";
import * as fs from "fs";
import * as path from "path";

export function createDeauthOpencodeHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      // Create a marker file to indicate the CLI is disconnected from the app
      const pegasusDir = path.join(process.cwd(), ".pegasus");
      const markerPath = path.join(pegasusDir, ".opencode-disconnected");

      // Ensure .pegasus directory exists
      if (!fs.existsSync(pegasusDir)) {
        fs.mkdirSync(pegasusDir, { recursive: true });
      }

      // Create the marker file with timestamp
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          disconnectedAt: new Date().toISOString(),
          message: "OpenCode CLI is disconnected from the app",
        }),
      );

      res.json({
        success: true,
        message: "OpenCode CLI is now disconnected from the app",
      });
    } catch (error) {
      logError(error, "Deauth OpenCode failed");
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
        message: "Failed to disconnect OpenCode CLI from the app",
      });
    }
  };
}
