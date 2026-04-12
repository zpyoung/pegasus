/**
 * Pipeline Compiler - Loads, validates, and compiles YAML pipeline definitions
 *
 * Handles the full lifecycle of YAML pipeline files stored in `.pegasus/pipelines/`:
 * 1. Load: Read and parse YAML files from disk
 * 2. Validate: Verify structure against Zod schemas with detailed error messages
 * 3. Compile: Merge defaults into stages to produce ResolvedStage[] for execution
 * 4. Stage Compile: Resolve Handlebars template variables in stage prompts
 *
 * Flow: YAML file → parse → validate (Zod) → YamlPipelineConfig → compile → ResolvedStage[]
 *       → compileStage (per-stage template resolution) → StageCompilationResult
 */

import { parse as yamlParse } from "yaml";
import Handlebars from "handlebars";
import { z } from "zod";
import { createLogger } from "@pegasus/utils";
import {
  getPipelineFilePath,
  getPipelinesDir,
  getUserPipelinesDir,
  getUserPipelineFilePath,
  systemPaths,
} from "@pegasus/platform";
import * as secureFs from "../lib/secure-fs.js";
import type {
  YamlPipelineConfig,
  ResolvedStage,
  DiscoveredPipeline,
  PipelineSource,
  StageCompilationContext,
  StageCompilationResult,
} from "@pegasus/types";

const logger = createLogger("PipelineCompiler");

// ============================================================================
// Default Values
// ============================================================================

/** Default model when neither stage nor pipeline defaults specify one */
const DEFAULT_MODEL = "sonnet";

/** Default maximum turns when neither stage nor pipeline defaults specify */
const DEFAULT_MAX_TURNS = 10;

/** Default permission mode when neither stage nor pipeline defaults specify */
const DEFAULT_PERMISSION_MODE = "plan";

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Schema for Claude CLI flag overrides per stage.
 * All fields are optional — unspecified fields fall back to pipeline defaults.
 */
export const claudeFlagsSchema = z
  .object({
    model: z.string().min(1, "Model must be a non-empty string").optional(),
    permission_mode: z
      .string()
      .min(1, "Permission mode must be a non-empty string")
      .optional(),
    max_turns: z
      .number()
      .int("max_turns must be an integer")
      .positive("max_turns must be a positive integer")
      .optional(),
  })
  .strict();

/**
 * Schema for a single pipeline stage definition.
 * Each stage requires an id, name, and prompt template.
 */
