/**
 * POST /stop endpoint - Stop execution
 */

import type { Request, Response } from 'express';
import { AgentService } from '../../../services/agent-service.js';
import { getErrorMessage, logError } from '../common.js';

export function createStopHandler(agentService: AgentService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { sessionId } = req.body as { sessionId: string };

      if (!sessionId) {
        res.status(400).json({ success: false, error: 'sessionId is required' });
        return;
      }

      const result = await agentService.stopExecution(sessionId);
      res.json(result);
    } catch (error) {
      logError(error, 'Stop execution failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
