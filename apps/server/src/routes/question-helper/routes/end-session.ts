/**
 * POST /end-session — terminate the helper session for a feature.
 * Called when the user closes the dialog or submits answers (FR-006).
 */

import type { Request, Response } from "express";
import type { QuestionHelperService } from "../../../services/question-helper-service.js";

export function createEndSessionHandler(helperService: QuestionHelperService) {
  return (req: Request, res: Response): void => {
    const { featureId } = req.body as { featureId?: string };

    if (!featureId) {
      res.status(400).json({ success: false, error: "featureId is required" });
      return;
    }

    helperService.terminateSession(featureId);
    res.json({ success: true });
  };
}
