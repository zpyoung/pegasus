/**
 * POST /api/settings/migrate - Migrate settings from localStorage to file storage
 *
 * Called during onboarding when UI detects localStorage data but no settings files.
 * Extracts settings from various localStorage keys and writes to new file structure.
 * Collects errors but continues on partial failures (graceful degradation).
 *
 * Request body:
 * ```json
 * {
 *   "data": {
 *     "pegasus-storage"?: string,
 *     "pegasus-setup"?: string,
 *     "worktree-panel-collapsed"?: string,
 *     "file-browser-recent-folders"?: string,
 *     "pegasus:lastProjectDir"?: string
 *   }
 * }
 * ```
 *
 * Response:
 * ```json
 * {
 *   "success": boolean,
 *   "migratedGlobalSettings": boolean,
 *   "migratedCredentials": boolean,
 *   "migratedProjectCount": number,
 *   "errors": string[]
 * }
 * ```
 */

import type { Request, Response } from 'express';
import type { SettingsService } from '../../../services/settings-service.js';
import { getErrorMessage, logError, logger } from '../common.js';

/**
 * Create handler factory for POST /api/settings/migrate
 *
 * @param settingsService - Instance of SettingsService for file I/O
 * @returns Express request handler
 */
export function createMigrateHandler(settingsService: SettingsService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { data } = req.body as {
        data?: {
          'pegasus-storage'?: string;
          'pegasus-setup'?: string;
          'worktree-panel-collapsed'?: string;
          'file-browser-recent-folders'?: string;
          'pegasus:lastProjectDir'?: string;
        };
      };

      if (!data || typeof data !== 'object') {
        res.status(400).json({
          success: false,
          error: 'data object is required containing localStorage data',
        });
        return;
      }

      logger.info('Starting settings migration from localStorage');

      const result = await settingsService.migrateFromLocalStorage(data);

      if (result.success) {
        logger.info(`Migration successful: ${result.migratedProjectCount} projects migrated`);
      } else {
        logger.warn(`Migration completed with errors: ${result.errors.join(', ')}`);
      }

      res.json({
        success: result.success,
        migratedGlobalSettings: result.migratedGlobalSettings,
        migratedCredentials: result.migratedCredentials,
        migratedProjectCount: result.migratedProjectCount,
        errors: result.errors,
      });
    } catch (error) {
      logError(error, 'Migration failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
