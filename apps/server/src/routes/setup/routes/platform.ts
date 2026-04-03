/**
 * GET /platform endpoint - Get platform info
 */

import type { Request, Response } from 'express';
import os from 'os';
import { getErrorMessage, logError } from '../common.js';

export function createPlatformHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const platform = os.platform();
      res.json({
        success: true,
        platform,
        arch: os.arch(),
        homeDir: os.homedir(),
        isWindows: platform === 'win32',
        isMac: platform === 'darwin',
        isLinux: platform === 'linux',
      });
    } catch (error) {
      logError(error, 'Get platform info failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
