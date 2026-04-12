/**
 * Unit tests for PromptCommandPopover
 *
 * Tests:
 *  - Trigger button renders with correct label
 *  - Popover opens when button is clicked (command input visible)
 *  - All prompts and categories appear when popover is open with no search
 *  - Search by title filters to only matching prompts
 *  - Search by description filters to only matching prompts
 *  - Category groups with no matching prompts are hidden during search
 *  - "No prompts found." shown when search matches nothing
 *  - "Loading prompts…" shown when isLoading is true
 *  - Selecting a prompt calls addGenerationJob + mutation.mutate with correct args
 *  - Does not call handlers when projectPath is empty
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PromptCommandPopover } from "../../../src/components/views/ideation-view/prompt-command-popover";
import { useIdeationStore } from "@/store/ideation-store";
import { useAppStore } from "@/store/app-store";
import { useGuidedPrompts } from "@/hooks/use-guided-prompts";
import { useGenerateIdeationSuggestions } from "@/hooks/mutations/use-ideation-mutations";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/store/ideation-store");
vi.mock("@/store/app-store");
vi.mock("@/hooks/use-guided-prompts");
vi.mock("@/hooks/mutations/use-ideation-mutations");

const mockUseIdeationStore = useIdeationStore as unknown as ReturnType<
  typeof vi.fn
>;
const mockUseAppStore = useAppStore as unknown as ReturnType<typeof vi.fn>;
const mockUseGuidedPrompts = useGuidedPrompts as ReturnType<typeof vi.fn>;
const mockUseGenerateIdeationSuggestions =
  useGenerateIdeationSuggestions as ReturnType<typeof vi.fn>;

// ─── Test Data ────────────────────────────────────────────────────────────────

const TEST_PROJECT = "/test/project";

const mockAddGenerationJob = vi.fn().mockReturnValue("job-123");
const mockMutate = vi.fn();

const mockCategories = [
  {
    id: "feature",
    name: "Feature",
    icon: "lightbulb",
    description: "Feature prompts",
  },
  { id: "ux-ui", name: "UX/UI", icon: "palette", description: "UX/UI prompts" },
];

const mockPrompts = [
  {
    id: "p1",
    category: "feature",
    title: "Add dark mode",
    description: "Add a dark mode toggle to settings",
    prompt: "...",
  },
  {
    id: "p2",
    category: "feature",
    title: "Improve onboarding",
    description: "Better user onboarding flow",
    prompt: "...",
  },
  {
    id: "p3",
    category: "ux-ui",
    title: "Accessibility audit",
    description: "Check all a11y compliance issues",
    prompt: "...",
  },
];

// ─── Setup Helpers ────────────────────────────────────────────────────────────

/**
 * Re-establish the ResizeObserver mock before each test.
 *
 * vitest's `mockReset: true` config resets ALL vi.fn() implementations after
 * every test — including `globalThis.ResizeObserver` from setup.ts.
 * cmdk uses `new ResizeObserver(...)` internally when it mounts, so it needs
 * a proper constructor (class) that survives vitest's mock resets.
 */
function resetBrowserAPIs() {
  // ResizeObserver — must be a class (proper constructor) because cmdk calls `new ResizeObserver()`
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    MockResizeObserver as unknown as typeof ResizeObserver;

  // scrollIntoView — cmdk calls this when highlighting items; not implemented in jsdom
  Element.prototype.scrollIntoView = function () {};
}

function setupDefaultMocks() {
  // Re-establish return values after vitest's mockReset clears them between tests
  mockAddGenerationJob.mockReturnValue("job-123");

  mockUseAppStore.mockImplementation((selector: (s: object) => unknown) =>
    selector({ currentProject: { path: TEST_PROJECT } }),
  );

  mockUseIdeationStore.mockImplementation((selector: (s: object) => unknown) =>
    selector({ addGenerationJob: mockAddGenerationJob }),
  );

  mockUseGuidedPrompts.mockReturnValue({
    categories: mockCategories,
    prompts: mockPrompts,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    getPromptsByCategory: vi.fn(),
    getPromptById: vi.fn(),
    getCategoryById: vi.fn(),
  });

  mockUseGenerateIdeationSuggestions.mockReturnValue({
    mutate: mockMutate,
    isPending: false,
    isError: false,
    isSuccess: false,
  });
}

