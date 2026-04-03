/**
 * POST /stage-files endpoint - Stage or unstage files in the main project
 */

import type { Request, Response } from 'express';
import { getErrorMessage, logError } from '../common.js';
import { stageFiles, StageFilesValidationError } from '../../../services/stage-files-service.js';

export function createStageFilesHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, files, operation } = req.body as {
        projectPath: string;
        files: string[];
        operation: 'stage' | 'unstage';
      };

      if (!projectPath) {
        res.status(400).json({
          success: false,
          error: 'projectPath required',
        });
        return;
      }

      if (!Array.isArray(files) || files.length === 0) {
        res.status(400).json({
          success: false,
          error: 'files array required and must not be empty',
        });
        return;
      }

      for (const file of files) {
        if (typeof file !== 'string' || file.trim() === '') {
          res.status(400).json({
            success: false,
            error: 'Each element of files must be a non-empty string',
          });
          return;
        }
      }

      if (operation !== 'stage' && operation !== 'unstage') {
        res.status(400).json({
          success: false,
          error: 'operation must be "stage" or "unstage"',
        });
        return;
      }

      const result = await stageFiles(projectPath, files, operation);

      res.json({
        success: true,
        result,
      });
    } catch (error) {
      if (error instanceof StageFilesValidationError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      logError(error, `${(req.body as { operation?: string })?.operation ?? 'stage'} files failed`);
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
