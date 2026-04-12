/**
 * Project initialization utilities
 *
 * Handles the setup of the .pegasus directory structure when opening
 * new or existing projects.
 */

import { createLogger } from "@pegasus/utils/logger";
import { getElectronAPI } from "./electron";

const logger = createLogger("ProjectInit");

export interface ProjectInitResult {
  success: boolean;
  isNewProject: boolean;
  error?: string;
  createdFiles?: string[];
  existingFiles?: string[];
}

/**
 * Required files and directories in the .pegasus directory
 * Note: app_spec.txt is NOT created automatically - user must set it up via the spec editor
 */
const REQUIRED_STRUCTURE: {
  directories: string[];
  files: Record<string, string>;
} = {
  directories: [
    ".pegasus",
    ".pegasus/context",
    ".pegasus/features",
    ".pegasus/images",
  ],
  files: {
    ".pegasus/categories.json": "[]",
  },
};

/**
 * Lines that should be in .gitignore for the .pegasus directory.
 * Tracked items (config.yaml, pipelines/, context/) are NOT listed here.
 */
const PEGASUS_GITIGNORE_ENTRIES = [
  "# Pegasus runtime files",
  ".pegasus/pegasus.db",
  ".pegasus/pegasus.db-wal",
  ".pegasus/pegasus.db-shm",
  ".pegasus/logs/",
  ".pegasus/categories.json",
  ".pegasus/events/",
  ".pegasus/memory/",
  ".pegasus/features/",
  ".pegasus/images/",
  ".pegasus/settings.json",
  ".pegasus/settings.json.*",
  ".pegasus/active-branches.json",
  ".pegasus/notifications.json",
];

/**
 * Initializes the .pegasus directory structure for a project
 *
 * @param projectPath - The root path of the project
 * @returns Result indicating what was created or if the project was already initialized
 */
