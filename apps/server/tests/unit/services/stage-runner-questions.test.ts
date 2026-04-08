/**
 * Tests for StageRunner YAML question handling.
 *
 * Verifies that:
 * - A stage with `question` field pauses execution (throws PauseExecutionError) if no answer present
 * - A stage with `question` field and an existing answer proceeds normally
 * - QuestionService.askQuestion is called with correct data
 * - Stages without `question` field are unaffected (no regression)
 * - No QuestionService injected → question field is silently ignored
 * - stagesContext is correctly built from feature.questionState.questions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Feature, ResolvedStage, AgentQuestion } from '@pegasus/types';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('@pegasus/utils', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@pegasus/platform', () => ({
  getFeatureDir: (projectPath: string, featureId: string) =>
    `${projectPath}/.pegasus/features/${featureId}`,
  getPipelineStatePath: (projectPath: string, featureId: string) =>
    `${projectPath}/.pegasus/features/${featureId}/pipeline-state.json`,
  getStageOutputsDir: (projectPath: string, featureId: string) =>
    `${projectPath}/.pegasus/features/${featureId}/stage-outputs`,
  getStageOutputPath: (projectPath: string, featureId: string, stageId: string) =>
    `${projectPath}/.pegasus/features/${featureId}/stage-outputs/${stageId}.md`,
}));

vi.mock('@/lib/secure-fs.js', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/pipeline-compiler.js', () => ({
  compileStage: vi.fn((stage: ResolvedStage) => ({
    stage,
    missingVariables: [],
    hasMissingVariables: false,
  })),
}));

// Import after mocks
import { StageRunner } from '@/services/stage-runner.js';
import { PauseExecutionError } from '@/services/pause-execution-error.js';
import type { StageRunnerConfig, StageRunAgentFn } from '@/services/stage-runner.js';
import type { QuestionService } from '@/services/question-service.js';
import type { TypedEventBus } from '@/services/typed-event-bus.js';

// ============================================================================
// Fixtures
// ============================================================================

const PROJECT_PATH = '/test/project';
const FEATURE_ID = 'feat-123';
const PIPELINE_NAME = 'Feature';

function createMockEventBus() {
  return {
    emitAutoModeEvent: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TypedEventBus;
}

function createMockQuestionService(): QuestionService {
  return {
    askQuestion: vi.fn().mockResolvedValue(undefined),
    resolveAnswer: vi.fn(),
    cancelQuestions: vi.fn(),
    getPendingQuestions: vi.fn(),
  } as unknown as QuestionService;
}

function createMockStage(id: string, name: string, extra?: Partial<ResolvedStage>): ResolvedStage {
  return {
    id,
    name,
    prompt: `Execute ${name}`,
    model: 'sonnet',
    permission_mode: 'plan',
    max_turns: 10,
    requires_approval: false,
    ...extra,
  };
}

function createMockFeature(overrides?: Partial<Feature>): Feature {
  return {
    id: FEATURE_ID,
    title: 'Test Feature',
    description: 'A test feature',
    status: 'in_progress',
    ...overrides,
  };
}

function createMockConfig(overrides?: Partial<StageRunnerConfig>): StageRunnerConfig {
  return {
    projectPath: PROJECT_PATH,
    featureId: FEATURE_ID,
    feature: createMockFeature(),
    stages: [
      createMockStage('plan', 'Planning'),
      createMockStage('implement', 'Implementation'),
    ],
    workDir: '/test/workdir',
    worktreePath: null,
    branchName: 'feat/test',
    abortController: new AbortController(),
    pipelineDefaults: { model: 'sonnet', max_turns: 10, permission_mode: 'plan' },
    pipelineName: PIPELINE_NAME,
    compilationContext: {
      task: { description: 'Test task' },
      project: { language: 'TypeScript' },
    },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('StageRunner — YAML question handling', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let runAgentFn: ReturnType<typeof vi.fn<StageRunAgentFn>>;
  let questionService: QuestionService;
  let runner: StageRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = createMockEventBus();
    runAgentFn = vi.fn<StageRunAgentFn>().mockResolvedValue(undefined);
    questionService = createMockQuestionService();
    runner = new StageRunner(eventBus, runAgentFn, questionService);
  });

  // ==========================================================================
  // Pause on unanswered question
  // ==========================================================================

  describe('pause execution when question is unanswered', () => {
    it('should throw PauseExecutionError when stage has question and no answer exists', async () => {
      const config = createMockConfig({
        stages: [
          createMockStage('plan', 'Planning', {
            question: 'What approach should we use?',
          }),
          createMockStage('implement', 'Implementation'),
        ],
        feature: createMockFeature({ questionState: undefined }),
      });

      await expect(runner.run(config)).rejects.toThrow(PauseExecutionError);
    });

    it('should throw PauseExecutionError with correct featureId', async () => {
      const config = createMockConfig({
        stages: [
          createMockStage('plan', 'Planning', { question: 'Approach?' }),
        ],
      });

      let thrownError: unknown;
      try {
        await runner.run(config);
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(PauseExecutionError);
      expect((thrownError as PauseExecutionError).featureId).toBe(FEATURE_ID);
    });

    it('should throw PauseExecutionError with reason "question"', async () => {
      const config = createMockConfig({
        stages: [createMockStage('plan', 'Planning', { question: 'Approach?' })],
      });

      let thrownError: unknown;
      try {
        await runner.run(config);
      } catch (err) {
        thrownError = err;
      }

      expect((thrownError as PauseExecutionError).reason).toBe('question');
    });

    it('should call questionService.askQuestion before throwing', async () => {
      const config = createMockConfig({
        stages: [
          createMockStage('plan', 'Planning', { question: 'What approach?' }),
        ],
      });

      await expect(runner.run(config)).rejects.toThrow(PauseExecutionError);

      expect(questionService.askQuestion).toHaveBeenCalledWith(
        PROJECT_PATH,
        FEATURE_ID,
        expect.arrayContaining([
          expect.objectContaining({
            stageId: 'plan',
            question: 'What approach?',
            type: 'free-text', // default type
            status: 'pending',
          }),
        ])
      );
    });

    it('should pass question_meta type to askQuestion', async () => {
      const config = createMockConfig({
        stages: [
          createMockStage('plan', 'Planning', {
            question: 'Which approach?',
            question_meta: { type: 'single-select', options: ['Option A', 'Option B'] },
          }),
        ],
      });

      await expect(runner.run(config)).rejects.toThrow(PauseExecutionError);

      expect(questionService.askQuestion).toHaveBeenCalledWith(
        PROJECT_PATH,
        FEATURE_ID,
        expect.arrayContaining([
          expect.objectContaining({
            type: 'single-select',
            options: [{ label: 'Option A' }, { label: 'Option B' }],
          }),
        ])
      );
    });

    it('should not call runAgentFn for the question stage before pausing', async () => {
      const config = createMockConfig({
        stages: [
          createMockStage('plan', 'Planning', { question: 'Approach?' }),
          createMockStage('implement', 'Implementation'),
        ],
      });

      await expect(runner.run(config)).rejects.toThrow(PauseExecutionError);

      // runAgentFn should not have been called — we paused before execution
      expect(runAgentFn).not.toHaveBeenCalled();
    });

    it('should pause at the first unanswered question stage, not execute later stages', async () => {
      const config = createMockConfig({
        stages: [
          createMockStage('plan', 'Planning', { question: 'Approach?' }),
          createMockStage('implement', 'Implementation'),
          createMockStage('test', 'Testing'),
        ],
      });

      await expect(runner.run(config)).rejects.toThrow(PauseExecutionError);

      // Only plan stage questioned, no stages executed
      expect(runAgentFn).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Proceed when question is already answered
  // ==========================================================================

  describe('proceed when question already answered', () => {
    it('should execute stage normally when answer exists in questionState', async () => {
      const answeredQuestion: AgentQuestion = {
        id: 'q-001',
        stageId: 'plan',
        question: 'Approach?',
        type: 'free-text',
        status: 'answered',
        answer: 'Use factory pattern',
        askedAt: '2024-01-01T00:00:00Z',
        answeredAt: '2024-01-01T01:00:00Z',
      };

      const config = createMockConfig({
        stages: [
          createMockStage('plan', 'Planning', { question: 'Approach?' }),
          createMockStage('implement', 'Implementation'),
        ],
        feature: createMockFeature({
          questionState: {
            questions: [answeredQuestion],
            status: 'answered',
          },
        }),
      });

      const result = await runner.run(config);

      expect(result.success).toBe(true);
      expect(runAgentFn).toHaveBeenCalledTimes(2);
    });

    it('should not call askQuestion when answer already exists', async () => {
      const answeredQuestion: AgentQuestion = {
        id: 'q-001',
        stageId: 'plan',
        question: 'Approach?',
        type: 'free-text',
        status: 'answered',
        answer: 'Use factory pattern',
        askedAt: '2024-01-01T00:00:00Z',
      };

      const config = createMockConfig({
        stages: [createMockStage('plan', 'Planning', { question: 'Approach?' })],
        feature: createMockFeature({
          questionState: {
            questions: [answeredQuestion],
            status: 'answered',
          },
        }),
      });

      await runner.run(config);

      expect(questionService.askQuestion).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // No regression: stages without questions
  // ==========================================================================

  describe('no regression for stages without questions', () => {
    it('should execute stages without question field normally', async () => {
      const config = createMockConfig({
        stages: [
          createMockStage('plan', 'Planning'),
          createMockStage('implement', 'Implementation'),
        ],
      });

      const result = await runner.run(config);

      expect(result.success).toBe(true);
      expect(result.stagesCompleted).toBe(2);
      expect(runAgentFn).toHaveBeenCalledTimes(2);
    });

    it('should not call askQuestion for stages without question', async () => {
      const config = createMockConfig({
        stages: [createMockStage('plan', 'Planning')],
      });

      await runner.run(config);

      expect(questionService.askQuestion).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // No QuestionService injected
  // ==========================================================================

  describe('no QuestionService injected', () => {
    it('should skip question check when questionService is not provided', async () => {
      const runnerWithoutQS = new StageRunner(eventBus, runAgentFn);
      const config = createMockConfig({
        stages: [
          createMockStage('plan', 'Planning', { question: 'Approach?' }),
        ],
      });

      // Should NOT throw — question check is skipped
      const result = await runnerWithoutQS.run(config);

      expect(result.success).toBe(true);
      expect(runAgentFn).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // PauseExecutionError thrown from runAgentFn (mid-stage agent question)
  // ==========================================================================

  describe('PauseExecutionError from runAgentFn (mid-stage AskUserQuestion)', () => {
    it('rethrows PauseExecutionError instead of swallowing it as an aborted return', async () => {
      // Regression guard: when the agent calls AskUserQuestion mid-stage,
      // AgentExecutor's tool_use handler throws PauseExecutionError out of
      // runAgentFn. StageRunner.run() must rethrow it so ExecutionService's
      // catch block can transition the feature to `waiting_question`.
      //
      // The previous implementation checked `abortController.signal.aborted`
      // BEFORE checking the error type. The extractor used to abort the
      // controller as belt-and-suspenders, which made every PauseExecutionError
      // get swallowed as `{ aborted: true }`, and the feature ended up in
      // `interrupted` (visible as Backlog) instead of `waiting_question`.
      const runAgentFnThatPauses = vi
        .fn<StageRunAgentFn>()
        .mockRejectedValue(new PauseExecutionError(FEATURE_ID, 'question'));
      const pausingRunner = new StageRunner(eventBus, runAgentFnThatPauses, questionService);

      const config = createMockConfig({
        stages: [createMockStage('plan', 'Planning')], // no YAML pre-stage question
      });

      await expect(pausingRunner.run(config)).rejects.toThrow(PauseExecutionError);
      expect(runAgentFnThatPauses).toHaveBeenCalledTimes(1);
    });

    it('rethrows PauseExecutionError even when the abort controller has been signaled', async () => {
      // Defense-in-depth: even if some future change re-introduces the abort,
      // PauseExecutionError must still take precedence over the aborted-signal
      // check in StageRunner's catch block.
      const sharedAbort = new AbortController();
      const runAgentFnThatPausesAndAborts = vi.fn<StageRunAgentFn>(async () => {
        sharedAbort.abort();
        throw new PauseExecutionError(FEATURE_ID, 'question');
      });
      const pausingRunner = new StageRunner(
        eventBus,
        runAgentFnThatPausesAndAborts,
        questionService
      );

      const config = createMockConfig({
        stages: [createMockStage('plan', 'Planning')],
        abortController: sharedAbort,
      });

      await expect(pausingRunner.run(config)).rejects.toThrow(PauseExecutionError);
    });

    it('still treats genuine user aborts as aborted (no regression)', async () => {
      // Sanity check: a genuine user-initiated abort (not a PauseExecutionError)
      // should still be returned as { aborted: true }, not rethrown.
      const sharedAbort = new AbortController();
      const runAgentFnThatAborts = vi.fn<StageRunAgentFn>(async () => {
        sharedAbort.abort();
        throw new Error('Stream aborted by user');
      });
      const abortingRunner = new StageRunner(
        eventBus,
        runAgentFnThatAborts,
        questionService
      );

      const config = createMockConfig({
        stages: [createMockStage('plan', 'Planning')],
        abortController: sharedAbort,
      });

      const result = await abortingRunner.run(config);
      expect(result.success).toBe(false);
      expect(result.aborted).toBe(true);
    });
  });

  // ==========================================================================
  // stagesContext building from questionState
  // ==========================================================================

  describe('stagesContext built from feature.questionState', () => {
    it('should include only answered questions in stagesContext', async () => {
      // We'll verify this indirectly: if answer exists for stage 'plan',
      // then stage 'plan' with a question will proceed (not throw PauseExecutionError)
      const mixedQuestions: AgentQuestion[] = [
        {
          id: 'q-001',
          stageId: 'plan',
          question: 'Approach?',
          type: 'free-text',
          status: 'answered',
          answer: 'Factory pattern',
          askedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'q-002',
          stageId: 'review',
          question: 'Review notes?',
          type: 'free-text',
          status: 'pending', // not answered
          askedAt: '2024-01-01T00:00:00Z',
        },
      ];

      const config = createMockConfig({
        stages: [
          createMockStage('plan', 'Planning', { question: 'Approach?' }), // answered → proceed
          createMockStage('implement', 'Implementation'), // no question → proceed
          createMockStage('review', 'Review', { question: 'Review notes?' }), // pending → pause
        ],
        feature: createMockFeature({
          questionState: { questions: mixedQuestions, status: 'pending' },
        }),
      });

      // Should pause at 'review' stage (not answered), having run 'plan' and 'implement'
      await expect(runner.run(config)).rejects.toThrow(PauseExecutionError);

      // plan and implement should have been executed before pausing at review
      expect(runAgentFn).toHaveBeenCalledTimes(2);

      // askQuestion called for 'review' stage
      expect(questionService.askQuestion).toHaveBeenCalledWith(
        PROJECT_PATH,
        FEATURE_ID,
        expect.arrayContaining([expect.objectContaining({ stageId: 'review' })])
      );
    });
  });

  // ==========================================================================
  // Multi-select question options conversion
  // ==========================================================================

  describe('question options conversion', () => {
    it('should convert string options array to QuestionOption objects', async () => {
      const config = createMockConfig({
        stages: [
          createMockStage('plan', 'Planning', {
            question: 'Pick an approach',
            question_meta: {
              type: 'multi-select',
              options: ['Microservices', 'Monolith', 'Serverless'],
            },
          }),
        ],
      });

      await expect(runner.run(config)).rejects.toThrow(PauseExecutionError);

      expect(questionService.askQuestion).toHaveBeenCalledWith(
        PROJECT_PATH,
        FEATURE_ID,
        expect.arrayContaining([
          expect.objectContaining({
            options: [
              { label: 'Microservices' },
              { label: 'Monolith' },
              { label: 'Serverless' },
            ],
          }),
        ])
      );
    });

    it('should set options to undefined when question_meta has no options', async () => {
      const config = createMockConfig({
        stages: [
          createMockStage('plan', 'Planning', {
            question: 'Describe the approach',
            question_meta: { type: 'free-text' },
          }),
        ],
      });

      await expect(runner.run(config)).rejects.toThrow(PauseExecutionError);

      expect(questionService.askQuestion).toHaveBeenCalledWith(
        PROJECT_PATH,
        FEATURE_ID,
        expect.arrayContaining([
          expect.objectContaining({ options: undefined }),
        ])
      );
    });
  });
});
