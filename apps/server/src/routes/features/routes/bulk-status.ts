/**
 * POST /bulk-status endpoint - Return lightweight {id, status, title} for all features
 *
 * Used by the board view to poll feature status without loading full Feature objects,
 * reducing payload size and avoiding per-card individual queries.
 */

import type { Request, Response } from "express";
import { FeatureLoader } from "../../../services/feature-loader.js";
import { getErrorMessage, logError } from "../common.js";

interface BulkStatusEntry {
  id: string;
  status?: string;
  title?: string;
}

export function createBulkStatusHandler(featureLoader: FeatureLoader) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath } = req.body as { projectPath?: string };

      if (!projectPath) {
        res
          .status(400)
          .json({ success: false, error: "projectPath is required" });
        return;
      }

      const features = await featureLoader.getAll(projectPath);

      const statuses: BulkStatusEntry[] = features.map((f) => ({
        id: f.id,
        status: f.status,
        title: f.title,
      }));

      res.json({ success: true, statuses });
    } catch (error) {
      logError(error, "Bulk status features failed");
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
