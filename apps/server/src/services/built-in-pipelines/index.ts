/**
 * Built-in Pipeline Templates - Default pipelines shipped with Pegasus
 *
 * These are the built-in pipeline definitions that are always available,
 * even when a project or user hasn't defined any custom pipelines.
 * They serve as sensible defaults and starting points for customization.
 *
 * Override hierarchy (highest priority first):
 *   1. Project-level: `.pegasus/pipelines/{slug}.yaml`
 *   2. User-level:    `~/.pegasus/pipelines/{slug}.yaml`
 *   3. Built-in:      These embedded templates (lowest priority)
 *
 * The YAML source files (bug-fix.yaml, feature.yaml) in this directory
 * are the canonical source of truth. The string constants below are
 * synchronized copies embedded for runtime access (tsc doesn't copy
 * non-TS files to dist/).
 */

import { parse as yamlParse } from 'yaml';
import type { YamlPipelineConfig, DiscoveredPipeline } from '@pegasus/types';

// ============================================================================
// Embedded YAML Content
// ============================================================================

/**
 * Built-in Bug Fix pipeline YAML content.
 *
 * Three-stage workflow: analyze → implement → verify
 * - Analyze: Read-only root cause analysis (plan mode)
 * - Implement: Apply minimal fix with approval gate (acceptEdits mode)
 * - Verify: Review changes and check for regressions (plan mode)
 */
export const BUG_FIX_YAML = `\
name: Bug Fix
description: Analyze, patch, and verify a reported bug

execution:
  mode: session

defaults:
  model: sonnet
  max_turns: 10
  permission_mode: plan

stages:
  - id: analyze
    name: Root Cause Analysis
    prompt: |
      Analyze this bug in a {{project.language}} project:

      {{task.description}}

      Steps:
      1. Search the codebase for files related to the bug description.
      2. Read the relevant source files and trace the code path that triggers the bug.
      3. Identify the root cause — explain exactly what is wrong and why.
      4. List all affected files and the specific lines/functions involved.
      5. Propose a minimal fix strategy (what to change and why).

      Do NOT make any code changes yet — analysis only.
    claude_flags:
      model: sonnet
      permission_mode: plan
      max_turns: 8

  - id: implement
    name: Apply Fix
    prompt: |
      Implement the fix for the bug you analyzed in the previous stage.

      Guidelines:
      - Be minimal and targeted — only change what is necessary to fix the bug.
      - Do not refactor unrelated code.
      - Follow the existing code style and patterns in the project.
      - Add or update tests to cover the bug scenario if a test command is available.
      {{#if project.test_command}}- Run tests with: {{project.test_command}}{{/if}}
      {{#if project.lint_command}}- Run linter with: {{project.lint_command}}{{/if}}
    claude_flags:
      model: sonnet
      permission_mode: acceptEdits
      max_turns: 15
    requires_approval: true

  - id: verify
    name: Verify Fix
    prompt: |
      Verify the fix is correct and complete:

      1. Review all changes made in the previous stage.
      2. Confirm the root cause identified in the analysis is addressed.
      3. Check for any regressions or unintended side effects.
      4. Verify edge cases are handled correctly.
      {{#if project.test_command}}5. Run the test suite: {{project.test_command}}{{/if}}

      If any issues are found, describe them clearly.
    claude_flags:
      permission_mode: plan
      max_turns: 5
`;

/**
 * Built-in Feature pipeline YAML content.
 *
 * Three-stage workflow: plan → implement → review
 * - Plan: Design implementation approach with approval gate (opus model, plan mode)
 * - Implement: Build the feature following the approved plan (acceptEdits mode)
 * - Review: Code quality review and test verification (plan mode)
 */
