/**
 * POST /file-diff endpoint - Get diff for a specific file
 */

import type { Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getErrorMessage, logError } from '../common.js';
import { generateSyntheticDiffForNewFile } from '../../common.js';

const execAsync = promisify(exec);

export function createFileDiffHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, filePath } = req.body as {
        projectPath: string;
        filePath: string;
      };

      if (!projectPath || !filePath) {
        res.status(400).json({ success: false, error: 'projectPath and filePath required' });
        return;
      }

      try {
        // First check if the file is untracked
        const { stdout: status } = await execAsync(`git status --porcelain -- "${filePath}"`, {
          cwd: projectPath,
        });

        const isUntracked = status.trim().startsWith('??');

        let diff: string;
        if (isUntracked) {
          // Generate synthetic diff for untracked file
          diff = await generateSyntheticDiffForNewFile(projectPath, filePath);
        } else {
          // Use regular git diff for tracked files
          const result = await execAsync(`git diff HEAD -- "${filePath}"`, {
            cwd: projectPath,
            maxBuffer: 10 * 1024 * 1024,
          });
          diff = result.stdout;
        }

        res.json({ success: true, diff, filePath });
      } catch (innerError) {
        logError(innerError, 'Git file diff failed');
        res.json({ success: true, diff: '', filePath });
      }
    } catch (error) {
      logError(error, 'Get file diff failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
