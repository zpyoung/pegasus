/**
 * POST /answer-question endpoint - Submit a user answer to an agent question
 */

import type { Request, Response } from 'express';
import type { AutoModeServiceCompat } from '../../../services/auto-mode/index.js';
import { createLogger } from '@pegasus/utils';
import { getErrorMessage, logError } from '../common.js';

const logger = createLogger('AutoMode');

export function createAnswerQuestionHandler(autoModeService: AutoModeServiceCompat) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { featureId, questionId, answer, projectPath } = req.body as {
        featureId: string;
        questionId: string;
        answer: string;
        projectPath: string;
      };

      if (!featureId) {
        res.status(400).json({ success: false, error: 'featureId is required' });
        return;
      }

      if (!questionId) {
        res.status(400).json({ success: false, error: 'questionId is required' });
        return;
      }

      if (typeof answer !== 'string') {
        res.status(400).json({ success: false, error: 'answer must be a string' });
        return;
      }

      if (!projectPath) {
        res.status(400).json({ success: false, error: 'projectPath is required' });
        return;
      }

      logger.info(
        `[AutoMode] Answering question ${questionId} for feature ${featureId}`
      );

      const result = await autoModeService.resolveQuestion(
        projectPath,
        featureId,
        questionId,
        answer
      );

      res.json({
        success: true,
        allAnswered: result.allAnswered,
        message: result.allAnswered
          ? 'All questions answered — feature will resume'
          : 'Answer recorded — waiting for remaining questions',
      });
    } catch (error) {
      logError(error, 'Answer question failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
