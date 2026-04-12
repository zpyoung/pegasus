/**
 * Tests for QuestionDialog and the synthetic "Other" option.
 *
 * Covers both the pure helpers (`buildFinalAnswer`, `isQuestionAnswered`)
 * and the rendered component behavior (radio/checkbox flows, hidden text
 * input, submit-disabled gating, payload substitution).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QuestionDialog,
  OTHER_OPTION_SENTINEL,
  buildFinalAnswer,
  isQuestionAnswered,
} from "../../../src/components/views/board-view/dialogs/question-dialog";
import type { AgentQuestion } from "@pegasus/types";
import type { Feature } from "../../../src/store/app-store";

// ============================================================================
// Fixtures
// ============================================================================

const FEATURE: Feature = {
  id: "feat-test",
  title: "Test Feature",
  description: "A test feature",
  category: "feature",
  steps: [],
  status: "waiting_question",
} as unknown as Feature;

function makeFreeTextQuestion(
  overrides?: Partial<AgentQuestion>,
): AgentQuestion {
  return {
    id: "q-free",
    stageId: "plan",
    question: "Describe the desired behavior.",
    type: "free-text",
    status: "pending",
    askedAt: "2026-04-07T00:00:00Z",
    source: "agent",
    ...overrides,
  };
}

function makeSingleSelectQuestion(
  overrides?: Partial<AgentQuestion>,
): AgentQuestion {
  return {
    id: "q-single",
    stageId: "plan",
    question: "Which library should we use?",
    type: "single-select",
    options: [
      { label: "date-fns", description: "Modular" },
      { label: "dayjs", description: "Tiny" },
    ],
    status: "pending",
    askedAt: "2026-04-07T00:00:00Z",
    source: "agent",
    ...overrides,
  };
}

function makeMultiSelectQuestion(
  overrides?: Partial<AgentQuestion>,
): AgentQuestion {
  return {
    id: "q-multi",
    stageId: "plan",
    question: "Which features do you want?",
    type: "multi-select",
    options: [
      { label: "Email", description: "SMTP" },
      { label: "SMS", description: "Twilio" },
    ],
    status: "pending",
    askedAt: "2026-04-07T00:00:00Z",
    source: "agent",
    ...overrides,
  };
}

// ============================================================================
// Pure helpers
// ============================================================================

describe("buildFinalAnswer", () => {
  it("returns trimmed answer for free-text", () => {
    const q = makeFreeTextQuestion();
    expect(buildFinalAnswer(q, "  hello world  ", "")).toBe("hello world");
  });

  it("returns the picked label for single-select when not Other", () => {
    const q = makeSingleSelectQuestion();
    expect(buildFinalAnswer(q, "date-fns", "")).toBe("date-fns");
  });

  it("substitutes the Other sentinel with trimmed custom text for single-select", () => {
    const q = makeSingleSelectQuestion();
    expect(buildFinalAnswer(q, OTHER_OPTION_SENTINEL, "  luxon  ")).toBe(
      "luxon",
    );
  });

  it("returns the comma-joined labels for multi-select when no Other", () => {
    const q = makeMultiSelectQuestion();
    expect(buildFinalAnswer(q, "Email, SMS", "")).toBe("Email, SMS");
  });

  it("substitutes Other sentinel within a multi-select list", () => {
    const q = makeMultiSelectQuestion();
    expect(
      buildFinalAnswer(q, `Email, ${OTHER_OPTION_SENTINEL}, SMS`, "Push"),
    ).toBe("Email, Push, SMS");
  });

  it("drops empty Other text from a multi-select list (defensive)", () => {
    const q = makeMultiSelectQuestion();
    // Should not happen because validation prevents submission, but defend anyway
    expect(buildFinalAnswer(q, `Email, ${OTHER_OPTION_SENTINEL}`, "")).toBe(
      "Email",
    );
  });
});

describe("isQuestionAnswered", () => {
  it("false for empty free-text", () => {
    expect(isQuestionAnswered(makeFreeTextQuestion(), "", "")).toBe(false);
  });

  it("false for whitespace-only free-text", () => {
    expect(isQuestionAnswered(makeFreeTextQuestion(), "   ", "")).toBe(false);
  });

  it("true for non-empty free-text", () => {
    expect(isQuestionAnswered(makeFreeTextQuestion(), "an answer", "")).toBe(
      true,
    );
  });

  it("false for unselected single-select", () => {
    expect(isQuestionAnswered(makeSingleSelectQuestion(), "", "")).toBe(false);
  });

  it("true for picked single-select option", () => {
    expect(isQuestionAnswered(makeSingleSelectQuestion(), "dayjs", "")).toBe(
      true,
    );
  });

  it("false for single-select Other with no custom text", () => {
    expect(
      isQuestionAnswered(makeSingleSelectQuestion(), OTHER_OPTION_SENTINEL, ""),
    ).toBe(false);
  });

  it("false for single-select Other with whitespace-only custom text", () => {
    expect(
      isQuestionAnswered(
        makeSingleSelectQuestion(),
        OTHER_OPTION_SENTINEL,
        "   ",
      ),
    ).toBe(false);
  });

  it("true for single-select Other with custom text", () => {
    expect(
      isQuestionAnswered(
        makeSingleSelectQuestion(),
        OTHER_OPTION_SENTINEL,
        "luxon",
      ),
    ).toBe(true);
  });

  it("false for empty multi-select", () => {
    expect(isQuestionAnswered(makeMultiSelectQuestion(), "", "")).toBe(false);
  });

  it("true for multi-select with at least one regular option", () => {
    expect(isQuestionAnswered(makeMultiSelectQuestion(), "Email", "")).toBe(
      true,
    );
  });

  it("false for multi-select Other-only with no custom text", () => {
    expect(
      isQuestionAnswered(makeMultiSelectQuestion(), OTHER_OPTION_SENTINEL, ""),
    ).toBe(false);
  });

  it("true for multi-select with both regular options and Other (with text)", () => {
    expect(
      isQuestionAnswered(
        makeMultiSelectQuestion(),
        `Email, ${OTHER_OPTION_SENTINEL}`,
        "Push",
      ),
    ).toBe(true);
  });
});

// ============================================================================
// Rendered component
// ============================================================================

describe("QuestionDialog — Other option rendering", () => {
  let onSubmitAllAnswers: ReturnType<typeof vi.fn>;
  let onOpenChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSubmitAllAnswers = vi.fn().mockResolvedValue(undefined);
    onOpenChange = vi.fn();
  });

  it('renders an "Other" radio for single-select questions', () => {
    const q = makeSingleSelectQuestion();
    render(
      <QuestionDialog
        open
        onOpenChange={onOpenChange}
        feature={FEATURE}
        questions={[q]}
        onSubmitAllAnswers={onSubmitAllAnswers}
      />,
    );

    expect(screen.getByTestId(`option-${q.id}-other`)).toBeInTheDocument();
  });

  it('renders an "Other" checkbox for multi-select questions', () => {
    const q = makeMultiSelectQuestion();
    render(
      <QuestionDialog
        open
        onOpenChange={onOpenChange}
        feature={FEATURE}
        questions={[q]}
        onSubmitAllAnswers={onSubmitAllAnswers}
      />,
    );

    expect(screen.getByTestId(`option-${q.id}-other`)).toBeInTheDocument();
  });

  it('does NOT render an "Other" option for free-text questions', () => {
    const q = makeFreeTextQuestion();
    render(
      <QuestionDialog
        open
        onOpenChange={onOpenChange}
        feature={FEATURE}
        questions={[q]}
        onSubmitAllAnswers={onSubmitAllAnswers}
      />,
    );

    expect(
      screen.queryByTestId(`option-${q.id}-other`),
    ).not.toBeInTheDocument();
  });

  it('hides the Other text input until "Other" is selected (single-select)', async () => {
    const user = userEvent.setup();
    const q = makeSingleSelectQuestion();
    render(
      <QuestionDialog
        open
        onOpenChange={onOpenChange}
        feature={FEATURE}
        questions={[q]}
        onSubmitAllAnswers={onSubmitAllAnswers}
      />,
    );

    expect(screen.queryByTestId(`other-text-${q.id}`)).not.toBeInTheDocument();

    await user.click(screen.getByTestId(`option-${q.id}-other`));

    expect(screen.getByTestId(`other-text-${q.id}`)).toBeInTheDocument();
  });

  it('hides the Other text input until "Other" is checked (multi-select)', async () => {
    const user = userEvent.setup();
    const q = makeMultiSelectQuestion();
    render(
      <QuestionDialog
        open
        onOpenChange={onOpenChange}
        feature={FEATURE}
        questions={[q]}
        onSubmitAllAnswers={onSubmitAllAnswers}
      />,
    );

    expect(screen.queryByTestId(`other-text-${q.id}`)).not.toBeInTheDocument();

    await user.click(screen.getByTestId(`option-${q.id}-other`));

    expect(screen.getByTestId(`other-text-${q.id}`)).toBeInTheDocument();
  });
});

describe("QuestionDialog — Submit gating with Other option", () => {
  let onSubmitAllAnswers: ReturnType<typeof vi.fn>;
  let onOpenChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSubmitAllAnswers = vi.fn().mockResolvedValue(undefined);
    onOpenChange = vi.fn();
  });

  function getSubmitButton() {
    // The dialog renders either "Submit Answer" or "Submit All Answers"
    return (
      screen.queryByRole("button", { name: /Submit Answer/i }) ??
      screen.getByRole("button", { name: /Submit All Answers/i })
    );
  }

  it("submit stays disabled when single-select Other is picked but no text is entered", async () => {
    const user = userEvent.setup();
    const q = makeSingleSelectQuestion();
    render(
      <QuestionDialog
        open
        onOpenChange={onOpenChange}
        feature={FEATURE}
        questions={[q]}
        onSubmitAllAnswers={onSubmitAllAnswers}
      />,
    );

    expect(getSubmitButton()).toBeDisabled();

    await user.click(screen.getByTestId(`option-${q.id}-other`));

    expect(getSubmitButton()).toBeDisabled();
  });

  it("enables submit once Other text is entered for single-select", async () => {
    const user = userEvent.setup();
    const q = makeSingleSelectQuestion();
    render(
      <QuestionDialog
        open
        onOpenChange={onOpenChange}
        feature={FEATURE}
        questions={[q]}
        onSubmitAllAnswers={onSubmitAllAnswers}
      />,
    );

    await user.click(screen.getByTestId(`option-${q.id}-other`));
    await user.type(screen.getByTestId(`other-text-${q.id}`), "luxon");

    expect(getSubmitButton()).toBeEnabled();
  });

  it("substitutes Other sentinel with custom text in the submit payload (single-select)", async () => {
    const user = userEvent.setup();
    const q = makeSingleSelectQuestion();
    render(
      <QuestionDialog
        open
        onOpenChange={onOpenChange}
        feature={FEATURE}
        questions={[q]}
        onSubmitAllAnswers={onSubmitAllAnswers}
      />,
    );

    await user.click(screen.getByTestId(`option-${q.id}-other`));
    await user.type(screen.getByTestId(`other-text-${q.id}`), "luxon");
    await user.click(getSubmitButton());

    expect(onSubmitAllAnswers).toHaveBeenCalledTimes(1);
    expect(onSubmitAllAnswers).toHaveBeenCalledWith([
      { questionId: q.id, answer: "luxon" },
    ]);
  });

  it("still submits the picked label when a regular single-select option is chosen", async () => {
    const user = userEvent.setup();
    const q = makeSingleSelectQuestion();
    render(
      <QuestionDialog
        open
        onOpenChange={onOpenChange}
        feature={FEATURE}
        questions={[q]}
        onSubmitAllAnswers={onSubmitAllAnswers}
      />,
    );

    // Click the dayjs radio by its label (testid is on the option itself)
    const dayjsRadio = screen.getByRole("radio", { name: /dayjs/i });
    await user.click(dayjsRadio);
    await user.click(getSubmitButton());

    expect(onSubmitAllAnswers).toHaveBeenCalledWith([
      { questionId: q.id, answer: "dayjs" },
    ]);
  });

  it("substitutes Other sentinel within a multi-select payload", async () => {
    const user = userEvent.setup();
    const q = makeMultiSelectQuestion();
    render(
      <QuestionDialog
        open
        onOpenChange={onOpenChange}
        feature={FEATURE}
        questions={[q]}
        onSubmitAllAnswers={onSubmitAllAnswers}
      />,
    );

    // Pick the Email checkbox
    const emailCheckbox = screen.getByRole("checkbox", { name: /Email/i });
    await user.click(emailCheckbox);

    // Pick Other and type
    await user.click(screen.getByTestId(`option-${q.id}-other`));
    await user.type(screen.getByTestId(`other-text-${q.id}`), "Push");

    await user.click(getSubmitButton());

    expect(onSubmitAllAnswers).toHaveBeenCalledTimes(1);
    const [[args]] = onSubmitAllAnswers.mock.calls;
    expect(args).toHaveLength(1);
    expect(args[0]).toEqual({ questionId: q.id, answer: "Email, Push" });
  });

  it("disables submit when multi-select Other is checked but no text is entered", async () => {
    const user = userEvent.setup();
    const q = makeMultiSelectQuestion();
    render(
      <QuestionDialog
        open
        onOpenChange={onOpenChange}
        feature={FEATURE}
        questions={[q]}
        onSubmitAllAnswers={onSubmitAllAnswers}
      />,
    );

    // Check Other only — no regular options, no text
    await user.click(screen.getByTestId(`option-${q.id}-other`));
    expect(getSubmitButton()).toBeDisabled();

    // Type text → enables
    await user.type(screen.getByTestId(`other-text-${q.id}`), "Push");
    expect(getSubmitButton()).toBeEnabled();
  });

  it("does not regress free-text submission flow", async () => {
    const user = userEvent.setup();
    const q = makeFreeTextQuestion();
    render(
      <QuestionDialog
        open
        onOpenChange={onOpenChange}
        feature={FEATURE}
        questions={[q]}
        onSubmitAllAnswers={onSubmitAllAnswers}
      />,
    );

    expect(getSubmitButton()).toBeDisabled();
    const textarea = within(
      screen.getByTestId("question-dialog"),
    ).getByPlaceholderText(/type your answer/i);
    await user.type(textarea, "a free-text answer");
    expect(getSubmitButton()).toBeEnabled();

    await user.click(getSubmitButton());

    expect(onSubmitAllAnswers).toHaveBeenCalledWith([
      { questionId: q.id, answer: "a free-text answer" },
    ]);
  });
});
