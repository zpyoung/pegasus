/**
 * GET /claude-status endpoint - Get Claude CLI status
 */

import type { Request, Response } from 'express';
import { getClaudeStatus } from '../get-claude-status.js';
import { getErrorMessage, logError } from '../common.js';

export function createClaudeStatusHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const status = await getClaudeStatus();
      res.json({
        success: true,
        ...status,
      });
    } catch (error) {
      logError(error, 'Get Claude status failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
