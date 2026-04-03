import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import type { YamlPipelineConfig, ResolvedStage } from '@pegasus/types';

// ============================================================================
// Mocks
// ============================================================================

// Mock secure-fs (used for project-level file operations)
vi.mock('@/lib/secure-fs.js', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

// Mock @pegasus/platform
vi.mock('@pegasus/platform', () => ({
  getPipelinesDir: vi.fn((projectPath: string) =>
    path.join(projectPath, '.pegasus', 'pipelines')
  ),
  getPipelineFilePath: vi.fn((projectPath: string, slug: string) =>
    path.join(projectPath, '.pegasus', 'pipelines', `${slug}.yaml`)
  ),
  getUserPipelinesDir: vi.fn(() =>
    path.join(os.homedir(), '.pegasus', 'pipelines')
  ),
  getUserPipelineFilePath: vi.fn((slug: string) =>
    path.join(os.homedir(), '.pegasus', 'pipelines', `${slug}.yaml`)
  ),
  systemPaths: {
    systemPathReaddir: vi.fn(),
    systemPathReadFile: vi.fn(),
  },
}));

// Mock @pegasus/utils
vi.mock('@pegasus/utils', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Import after mocks are set up
import * as secureFs from '@/lib/secure-fs.js';
import { systemPaths, getPipelineFilePath } from '@pegasus/platform';
import {
  discoverPipelines,
  validatePipeline,
  compilePipeline,
  loadPipeline,
  loadAndCompilePipeline,
  formatValidationErrors,
  extractTemplateVariables,
  compileStage,
  compileAllStages,
} from '@/services/pipeline-compiler.js';

// ============================================================================
// Test Fixtures
// ============================================================================

/** Minimal valid YAML string for a pipeline */
const VALID_PIPELINE_YAML = `
name: Feature
description: Plan, implement, and test a new feature
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
      Plan the implementation for this feature:
      {{task.description}}
    claude_flags:
      model: opus
      permission_mode: plan
    requires_approval: true
  - id: implement
    name: Implement Feature
    prompt: |
      Implement the feature based on the plan.
    claude_flags:
      model: sonnet
      permission_mode: acceptEdits
`;

const VALID_PIPELINE_CONFIG: YamlPipelineConfig = {
  name: 'Feature',
  description: 'Plan, implement, and test a new feature',
  execution: { mode: 'session' },
  defaults: { model: 'sonnet', max_turns: 10, permission_mode: 'plan' },
  stages: [
    {
      id: 'plan',
      name: 'Feature Planning',
      prompt: 'Plan the implementation for this feature:\n{{task.description}}\n',
      claude_flags: { model: 'opus', permission_mode: 'plan' },
      requires_approval: true,
    },
    {
      id: 'implement',
      name: 'Implement Feature',
      prompt: 'Implement the feature based on the plan.\n',
      claude_flags: { model: 'sonnet', permission_mode: 'acceptEdits' },
    },
  ],
};

/** User-level pipeline YAML — different from project-level */
const USER_PIPELINE_YAML = `
name: User Feature
description: User-level default feature pipeline
execution:
  mode: session
defaults:
  model: haiku
  max_turns: 5
  permission_mode: plan
stages:
  - id: quick-plan
    name: Quick Plan
    prompt: |
      Quickly plan: {{task.description}}
`;

/** A second pipeline (bug-fix) for testing multi-pipeline discovery */
const BUG_FIX_PIPELINE_YAML = `
name: Bug Fix
description: Fix a reported bug
execution:
  mode: session
defaults:
  model: sonnet
  max_turns: 8
stages:
  - id: investigate
    name: Investigate Bug
    prompt: |
      Investigate the bug: {{task.description}}
  - id: fix
    name: Fix Bug
    prompt: |
      Apply the fix.
`;

/** Minimal valid YAML without optional fields */
const MINIMAL_PIPELINE_YAML = `
name: Minimal
description: Minimal pipeline
stages:
  - id: step
    name: Step
    prompt: Do the thing
`;

// ============================================================================
// Helper: create a ResolvedStage for compileStage tests
// ============================================================================

function makeResolvedStage(overrides: Partial<ResolvedStage> = {}): ResolvedStage {
  return {
    id: 'test-stage',
    name: 'Test Stage',
    prompt: 'Default prompt',
    model: 'sonnet',
    permission_mode: 'plan',
    max_turns: 10,
    requires_approval: false,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('pipeline-compiler.ts', () => {
  const PROJECT_PATH = '/test/project';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================================
  // Tests: loadPipeline
  // ============================================================================

  describe('loadPipeline', () => {
    it('should load and validate a pipeline from disk', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue(VALID_PIPELINE_YAML as any);

      const config = await loadPipeline(PROJECT_PATH, 'feature');

      expect(config.name).toBe('Feature');
      expect(config.stages).toHaveLength(2);
    });

    it('should return all expected config properties', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue(VALID_PIPELINE_YAML as any);

      const config = await loadPipeline(PROJECT_PATH, 'feature');

      expect(config.name).toBe('Feature');
      expect(config.description).toBe('Plan, implement, and test a new feature');
      expect(config.execution).toEqual({ mode: 'session' });
      expect(config.defaults).toEqual({
        model: 'sonnet',
        max_turns: 10,
        permission_mode: 'plan',
      });
      expect(config.stages[0].id).toBe('plan');
      expect(config.stages[0].requires_approval).toBe(true);
      expect(config.stages[1].id).toBe('implement');
    });

    it('should read from the correct file path', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue(VALID_PIPELINE_YAML as any);

      await loadPipeline(PROJECT_PATH, 'my-pipeline');

      const expectedPath = path.join(PROJECT_PATH, '.pegasus', 'pipelines', 'my-pipeline.yaml');
      expect(secureFs.readFile).toHaveBeenCalledWith(expectedPath, 'utf-8');
    });

    it('should throw when file not found (ENOENT)', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      vi.mocked(secureFs.readFile).mockRejectedValue(enoent);

      await expect(loadPipeline(PROJECT_PATH, 'missing')).rejects.toThrow(
        /Pipeline "missing" not found/
      );
    });

    it('should throw with descriptive error on non-ENOENT read failure', async () => {
      const permError = new Error('Permission denied') as NodeJS.ErrnoException;
      permError.code = 'EACCES';
      vi.mocked(secureFs.readFile).mockRejectedValue(permError);

      await expect(loadPipeline(PROJECT_PATH, 'restricted')).rejects.toThrow(
        /Failed to read pipeline "restricted"/
      );
    });

    it('should throw on malformed YAML syntax', async () => {
      // Invalid YAML that will cause the parser to throw
      vi.mocked(secureFs.readFile).mockResolvedValue('  invalid:\n    - [broken: yaml: {{' as any);

      await expect(loadPipeline(PROJECT_PATH, 'broken')).rejects.toThrow(
        /Failed to parse pipeline YAML "broken"/
      );
    });

    it('should throw on invalid YAML content (fails schema validation)', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue('name: incomplete' as any);

      await expect(loadPipeline(PROJECT_PATH, 'bad')).rejects.toThrow(/failed validation/);
    });

    it('should load a pipeline with minimal fields (no execution or defaults)', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue(MINIMAL_PIPELINE_YAML as any);

      const config = await loadPipeline(PROJECT_PATH, 'minimal');

      expect(config.name).toBe('Minimal');
      expect(config.stages).toHaveLength(1);
      expect(config.stages[0].id).toBe('step');
    });

    it('should throw when YAML parses to null', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue('' as any);

      await expect(loadPipeline(PROJECT_PATH, 'empty')).rejects.toThrow(/failed validation/);
    });

    it('should throw on YAML with duplicate stage IDs', async () => {
      const duplicateYaml = `
name: Dup
description: Duplicate stage IDs
stages:
  - id: step
    name: Step 1
    prompt: Do thing 1
  - id: step
    name: Step 2
    prompt: Do thing 2
`;
      vi.mocked(secureFs.readFile).mockResolvedValue(duplicateYaml as any);

      await expect(loadPipeline(PROJECT_PATH, 'dup')).rejects.toThrow(/failed validation/);
    });
  });

  // ============================================================================
  // Tests: loadAndCompilePipeline
  // ============================================================================

  describe('loadAndCompilePipeline', () => {
    it('should load, validate, and compile a pipeline in one step', async () => {
      vi.mocked(secureFs.readFile).mockResolvedValue(VALID_PIPELINE_YAML as any);

      const stages = await loadAndCompilePipeline(PROJECT_PATH, 'feature');

      expect(stages).toHaveLength(2);
      expect(stages[0].id).toBe('plan');
      expect(stages[0].model).toBe('opus');
      expect(stages[1].id).toBe('implement');
      expect(stages[1].model).toBe('sonnet');
    });

    it('should propagate load errors', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      vi.mocked(secureFs.readFile).mockRejectedValue(enoent);

      await expect(loadAndCompilePipeline(PROJECT_PATH, 'missing')).rejects.toThrow(
        /Pipeline "missing" not found/
      );
    });
  });

  // ============================================================================
  // Tests: validatePipeline
  // ============================================================================

  describe('validatePipeline', () => {
    it('should validate a correct pipeline config', () => {
      const result = validatePipeline(VALID_PIPELINE_CONFIG);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.config).toBeDefined();
      expect(result.config!.name).toBe('Feature');
    });

    it('should return config with all expected properties on success', () => {
      const result = validatePipeline(VALID_PIPELINE_CONFIG);

      expect(result.valid).toBe(true);
      expect(result.config!.name).toBe('Feature');
      expect(result.config!.description).toBe('Plan, implement, and test a new feature');
      expect(result.config!.execution).toEqual({ mode: 'session' });
      expect(result.config!.defaults).toEqual({
        model: 'sonnet',
        max_turns: 10,
        permission_mode: 'plan',
      });
      expect(result.config!.stages).toHaveLength(2);
    });

    it('should validate a minimal config without optional fields', () => {
      const result = validatePipeline({
        name: 'Minimal',
        description: 'No optional fields',
        stages: [{ id: 'step', name: 'Step', prompt: 'Do thing' }],
      });

      expect(result.valid).toBe(true);
      expect(result.config!.execution).toBeUndefined();
      expect(result.config!.defaults).toBeUndefined();
    });

    it('should reject a pipeline with no stages', () => {
      const result = validatePipeline({
        name: 'Empty',
        description: 'No stages',
        stages: [],
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject a pipeline with duplicate stage IDs', () => {
      const result = validatePipeline({
        name: 'Duplicate',
        description: 'Has duplicate IDs',
        stages: [
          { id: 'step', name: 'Step 1', prompt: 'Do thing 1' },
          { id: 'step', name: 'Step 2', prompt: 'Do thing 2' },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('unique'))).toBe(true);
    });

    it('should detect three duplicate stage IDs', () => {
      const result = validatePipeline({
        name: 'Triple Dup',
        description: 'Three duplicates',
        stages: [
          { id: 'step', name: 'Step 1', prompt: 'Do thing 1' },
          { id: 'step', name: 'Step 2', prompt: 'Do thing 2' },
          { id: 'step', name: 'Step 3', prompt: 'Do thing 3' },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('unique'))).toBe(true);
    });

    it('should reject a pipeline with missing name', () => {
      const result = validatePipeline({
        description: 'Missing name',
        stages: [{ id: 'step', name: 'Step', prompt: 'Do thing' }],
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject a pipeline with missing description', () => {
      const result = validatePipeline({
        name: 'No Description',
        stages: [{ id: 'step', name: 'Step', prompt: 'Do thing' }],
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject a pipeline with empty name', () => {
      const result = validatePipeline({
        name: '',
        description: 'Empty name',
        stages: [{ id: 'step', name: 'Step', prompt: 'Do thing' }],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject a pipeline with empty description', () => {
      const result = validatePipeline({
        name: 'Test',
        description: '',
        stages: [{ id: 'step', name: 'Step', prompt: 'Do thing' }],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject a stage with invalid ID format (uppercase)', () => {
      const result = validatePipeline({
        name: 'Bad ID',
        description: 'Has bad stage ID',
        stages: [{ id: 'Invalid-ID', name: 'Step', prompt: 'Do thing' }],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject a stage ID starting with a number', () => {
      const result = validatePipeline({
        name: 'Numeric ID',
        description: 'Stage ID starts with number',
        stages: [{ id: '1step', name: 'Step', prompt: 'Do thing' }],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject a stage ID with spaces', () => {
      const result = validatePipeline({
        name: 'Spaced ID',
        description: 'Stage ID has spaces',
        stages: [{ id: 'my step', name: 'Step', prompt: 'Do thing' }],
      });

      expect(result.valid).toBe(false);
    });

    it('should accept a stage ID with hyphens and underscores', () => {
      const result = validatePipeline({
        name: 'Good IDs',
        description: 'Valid stage IDs',
        stages: [
          { id: 'my-step', name: 'Step 1', prompt: 'Do thing 1' },
          { id: 'my_step', name: 'Step 2', prompt: 'Do thing 2' },
          { id: 'step-1', name: 'Step 3', prompt: 'Do thing 3' },
        ],
      });

      expect(result.valid).toBe(true);
    });

    it('should reject a stage with empty name', () => {
      const result = validatePipeline({
        name: 'Empty Stage Name',
        description: 'Stage has empty name',
        stages: [{ id: 'step', name: '', prompt: 'Do thing' }],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject a stage with empty prompt', () => {
      const result = validatePipeline({
        name: 'Empty Prompt',
        description: 'Stage has empty prompt',
        stages: [{ id: 'step', name: 'Step', prompt: '' }],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject extra unknown top-level fields (strict mode)', () => {
      const result = validatePipeline({
        name: 'Extra Fields',
        description: 'Has unknown field',
        stages: [{ id: 'step', name: 'Step', prompt: 'Do thing' }],
        unknown_field: 'should fail',
      });

      expect(result.valid).toBe(false);
    });

    it('should reject extra unknown fields in a stage (strict mode)', () => {
      const result = validatePipeline({
        name: 'Extra Stage Fields',
        description: 'Stage has unknown field',
        stages: [{ id: 'step', name: 'Step', prompt: 'Do thing', unknown_flag: true }],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject extra unknown fields in claude_flags (strict mode)', () => {
      const result = validatePipeline({
        name: 'Extra Flags',
        description: 'claude_flags has unknown field',
        stages: [
          {
            id: 'step',
            name: 'Step',
            prompt: 'Do thing',
            claude_flags: { model: 'sonnet', temperature: 0.7 },
          },
        ],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject negative max_turns', () => {
      const result = validatePipeline({
        name: 'Negative Turns',
        description: 'Negative max_turns',
        stages: [
          {
            id: 'step',
            name: 'Step',
            prompt: 'Do thing',
            claude_flags: { max_turns: -5 },
          },
        ],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject zero max_turns', () => {
      const result = validatePipeline({
        name: 'Zero Turns',
        description: 'Zero max_turns',
        stages: [
          {
            id: 'step',
            name: 'Step',
            prompt: 'Do thing',
            claude_flags: { max_turns: 0 },
          },
        ],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject non-integer max_turns (float)', () => {
      const result = validatePipeline({
        name: 'Float Turns',
        description: 'Float max_turns',
        stages: [
          {
            id: 'step',
            name: 'Step',
            prompt: 'Do thing',
            claude_flags: { max_turns: 5.5 },
          },
        ],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject negative max_turns in pipeline defaults', () => {
      const result = validatePipeline({
        name: 'Bad Defaults',
        description: 'Negative default max_turns',
        defaults: { max_turns: -1 },
        stages: [{ id: 'step', name: 'Step', prompt: 'Do thing' }],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject empty model string in claude_flags', () => {
      const result = validatePipeline({
        name: 'Empty Model',
        description: 'Empty model string',
        stages: [
          {
            id: 'step',
            name: 'Step',
            prompt: 'Do thing',
            claude_flags: { model: '' },
          },
        ],
      });

      expect(result.valid).toBe(false);
    });

    it('should reject null input', () => {
      const result = validatePipeline(null);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject undefined input', () => {
      const result = validatePipeline(undefined);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject a non-object input', () => {
      const result = validatePipeline('not an object');

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should report multiple validation errors at once', () => {
      const result = validatePipeline({
        // Missing: name, description
        stages: [],
      });

      expect(result.valid).toBe(false);
      // Should report errors for both missing name, missing description, and empty stages
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it('should not return config when validation fails', () => {
      const result = validatePipeline({
        name: 'Invalid',
        description: 'Missing stages',
        stages: [],
      });

      expect(result.valid).toBe(false);
      expect(result.config).toBeUndefined();
    });

    it('should accept valid requires_approval boolean', () => {
      const result = validatePipeline({
        name: 'Approval',
        description: 'With approval gate',
        stages: [
          { id: 'step', name: 'Step', prompt: 'Do thing', requires_approval: true },
        ],
      });

      expect(result.valid).toBe(true);
      expect(result.config!.stages[0].requires_approval).toBe(true);
    });

    it('should accept valid execution config with mode session', () => {
      const result = validatePipeline({
        name: 'Session',
        description: 'With execution config',
        execution: { mode: 'session' },
        stages: [{ id: 'step', name: 'Step', prompt: 'Do thing' }],
      });

      expect(result.valid).toBe(true);
      expect(result.config!.execution!.mode).toBe('session');
    });

    it('should include path in error for nested validation issues', () => {
      const result = validatePipeline({
        name: 'Bad Nested',
        description: 'Nested error',
        stages: [{ id: 'step', name: 'Step', prompt: 'Do thing', claude_flags: { max_turns: -1 } }],
      });

      expect(result.valid).toBe(false);
      // Verify at least one error has a meaningful path
      const hasNestedPath = result.errors.some(
        (e) => e.path.includes('stages') || e.path.includes('claude_flags') || e.path.includes('max_turns')
      );
      expect(hasNestedPath).toBe(true);
    });
  });

  // ============================================================================
  // Tests: formatValidationErrors
  // ============================================================================

  describe('formatValidationErrors', () => {
    it('should return "No errors" for empty array', () => {
      expect(formatValidationErrors([])).toBe('No errors');
    });

    it('should format errors with path and message', () => {
      const result = formatValidationErrors([
        { path: 'stages[0].id', message: 'Must be non-empty' },
        { path: 'name', message: 'Required' },
      ]);

      expect(result).toContain('stages[0].id: Must be non-empty');
      expect(result).toContain('name: Required');
    });

    it('should format a single error', () => {
      const result = formatValidationErrors([
        { path: 'stages', message: 'Must have at least one stage' },
      ]);

      expect(result).toBe('  - stages: Must have at least one stage');
    });

    it('should join multiple errors with newlines', () => {
      const result = formatValidationErrors([
        { path: 'a', message: 'Error A' },
        { path: 'b', message: 'Error B' },
        { path: 'c', message: 'Error C' },
      ]);

      const lines = result.split('\n');
      expect(lines).toHaveLength(3);
    });
  });

  // ============================================================================
  // Tests: compilePipeline (defaults merging)
  // ============================================================================

  describe('compilePipeline', () => {
    it('should merge stage claude_flags over pipeline defaults', () => {
      const stages = compilePipeline(VALID_PIPELINE_CONFIG);

      expect(stages).toHaveLength(2);
      // Stage 0 (plan) has claude_flags that override defaults
      expect(stages[0].model).toBe('opus');
      expect(stages[0].permission_mode).toBe('plan');
      expect(stages[0].max_turns).toBe(10); // Falls back to pipeline default
      expect(stages[0].requires_approval).toBe(true);

      // Stage 1 (implement) has its own claude_flags
      expect(stages[1].model).toBe('sonnet');
      expect(stages[1].permission_mode).toBe('acceptEdits');
      expect(stages[1].max_turns).toBe(10); // Falls back to pipeline default
      expect(stages[1].requires_approval).toBe(false);
    });

    it('should use built-in defaults when no pipeline defaults and no stage flags', () => {
      const config: YamlPipelineConfig = {
        name: 'Minimal',
        description: 'No defaults',
        stages: [
          { id: 'step', name: 'Step', prompt: 'Do thing' },
        ],
      };

      const stages = compilePipeline(config);

      expect(stages[0].model).toBe('sonnet');
      expect(stages[0].permission_mode).toBe('plan');
      expect(stages[0].max_turns).toBe(10);
      expect(stages[0].requires_approval).toBe(false);
    });

    it('should preserve stage id, name, and prompt', () => {
      const config: YamlPipelineConfig = {
        name: 'Test',
        description: 'Test',
        stages: [
          { id: 'my-step', name: 'My Step', prompt: 'Do the thing please' },
        ],
      };

      const stages = compilePipeline(config);

      expect(stages[0].id).toBe('my-step');
      expect(stages[0].name).toBe('My Step');
      expect(stages[0].prompt).toBe('Do the thing please');
    });

    it('should use pipeline defaults when stage has no claude_flags', () => {
      const config: YamlPipelineConfig = {
        name: 'Defaults Test',
        description: 'Pipeline has defaults, stage has no flags',
        defaults: { model: 'opus', max_turns: 20, permission_mode: 'acceptEdits' },
        stages: [
          { id: 'step', name: 'Step', prompt: 'Do thing' },
        ],
      };

      const stages = compilePipeline(config);

      expect(stages[0].model).toBe('opus');
      expect(stages[0].max_turns).toBe(20);
      expect(stages[0].permission_mode).toBe('acceptEdits');
    });

    it('should handle partial pipeline defaults with built-in fallback', () => {
      const config: YamlPipelineConfig = {
        name: 'Partial Defaults',
        description: 'Only model specified in defaults',
        defaults: { model: 'opus' },
        stages: [
          { id: 'step', name: 'Step', prompt: 'Do thing' },
        ],
      };

      const stages = compilePipeline(config);

      expect(stages[0].model).toBe('opus'); // From pipeline defaults
      expect(stages[0].max_turns).toBe(10); // Built-in default
      expect(stages[0].permission_mode).toBe('plan'); // Built-in default
    });

    it('should handle partial stage claude_flags with pipeline default fallback', () => {
      const config: YamlPipelineConfig = {
        name: 'Partial Flags',
        description: 'Stage only overrides model',
        defaults: { model: 'haiku', max_turns: 15, permission_mode: 'acceptEdits' },
        stages: [
          {
            id: 'step',
            name: 'Step',
            prompt: 'Do thing',
            claude_flags: { model: 'opus' },
          },
        ],
      };

      const stages = compilePipeline(config);

      expect(stages[0].model).toBe('opus'); // Stage override
      expect(stages[0].max_turns).toBe(15); // Pipeline default
      expect(stages[0].permission_mode).toBe('acceptEdits'); // Pipeline default
    });

    it('should compile multiple stages independently', () => {
      const config: YamlPipelineConfig = {
        name: 'Multi',
        description: 'Multiple stages with different overrides',
        defaults: { model: 'sonnet', max_turns: 10, permission_mode: 'plan' },
        stages: [
          {
            id: 'plan',
            name: 'Plan',
            prompt: 'Plan it',
            claude_flags: { model: 'opus' },
            requires_approval: true,
          },
          {
            id: 'implement',
            name: 'Implement',
            prompt: 'Do it',
            claude_flags: { permission_mode: 'acceptEdits', max_turns: 30 },
          },
          {
            id: 'review',
            name: 'Review',
            prompt: 'Review it',
          },
        ],
      };

      const stages = compilePipeline(config);

      expect(stages).toHaveLength(3);

      // Stage 0: model overridden, others from defaults
      expect(stages[0].model).toBe('opus');
      expect(stages[0].max_turns).toBe(10);
      expect(stages[0].permission_mode).toBe('plan');
      expect(stages[0].requires_approval).toBe(true);

      // Stage 1: permission_mode and max_turns overridden
      expect(stages[1].model).toBe('sonnet');
      expect(stages[1].max_turns).toBe(30);
      expect(stages[1].permission_mode).toBe('acceptEdits');
      expect(stages[1].requires_approval).toBe(false);

      // Stage 2: all from defaults
      expect(stages[2].model).toBe('sonnet');
      expect(stages[2].max_turns).toBe(10);
      expect(stages[2].permission_mode).toBe('plan');
      expect(stages[2].requires_approval).toBe(false);
    });
  });

  // ============================================================================
  // Tests: extractTemplateVariables
  // ============================================================================

  describe('extractTemplateVariables', () => {
    it('should extract simple variables', () => {
      const vars = extractTemplateVariables('Hello {{task.description}} in {{project.language}}');
      expect(vars).toContain('task.description');
      expect(vars).toContain('project.language');
    });

    it('should deduplicate variables', () => {
      const vars = extractTemplateVariables('{{task.description}} and {{task.description}}');
      expect(vars).toHaveLength(1);
      expect(vars).toContain('task.description');
    });

    it('should return empty array for templates without variables', () => {
      const vars = extractTemplateVariables('No variables here');
      expect(vars).toEqual([]);
    });

    it('should handle triple-stash syntax', () => {
      const vars = extractTemplateVariables('{{{task.description}}}');
      expect(vars).toContain('task.description');
    });

    it('should extract variables with underscores', () => {
      const vars = extractTemplateVariables('{{project.test_command}} and {{project.lint_command}}');
      expect(vars).toContain('project.test_command');
      expect(vars).toContain('project.lint_command');
    });

    it('should extract deeply nested variable paths', () => {
      const vars = extractTemplateVariables('{{task.some.deep.path}}');
      expect(vars).toContain('task.some.deep.path');
    });

    it('should handle variables with surrounding whitespace', () => {
      const vars = extractTemplateVariables('{{ task.description }}');
      expect(vars).toContain('task.description');
    });

    it('should extract previous_context as a simple variable', () => {
      const vars = extractTemplateVariables('Context: {{previous_context}}');
      expect(vars).toContain('previous_context');
    });

    it('should extract inputs variables', () => {
      const vars = extractTemplateVariables('Module: {{inputs.target_module}}');
      expect(vars).toContain('inputs.target_module');
    });

    it('should return empty array for an empty template', () => {
      const vars = extractTemplateVariables('');
      expect(vars).toEqual([]);
    });

    it('should extract multiple unique variables from a complex template', () => {
      const template = `
        Plan {{task.description}} in {{project.language}}.
        Use {{project.test_command}} to test.
        Previous context: {{previous_context}}
        Module: {{inputs.target_module}}
      `;
      const vars = extractTemplateVariables(template);

      expect(vars).toContain('task.description');
      expect(vars).toContain('project.language');
      expect(vars).toContain('project.test_command');
      expect(vars).toContain('previous_context');
      expect(vars).toContain('inputs.target_module');
      expect(vars).toHaveLength(5);
    });
  });

  // ============================================================================
  // Tests: compileStage
  // ============================================================================

  describe('compileStage', () => {
    it('should resolve template variables', () => {
      const stage = makeResolvedStage({
        prompt: 'Plan {{task.description}} in {{project.language}}',
      });

      const result = compileStage(stage, {
        task: { description: 'add auth' },
        project: { language: 'TypeScript' },
      });

      expect(result.stage.prompt).toBe('Plan add auth in TypeScript');
      expect(result.hasMissingVariables).toBe(false);
      expect(result.missingVariables).toEqual([]);
    });

    it('should detect missing variables', () => {
      const stage = makeResolvedStage({
        prompt: 'Plan {{task.description}} with {{project.test_command}}',
      });

      const result = compileStage(stage, {
        task: { description: 'fix bug' },
        project: {},
      });

      expect(result.hasMissingVariables).toBe(true);
      expect(result.missingVariables).toContain('project.test_command');
    });

    it('should resolve previous_context variable', () => {
      const stage = makeResolvedStage({
        prompt: 'Continue from: {{previous_context}}',
      });

      const result = compileStage(stage, {
        task: { description: 'test' },
        project: {},
        previous_context: 'The plan was approved.',
      });

      expect(result.stage.prompt).toBe('Continue from: The plan was approved.');
      expect(result.hasMissingVariables).toBe(false);
    });

    it('should default previous_context to empty string when not provided', () => {
      const stage = makeResolvedStage({
        prompt: 'Context: {{previous_context}} end',
      });

      const result = compileStage(stage, {
        task: { description: 'test' },
        project: {},
      });

      expect(result.stage.prompt).toBe('Context:  end');
      expect(result.hasMissingVariables).toBe(false);
    });

    it('should resolve inputs variables', () => {
      const stage = makeResolvedStage({
        prompt: 'Build {{inputs.target_module}} module',
      });

      const result = compileStage(stage, {
        task: { description: 'build module' },
        project: {},
        inputs: { target_module: 'authentication' },
      });

      expect(result.stage.prompt).toBe('Build authentication module');
      expect(result.hasMissingVariables).toBe(false);
    });

    it('should default inputs to empty object when not provided', () => {
      const stage = makeResolvedStage({
        prompt: 'Module: {{inputs.target_module}} end',
      });

      const result = compileStage(stage, {
        task: { description: 'test' },
        project: {},
        // inputs not provided
      });

      // inputs.target_module is missing
      expect(result.hasMissingVariables).toBe(true);
      expect(result.missingVariables).toContain('inputs.target_module');
    });

    it('should preserve all stage properties (id, name, model, etc.)', () => {
      const stage = makeResolvedStage({
        id: 'my-stage',
        name: 'My Stage',
        prompt: 'Hello {{task.description}}',
        model: 'opus',
        permission_mode: 'acceptEdits',
        max_turns: 25,
        requires_approval: true,
      });

      const result = compileStage(stage, {
        task: { description: 'world' },
        project: {},
      });

      expect(result.stage.id).toBe('my-stage');
      expect(result.stage.name).toBe('My Stage');
      expect(result.stage.model).toBe('opus');
      expect(result.stage.permission_mode).toBe('acceptEdits');
      expect(result.stage.max_turns).toBe(25);
      expect(result.stage.requires_approval).toBe(true);
      expect(result.stage.prompt).toBe('Hello world');
    });

    it('should handle a stage with no template variables', () => {
      const stage = makeResolvedStage({
        prompt: 'This is a static prompt with no variables.',
      });

      const result = compileStage(stage, {
        task: { description: 'test' },
        project: {},
      });

      expect(result.stage.prompt).toBe('This is a static prompt with no variables.');
      expect(result.hasMissingVariables).toBe(false);
      expect(result.missingVariables).toEqual([]);
    });

    it('should detect multiple missing variables', () => {
      const stage = makeResolvedStage({
        prompt: 'Test {{project.test_command}} and lint {{project.lint_command}} for {{project.language}}',
      });

      const result = compileStage(stage, {
        task: { description: 'test' },
        project: {},
      });

      expect(result.hasMissingVariables).toBe(true);
      expect(result.missingVariables).toContain('project.test_command');
      expect(result.missingVariables).toContain('project.lint_command');
      expect(result.missingVariables).toContain('project.language');
      expect(result.missingVariables).toHaveLength(3);
    });

    it('should resolve multiple project properties', () => {
      const stage = makeResolvedStage({
        prompt: 'Language: {{project.language}}, Test: {{project.test_command}}, Lint: {{project.lint_command}}',
      });

      const result = compileStage(stage, {
        task: { description: 'test' },
        project: { language: 'Python', test_command: 'pytest', lint_command: 'ruff check' },
      });

      expect(result.stage.prompt).toBe('Language: Python, Test: pytest, Lint: ruff check');
      expect(result.hasMissingVariables).toBe(false);
    });

    it('should resolve task.title when provided', () => {
      const stage = makeResolvedStage({
        prompt: 'Title: {{task.title}}, Desc: {{task.description}}',
      });

      const result = compileStage(stage, {
        task: { description: 'Add a login page', title: 'Login Feature' },
        project: {},
      });

      expect(result.stage.prompt).toBe('Title: Login Feature, Desc: Add a login page');
      expect(result.hasMissingVariables).toBe(false);
    });

    it('should handle mixed present and missing variables', () => {
      const stage = makeResolvedStage({
        prompt: 'Build {{task.description}} in {{project.language}} using {{project.framework}}',
      });

      const result = compileStage(stage, {
        task: { description: 'dashboard' },
        project: { language: 'TypeScript' },
      });

      expect(result.stage.prompt).toContain('Build dashboard in TypeScript');
      expect(result.hasMissingVariables).toBe(true);
      expect(result.missingVariables).toEqual(['project.framework']);
    });

    it('should not mutate the original stage object', () => {
      const originalPrompt = 'Plan {{task.description}}';
      const stage = makeResolvedStage({ prompt: originalPrompt });

      compileStage(stage, {
        task: { description: 'something' },
        project: {},
      });

      // Original stage should not be modified
      expect(stage.prompt).toBe(originalPrompt);
    });

    it('should resolve all context namespaces in one prompt', () => {
      const stage = makeResolvedStage({
        prompt: 'Task: {{task.description}}, Lang: {{project.language}}, Input: {{inputs.target}}, Prev: {{previous_context}}',
      });

      const result = compileStage(stage, {
        task: { description: 'build API' },
        project: { language: 'Go' },
        inputs: { target: 'v2' },
        previous_context: 'Plan approved.',
      });

      expect(result.stage.prompt).toBe(
        'Task: build API, Lang: Go, Input: v2, Prev: Plan approved.'
      );
      expect(result.hasMissingVariables).toBe(false);
      expect(result.missingVariables).toEqual([]);
    });
  });

  // ============================================================================
  // Tests: compileAllStages
  // ============================================================================

  describe('compileAllStages', () => {
    it('should compile all stages', () => {
      const stages = compilePipeline(VALID_PIPELINE_CONFIG);
      const results = compileAllStages(stages, {
        task: { description: 'add feature' },
        project: {},
      });

      expect(results).toHaveLength(2);
      results.forEach((r) => {
        expect(r.stage).toBeDefined();
        expect(r.stage.prompt).toBeDefined();
      });
    });

    it('should return empty array for empty stages input', () => {
      const results = compileAllStages([], {
        task: { description: 'test' },
        project: {},
      });

      expect(results).toEqual([]);
    });

    it('should track missing variables independently per stage', () => {
      const stages: ResolvedStage[] = [
        makeResolvedStage({
          id: 'stage-1',
          prompt: 'Use {{project.test_command}}',
        }),
        makeResolvedStage({
          id: 'stage-2',
          prompt: 'Hello {{task.description}}',
        }),
      ];

      const results = compileAllStages(stages, {
        task: { description: 'world' },
        project: {},
      });

      expect(results[0].hasMissingVariables).toBe(true);
      expect(results[0].missingVariables).toContain('project.test_command');
      expect(results[1].hasMissingVariables).toBe(false);
      expect(results[1].missingVariables).toEqual([]);
    });

    it('should resolve templates with the same context for all stages', () => {
      const stages: ResolvedStage[] = [
        makeResolvedStage({
          id: 'stage-1',
          prompt: 'Task: {{task.description}}',
        }),
        makeResolvedStage({
          id: 'stage-2',
          prompt: 'Also: {{task.description}}',
        }),
      ];

      const results = compileAllStages(stages, {
        task: { description: 'build feature' },
        project: {},
      });

      expect(results[0].stage.prompt).toBe('Task: build feature');
      expect(results[1].stage.prompt).toBe('Also: build feature');
    });
  });

  // ============================================================================
  // Tests: discoverPipelines (project + user-level with override logic)
  // ============================================================================

  describe('discoverPipelines', () => {
    it('should return empty array when neither directory exists', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      vi.mocked(systemPaths.systemPathReaddir).mockRejectedValue(enoent);
      vi.mocked(secureFs.readdir).mockRejectedValue(enoent);

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toEqual([]);
    });

    it('should discover project-level pipelines only', async () => {
      // User dir doesn't exist
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      vi.mocked(systemPaths.systemPathReaddir).mockRejectedValue(enoent);

      // Project dir has one pipeline
      vi.mocked(secureFs.readdir).mockResolvedValue(['feature.yaml'] as any);
      vi.mocked(secureFs.readFile).mockResolvedValue(VALID_PIPELINE_YAML as any);

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('feature');
      expect(result[0].source).toBe('project');
      expect(result[0].config.name).toBe('Feature');
      expect(result[0].stageCount).toBe(2);
      expect(result[0].filePath).toBe(
        path.join(PROJECT_PATH, '.pegasus', 'pipelines', 'feature.yaml')
      );
    });

    it('should discover user-level pipelines only', async () => {
      // User dir has one pipeline
      vi.mocked(systemPaths.systemPathReaddir).mockResolvedValue(['feature.yaml']);
      vi.mocked(systemPaths.systemPathReadFile).mockResolvedValue(USER_PIPELINE_YAML);

      // Project dir doesn't exist
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      vi.mocked(secureFs.readdir).mockRejectedValue(enoent);

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('feature');
      expect(result[0].source).toBe('user');
      expect(result[0].config.name).toBe('User Feature');
      expect(result[0].stageCount).toBe(1);
      expect(result[0].filePath).toBe(
        path.join(os.homedir(), '.pegasus', 'pipelines', 'feature.yaml')
      );
    });

    it('should merge user and project pipelines with different slugs', async () => {
      // User dir has "feature" pipeline
      vi.mocked(systemPaths.systemPathReaddir).mockResolvedValue(['feature.yaml']);
      vi.mocked(systemPaths.systemPathReadFile).mockResolvedValue(USER_PIPELINE_YAML);

      // Project dir has "bug-fix" pipeline
      vi.mocked(secureFs.readdir).mockResolvedValue(['bug-fix.yaml'] as any);
      vi.mocked(secureFs.readFile).mockResolvedValue(BUG_FIX_PIPELINE_YAML as any);

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toHaveLength(2);

      const featurePipeline = result.find((p) => p.slug === 'feature');
      const bugFixPipeline = result.find((p) => p.slug === 'bug-fix');

      expect(featurePipeline).toBeDefined();
      expect(featurePipeline!.source).toBe('user');
      expect(featurePipeline!.config.name).toBe('User Feature');

      expect(bugFixPipeline).toBeDefined();
      expect(bugFixPipeline!.source).toBe('project');
      expect(bugFixPipeline!.config.name).toBe('Bug Fix');
    });

    it('should override user pipeline with project pipeline when slugs match', async () => {
      // User dir has "feature" pipeline
      vi.mocked(systemPaths.systemPathReaddir).mockResolvedValue(['feature.yaml']);
      vi.mocked(systemPaths.systemPathReadFile).mockResolvedValue(USER_PIPELINE_YAML);

      // Project dir also has "feature" pipeline (should override)
      vi.mocked(secureFs.readdir).mockResolvedValue(['feature.yaml'] as any);
      vi.mocked(secureFs.readFile).mockResolvedValue(VALID_PIPELINE_YAML as any);

      const result = await discoverPipelines(PROJECT_PATH);

      // Only one pipeline with slug "feature" should exist
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('feature');
      expect(result[0].source).toBe('project');
      // Project pipeline should win — name is "Feature" (not "User Feature")
      expect(result[0].config.name).toBe('Feature');
      expect(result[0].stageCount).toBe(2);
      expect(result[0].filePath).toBe(
        path.join(PROJECT_PATH, '.pegasus', 'pipelines', 'feature.yaml')
      );
    });

    it('should override user pipeline with project pipeline while keeping non-overlapping user pipelines', async () => {
      // User dir has two pipelines: "feature" and "bug-fix"
      vi.mocked(systemPaths.systemPathReaddir).mockResolvedValue([
        'feature.yaml',
        'bug-fix.yaml',
      ]);
      vi.mocked(systemPaths.systemPathReadFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('feature.yaml')) return USER_PIPELINE_YAML;
        if (filePath.includes('bug-fix.yaml')) return BUG_FIX_PIPELINE_YAML;
        throw new Error('Unexpected file');
      });

      // Project dir has only "feature" pipeline (overrides user "feature")
      vi.mocked(secureFs.readdir).mockResolvedValue(['feature.yaml'] as any);
      vi.mocked(secureFs.readFile).mockResolvedValue(VALID_PIPELINE_YAML as any);

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toHaveLength(2);

      const featurePipeline = result.find((p) => p.slug === 'feature');
      const bugFixPipeline = result.find((p) => p.slug === 'bug-fix');

      // Feature should be overridden by project
      expect(featurePipeline!.source).toBe('project');
      expect(featurePipeline!.config.name).toBe('Feature');

      // Bug-fix should remain from user
      expect(bugFixPipeline!.source).toBe('user');
      expect(bugFixPipeline!.config.name).toBe('Bug Fix');
    });

    it('should skip invalid user pipeline files', async () => {
      // User dir has an invalid pipeline
      vi.mocked(systemPaths.systemPathReaddir).mockResolvedValue(['invalid.yaml']);
      vi.mocked(systemPaths.systemPathReadFile).mockResolvedValue('not valid yaml: [');

      // Project dir doesn't exist
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      vi.mocked(secureFs.readdir).mockRejectedValue(enoent);

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toEqual([]);
    });

    it('should skip invalid project pipeline files', async () => {
      // User dir doesn't exist
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      vi.mocked(systemPaths.systemPathReaddir).mockRejectedValue(enoent);

      // Project dir has an invalid pipeline
      vi.mocked(secureFs.readdir).mockResolvedValue(['broken.yaml'] as any);
      vi.mocked(secureFs.readFile).mockResolvedValue('name: incomplete' as any);

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toEqual([]);
    });

    it('should ignore non-yaml files in both directories', async () => {
      // User dir has mixed files
      vi.mocked(systemPaths.systemPathReaddir).mockResolvedValue([
        'readme.md',
        'notes.txt',
        '.gitkeep',
      ]);

      // Project dir has mixed files
      vi.mocked(secureFs.readdir).mockResolvedValue([
        'config.json',
        'pipeline.json',
        'backup.yaml.bak',
      ] as any);

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toEqual([]);
      // systemPathReadFile should not have been called — no .yaml files found
      expect(systemPaths.systemPathReadFile).not.toHaveBeenCalled();
      expect(secureFs.readFile).not.toHaveBeenCalled();
    });

    it('should handle directory read errors gracefully (non-ENOENT)', async () => {
      // User dir has a permission error
      vi.mocked(systemPaths.systemPathReaddir).mockRejectedValue(new Error('EACCES'));

      // Project dir has a permission error
      vi.mocked(secureFs.readdir).mockRejectedValue(new Error('EACCES'));

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toEqual([]);
    });

    it('should set isBuiltIn to false for all discovered pipelines', async () => {
      vi.mocked(systemPaths.systemPathReaddir).mockResolvedValue(['feature.yaml']);
      vi.mocked(systemPaths.systemPathReadFile).mockResolvedValue(USER_PIPELINE_YAML);

      vi.mocked(secureFs.readdir).mockResolvedValue(['bug-fix.yaml'] as any);
      vi.mocked(secureFs.readFile).mockResolvedValue(BUG_FIX_PIPELINE_YAML as any);

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toHaveLength(2);
      result.forEach((p) => {
        expect(p.isBuiltIn).toBe(false);
      });
    });

    it('should correctly derive slugs from filenames', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      vi.mocked(systemPaths.systemPathReaddir).mockRejectedValue(enoent);

      vi.mocked(secureFs.readdir).mockResolvedValue([
        'feature.yaml',
        'bug-fix.yaml',
        'feature-from-design.yaml',
      ] as any);

      // Return valid YAML for all
      vi.mocked(secureFs.readFile).mockResolvedValue(VALID_PIPELINE_YAML as any);

      const result = await discoverPipelines(PROJECT_PATH);

      const slugs = result.map((p) => p.slug).sort();
      expect(slugs).toEqual(['bug-fix', 'feature', 'feature-from-design']);
    });

    it('should discover project pipelines when user dir has a permission error', async () => {
      // User dir has a permission error (not ENOENT)
      vi.mocked(systemPaths.systemPathReaddir).mockRejectedValue(new Error('EACCES'));

      // Project dir has a valid pipeline
      vi.mocked(secureFs.readdir).mockResolvedValue(['feature.yaml'] as any);
      vi.mocked(secureFs.readFile).mockResolvedValue(VALID_PIPELINE_YAML as any);

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('feature');
      expect(result[0].source).toBe('project');
    });

    it('should discover user pipelines when project dir has a permission error', async () => {
      // User dir has a valid pipeline
      vi.mocked(systemPaths.systemPathReaddir).mockResolvedValue(['feature.yaml']);
      vi.mocked(systemPaths.systemPathReadFile).mockResolvedValue(USER_PIPELINE_YAML);

      // Project dir has a permission error
      vi.mocked(secureFs.readdir).mockRejectedValue(new Error('EACCES'));

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('feature');
      expect(result[0].source).toBe('user');
    });

    it('should return empty array when directories have empty file lists', async () => {
      vi.mocked(systemPaths.systemPathReaddir).mockResolvedValue([]);
      vi.mocked(secureFs.readdir).mockResolvedValue([] as any);

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toEqual([]);
      expect(systemPaths.systemPathReadFile).not.toHaveBeenCalled();
      expect(secureFs.readFile).not.toHaveBeenCalled();
    });

    it('should correctly count stages in discovered pipelines', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      vi.mocked(systemPaths.systemPathReaddir).mockRejectedValue(enoent);

      vi.mocked(secureFs.readdir).mockResolvedValue(['feature.yaml', 'bug-fix.yaml'] as any);
      vi.mocked(secureFs.readFile).mockImplementation(async (filePath: string) => {
        if ((filePath as string).includes('feature.yaml')) return VALID_PIPELINE_YAML as any;
        if ((filePath as string).includes('bug-fix.yaml')) return BUG_FIX_PIPELINE_YAML as any;
        throw new Error('Unexpected file');
      });

      const result = await discoverPipelines(PROJECT_PATH);

      const featurePipeline = result.find((p) => p.slug === 'feature');
      const bugFixPipeline = result.find((p) => p.slug === 'bug-fix');

      expect(featurePipeline!.stageCount).toBe(2);
      expect(bugFixPipeline!.stageCount).toBe(2);
    });

    it('should skip invalid pipeline but still include valid ones in same directory', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      vi.mocked(systemPaths.systemPathReaddir).mockRejectedValue(enoent);

      // Project dir has one valid and one invalid pipeline
      vi.mocked(secureFs.readdir).mockResolvedValue(['feature.yaml', 'broken.yaml'] as any);
      vi.mocked(secureFs.readFile).mockImplementation(async (filePath: string) => {
        if ((filePath as string).includes('feature.yaml')) return VALID_PIPELINE_YAML as any;
        if ((filePath as string).includes('broken.yaml')) return 'name: incomplete' as any;
        throw new Error('Unexpected file');
      });

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('feature');
      expect(result[0].config.name).toBe('Feature');
    });

    it('should include full config in discovered pipeline', async () => {
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      vi.mocked(systemPaths.systemPathReaddir).mockRejectedValue(enoent);

      vi.mocked(secureFs.readdir).mockResolvedValue(['feature.yaml'] as any);
      vi.mocked(secureFs.readFile).mockResolvedValue(VALID_PIPELINE_YAML as any);

      const result = await discoverPipelines(PROJECT_PATH);

      expect(result[0].config).toBeDefined();
      expect(result[0].config.name).toBe('Feature');
      expect(result[0].config.description).toBe('Plan, implement, and test a new feature');
      expect(result[0].config.stages).toHaveLength(2);
      expect(result[0].config.stages[0].id).toBe('plan');
      expect(result[0].config.stages[1].id).toBe('implement');
    });
  });
});