export async function initializeProject(
  projectPath: string,
): Promise<ProjectInitResult> {
  const api = getElectronAPI();
  const createdFiles: string[] = [];
  const existingFiles: string[] = [];

  try {
    // Validate that the project directory exists and is a directory
    const projectExists = await api.exists(projectPath);
    if (!projectExists) {
      return {
        success: false,
        isNewProject: false,
        error: `Project directory does not exist: ${projectPath}. Create it first before initializing.`,
      };
    }

    // Verify it's actually a directory (not a file)
    const projectStat = await api.stat(projectPath);
    if (!projectStat.success) {
      return {
        success: false,
        isNewProject: false,
        error:
          projectStat.error ||
          `Failed to stat project directory: ${projectPath}`,
      };
    }

    if (projectStat.stats && !projectStat.stats.isDirectory) {
      return {
        success: false,
        isNewProject: false,
        error: `Project path is not a directory: ${projectPath}`,
      };
    }

    // Initialize git repository if it doesn't exist
    const gitDirExists = await api.exists(`${projectPath}/.git`);
    if (!gitDirExists) {
      logger.info("Initializing git repository...");
      try {
        // Initialize git and create an initial empty commit via server route
        const result = await api.worktree?.initGit(projectPath);
        if (result?.success && result.result?.initialized) {
          createdFiles.push(".git");
          logger.info("Git repository initialized with initial commit");
        } else if (result?.success && !result.result?.initialized) {
          // Git already existed (shouldn't happen since we checked, but handle it)
          existingFiles.push(".git");
          logger.info("Git repository already exists");
        } else {
          logger.warn("Failed to initialize git repository:", result?.error);
        }
      } catch (gitError) {
        logger.warn("Failed to initialize git repository:", gitError);
        // Don't fail the whole initialization if git init fails
      }
    } else {
      existingFiles.push(".git");
    }

    // Create all required directories in parallel
    await Promise.all(
      REQUIRED_STRUCTURE.directories.map((dir) =>
        api.mkdir(`${projectPath}/${dir}`),
      ),
    );

    // Check and create required files in parallel
    await Promise.all(
      Object.entries(REQUIRED_STRUCTURE.files).map(
        async ([relativePath, defaultContent]) => {
          const fullPath = `${projectPath}/${relativePath}`;
          const exists = await api.exists(fullPath);

          if (!exists) {
            await api.writeFile(fullPath, defaultContent as string);
            createdFiles.push(relativePath);
          } else {
            existingFiles.push(relativePath);
          }
        },
      ),
    );

    // Ensure .gitignore has pegasus entries
    await ensureGitignoreEntries(projectPath, api);

    // Determine if this is a new project (no files needed to be created since features/ is empty by default)
    const isNewProject =
      createdFiles.length === 0 && existingFiles.length === 0;

    return {
      success: true,
      isNewProject,
      createdFiles,
      existingFiles,
    };
  } catch (error) {
    logger.error("Failed to initialize project:", error);
    return {
      success: false,
      isNewProject: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

/**
 * Ensures .gitignore contains the required .pegasus ignore entries.
 * Appends missing entries without duplicating existing ones.
 */
async function ensureGitignoreEntries(
  projectPath: string,
  api: ReturnType<typeof getElectronAPI>,
): Promise<void> {
  const gitignorePath = `${projectPath}/.gitignore`;

  try {
    let content = "";
    const exists = await api.exists(gitignorePath);
    if (exists) {
      const result = await api.readFile(gitignorePath);
      content = result.content || "";
    }

    const existingLines = new Set(
      content.split("\n").map((line) => line.trim()),
    );
    const missing = PEGASUS_GITIGNORE_ENTRIES.filter(
      (entry) => !existingLines.has(entry),
    );

    if (missing.length === 0) {
      return;
    }

    const suffix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    const block = missing.join("\n") + "\n";
    await api.writeFile(gitignorePath, content + suffix + block);
    logger.info(`Added ${missing.length} entries to .gitignore`);
  } catch (error) {
    logger.warn("Failed to update .gitignore:", error);
  }
}

/**
 * Checks if a project has the required .pegasus structure
 *
 * @param projectPath - The root path of the project
 * @returns true if all required files/directories exist
 */
export async function isProjectInitialized(
  projectPath: string,
): Promise<boolean> {
  const api = getElectronAPI();

  try {
    // Check all required directories exist (no files required - features/ folder is source of truth)
    for (const dir of REQUIRED_STRUCTURE.directories) {
      const fullPath = `${projectPath}/${dir}`;
      const exists = await api.exists(fullPath);
      if (!exists) {
        return false;
      }
    }

    return true;
  } catch (error) {
    logger.error("Error checking project initialization:", error);
    return false;
  }
}

/**
 * Gets a summary of what needs to be initialized for a project
 *
 * @param projectPath - The root path of the project
 * @returns List of missing files/directories
 */
export async function getProjectInitStatus(projectPath: string): Promise<{
  initialized: boolean;
  missingFiles: string[];
  existingFiles: string[];
}> {
  const api = getElectronAPI();
  const missingFiles: string[] = [];
  const existingFiles: string[] = [];

  try {
    // Check directories (no files required - features/ folder is source of truth)
    for (const dir of REQUIRED_STRUCTURE.directories) {
      const fullPath = `${projectPath}/${dir}`;
      const exists = await api.exists(fullPath);
      if (exists) {
        existingFiles.push(dir);
      } else {
        missingFiles.push(dir);
      }
    }

    return {
      initialized: missingFiles.length === 0,
      missingFiles,
      existingFiles,
    };
  } catch (error) {
    logger.error("Error getting project status:", error);
    return {
      initialized: false,
      missingFiles: REQUIRED_STRUCTURE.directories,
      existingFiles: [],
    };
  }
}

/**
 * Checks if the app_spec.txt file exists for a project
 *
 * @param projectPath - The root path of the project
 * @returns true if app_spec.txt exists
 */
export async function hasAppSpec(projectPath: string): Promise<boolean> {
  const api = getElectronAPI();
  try {
    const fullPath = `${projectPath}/.pegasus/app_spec.txt`;
    return await api.exists(fullPath);
  } catch (error) {
    logger.error("Error checking app_spec.txt:", error);
    return false;
  }
}

/**
 * Checks if the .pegasus directory exists for a project
 *
 * @param projectPath - The root path of the project
 * @returns true if .pegasus directory exists
 */
export async function hasPegasusDir(projectPath: string): Promise<boolean> {
  const api = getElectronAPI();
  try {
    const fullPath = `${projectPath}/.pegasus`;
    return await api.exists(fullPath);
  } catch (error) {
    logger.error("Error checking .pegasus dir:", error);
    return false;
  }
}
