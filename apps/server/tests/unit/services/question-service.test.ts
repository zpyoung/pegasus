import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Feature, AgentQuestion } from '@pegasus/types';

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
  atomicWriteJson: vi.fn().mockResolvedValue(undefined),
  readJsonWithRecovery: vi.fn(),
  DEFAULT_BACKUP_COUNT: 3,
}));

vi.mock('@pegasus/platform', () => ({
  getFeatureDir: (projectPath: string, featureId: string) =>
    `${projectPath}/.pegasus/features/${featureId}`,
}));

// Imports after mocks
import { atomicWriteJson, readJsonWithRecovery } from '@pegasus/utils';
import { QuestionService } from '@/services/question-service.js';
import type { TypedEventBus } from '@/services/typed-event-bus.js';

// ============================================================================
// Helpers
// ============================================================================

const PROJECT_PATH = '/test/project';
const FEATURE_ID = 'feat-123';

function createMockEventBus(): TypedEventBus {
  return {
    emitAutoModeEvent: vi.fn(),
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    getUnderlyingEmitter: vi.fn(),
  } as unknown as TypedEventBus;
}

function createMockFeature(overrides?: Partial<Feature>): Feature {
  return {
    id: FEATURE_ID,
    title: 'Test Feature',
    description: 'A test feature',
    status: 'waiting_question',
    branchName: 'feat/test-feature',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function createMockQuestion(overrides?: Partial<AgentQuestion>): AgentQuestion {
  return {
    id: 'q-001',
    stageId: 'plan',
    question: 'What approach should we take?',
    type: 'free-text',
    status: 'pending',
    askedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Sets up readJsonWithRecovery to return a feature on every call */
function mockFeatureLoad(feature: Feature | null) {
  vi.mocked(readJsonWithRecovery).mockResolvedValue({ data: feature });
}

// ============================================================================
// Tests
// ============================================================================

describe('QuestionService', () => {
  let service: QuestionService;
  let mockEventBus: TypedEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventBus = createMockEventBus();
    service = new QuestionService(mockEventBus);
  });

  // ==========================================================================
  // askQuestion
  // ==========================================================================

  describe('askQuestion', () => {
    it('should persist questionState to feature JSON', async () => {
      const feature = createMockFeature();
      mockFeatureLoad(feature);

      const question = createMockQuestion();
      await service.askQuestion(PROJECT_PATH, FEATURE_ID, [question]);

      expect(atomicWriteJson).toHaveBeenCalledWith(
        expect.stringContaining('feature.json'),
        expect.objectContaining({
          questionState: expect.objectContaining({
            questions: [question],
            status: 'pending',
          }),
        }),
        expect.any(Object)
      );
    });

    it('should emit question_required event', async () => {
      const feature = createMockFeature();
      mockFeatureLoad(feature);

      const question = createMockQuestion();
      await service.askQuestion(PROJECT_PATH, FEATURE_ID, [question]);

      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'question_required',
        expect.objectContaining({
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          questions: [question],
        })
      );
    });

    it('should include branchName in event when available', async () => {
      const feature = createMockFeature({ branchName: 'feat/my-branch' });
      mockFeatureLoad(feature);

      await service.askQuestion(PROJECT_PATH, FEATURE_ID, [createMockQuestion()]);

      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'question_required',
        expect.objectContaining({ branchName: 'feat/my-branch' })
      );
    });

    it('should support multiple questions in a single batch', async () => {
      const feature = createMockFeature();
      mockFeatureLoad(feature);

      const questions = [
        createMockQuestion({ id: 'q-1', question: 'First question?' }),
        createMockQuestion({ id: 'q-2', question: 'Second question?', type: 'single-select' }),
      ];

      await service.askQuestion(PROJECT_PATH, FEATURE_ID, questions);

      expect(atomicWriteJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          questionState: expect.objectContaining({
            questions,
            status: 'pending',
          }),
        }),
        expect.any(Object)
      );

      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'question_required',
        expect.objectContaining({ questions })
      );
    });

    it('should use correct feature path', async () => {
      mockFeatureLoad(createMockFeature());

      await service.askQuestion(PROJECT_PATH, FEATURE_ID, [createMockQuestion()]);

      expect(atomicWriteJson).toHaveBeenCalledWith(
        `/test/project/.pegasus/features/${FEATURE_ID}/feature.json`,
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('should not throw when feature cannot be loaded for event branchName', async () => {
      // Feature loads OK for writeQuestionState but returns null for loadFeature
      vi.mocked(readJsonWithRecovery)
        .mockResolvedValueOnce({ data: createMockFeature() }) // writeQuestionState: load
        .mockResolvedValueOnce({ data: null }); // loadFeature: load for event

      await expect(
        service.askQuestion(PROJECT_PATH, FEATURE_ID, [createMockQuestion()])
      ).resolves.not.toThrow();

      // Event is still emitted (without branchName)
      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'question_required',
        expect.objectContaining({ branchName: undefined })
      );
    });
  });

  // ==========================================================================
  // resolveAnswer
  // ==========================================================================

  describe('resolveAnswer', () => {
    it('should mark question as answered and persist to JSON', async () => {
      const question = createMockQuestion({ id: 'q-001', status: 'pending' });
      const feature = createMockFeature({
        questionState: { questions: [question], status: 'pending' },
      });

      // Called by loadFeature, then by writeQuestionState (inner load)
      mockFeatureLoad(feature);

      const result = await service.resolveAnswer(
        PROJECT_PATH,
        FEATURE_ID,
        'q-001',
        'My answer'
      );

      expect(result).toEqual({ allAnswered: true });
      expect(atomicWriteJson).toHaveBeenCalled();
    });

    it('should set questionState.status to "answered" when all answered', async () => {
      const question = createMockQuestion({ id: 'q-001', status: 'pending' });
      const feature = createMockFeature({
        questionState: { questions: [question], status: 'pending' },
      });
      mockFeatureLoad(feature);

      await service.resolveAnswer(PROJECT_PATH, FEATURE_ID, 'q-001', 'Done');

      // The first write call is from writeQuestionState
      const writeCall = vi.mocked(atomicWriteJson).mock.calls[0];
      expect(writeCall[1]).toMatchObject({
        questionState: {
          status: 'answered',
          questions: [
            expect.objectContaining({
              id: 'q-001',
              status: 'answered',
              answer: 'Done',
            }),
          ],
        },
      });
    });

    it('should emit question_answered event', async () => {
      const question = createMockQuestion({ id: 'q-001', status: 'pending' });
      const feature = createMockFeature({
        questionState: { questions: [question], status: 'pending' },
      });
      mockFeatureLoad(feature);

      await service.resolveAnswer(PROJECT_PATH, FEATURE_ID, 'q-001', 'Answer text');

      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'question_answered',
        expect.objectContaining({
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          questionId: 'q-001',
          allAnswered: true,
        })
      );
    });

    it('should set feature status to ready and emit feature_status_changed when all answered', async () => {
      const question = createMockQuestion({ id: 'q-001', status: 'pending' });
      const feature = createMockFeature({
        questionState: { questions: [question], status: 'pending' },
      });
      mockFeatureLoad(feature);

      await service.resolveAnswer(PROJECT_PATH, FEATURE_ID, 'q-001', 'Answer text');

      // atomicWriteJson called twice: once for questionState, once for status=ready
      expect(atomicWriteJson).toHaveBeenCalledTimes(2);

      // Second write sets status to ready
      const secondWrite = vi.mocked(atomicWriteJson).mock.calls[1];
      expect(secondWrite[1]).toMatchObject({ status: 'ready' });

      // feature_status_changed event
      expect(mockEventBus.emitAutoModeEvent).toHaveBeenCalledWith(
        'feature_status_changed',
        expect.objectContaining({
          featureId: FEATURE_ID,
          projectPath: PROJECT_PATH,
          status: 'ready',
        })
      );
    });

    it('should return allAnswered=false when more questions remain', async () => {
      const questions = [
        createMockQuestion({ id: 'q-001', status: 'pending' }),
        createMockQuestion({ id: 'q-002', status: 'pending' }),
      ];
      const feature = createMockFeature({
        questionState: { questions, status: 'pending' },
      });
      mockFeatureLoad(feature);

      const result = await service.resolveAnswer(
        PROJECT_PATH,
        FEATURE_ID,
        'q-001', // Only answering the first one
        'First answer'
      );

      expect(result).toEqual({ allAnswered: false });
      // Should NOT set status to ready
      expect(atomicWriteJson).toHaveBeenCalledTimes(1);
      expect(mockEventBus.emitAutoModeEvent).not.toHaveBeenCalledWith(
        'feature_status_changed',
        expect.any(Object)
      );
    });

    it('should throw when feature is not found', async () => {
      vi.mocked(readJsonWithRecovery).mockResolvedValue({ data: null });

      await expect(
        service.resolveAnswer(PROJECT_PATH, FEATURE_ID, 'q-001', 'Answer')
      ).rejects.toThrow(`Feature ${FEATURE_ID} not found`);
    });

    it('should throw when feature has no questionState', async () => {
      const feature = createMockFeature({ questionState: undefined });
      mockFeatureLoad(feature);

      await expect(
        service.resolveAnswer(PROJECT_PATH, FEATURE_ID, 'q-001', 'Answer')
      ).rejects.toThrow(`Feature ${FEATURE_ID} has no pending questions`);
    });

    it('should throw when question ID is not found', async () => {
      const question = createMockQuestion({ id: 'q-001' });
      const feature = createMockFeature({
        questionState: { questions: [question], status: 'pending' },
      });
      mockFeatureLoad(feature);

      await expect(
        service.resolveAnswer(PROJECT_PATH, FEATURE_ID, 'q-999', 'Answer')
      ).rejects.toThrow(`Question q-999 not found for feature ${FEATURE_ID}`);
    });

    it('should set answeredAt timestamp on the question', async () => {
      const question = createMockQuestion({ id: 'q-001', status: 'pending' });
      const feature = createMockFeature({
        questionState: { questions: [question], status: 'pending' },
      });
      mockFeatureLoad(feature);

      await service.resolveAnswer(PROJECT_PATH, FEATURE_ID, 'q-001', 'My answer');

      const writeCall = vi.mocked(atomicWriteJson).mock.calls[0];
      const updatedQuestion = writeCall[1].questionState.questions[0];
      expect(updatedQuestion.answeredAt).toBeDefined();
      expect(updatedQuestion.answeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // ==========================================================================
  // cancelQuestions
  // ==========================================================================

  describe('cancelQuestions', () => {
    it('should set questionState.status to "cancelled"', async () => {
      const question = createMockQuestion();
      const feature = createMockFeature({
        questionState: { questions: [question], status: 'pending' },
      });
      mockFeatureLoad(feature);

      await service.cancelQuestions(PROJECT_PATH, FEATURE_ID);

      expect(atomicWriteJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          questionState: expect.objectContaining({ status: 'cancelled' }),
        }),
        expect.any(Object)
      );
    });

    it('should do nothing when feature has no questionState', async () => {
      const feature = createMockFeature({ questionState: undefined });
      mockFeatureLoad(feature);

      await service.cancelQuestions(PROJECT_PATH, FEATURE_ID);

      expect(atomicWriteJson).not.toHaveBeenCalled();
    });

    it('should do nothing when feature is not found', async () => {
      vi.mocked(readJsonWithRecovery).mockResolvedValue({ data: null });

      await service.cancelQuestions(PROJECT_PATH, FEATURE_ID);

      expect(atomicWriteJson).not.toHaveBeenCalled();
    });

    it('should not throw when cancellation succeeds', async () => {
      const question = createMockQuestion();
      const feature = createMockFeature({
        questionState: { questions: [question], status: 'pending' },
      });
      mockFeatureLoad(feature);

      await expect(service.cancelQuestions(PROJECT_PATH, FEATURE_ID)).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // getPendingQuestions
  // ==========================================================================

  describe('getPendingQuestions', () => {
    it('should return pending questions when feature has pending questionState', async () => {
      const questions = [
        createMockQuestion({ id: 'q-001', status: 'pending' }),
        createMockQuestion({ id: 'q-002', status: 'pending' }),
      ];
      const feature = createMockFeature({
        questionState: { questions, status: 'pending' },
      });
      mockFeatureLoad(feature);

      const result = await service.getPendingQuestions(PROJECT_PATH, FEATURE_ID);

      expect(result).toHaveLength(2);
      expect(result).toEqual(questions);
    });

    it('should filter out answered questions', async () => {
      const questions = [
        createMockQuestion({ id: 'q-001', status: 'answered', answer: 'done' }),
        createMockQuestion({ id: 'q-002', status: 'pending' }),
      ];
      const feature = createMockFeature({
        questionState: { questions, status: 'pending' },
      });
      mockFeatureLoad(feature);

      const result = await service.getPendingQuestions(PROJECT_PATH, FEATURE_ID);

      expect(result).toHaveLength(1);
      expect(result![0].id).toBe('q-002');
    });

    it('should return null when feature has no questionState', async () => {
      const feature = createMockFeature({ questionState: undefined });
      mockFeatureLoad(feature);

      const result = await service.getPendingQuestions(PROJECT_PATH, FEATURE_ID);

      expect(result).toBeNull();
    });

    it('should return null when questionState.status is "answered"', async () => {
      const questions = [createMockQuestion({ status: 'answered', answer: 'done' })];
      const feature = createMockFeature({
        questionState: { questions, status: 'answered' },
      });
      mockFeatureLoad(feature);

      const result = await service.getPendingQuestions(PROJECT_PATH, FEATURE_ID);

      expect(result).toBeNull();
    });

    it('should return null when questionState.status is "cancelled"', async () => {
      const feature = createMockFeature({
        questionState: { questions: [], status: 'cancelled' },
      });
      mockFeatureLoad(feature);

      const result = await service.getPendingQuestions(PROJECT_PATH, FEATURE_ID);

      expect(result).toBeNull();
    });

    it('should return null when feature is not found', async () => {
      vi.mocked(readJsonWithRecovery).mockResolvedValue({ data: null });

      const result = await service.getPendingQuestions(PROJECT_PATH, FEATURE_ID);

      expect(result).toBeNull();
    });
  });
});
