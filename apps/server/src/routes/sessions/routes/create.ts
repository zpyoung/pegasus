/**
 * POST / endpoint - Create a new session
 */

import type { Request, Response } from 'express';
import { AgentService } from '../../../services/agent-service.js';
import { getErrorMessage, logError } from '../common.js';

export function createCreateHandler(agentService: AgentService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { name, projectPath, workingDirectory, model } = req.body as {
        name: string;
        projectPath?: string;
        workingDirectory?: string;
        model?: string;
      };

      if (!name) {
        res.status(400).json({ success: false, error: 'name is required' });
        return;
      }

      const session = await agentService.createSession(name, projectPath, workingDirectory, model);
      res.json({ success: true, session });
    } catch (error) {
      logError(error, 'Create session failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