async function openPopover() {
  fireEvent.click(screen.getByRole("button", { name: /Generate Ideas/ }));
  await waitFor(() => {
    expect(screen.getByPlaceholderText("Search prompts…")).toBeInTheDocument();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PromptCommandPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBrowserAPIs();
    setupDefaultMocks();
  });

  // ─── Trigger button ──────────────────────────────────────────────────────────

  describe("trigger button", () => {
    it('renders the "Generate Ideas" button', () => {
      render(<PromptCommandPopover />);
      expect(
        screen.getByRole("button", { name: /Generate Ideas/ }),
      ).toBeInTheDocument();
    });

    it("does not show the command input before the button is clicked", () => {
      render(<PromptCommandPopover />);
      expect(
        screen.queryByPlaceholderText("Search prompts…"),
      ).not.toBeInTheDocument();
    });
  });

  // ─── Popover open ────────────────────────────────────────────────────────────

  describe("popover open state", () => {
    it("shows the search input when trigger button is clicked", async () => {
      render(<PromptCommandPopover />);
      await openPopover();
      expect(
        screen.getByPlaceholderText("Search prompts…"),
      ).toBeInTheDocument();
    });

    it("shows all prompt titles when opened with no search query", async () => {
      render(<PromptCommandPopover />);
      await openPopover();
      expect(screen.getByText("Add dark mode")).toBeInTheDocument();
      expect(screen.getByText("Improve onboarding")).toBeInTheDocument();
      expect(screen.getByText("Accessibility audit")).toBeInTheDocument();
    });

    it("shows prompt descriptions when opened", async () => {
      render(<PromptCommandPopover />);
      await openPopover();
      expect(
        screen.getByText("Add a dark mode toggle to settings"),
      ).toBeInTheDocument();
    });

    it("shows category group headings when prompts are available", async () => {
      render(<PromptCommandPopover />);
      await openPopover();
      expect(screen.getByText("Feature")).toBeInTheDocument();
      expect(screen.getByText("UX/UI")).toBeInTheDocument();
    });
  });

  // ─── Loading state ───────────────────────────────────────────────────────────

  describe("loading state", () => {
    it('shows "Loading prompts…" when isLoading is true and no prompts exist yet', async () => {
      mockUseGuidedPrompts.mockReturnValue({
        categories: [],
        prompts: [],
        isLoading: true,
        error: null,
        refetch: vi.fn(),
        getPromptsByCategory: vi.fn(),
        getPromptById: vi.fn(),
        getCategoryById: vi.fn(),
      });

      render(<PromptCommandPopover />);
      await openPopover();

      expect(screen.getByText("Loading prompts…")).toBeInTheDocument();
    });

    it('shows "No prompts found." when not loading and no prompts exist', async () => {
      mockUseGuidedPrompts.mockReturnValue({
        categories: [],
        prompts: [],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        getPromptsByCategory: vi.fn(),
        getPromptById: vi.fn(),
        getCategoryById: vi.fn(),
      });

      render(<PromptCommandPopover />);
      await openPopover();

      expect(screen.getByText("No prompts found.")).toBeInTheDocument();
    });
  });

  // ─── Search filtering ────────────────────────────────────────────────────────

  describe("search filtering", () => {
    it("filters prompts by title when the user types in the search input", async () => {
      render(<PromptCommandPopover />);
      await openPopover();

      fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
        target: { value: "dark mode" },
      });

      await waitFor(() => {
        expect(screen.getByText("Add dark mode")).toBeInTheDocument();
        expect(
          screen.queryByText("Improve onboarding"),
        ).not.toBeInTheDocument();
        expect(
          screen.queryByText("Accessibility audit"),
        ).not.toBeInTheDocument();
      });
    });

    it("filters prompts by description when the search term matches description text", async () => {
      render(<PromptCommandPopover />);
      await openPopover();

      fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
        target: { value: "a11y" },
      });

      await waitFor(() => {
        expect(screen.getByText("Accessibility audit")).toBeInTheDocument();
        expect(screen.queryByText("Add dark mode")).not.toBeInTheDocument();
        expect(
          screen.queryByText("Improve onboarding"),
        ).not.toBeInTheDocument();
      });
    });

    it("is case-insensitive", async () => {
      render(<PromptCommandPopover />);
      await openPopover();

      fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
        target: { value: "DARK MODE" },
      });

      await waitFor(() => {
        expect(screen.getByText("Add dark mode")).toBeInTheDocument();
      });
    });

    it("hides a category group when search filters out all its prompts", async () => {
      render(<PromptCommandPopover />);
      await openPopover();

      // "dark mode" only matches the feature category
      fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
        target: { value: "dark mode" },
      });

      await waitFor(() => {
        expect(screen.getByText("Feature")).toBeInTheDocument();
        expect(screen.queryByText("UX/UI")).not.toBeInTheDocument();
      });
    });

    it('shows "No prompts found." when no prompts match the search query', async () => {
      render(<PromptCommandPopover />);
      await openPopover();

      fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
        target: { value: "xyzzy-this-will-never-match" },
      });

      await waitFor(() => {
        expect(screen.getByText("No prompts found.")).toBeInTheDocument();
      });
    });

    it("shows all prompts again when search is cleared", async () => {
      render(<PromptCommandPopover />);
      await openPopover();

      // Filter down
      fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
        target: { value: "dark mode" },
      });
      await waitFor(() =>
        expect(
          screen.queryByText("Improve onboarding"),
        ).not.toBeInTheDocument(),
      );

      // Clear search
      fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
        target: { value: "" },
      });
      await waitFor(() => {
        expect(screen.getByText("Improve onboarding")).toBeInTheDocument();
        expect(screen.getByText("Accessibility audit")).toBeInTheDocument();
      });
    });
  });

  // ─── Prompt selection ────────────────────────────────────────────────────────

  describe("prompt selection", () => {
    it("calls addGenerationJob with the project path and the selected prompt", async () => {
      render(<PromptCommandPopover />);
      await openPopover();

      fireEvent.click(screen.getByText("Add dark mode"));

      await waitFor(() => {
        expect(mockAddGenerationJob).toHaveBeenCalledTimes(1);
        expect(mockAddGenerationJob).toHaveBeenCalledWith(
          TEST_PROJECT,
          expect.objectContaining({
            id: "p1",
            title: "Add dark mode",
            category: "feature",
          }),
        );
      });
    });

    it("calls mutation.mutate with the correct payload after selection", async () => {
      render(<PromptCommandPopover />);
      await openPopover();

      fireEvent.click(screen.getByText("Add dark mode"));

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledTimes(1);
        expect(mockMutate).toHaveBeenCalledWith({
          promptId: "p1",
          category: "feature",
          jobId: "job-123",
          promptTitle: "Add dark mode",
        });
      });
    });

    it("uses the job ID returned by addGenerationJob in the mutation call", async () => {
      mockAddGenerationJob.mockReturnValueOnce("custom-job-id-xyz");

      render(<PromptCommandPopover />);
      await openPopover();

      fireEvent.click(screen.getByText("Add dark mode"));

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledWith(
          expect.objectContaining({ jobId: "custom-job-id-xyz" }),
        );
      });
    });

    it("does not call addGenerationJob or mutate when projectPath is empty", async () => {
      mockUseAppStore.mockImplementation((selector: (s: object) => unknown) =>
        selector({ currentProject: null }),
      );

      render(<PromptCommandPopover />);
      await openPopover();

      fireEvent.click(screen.getByText("Add dark mode"));

      // Small wait to confirm nothing was called
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAddGenerationJob).not.toHaveBeenCalled();
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it("can select prompts from different categories independently", async () => {
      render(<PromptCommandPopover />);
      await openPopover();

      fireEvent.click(screen.getByText("Accessibility audit"));

      await waitFor(() => {
        expect(mockAddGenerationJob).toHaveBeenCalledWith(
          TEST_PROJECT,
          expect.objectContaining({ id: "p3", category: "ux-ui" }),
        );
        expect(mockMutate).toHaveBeenCalledWith(
          expect.objectContaining({ promptId: "p3", category: "ux-ui" }),
        );
      });
    });
  });
});