export const FEATURE_YAML = `\
name: Feature
description: Plan, implement, and review a new feature

execution:
  mode: session

defaults:
  model: sonnet
  max_turns: 10
  permission_mode: plan

stages:
  - id: plan
    name: Feature Planning
    prompt: |
      Plan the implementation for this feature in a {{project.language}} project:

      {{task.description}}

      Steps:
      1. Analyze the existing codebase to understand the architecture and patterns.
      2. Identify all files that need to be created or modified.
      3. Design the implementation approach, considering:
         - How it fits with existing code patterns and architecture
         - What new dependencies (if any) are needed
         - Edge cases and error handling
      4. Create a detailed implementation plan listing:
         - Each file to create/modify
         - The specific changes needed in each file
         - The order of implementation (dependency order)
      5. Identify any potential risks or trade-offs.

      Do NOT make any code changes yet — planning only.
    claude_flags:
      model: opus
      permission_mode: plan
      max_turns: 10
    requires_approval: true

  - id: implement
    name: Implement Feature
    prompt: |
      Implement the feature according to the approved plan from the previous stage.

      Guidelines:
      - Follow the implementation plan exactly, in the specified order.
      - Follow the existing code style and patterns in the project.
      - Write clean, well-documented code with appropriate comments.
      - Include error handling and input validation where appropriate.
      - Add or update tests to cover the new functionality.
      {{#if project.test_command}}- Run tests with: {{project.test_command}}{{/if}}
      {{#if project.lint_command}}- Run linter with: {{project.lint_command}}{{/if}}
    claude_flags:
      model: sonnet
      permission_mode: acceptEdits
      max_turns: 20
    requires_approval: false

  - id: review
    name: Code Review
    prompt: |
      Review the implemented code for quality and correctness:

      1. Verify all planned changes were implemented correctly.
      2. Check for code style consistency with the rest of the project.
      3. Look for potential bugs, edge cases, or error handling gaps.
      4. Verify tests adequately cover the new functionality.
      5. Check for any security concerns or performance issues.
      {{#if project.test_command}}6. Run the full test suite: {{project.test_command}}{{/if}}
      {{#if project.lint_command}}7. Run the linter: {{project.lint_command}}{{/if}}

      Suggest specific improvements if any issues are found.
    claude_flags:
      permission_mode: plan
      max_turns: 8
`;

// ============================================================================
// Parsed Pipeline Configurations
// ============================================================================

/** Map of built-in pipeline slug → raw YAML string */
export const BUILT_IN_YAML_MAP: Record<string, string> = {
  'bug-fix': BUG_FIX_YAML,
  'feature': FEATURE_YAML,
};

/** List of all built-in pipeline slugs */
export const BUILT_IN_PIPELINE_SLUGS = Object.keys(BUILT_IN_YAML_MAP);

/**
 * Parse a YAML string into a YamlPipelineConfig.
 *
 * @param yamlContent - Raw YAML string
 * @returns Parsed pipeline configuration
 * @throws If YAML parsing fails
 */
function parseBuiltInYaml(yamlContent: string): YamlPipelineConfig {
  return yamlParse(yamlContent) as YamlPipelineConfig;
}

/**
 * Get the parsed YamlPipelineConfig for a built-in pipeline.
 *
 * @param slug - Pipeline slug (e.g., "bug-fix", "feature")
 * @returns The parsed config, or undefined if slug is not a built-in pipeline
 */
export function getBuiltInPipelineConfig(slug: string): YamlPipelineConfig | undefined {
  const yaml = BUILT_IN_YAML_MAP[slug];
  if (!yaml) return undefined;
  return parseBuiltInYaml(yaml);
}

/**
 * Check if a pipeline slug corresponds to a built-in pipeline.
 *
 * @param slug - Pipeline slug to check
 * @returns true if the slug is a built-in pipeline
 */
export function isBuiltInPipeline(slug: string): boolean {
  return slug in BUILT_IN_YAML_MAP;
}

/**
 * Get all built-in pipelines as DiscoveredPipeline objects.
 *
 * Returns the built-in pipelines in the same format used by discoverPipelines(),
 * making it easy to merge them into the discovery results. Built-in pipelines
 * have the lowest priority and should be overridden by user-level or project-level
 * pipelines with the same slug.
 *
 * @returns Array of DiscoveredPipeline objects for all built-in pipelines
 */
export function getBuiltInPipelines(): DiscoveredPipeline[] {
  return BUILT_IN_PIPELINE_SLUGS.map((slug) => {
    const config = parseBuiltInYaml(BUILT_IN_YAML_MAP[slug]);
    return {
      slug,
      filePath: `built-in://${slug}`,
      config,
      stageCount: config.stages.length,
      isBuiltIn: true,
      source: 'user' as const, // Use 'user' source so project-level can override
    };
  });
}

/**
 * Get the raw YAML string for a built-in pipeline.
 *
 * Useful when you need to write the built-in template to disk (e.g., for
 * initializing a new project's `.pegasus/pipelines/` directory).
 *
 * @param slug - Pipeline slug (e.g., "bug-fix", "feature")
 * @returns Raw YAML string, or undefined if slug is not a built-in pipeline
 */
export function getBuiltInPipelineYaml(slug: string): string | undefined {
  return BUILT_IN_YAML_MAP[slug];
}
