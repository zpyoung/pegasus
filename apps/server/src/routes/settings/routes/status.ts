/**
 * GET /api/settings/status - Get settings migration and availability status
 *
 * Checks which settings files exist to determine if migration from localStorage
 * is needed. Used by UI during onboarding to decide whether to show migration flow.
 *
 * Response:
 * ```json
 * {
 *   "success": true,
 *   "hasGlobalSettings": boolean,
 *   "hasCredentials": boolean,
 *   "dataDir": string,
 *   "needsMigration": boolean
 * }
 * ```
 */

import type { Request, Response } from "express";
import type { SettingsService } from "../../../services/settings-service.js";
import { getErrorMessage, logError } from "../common.js";

/**
 * Create handler factory for GET /api/settings/status
 *
 * @param settingsService - Instance of SettingsService for file I/O
 * @returns Express request handler
 */
export function createStatusHandler(settingsService: SettingsService) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const hasGlobalSettings = await settingsService.hasGlobalSettings();
      const hasCredentials = await settingsService.hasCredentials();

      res.json({
        success: true,
        hasGlobalSettings,
        hasCredentials,
        dataDir: settingsService.getDataDir(),
        needsMigration: !hasGlobalSettings,
      });
    } catch (error) {
      logError(error, "Get settings status failed");
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
