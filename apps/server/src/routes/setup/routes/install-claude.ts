/**
 * POST /install-claude endpoint - Install Claude CLI
 */

import type { Request, Response } from 'express';
import { getErrorMessage, logError } from '../common.js';

export function createInstallClaudeHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      // In web mode, we can't install CLIs directly
      // Return instructions instead
      res.json({
        success: false,
        error:
          'CLI installation requires terminal access. Please install manually using: pnpm add -g @anthropic-ai/claude-code',
      });
    } catch (error) {
      logError(error, 'Install Claude CLI failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