export const stageConfigSchema = z
  .object({
    id: z
      .string()
      .min(1, "Stage id must be a non-empty string")
      .regex(
        /^[a-z][a-z0-9_-]*$/,
        "Stage id must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores",
      ),
    name: z.string().min(1, "Stage name must be a non-empty string"),
    prompt: z.string().min(1, "Stage prompt must be a non-empty string"),
    claude_flags: claudeFlagsSchema.optional(),
    requires_approval: z.boolean().optional(),
    question: z
      .string()
      .min(1, "Question must be a non-empty string")
      .optional(),
    question_meta: z
      .object({
        type: z.enum(["free-text", "single-select", "multi-select"]).optional(),
        options: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strict();

/**
 * Schema for pipeline execution mode configuration.
 * Currently only "session" mode is supported.
 */
export const executionConfigSchema = z
  .object({
    mode: z.literal("session", 'Execution mode must be "session"'),
  })
  .strict();

/**
 * Schema for pipeline-level default settings.
 * These values are used as fallbacks for stages that don't override them.
 */
export const pipelineDefaultsSchema = z
  .object({
    model: z
      .string()
      .min(1, "Default model must be a non-empty string")
      .optional(),
    max_turns: z
      .number()
      .int("Default max_turns must be an integer")
      .positive("Default max_turns must be a positive integer")
      .optional(),
    permission_mode: z
      .string()
      .min(1, "Default permission_mode must be a non-empty string")
      .optional(),
  })
  .strict();

/**
 * Schema for a single declared pipeline input field.
 *
 * Each input field declares its type, whether it is required, an optional
 * default value, and an optional human-readable description for display in the UI.
 */
export const pipelineInputSchema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().optional(),
  })
  .strict();

/**
 * Top-level schema for a complete YAML pipeline configuration file.
 *
 * Validates the entire structure including nested stages, ensuring:
 * - Required fields (name, description, stages) are present
 * - At least one stage is defined
 * - Stage IDs are unique across the pipeline
 * - All nested objects conform to their schemas
 */
export const yamlPipelineConfigSchema = z
  .object({
    name: z.string().min(1, "Pipeline name must be a non-empty string"),
    description: z
      .string()
      .min(1, "Pipeline description must be a non-empty string"),
    execution: executionConfigSchema.optional(),
    defaults: pipelineDefaultsSchema.optional(),
    inputs: z.record(z.string(), pipelineInputSchema).optional(),
    stages: z
      .array(stageConfigSchema)
      .min(1, "Pipeline must have at least one stage"),
  })
  .strict()
  .refine(
    (config) => {
      const ids = config.stages.map((s) => s.id);
      return new Set(ids).size === ids.length;
    },
    {
      message: "Stage IDs must be unique within a pipeline",
      path: ["stages"],
    },
  );

// ============================================================================
// Validation Result Types
// ============================================================================

/** A validation error with a human-readable path and message */
export interface PipelineValidationError {
  /** Dot-path to the invalid field (e.g., "stages[0].id") */
  path: string;
  /** Human-readable error description */
  message: string;
}

/** Result of pipeline validation */
export interface PipelineValidationResult {
  /** Whether the pipeline configuration is valid */
  valid: boolean;
  /** Array of validation errors (empty when valid) */
  errors: PipelineValidationError[];
  /** The validated config (only present when valid) */
  config?: YamlPipelineConfig;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a parsed pipeline configuration object against the Zod schema.
 *
 * Returns a structured result with detailed error paths and messages for each
 * validation failure. When validation succeeds, the typed config is returned.
 *
 * @param data - Raw parsed data (typically from YAML.parse)
 * @returns Validation result with errors array and optional typed config
 *
 * @example
 * ```ts
 * const raw = yamlParse(yamlString);
 * const result = validatePipeline(raw);
 * if (result.valid) {
 *   console.log(result.config.name); // typed as YamlPipelineConfig
 * } else {
 *   console.error(result.errors); // detailed error list
 * }
 * ```
 */
export function validatePipeline(data: unknown): PipelineValidationResult {
  const result = yamlPipelineConfigSchema.safeParse(data);

  if (result.success) {
    // The Zod schema validates the exact shape of YamlPipelineConfig
    const config = result.data as unknown as YamlPipelineConfig;
    return {
      valid: true,
      errors: [],
      config,
    };
  }

  const errors: PipelineValidationError[] = result.error.issues.map(
    (issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
      message: issue.message,
    }),
  );

  return {
    valid: false,
    errors,
  };
}

/**
 * Format validation errors into a human-readable multi-line string.
 *
 * @param errors - Array of validation errors
 * @returns Formatted string suitable for logging or user display
 */
export function formatValidationErrors(
  errors: PipelineValidationError[],
): string {
  if (errors.length === 0) return "No errors";
  return errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
}

// ============================================================================
// Loading
// ============================================================================

/**
 * Load and validate a pipeline YAML file from disk.
 *
 * Reads the YAML file for the given pipeline slug, parses it, and validates
 * against the Zod schema. Returns the typed configuration on success, or
 * throws with detailed error information on failure.
 *
 * @param projectPath - Absolute path to the project directory
 * @param pipelineSlug - Pipeline identifier (e.g., "feature", "bug-fix")
 * @returns Promise resolving to the validated YamlPipelineConfig
 * @throws Error if the file cannot be read, parsed, or fails validation
 *
 * @example
 * ```ts
 * const config = await loadPipeline('/path/to/project', 'feature');
 * console.log(config.name); // "Feature"
 * console.log(config.stages.length); // number of stages
 * ```
 */
export async function loadPipeline(
  projectPath: string,
  pipelineSlug: string,
): Promise<YamlPipelineConfig> {
  const filePath = getPipelineFilePath(projectPath, pipelineSlug);

  // Read the YAML file
  let rawContent: string;
  try {
    rawContent = (await secureFs.readFile(filePath, "utf-8")) as string;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Pipeline "${pipelineSlug}" not found at ${filePath}`);
    }
    throw new Error(
      `Failed to read pipeline "${pipelineSlug}": ${(error as Error).message}`,
    );
  }

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = yamlParse(rawContent);
  } catch (error) {
    throw new Error(
      `Failed to parse pipeline YAML "${pipelineSlug}": ${(error as Error).message}`,
    );
  }

  // Validate against schema
  const validation = validatePipeline(parsed);
  if (!validation.valid) {
    const errorDetails = formatValidationErrors(validation.errors);
    throw new Error(
      `Pipeline "${pipelineSlug}" failed validation:\n${errorDetails}`,
    );
  }

  logger.info(
    `Loaded pipeline "${pipelineSlug}" with ${validation.config!.stages.length} stages`,
  );
  return validation.config!;
}

// ============================================================================
// Compilation (defaults merging)
// ============================================================================

/**
 * Compile a validated pipeline config into an array of resolved stages.
 *
 * Merges pipeline-level defaults into each stage's settings, applying the
 * cascade: stage claude_flags > pipeline defaults > built-in defaults.
 *
 * @param config - A validated YamlPipelineConfig
 * @returns Array of ResolvedStage objects ready for execution
 *
 * @example
 * ```ts
 * const config = await loadPipeline(projectPath, 'feature');
 * const stages = compilePipeline(config);
 * // Each stage now has guaranteed model, permission_mode, max_turns values
 * ```
 */
export function compilePipeline(config: YamlPipelineConfig): ResolvedStage[] {
  const defaults = config.defaults ?? {};

  return config.stages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    prompt: stage.prompt,
    model: stage.claude_flags?.model ?? defaults.model ?? DEFAULT_MODEL,
    permission_mode:
      stage.claude_flags?.permission_mode ??
      defaults.permission_mode ??
      DEFAULT_PERMISSION_MODE,
    max_turns:
      stage.claude_flags?.max_turns ?? defaults.max_turns ?? DEFAULT_MAX_TURNS,
    requires_approval: stage.requires_approval ?? false,
    question: stage.question,
    question_meta: stage.question_meta,
  }));
}

// ============================================================================
// Stage Compilation (Handlebars template resolution)
// ============================================================================

/**
 * Regex pattern to extract Handlebars variable references from a template string.
 *
 * Matches simple `{{variable.path}}` expressions, ignoring:
 * - Block helpers: `{{#if ...}}`, `{{/if}}`
 * - Partial inclusions: `{{> partial}}`
 * - Comments: `{{! comment }}`
 * - Triple-stash (unescaped): `{{{var}}}` is included (same variable reference)
 *
 * Captures the dot-path portion (e.g., "task.description", "project.language").
 */
const TEMPLATE_VARIABLE_REGEX =
  /\{\{\{?\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}?\}\}/g;

/**
 * Extract all Handlebars variable references from a template string.
 *
 * Parses the template to find all `{{variable.path}}` expressions and returns
 * a deduplicated array of variable paths.
 *
 * @param template - The Handlebars template string to scan
 * @returns Deduplicated array of variable paths (e.g., ["task.description", "project.language"])
 *
 * @example
 * ```ts
 * extractTemplateVariables('Hello {{task.description}} in {{project.language}}')
 * // → ["task.description", "project.language"]
 * ```
 */
export function extractTemplateVariables(template: string): string[] {
  const variables = new Set<string>();
  let match: RegExpExecArray | null;

  // Reset regex state for reuse
  TEMPLATE_VARIABLE_REGEX.lastIndex = 0;

  while ((match = TEMPLATE_VARIABLE_REGEX.exec(template)) !== null) {
    variables.add(match[1]);
  }

  return [...variables];
}

/**
 * Resolve a dot-separated variable path against a nested context object.
 *
 * Traverses the context object following the dot-separated path segments.
 * Returns `undefined` if any segment along the path is missing or not an object.
 *
 * @param context - The nested context object to resolve against
 * @param path - Dot-separated path (e.g., "task.description", "project.language")
 * @returns The resolved value, or `undefined` if the path doesn't exist
 *
 * @example
 * ```ts
 * resolveVariablePath({ task: { description: 'Add auth' } }, 'task.description')
 * // → 'Add auth'
 *
 * resolveVariablePath({ task: { description: 'Add auth' } }, 'project.language')
 * // → undefined
 * ```
 */
function resolveVariablePath(
  context: Record<string, unknown>,
  path: string,
): unknown {
  const segments = path.split(".");
  let current: unknown = context;

  for (const segment of segments) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Find template variables referenced in the prompt that are missing from the context.
 *
 * Extracts all variable references from the template, then checks each one against
 * the provided context. A variable is considered "missing" if it resolves to
 * `undefined` or `null` in the context.
 *
 * @param template - The Handlebars template string
 * @param context - The flat context object to check against
 * @returns Array of missing variable paths (e.g., ["project.test_command"])
 */
function findMissingVariables(
  template: string,
  context: Record<string, unknown>,
): string[] {
  const referenced = extractTemplateVariables(template);
  return referenced.filter((varPath) => {
    const value = resolveVariablePath(context, varPath);
    return value === undefined || value === null;
  });
}

/**
 * Compile a single stage's prompt template using Handlebars.
 *
 * Resolves all `{{variable.path}}` expressions in the stage's prompt using
 * the provided compilation context. Also detects any template variables that
 * are referenced but not provided in the context.
 *
 * The context is flattened into a namespace structure for Handlebars:
 * - `task.*` → feature/task properties (description, title, etc.)
 * - `project.*` → project config values (language, test_command, etc.)
 * - `inputs.*` → user-provided pipeline input values
 * - `previous_context` → accumulated output from prior stages
 *
 * Missing variables are rendered as empty strings (Handlebars default behavior)
 * but are reported in the result so callers can warn users or take corrective action.
 *
 * @param stage - A ResolvedStage (from compilePipeline) with an unresolved prompt template
 * @param context - The StageCompilationContext providing template variable values
 * @returns StageCompilationResult with the resolved stage and any missing variable warnings
 *
 * @example
 * ```ts
 * const stage: ResolvedStage = {
 *   id: 'plan',
 *   name: 'Feature Planning',
 *   prompt: 'Plan {{task.description}} in {{project.language}}',
 *   model: 'opus',
 *   permission_mode: 'plan',
 *   max_turns: 10,
 *   requires_approval: true,
 * };
 *
 * const context: StageCompilationContext = {
 *   task: { description: 'Add user authentication' },
 *   project: { language: 'TypeScript' },
 * };
 *
 * const result = compileStage(stage, context);
 * // result.stage.prompt === 'Plan Add user authentication in TypeScript'
 * // result.missingVariables === []
 * // result.hasMissingVariables === false
 * ```
 *
 * @example
 * ```ts
 * // With missing variables:
 * const result = compileStage(stage, {
 *   task: { description: 'Fix bug' },
 *   project: {},
 * });
 * // result.stage.prompt === 'Plan Fix bug in '
 * // result.missingVariables === ['project.language']
 * // result.hasMissingVariables === true
 * ```
 */
export function compileStage(
  stage: ResolvedStage,
  context: StageCompilationContext,
): StageCompilationResult {
  // Build a flat context object for Handlebars resolution
  const templateContext: Record<string, unknown> = {
    task: context.task,
    project: context.project,
    inputs: context.inputs ?? {},
    previous_context: context.previous_context ?? "",
    stages: context.stages ?? {},
  };

  // Detect missing variables before compilation
  const missingVariables = findMissingVariables(stage.prompt, templateContext);

  if (missingVariables.length > 0) {
    logger.warn(
      `Stage "${stage.id}" has missing template variables: ${missingVariables.join(", ")}`,
    );
  }

  // Compile the Handlebars template and resolve variables
  let resolvedPrompt: string;
  try {
    const template = Handlebars.compile(stage.prompt, {
      // Disable prototype access for security (prevents accessing __proto__, constructor, etc.)
      noEscape: true, // Don't HTML-escape values — prompts are plain text, not HTML
      strict: false, // Don't throw on missing variables — we handle detection separately
    });
    resolvedPrompt = template(templateContext);
  } catch (error) {
    logger.error(`Failed to compile template for stage "${stage.id}":`, error);
    // Fall back to the raw prompt on template compilation failure
    resolvedPrompt = stage.prompt;
  }

  return {
    stage: {
      ...stage,
      prompt: resolvedPrompt,
    },
    missingVariables,
    hasMissingVariables: missingVariables.length > 0,
  };
}

/**
 * Compile all stages in a pipeline, resolving template variables in each prompt.
 *
 * Convenience function that applies compileStage() to every stage from compilePipeline().
 * Returns results for all stages, with aggregated missing variable information.
 *
 * @param stages - Array of ResolvedStage objects (from compilePipeline)
 * @param context - The StageCompilationContext providing template variable values
 * @returns Array of StageCompilationResult objects, one per stage
 *
 * @example
 * ```ts
 * const config = await loadPipeline(projectPath, 'feature');
 * const stages = compilePipeline(config);
 * const results = compileAllStages(stages, {
 *   task: { description: 'Add dark mode' },
 *   project: { language: 'TypeScript', test_command: 'pnpm test' },
 * });
 *
 * // Check for any missing variables across all stages
 * const allMissing = results.flatMap(r => r.missingVariables);
 * if (allMissing.length > 0) {
 *   console.warn('Missing template variables:', [...new Set(allMissing)]);
 * }
 * ```
 */
export function compileAllStages(
  stages: ResolvedStage[],
  context: StageCompilationContext,
): StageCompilationResult[] {
  return stages.map((stage) => compileStage(stage, context));
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Load and validate a user-level pipeline YAML file from `~/.pegasus/pipelines/`.
 *
 * Uses `systemPaths` for file access since user-level paths are outside the
 * project's allowed root directory (secureFs would reject them).
 *
 * @param pipelineSlug - Pipeline identifier (e.g., "feature", "bug-fix")
 * @returns Promise resolving to the validated YamlPipelineConfig
 * @throws Error if the file cannot be read, parsed, or fails validation
 */
async function loadUserPipeline(
  pipelineSlug: string,
): Promise<YamlPipelineConfig> {
  const filePath = getUserPipelineFilePath(pipelineSlug);

  // Read the YAML file using systemPaths (not secureFs — path is outside project root)
  let rawContent: string;
  try {
    rawContent = (await systemPaths.systemPathReadFile(
      filePath,
      "utf-8",
    )) as string;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `User pipeline "${pipelineSlug}" not found at ${filePath}`,
      );
    }
    throw new Error(
      `Failed to read user pipeline "${pipelineSlug}": ${(error as Error).message}`,
    );
  }

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = yamlParse(rawContent);
  } catch (error) {
    throw new Error(
      `Failed to parse user pipeline YAML "${pipelineSlug}": ${(error as Error).message}`,
    );
  }

  // Validate against schema
  const validation = validatePipeline(parsed);
  if (!validation.valid) {
    const errorDetails = formatValidationErrors(validation.errors);
    throw new Error(
      `User pipeline "${pipelineSlug}" failed validation:\n${errorDetails}`,
    );
  }

  logger.info(
    `Loaded user pipeline "${pipelineSlug}" with ${validation.config!.stages.length} stages`,
  );
  return validation.config!;
}

/**
 * Scan a directory for `.yaml` pipeline files and return their filenames.
 *
 * @param dirPath - Absolute path to the directory to scan
 * @param source - Whether this is a 'project' or 'user' directory (determines fs adapter)
 * @returns Array of `.yaml` filenames found in the directory, or empty array if dir doesn't exist
 */
async function scanPipelineDirectory(
  dirPath: string,
  source: PipelineSource,
): Promise<string[]> {
  let entries: string[];

  try {
    if (source === "user") {
      // User-level directory: use systemPaths (outside project root)
      entries = await systemPaths.systemPathReaddir(dirPath);
    } else {
      // Project-level directory: use secureFs (within project root)
      entries = (await secureFs.readdir(dirPath)) as string[];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logger.debug(`No pipelines directory at ${dirPath}`);
      return [];
    }
    logger.error(`Failed to read pipelines directory ${dirPath}:`, error);
    return [];
  }

  // Filter to only .yaml files
  return entries.filter((f) => f.endsWith(".yaml"));
}

/**
 * Discover all available pipeline YAML files from both project and user-level directories.
 *
 * Scans two locations for pipeline definitions:
 * 1. **User-level** (`~/.pegasus/pipelines/`): Shared pipelines available across all projects
 * 2. **Project-level** (`{projectPath}/.pegasus/pipelines/`): Project-specific pipelines
 *
 * **Override logic**: When both locations contain a pipeline with the same slug,
 * the project-level pipeline takes precedence. This allows users to define shared
 * default pipelines in their home directory while enabling project-specific overrides.
 *
 * Each discovered pipeline is loaded, validated against the Zod schema, and tagged
 * with its `source`. Invalid files are logged as warnings but skipped.
 *
 * @param projectPath - Absolute path to the project directory
 * @returns Promise resolving to array of DiscoveredPipeline objects (deduplicated by slug)
 *
 * @example
 * ```ts
 * const pipelines = await discoverPipelines('/path/to/project');
 * pipelines.forEach(p => {
 *   console.log(`${p.slug}: ${p.config.name} (${p.stageCount} stages, source: ${p.source})`);
 * });
 * ```
 *
 * @example
 * ```ts
 * // Override scenario:
 * // ~/.pegasus/pipelines/feature.yaml       → user-level "Feature" pipeline
 * // .pegasus/pipelines/feature.yaml          → project-level "Custom Feature" pipeline
 * // Result: Only the project-level "Custom Feature" pipeline is returned for slug "feature"
 * ```
 */
export async function discoverPipelines(
  projectPath: string,
): Promise<DiscoveredPipeline[]> {
  // Map of slug → DiscoveredPipeline (user-level pipelines added first, then overridden by project)
  const pipelineMap = new Map<string, DiscoveredPipeline>();

  // 1. Scan user-level pipelines (~/.pegasus/pipelines/)
  const userDir = getUserPipelinesDir();
  const userYamlFiles = await scanPipelineDirectory(userDir, "user");

  for (const filename of userYamlFiles) {
    const slug = filename.replace(/\.yaml$/, "");

    try {
      const config = await loadUserPipeline(slug);
      pipelineMap.set(slug, {
        slug,
        filePath: getUserPipelineFilePath(slug),
        config,
        stageCount: config.stages.length,
        isBuiltIn: false,
        source: "user",
      });
    } catch (error) {
      logger.warn(
        `Skipping invalid user pipeline "${slug}": ${(error as Error).message}`,
      );
    }
  }

  if (userYamlFiles.length > 0) {
    logger.info(
      `Discovered ${pipelineMap.size} valid user-level pipeline(s) from ${userDir}`,
    );
  }

  // 2. Scan project-level pipelines (.pegasus/pipelines/) — these override user-level
  const projectDir = getPipelinesDir(projectPath);
  const projectYamlFiles = await scanPipelineDirectory(projectDir, "project");
  let projectCount = 0;
  let overrideCount = 0;

  for (const filename of projectYamlFiles) {
    const slug = filename.replace(/\.yaml$/, "");

    try {
      const config = await loadPipeline(projectPath, slug);

      if (pipelineMap.has(slug)) {
        logger.info(`Project pipeline "${slug}" overrides user-level pipeline`);
        overrideCount++;
      }

      pipelineMap.set(slug, {
        slug,
        filePath: getPipelineFilePath(projectPath, slug),
        config,
        stageCount: config.stages.length,
        isBuiltIn: false,
        source: "project",
      });
      projectCount++;
    } catch (error) {
      logger.warn(
        `Skipping invalid project pipeline "${slug}": ${(error as Error).message}`,
      );
    }
  }

  if (projectYamlFiles.length > 0) {
    logger.info(
      `Discovered ${projectCount} valid project-level pipeline(s) from ${projectDir}` +
        (overrideCount > 0 ? ` (${overrideCount} override(s))` : ""),
    );
  }

  const discovered = [...pipelineMap.values()];
  logger.info(
    `Total: ${discovered.length} pipeline(s) available for ${projectPath}`,
  );
  return discovered;
}

// ============================================================================
// Convenience: Load + Compile
// ============================================================================

/**
 * Load, validate, and compile a pipeline in one step.
 *
 * Convenience function that combines loadPipeline() and compilePipeline()
 * for the common case where you need resolved stages ready for execution.
 *
 * @param projectPath - Absolute path to the project directory
 * @param pipelineSlug - Pipeline identifier (e.g., "feature", "bug-fix")
 * @returns Promise resolving to array of ResolvedStage objects
 * @throws Error if loading or validation fails
 */
export async function loadAndCompilePipeline(
  projectPath: string,
  pipelineSlug: string,
): Promise<ResolvedStage[]> {
  const config = await loadPipeline(projectPath, pipelineSlug);
  return compilePipeline(config);
}
