/**
 * POST /model endpoint - Set session model
 */

import type { Request, Response } from 'express';
import { AgentService } from '../../../services/agent-service.js';
import { getErrorMessage, logError } from '../common.js';

export function createModelHandler(agentService: AgentService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { sessionId, model } = req.body as {
        sessionId: string;
        model: string;
      };

      if (!sessionId || !model) {
        res.status(400).json({ success: false, error: 'sessionId and model are required' });
        return;
      }

      const result = await agentService.setSessionModel(sessionId, model);
      res.json({ success: result });
    } catch (error) {
      logError(error, 'Set session model failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
