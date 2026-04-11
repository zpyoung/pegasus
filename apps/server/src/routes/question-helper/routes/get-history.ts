/**
 * GET /history/:featureId — return in-memory chat history for FR-005 restore.
 */

import type { Request, Response } from 'express';
import type { QuestionHelperService } from '../../../services/question-helper-service.js';

export function createGetHistoryHandler(helperService: QuestionHelperService) {
  return (req: Request, res: Response): void => {
    const { featureId } = req.params as { featureId: string };

    if (!featureId) {
      res.status(400).json({ success: false, error: 'featureId is required' });
      return;
    }

    const history = helperService.getHistory(featureId);
    res.json({ success: true, history });
  };
}
