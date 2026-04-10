/**
 * POST /add-suggestion - Add an analysis suggestion to the idea board as a raw idea
 *
 * Redirected from creating Features directly to creating Ideas (status=raw),
 * so AI-generated suggestions land in the Idea Board rather than going
 * directly into Automode's eligible pool (ADR-003).
 */

import type { Request, Response } from 'express';
import type { IdeationService } from '../../../services/ideation-service.js';
import type { FeatureLoader } from '../../../services/feature-loader.js';
import type { AnalysisSuggestion } from '@pegasus/types';
import { getErrorMessage, logError } from '../common.js';

export function createAddSuggestionHandler(
  ideationService: IdeationService,
  _featureLoader: FeatureLoader
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, suggestion } = req.body as {
        projectPath: string;
        suggestion: AnalysisSuggestion;
      };

      if (!projectPath) {
        res.status(400).json({ success: false, error: 'projectPath is required' });
        return;
      }

      if (!suggestion) {
        res.status(400).json({ success: false, error: 'suggestion is required' });
        return;
      }

      if (!suggestion.title) {
        res.status(400).json({ success: false, error: 'suggestion.title is required' });
        return;
      }

      // Build description with rationale if provided
      const description = suggestion.rationale
        ? `${suggestion.description}\n\n**Rationale:** ${suggestion.rationale}`
        : suggestion.description ?? '';

      // Create a raw idea instead of a feature (ADR-003: redirect AI output through Idea entity)
      const idea = await ideationService.createIdea(projectPath, {
        title: suggestion.title,
        description,
        category: suggestion.category,
        status: 'raw',
      });

      res.json({ success: true, ideaId: idea.id });
    } catch (error) {
      logError(error, 'Add suggestion to board failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
