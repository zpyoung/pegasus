/**
 * GET /api/settings/global - Retrieve global user settings
 *
 * Returns the complete GlobalSettings object with all user preferences,
 * keyboard shortcuts, AI profiles, and project history.
 *
 * Response: `{ "success": true, "settings": GlobalSettings }`
 */

import type { Request, Response } from "express";
import type { SettingsService } from "../../../services/settings-service.js";
import { getErrorMessage, logError } from "../common.js";

/**
 * Create handler factory for GET /api/settings/global
 *
 * @param settingsService - Instance of SettingsService for file I/O
 * @returns Express request handler
 */
export function createGetGlobalHandler(settingsService: SettingsService) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const settings = await settingsService.getGlobalSettings();

      res.json({
        success: true,
        settings,
      });
    } catch (error) {
      logError(error, "Get global settings failed");
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
