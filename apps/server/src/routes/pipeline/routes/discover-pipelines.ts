/**
 * GET /api/pipeline/discover - Discover available YAML pipeline definitions
 *
 * Scans both user-level (~/.pegasus/pipelines/) and project-level
 * ({projectPath}/.pegasus/pipelines/) directories for YAML pipeline files,
 * validates them, and returns an array of DiscoveredPipeline objects.
 *
 * Project-level pipelines override user-level pipelines with the same slug.
 *
 * Query params: { projectPath: string }
 * Response: { success: true, pipelines: DiscoveredPipeline[] }
 */

import type { Request, Response } from "express";
import { discoverPipelines } from "../../../services/pipeline-compiler.js";
import { getErrorMessage, logError } from "../common.js";

/**
 * Create handler for discovering YAML pipeline definitions
 *
 * GET /api/pipeline/discover?projectPath=/path/to/project
 *
 * Returns:
 * {
 *   success: true,
 *   pipelines: DiscoveredPipeline[]
 * }
 */
export function createDiscoverPipelinesHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const projectPath = req.query.projectPath as string | undefined;

      if (!projectPath) {
        res.status(400).json({
          success: false,
          error: "projectPath query parameter is required",
        });
        return;
      }

      const pipelines = await discoverPipelines(projectPath);

      res.json({
        success: true,
        pipelines,
      });
    } catch (error) {
      logError(error, "Discover pipelines failed");
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
