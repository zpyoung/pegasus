/**
 * POST /browse-project-files endpoint - Browse files and directories within a project
 *
 * Unlike /browse which only lists directories (for project folder selection),
 * this endpoint lists both files and directories relative to a project root.
 * Used by the file selector for "Copy files to worktree" settings.
 *
 * Features:
 * - Lists both files and directories
 * - Hides .git, .worktrees, node_modules, and other build artifacts
 * - Returns entries relative to the project root
 * - Supports navigating into subdirectories
 * - Security: prevents path traversal outside project root
 */

import type { Request, Response } from "express";
import * as secureFs from "../../../lib/secure-fs.js";
import path from "path";
import { PathNotAllowedError } from "@pegasus/platform";
import { getErrorMessage, logError } from "../common.js";

// Directories to hide from the listing (build artifacts, caches, etc.)
const HIDDEN_DIRECTORIES = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  ".pegasus",
  "__pycache__",
  ".cache",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".output",
  "coverage",
  ".nyc_output",
  "dist",
  "build",
  "out",
  ".tmp",
  "tmp",
  ".venv",
  "venv",
  "target",
  "vendor",
  ".gradle",
  ".idea",
  ".vscode",
]);

interface ProjectFileEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  isFile: boolean;
}

export function createBrowseProjectFilesHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath, relativePath } = req.body as {
        projectPath: string;
        relativePath?: string; // Relative path within the project to browse (empty = project root)
      };

      if (!projectPath) {
        res
          .status(400)
          .json({ success: false, error: "projectPath is required" });
        return;
      }

      const resolvedProjectPath = path.resolve(projectPath);

      // Determine the target directory to browse
      let targetPath = resolvedProjectPath;
      let currentRelativePath = "";

      if (relativePath) {
        // Security: normalize and validate the relative path
        const normalized = path.normalize(relativePath);
        if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
          res.status(400).json({
            success: false,
            error:
              "Invalid relative path - must be within the project directory",
          });
          return;
        }
        targetPath = path.join(resolvedProjectPath, normalized);
        currentRelativePath = normalized;

        // Double-check the resolved path is within the project
        // Use a separator-terminated prefix to prevent matching sibling dirs
        // that share the same prefix (e.g. /projects/foo vs /projects/foobar).
        const resolvedTarget = path.resolve(targetPath);
        const projectPrefix = resolvedProjectPath.endsWith(path.sep)
          ? resolvedProjectPath
          : resolvedProjectPath + path.sep;
        if (
          !resolvedTarget.startsWith(projectPrefix) &&
          resolvedTarget !== resolvedProjectPath
        ) {
          res.status(400).json({
            success: false,
            error: "Path traversal detected",
          });
          return;
        }
      }

      // Determine parent relative path
      let parentRelativePath: string | null = null;
      if (currentRelativePath) {
        const parent = path.dirname(currentRelativePath);
        parentRelativePath = parent === "." ? "" : parent;
      }

      try {
        const stat = await secureFs.stat(targetPath);

        if (!stat.isDirectory()) {
          res
            .status(400)
            .json({ success: false, error: "Path is not a directory" });
          return;
        }

        // Read directory contents
        const dirEntries = await secureFs.readdir(targetPath, {
          withFileTypes: true,
        });

        // Filter and map entries
        const entries: ProjectFileEntry[] = dirEntries
          .filter((entry) => {
            // Skip hidden directories (build artifacts, etc.)
            if (entry.isDirectory() && HIDDEN_DIRECTORIES.has(entry.name)) {
              return false;
            }
            // Skip entries starting with . (hidden files) except common config files
            // We keep hidden files visible since users often need .env, .eslintrc, etc.
            return true;
          })
          .map((entry) => {
            const entryRelativePath = currentRelativePath
              ? path.posix.join(
                  currentRelativePath.replace(/\\/g, "/"),
                  entry.name,
                )
              : entry.name;

            return {
              name: entry.name,
              relativePath: entryRelativePath,
              isDirectory: entry.isDirectory(),
              isFile: entry.isFile(),
            };
          })
          // Sort: directories first, then files, alphabetically within each group
          .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) {
              return a.isDirectory ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
          });

        res.json({
          success: true,
          currentRelativePath,
          parentRelativePath,
          entries,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to read directory";
        const isPermissionError =
          errorMessage.includes("EPERM") || errorMessage.includes("EACCES");

        if (isPermissionError) {
          res.json({
            success: true,
            currentRelativePath,
            parentRelativePath,
            entries: [],
            warning: "Permission denied - unable to read this directory",
          });
        } else {
          res.status(400).json({
            success: false,
            error: errorMessage,
          });
        }
      }
    } catch (error) {
      if (error instanceof PathNotAllowedError) {
        res.status(403).json({ success: false, error: getErrorMessage(error) });
        return;
      }

      logError(error, "Browse project files failed");
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
