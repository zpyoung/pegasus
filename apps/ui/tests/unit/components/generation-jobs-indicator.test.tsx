/**
 * Unit tests for GenerationJobsIndicator
 *
 * Tests:
 *  - Returns null when there are no generation jobs
 *  - Returns null when all jobs belong to a different project
 *  - Returns null when all current-project jobs have non-generating status
 *  - Returns null when projectPath prop is empty
 *  - Shows spinner + singular "idea" text for exactly one active job
 *  - Shows spinner + plural "ideas" text for multiple active jobs
 *  - Only counts generating jobs for the current project
 *  - Transitions from active → null when count drops to 0
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { GenerationJobsIndicator } from "../../../src/components/views/ideation-view/generation-jobs-indicator";
import { useIdeationStore } from "@/store/ideation-store";
import type { GenerationJob } from "@/store/ideation-store";
import type { IdeationPrompt } from "@pegasus/types";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/store/ideation-store");

const mockUseIdeationStore = useIdeationStore as unknown as ReturnType<
  typeof vi.fn
>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_PROJECT = "/test/project";

const makePrompt = (): IdeationPrompt => ({
  id: "p1",
  category: "feature",
  title: "Test Prompt",
  description: "A test prompt description",
  prompt: "Generate something cool",
});

const makeJob = (overrides: Partial<GenerationJob> = {}): GenerationJob => ({
  id: "job-1",
  projectPath: TEST_PROJECT,
  prompt: makePrompt(),
  status: "generating",
  suggestions: [],
  error: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GenerationJobsIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("null rendering (no visible indicator)", () => {
    it("renders nothing when there are no jobs at all", () => {
      mockUseIdeationStore.mockImplementation(
        (selector: (s: object) => unknown) => selector({ generationJobs: [] }),
      );
      const { container } = render(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when all jobs belong to a different project", () => {
      mockUseIdeationStore.mockImplementation(
        (selector: (s: object) => unknown) =>
          selector({
            generationJobs: [makeJob({ projectPath: "/other/project" })],
          }),
      );
      const { container } = render(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when current-project jobs are all in ready status", () => {
      mockUseIdeationStore.mockImplementation(
        (selector: (s: object) => unknown) =>
          selector({ generationJobs: [makeJob({ status: "ready" })] }),
      );
      const { container } = render(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when current-project jobs are all in error status", () => {
      mockUseIdeationStore.mockImplementation(
        (selector: (s: object) => unknown) =>
          selector({
            generationJobs: [
              makeJob({ status: "error", error: "Network error" }),
            ],
          }),
      );
      const { container } = render(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when projectPath prop is empty", () => {
      mockUseIdeationStore.mockImplementation(
        (selector: (s: object) => unknown) =>
          selector({ generationJobs: [makeJob()] }),
      );
      // Empty string won't match any job's projectPath
      const { container } = render(<GenerationJobsIndicator projectPath="" />);
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe("active indicator rendering", () => {
    it("shows a spinner when one job is generating", () => {
      mockUseIdeationStore.mockImplementation(
        (selector: (s: object) => unknown) =>
          selector({ generationJobs: [makeJob()] }),
      );
      render(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });

    it('shows singular "idea" text for exactly one active generating job', () => {
      mockUseIdeationStore.mockImplementation(
        (selector: (s: object) => unknown) =>
          selector({ generationJobs: [makeJob()] }),
      );
      const { container } = render(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(container).toHaveTextContent("Generating 1 idea…");
    });

    it('shows plural "ideas" text for two active generating jobs', () => {
      mockUseIdeationStore.mockImplementation(
        (selector: (s: object) => unknown) =>
          selector({ generationJobs: [makeJob(), makeJob({ id: "job-2" })] }),
      );
      const { container } = render(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(container).toHaveTextContent("Generating 2 ideas…");
    });

    it('shows plural "ideas" text for three active generating jobs', () => {
      mockUseIdeationStore.mockImplementation(
        (selector: (s: object) => unknown) =>
          selector({
            generationJobs: [
              makeJob(),
              makeJob({ id: "job-2" }),
              makeJob({ id: "job-3" }),
            ],
          }),
      );
      const { container } = render(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(container).toHaveTextContent("Generating 3 ideas…");
    });
  });

  describe("count accuracy", () => {
    it("only counts generating jobs for the current project, ignoring other statuses and projects", () => {
      mockUseIdeationStore.mockImplementation(
        (selector: (s: object) => unknown) =>
          selector({
            generationJobs: [
              makeJob(), // counted (generating, current project)
              makeJob({ id: "job-2", status: "ready" }), // not counted (not generating)
              makeJob({ id: "job-3", status: "error" }), // not counted (not generating)
              makeJob({ id: "job-4", projectPath: "/other" }), // not counted (different project)
              makeJob({ id: "job-5" }), // counted (generating, current project)
            ],
          }),
      );
      const { container } = render(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(container).toHaveTextContent("Generating 2 ideas…");
    });

    it('transitions from "ideas" to "idea" if count drops to one', () => {
      // First render with 2 jobs
      mockUseIdeationStore.mockImplementation(
        (selector: (s: object) => unknown) =>
          selector({ generationJobs: [makeJob(), makeJob({ id: "job-2" })] }),
      );
      const { container, rerender } = render(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(container).toHaveTextContent("Generating 2 ideas…");

      // Update to 1 job
      mockUseIdeationStore.mockImplementation(
        (selector: (s: object) => unknown) =>
          selector({ generationJobs: [makeJob()] }),
      );
      rerender(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(container).toHaveTextContent("Generating 1 idea…");
    });

    it('transitions from active indicator to null when all jobs complete', () => {
      // First render with 1 generating job
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ generationJobs: [makeJob()] })
      );
      const { container, rerender } = render(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(container).toHaveTextContent('Generating 1 idea…');

      // Job transitions to 'ready' — no more active jobs
      mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ generationJobs: [makeJob({ status: 'ready' })] })
      );
      rerender(<GenerationJobsIndicator projectPath={TEST_PROJECT} />);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
