/**
 * Unit tests for PlanApprovalDialog — interactive planning mode
 *
 * Covers:
 * - Normal rendering (review mode)
 * - Approve flow
 * - Reject / feedback flow (Revise Plan vs Cancel Feature)
 * - isRevising prop: banner, dimmed content, disabled footer, disabled toggle, close prevention
 * - isLoading prop: button disabled states
 * - viewOnly mode
 * - State resets (open/planContent changes, isRevising→false transition)
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanApprovalDialog } from "../../../src/components/views/board-view/dialogs/plan-approval-dialog";
import type { Feature } from "../../../src/store/app-store";

// Mock PlanContentViewer to avoid react-markdown / rehype overhead in unit tests
vi.mock(
  "../../../src/components/views/board-view/dialogs/plan-content-viewer",
  () => ({
    PlanContentViewer: ({ content }: { content: string }) => (
      <div data-testid="plan-content-viewer">{content}</div>
    ),
  }),
);

// ============================================================================
// Fixtures
// ============================================================================

const FEATURE: Feature = {
  id: "feat-1",
  title: "Add dark mode",
  description: "Support a dark color scheme",
  category: "feature",
  steps: [],
  status: "waiting_approval",
} as unknown as Feature;

const PLAN_CONTENT = "## Plan\n\n1. Step one\n2. Step two";

type DialogProps = Parameters<typeof PlanApprovalDialog>[0];

function renderDialog(overrides: Partial<DialogProps> = {}) {
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  const onApprove = overrides.onApprove ?? vi.fn();
  const onReject = overrides.onReject ?? vi.fn();

  const props: DialogProps = {
    open: true,
    onOpenChange,
    feature: FEATURE,
    planContent: PLAN_CONTENT,
    onApprove,
    onReject,
    ...overrides,
  };
  const utils = render(<PlanApprovalDialog {...props} />);
  return { ...utils, onOpenChange, onApprove, onReject };
}

// ============================================================================
// Basic rendering
// ============================================================================

describe("PlanApprovalDialog — basic rendering", () => {
  it('renders with data-testid="plan-approval-dialog"', () => {
    renderDialog();
    expect(screen.getByTestId("plan-approval-dialog")).toBeInTheDocument();
  });

  it('shows "Review Plan" title in normal mode', () => {
    renderDialog();
    expect(screen.getByText(/Review Plan/i)).toBeInTheDocument();
  });

  it("shows the plan content via PlanContentViewer", () => {
    renderDialog();
    // Check for a unique substring rather than exact multi-line match
    expect(screen.getByTestId("plan-content-viewer")).toHaveTextContent(
      "Step one",
    );
  });

  it('shows "Approve Plan" and "Request Changes" buttons', () => {
    renderDialog();
    expect(
      screen.getByRole("button", { name: /Approve Plan/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Request Changes/i }),
    ).toBeInTheDocument();
  });

  it("does not render when open=false", () => {
    renderDialog({ open: false });
    expect(
      screen.queryByTestId("plan-approval-dialog"),
    ).not.toBeInTheDocument();
  });
});

// ============================================================================
// Approve flow
// ============================================================================

describe("PlanApprovalDialog — approve flow", () => {
  it("calls onApprove with undefined when plan is unmodified", async () => {
    const user = userEvent.setup();
    const { onApprove } = renderDialog();

    await user.click(screen.getByRole("button", { name: /Approve Plan/i }));

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(undefined);
  });

  it("calls onApprove with edited content after editing the plan", async () => {
    const user = userEvent.setup();
    const { onApprove } = renderDialog();

    // Switch to edit mode
    await user.click(screen.getByRole("button", { name: /Edit/i }));

    // Modify the textarea
    const textarea = screen.getByPlaceholderText(/Enter plan content/i);
    await user.clear(textarea);
    await user.type(textarea, "Edited plan content");

    // Approve
    await user.click(screen.getByRole("button", { name: /Approve Plan/i }));

    expect(onApprove).toHaveBeenCalledWith("Edited plan content");
  });
});

// ============================================================================
// Reject / feedback flow
// ============================================================================

describe("PlanApprovalDialog — reject / feedback flow", () => {
  it('shows feedback textarea after clicking "Request Changes"', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Request Changes/i }));

    expect(
      screen.getByLabelText(/What changes would you like/i),
    ).toBeInTheDocument();
  });

  it('"Back" button hides the feedback textarea', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Request Changes/i }));
    expect(
      screen.getByLabelText(/What changes would you like/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Back/i }));
    expect(
      screen.queryByLabelText(/What changes would you like/i),
    ).not.toBeInTheDocument();
  });

  it('shows "Cancel Feature" button when feedback textarea is empty', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Request Changes/i }));

    // No feedback typed — should show "Cancel Feature"
    expect(
      screen.getByRole("button", { name: /Cancel Feature/i }),
    ).toBeInTheDocument();
  });

  it('shows "Revise Plan" button when feedback text is entered', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Request Changes/i }));
    await user.type(
      screen.getByLabelText(/What changes would you like/i),
      "Please add error handling",
    );

    expect(
      screen.getByRole("button", { name: /Revise Plan/i }),
    ).toBeInTheDocument();
  });

  it('calls onReject with feedback when "Revise Plan" is clicked', async () => {
    const user = userEvent.setup();
    const { onReject } = renderDialog();

    await user.click(screen.getByRole("button", { name: /Request Changes/i }));
    await user.type(
      screen.getByLabelText(/What changes would you like/i),
      "Add more tests",
    );
    await user.click(screen.getByRole("button", { name: /Revise Plan/i }));

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith("Add more tests");
  });

  it('calls onReject with undefined when "Cancel Feature" is clicked (no feedback)', async () => {
    const user = userEvent.setup();
    const { onReject } = renderDialog();

    await user.click(screen.getByRole("button", { name: /Request Changes/i }));
    // No feedback typed
    await user.click(screen.getByRole("button", { name: /Cancel Feature/i }));

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith(undefined);
  });
});

// ============================================================================
// isRevising prop — interactive planning mode
// ============================================================================

describe("PlanApprovalDialog — isRevising=true", () => {
  it("shows the revision-in-progress banner", () => {
    renderDialog({ isRevising: true });

    expect(
      screen.getByText(/AI is revising the plan based on your feedback/i),
    ).toBeInTheDocument();
  });

  it('shows a disabled "Revising plan" button in the footer', () => {
    renderDialog({ isRevising: true });

    const revisingBtn = screen.getByRole("button", { name: /Revising plan/i });
    expect(revisingBtn).toBeInTheDocument();
    expect(revisingBtn).toBeDisabled();
  });

  it('does NOT show "Approve Plan" or "Request Changes" when isRevising', () => {
    renderDialog({ isRevising: true });

    expect(
      screen.queryByRole("button", { name: /Approve Plan/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Request Changes/i }),
    ).not.toBeInTheDocument();
  });

  it("applies opacity-40 class to the plan content area while revising", () => {
    renderDialog({ isRevising: true });

    // The plan content wrapper should have opacity-40
    const contentViewer = screen.getByTestId("plan-content-viewer");
    // Walk up to the wrapper div that has the opacity class
    const wrapper = contentViewer.closest(".opacity-40");
    expect(wrapper).not.toBeNull();
  });

  it("applies pointer-events-none to plan content area while revising", () => {
    renderDialog({ isRevising: true });

    const contentViewer = screen.getByTestId("plan-content-viewer");
    const wrapper = contentViewer.closest(".pointer-events-none");
    expect(wrapper).not.toBeNull();
  });

  it("disables the Edit/View toggle button when isRevising=true", () => {
    renderDialog({ isRevising: true });

    // The mode toggle should be disabled — user cannot enter edit mode mid-revision
    expect(screen.getByRole("button", { name: /Edit/i })).toBeDisabled();
  });

  it("does NOT show the revision banner when isRevising=false", () => {
    renderDialog({ isRevising: false });

    expect(
      screen.queryByText(/AI is revising the plan based on your feedback/i),
    ).not.toBeInTheDocument();
  });

  it("prevents closing the dialog while isRevising (onOpenChange not called on Escape)", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ isRevising: true });

    await user.keyboard("{Escape}");

    // onOpenChange(false) should NOT be called because isRevising blocks it
    const closeCalls = onOpenChange.mock.calls.filter(([v]) => v === false);
    expect(closeCalls).toHaveLength(0);
  });
});

// ============================================================================
// isRevising state resets
// ============================================================================

describe("PlanApprovalDialog — isRevising state transitions", () => {
  it("clears feedback state when isRevising transitions to false (revised plan arrives)", async () => {
    const user = userEvent.setup();

    // Start in normal review mode, click Request Changes, enter feedback
    const { rerender, onOpenChange, onApprove, onReject } = renderDialog({
      isRevising: false,
    });
    await user.click(screen.getByRole("button", { name: /Request Changes/i }));
    await user.type(
      screen.getByLabelText(/What changes would you like/i),
      "Needs more detail",
    );

    // Feedback textarea should be visible
    expect(
      screen.getByLabelText(/What changes would you like/i),
    ).toBeInTheDocument();

    // Simulate: revision is submitted → isRevising becomes true
    rerender(
      <PlanApprovalDialog
        open={true}
        onOpenChange={onOpenChange}
        feature={FEATURE}
        planContent={PLAN_CONTENT}
        onApprove={onApprove}
        onReject={onReject}
        isRevising={true}
      />,
    );

    // Simulate: revised plan arrives → isRevising becomes false, planContent updated
    const REVISED_CONTENT =
      "## Revised Plan\n\n1. Step one (revised)\n2. Step two (revised)";
    rerender(
      <PlanApprovalDialog
        open={true}
        onOpenChange={onOpenChange}
        feature={FEATURE}
        planContent={REVISED_CONTENT}
        onApprove={onApprove}
        onReject={onReject}
        isRevising={false}
      />,
    );

    // Feedback textarea should be gone — reset by useEffect
    expect(
      screen.queryByLabelText(/What changes would you like/i),
    ).not.toBeInTheDocument();
    // Normal approve/reject buttons should be back
    expect(
      screen.getByRole("button", { name: /Approve Plan/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================================
// isLoading state
// ============================================================================

describe("PlanApprovalDialog — isLoading=true", () => {
  it('disables the "Approve Plan" button while loading', () => {
    renderDialog({ isLoading: true });
    expect(
      screen.getByRole("button", { name: /Approve Plan/i }),
    ).toBeDisabled();
  });

  it('disables the "Request Changes" button while loading', () => {
    renderDialog({ isLoading: true });
    expect(
      screen.getByRole("button", { name: /Request Changes/i }),
    ).toBeDisabled();
  });

  it("disables the Edit/View toggle button while loading", () => {
    renderDialog({ isLoading: true });
    expect(screen.getByRole("button", { name: /Edit/i })).toBeDisabled();
  });
});

// ============================================================================
// viewOnly mode
// ============================================================================

describe("PlanApprovalDialog — viewOnly mode", () => {
  it('shows "View Plan" title in viewOnly mode', () => {
    renderDialog({ viewOnly: true });
    expect(screen.getByText(/View Plan/i)).toBeInTheDocument();
  });

  it('shows only a "Close" button in viewOnly mode', () => {
    renderDialog({ viewOnly: true });
    // Radix Dialog also renders an X-icon close button; scope to the footer
    const footer = document.querySelector('[data-slot="dialog-footer"]')!;
    expect(
      within(footer).getByRole("button", { name: /Close/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Approve Plan/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Request Changes/i }),
    ).not.toBeInTheDocument();
  });

  it('calls onOpenChange(false) when "Close" is clicked in viewOnly mode', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ viewOnly: true });

    // Radix Dialog also renders an X-icon close button; click the footer one
    const footer = document.querySelector('[data-slot="dialog-footer"]')!;
    await user.click(within(footer).getByRole("button", { name: /Close/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does NOT show the Edit/View toggle in viewOnly mode", () => {
    renderDialog({ viewOnly: true });
    expect(
      screen.queryByRole("button", { name: /Edit/i }),
    ).not.toBeInTheDocument();
  });
});

// ============================================================================
// Dialog re-open / planContent change resets state
// ============================================================================

describe("PlanApprovalDialog — state reset on open/content change", () => {
  it("resets edit mode when dialog re-opens", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onApprove = vi.fn();
    const onReject = vi.fn();

    const { rerender } = render(
      <PlanApprovalDialog
        open={true}
        onOpenChange={onOpenChange}
        feature={FEATURE}
        planContent={PLAN_CONTENT}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    // Enter edit mode
    await user.click(screen.getByRole("button", { name: /Edit/i }));
    // Now in edit mode — should see "View" button
    expect(screen.getByRole("button", { name: /View/i })).toBeInTheDocument();

    // Close and re-open
    rerender(
      <PlanApprovalDialog
        open={false}
        onOpenChange={onOpenChange}
        feature={FEATURE}
        planContent={PLAN_CONTENT}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    rerender(
      <PlanApprovalDialog
        open={true}
        onOpenChange={onOpenChange}
        feature={FEATURE}
        planContent={PLAN_CONTENT}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    // Should be back in view mode — "Edit" button visible, not "View"
    expect(screen.getByRole("button", { name: /Edit/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^View$/i }),
    ).not.toBeInTheDocument();
  });

  it("resets the edited plan when planContent changes while open", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onApprove = vi.fn();
    const onReject = vi.fn();

    const { rerender } = render(
      <PlanApprovalDialog
        open={true}
        onOpenChange={onOpenChange}
        feature={FEATURE}
        planContent={PLAN_CONTENT}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    // Switch to edit mode and make a change
    await user.click(screen.getByRole("button", { name: /Edit/i }));
    const textarea = screen.getByPlaceholderText(/Enter plan content/i);
    await user.clear(textarea);
    await user.type(textarea, "My custom edit");
    expect(textarea).toHaveValue("My custom edit");

    // Simulate the server returning a new plan
    const NEW_PLAN = "## New Plan\n\n- Task A\n- Task B";
    rerender(
      <PlanApprovalDialog
        open={true}
        onOpenChange={onOpenChange}
        feature={FEATURE}
        planContent={NEW_PLAN}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    // planContent change resets edit mode (isEditMode=false) and editedPlan to the new content.
    // Since we're now in view mode, PlanContentViewer shows the new plan (not the old custom edit).
    expect(
      screen.queryByPlaceholderText(/Enter plan content/i),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-content-viewer")).toHaveTextContent(
      "Task A",
    );
  });
});
