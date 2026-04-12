/**
 * POST /api/pipeline/copy-templates - Copy built-in pipeline templates to a project
 *
 * Copies built-in pipeline YAML templates to the project's `.pegasus/pipelines/`
 * directory so users can customize them. This is the recommended way to scaffold
 * pipeline customization for a project.
 *
 * Request body:
 * {
 *   projectPath: string;          // Absolute path to the project directory
 *   slugs?: string[];             // Specific built-in slugs to copy (default: all)
 *   overwrite?: boolean;          // Whether to overwrite existing files (default: false)
 * }
 *
 * Response:
 * {
 *   success: true;
 *   copied: string[];             // Slugs that were successfully copied
 *   skipped: string[];            // Slugs skipped (already exist and overwrite=false)
 *   errors: Array<{ slug: string; message: string }>;  // Slugs that failed
 * }
 */

import type { Request, Response } from "express";
import { ensurePipelinesDir, getPipelineFilePath } from "@pegasus/platform";
import * as secureFs from "../../../lib/secure-fs.js";
import {
  BUILT_IN_YAML_MAP,
  BUILT_IN_PIPELINE_SLUGS,
} from "../../../services/built-in-pipelines/index.js";
import { logger, getErrorMessage, logError } from "../common.js";

/** Result details for individual slug operations */
interface CopyResult {
  /** Slugs that were successfully written to disk */
  copied: string[];
  /** Slugs skipped because a file already exists and overwrite was false */
  skipped: string[];
  /** Slugs that failed with an error message */
  errors: Array<{ slug: string; message: string }>;
}

/**
 * Create handler for copying built-in pipeline templates to a project.
 *
 * POST /api/pipeline/copy-templates
 *
 * Copies one or more built-in pipeline YAML templates into the project's
 * `.pegasus/pipelines/` directory. This allows users to start with sensible
 * defaults and customize them for their specific project needs.
 *
 * By default, existing files are NOT overwritten. Pass `overwrite: true` to
 * replace existing pipeline files with fresh copies from the built-in templates.
 *
 * @returns Express request handler
 */
export function createCopyTemplatesHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const {
        projectPath,
        slugs,
        overwrite = false,
      } = req.body as {
        projectPath: string;
        slugs?: string[];
        overwrite?: boolean;
      };

      // ── Validate inputs ──────────────────────────────────────────────
      if (!projectPath) {
        res.status(400).json({
          success: false,
          error: "projectPath is required",
        });
        return;
      }

      // Determine which slugs to copy
      const requestedSlugs = slugs ?? [...BUILT_IN_PIPELINE_SLUGS];

      // Validate all requested slugs are valid built-in pipelines
      const invalidSlugs = requestedSlugs.filter(
        (slug) => !(slug in BUILT_IN_YAML_MAP),
      );
      if (invalidSlugs.length > 0) {
        res.status(400).json({
          success: false,
          error: `Unknown built-in pipeline slug(s): ${invalidSlugs.join(", ")}. Available: ${BUILT_IN_PIPELINE_SLUGS.join(", ")}`,
        });
        return;
      }

      if (requestedSlugs.length === 0) {
        res.status(400).json({
          success: false,
          error:
            "No pipeline slugs specified and no built-in pipelines available",
        });
        return;
      }

      // ── Ensure pipelines directory exists ────────────────────────────
      const pipelinesDir = await ensurePipelinesDir(projectPath);
      logger.info(
        `Copying ${requestedSlugs.length} built-in template(s) to ${pipelinesDir}` +
          (overwrite ? " (overwrite enabled)" : ""),
      );

      // ── Copy each template ──────────────────────────────────────────
      const result: CopyResult = {
        copied: [],
        skipped: [],
        errors: [],
      };

      for (const slug of requestedSlugs) {
        const destPath = getPipelineFilePath(projectPath, slug);

        try {
          // Check if file already exists
          if (!overwrite) {
            try {
              await secureFs.access(destPath);
              // File exists and overwrite is false — skip
              logger.info(`Skipping "${slug}" — already exists at ${destPath}`);
              result.skipped.push(slug);
              continue;
            } catch {
              // File doesn't exist — proceed with copy
            }
          }

          // Get the built-in YAML content
          const yamlContent = BUILT_IN_YAML_MAP[slug];

          // Write the YAML content to the project's pipelines directory
          await secureFs.writeFile(destPath, yamlContent, "utf-8");
          logger.info(`Copied built-in template "${slug}" to ${destPath}`);
          result.copied.push(slug);
        } catch (error) {
          const message = getErrorMessage(error);
          logger.error(`Failed to copy template "${slug}":`, error);
          result.errors.push({ slug, message });
        }
      }

      // ── Respond ─────────────────────────────────────────────────────
      logger.info(
        `Copy templates complete: ${result.copied.length} copied, ` +
          `${result.skipped.length} skipped, ${result.errors.length} error(s)`,
      );

      res.json({
        success: true,
        copied: result.copied,
        skipped: result.skipped,
        errors: result.errors,
      });
    } catch (error) {
      logError(error, "Copy pipeline templates failed");
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
      });
    }
  };
}
