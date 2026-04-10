/**
 * Unit tests for GenerationJobsIndicator
 *
 * Tests:
 *  - Returns null when there are no generation jobs
 *  - Returns null when all jobs belong to a different project
 *  - Returns null when all current-project jobs have non-generating status
 *  - Shows spinner + singular "idea" text for exactly one active job
 *  - Shows spinner + plural "ideas" text for multiple active jobs
 *  - Only counts generating jobs for the current project
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GenerationJobsIndicator } from '../../../src/components/views/ideation-view/generation-jobs-indicator';
import { useIdeationStore } from '@/store/ideation-store';
import { useAppStore } from '@/store/app-store';
import type { GenerationJob } from '@/store/ideation-store';
import type { IdeationPrompt } from '@pegasus/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/store/ideation-store');
vi.mock('@/store/app-store');

const mockUseIdeationStore = useIdeationStore as unknown as ReturnType<typeof vi.fn>;
const mockUseAppStore = useAppStore as unknown as ReturnType<typeof vi.fn>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_PROJECT = '/test/project';

const makePrompt = (): IdeationPrompt => ({
  id: 'p1',
  category: 'feature',
  title: 'Test Prompt',
  description: 'A test prompt description',
  prompt: 'Generate something cool',
});

const makeJob = (overrides: Partial<GenerationJob> = {}): GenerationJob => ({
  id: 'job-1',
  projectPath: TEST_PROJECT,
  prompt: makePrompt(),
  status: 'generating',
  suggestions: [],
  error: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: null,
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GenerationJobsIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAppStore.mockImplementation((selector: (s: object) => unknown) =>
      selector({ currentProject: { path: TEST_PROJECT } })
    );
  });

  describe('null rendering (no visible indicator)', () => {
    it('renders nothing when there are no jobs at all', () => {
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ generationJobs: [] })
      );
      const { container } = render(<GenerationJobsIndicator />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when all jobs belong to a different project', () => {
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ generationJobs: [makeJob({ projectPath: '/other/project' })] })
      );
      const { container } = render(<GenerationJobsIndicator />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when current-project jobs are all in ready status', () => {
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ generationJobs: [makeJob({ status: 'ready' })] })
      );
      const { container } = render(<GenerationJobsIndicator />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when current-project jobs are all in error status', () => {
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ generationJobs: [makeJob({ status: 'error', error: 'Network error' })] })
      );
      const { container } = render(<GenerationJobsIndicator />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when there is no current project', () => {
      mockUseAppStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ currentProject: null })
      );
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ generationJobs: [makeJob()] })
      );
      const { container } = render(<GenerationJobsIndicator />);
      // projectPath is '' when currentProject is null, so the job (which has TEST_PROJECT) won't match
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('active indicator rendering', () => {
    it('shows a spinner when one job is generating', () => {
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ generationJobs: [makeJob()] })
      );
      render(<GenerationJobsIndicator />);
      expect(screen.getByTestId('spinner')).toBeInTheDocument();
    });

    it('shows singular "idea" text for exactly one active generating job', () => {
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ generationJobs: [makeJob()] })
      );
      render(<GenerationJobsIndicator />);
      const { container } = render(<GenerationJobsIndicator />);
      expect(container).toHaveTextContent('Generating 1 idea…');
    });

    it('shows plural "ideas" text for two active generating jobs', () => {
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ generationJobs: [makeJob(), makeJob({ id: 'job-2' })] })
      );
      const { container } = render(<GenerationJobsIndicator />);
      expect(container).toHaveTextContent('Generating 2 ideas…');
    });

    it('shows plural "ideas" text for three active generating jobs', () => {
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({
          generationJobs: [
            makeJob(),
            makeJob({ id: 'job-2' }),
            makeJob({ id: 'job-3' }),
          ],
        })
      );
      const { container } = render(<GenerationJobsIndicator />);
      expect(container).toHaveTextContent('Generating 3 ideas…');
    });
  });

  describe('count accuracy', () => {
    it('only counts generating jobs for the current project, ignoring other statuses and projects', () => {
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({
          generationJobs: [
            makeJob(),                                          // counted (generating, current project)
            makeJob({ id: 'job-2', status: 'ready' }),         // not counted (not generating)
            makeJob({ id: 'job-3', status: 'error' }),         // not counted (not generating)
            makeJob({ id: 'job-4', projectPath: '/other' }),   // not counted (different project)
            makeJob({ id: 'job-5' }),                          // counted (generating, current project)
          ],
        })
      );
      const { container } = render(<GenerationJobsIndicator />);
      expect(container).toHaveTextContent('Generating 2 ideas…');
    });

    it('transitions from "ideas" to "idea" if count drops to one', () => {
      // First render with 2 jobs
      const jobs = [makeJob(), makeJob({ id: 'job-2' })];
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ generationJobs: jobs })
      );
      const { container, rerender } = render(<GenerationJobsIndicator />);
      expect(container).toHaveTextContent('Generating 2 ideas…');

      // Update to 1 job
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ generationJobs: [makeJob()] })
      );
      rerender(<GenerationJobsIndicator />);
      expect(container).toHaveTextContent('Generating 1 idea…');
    });
  });
});
