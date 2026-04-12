/**
 * Unit tests for PromoteModal
 *
 * Tests:
 *  - FR-004: modal renders when open with a ready idea
 *  - Default form values (column=backlog, keepIdea=false, no tags)
 *  - onPromote called with correct options on confirm
 *  - Returns null when idea is null
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PromoteModal } from "../../../src/components/views/ideation-view/promote-modal";
import type { Idea } from "@pegasus/types";

const makeReadyIdea = (overrides: Partial<Idea> = {}): Idea => ({
  id: "idea-ready",
  title: "Auth redesign",
  description: "Rework the login flow",
  category: "feature",
  status: "ready",
  impact: "high",
  effort: "medium",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("PromoteModal", () => {
  // ─── Rendering ─────────────────────────────────────────────────────────────

  it("renders nothing when idea is null", () => {
    const { container } = render(
      <PromoteModal
        idea={null}
        open={false}
        onOpenChange={vi.fn()}
        onPromote={vi.fn()}
        isConverting={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders dialog content when open is true with an idea", () => {
    render(
      <PromoteModal
        idea={makeReadyIdea()}
        open={true}
        onOpenChange={vi.fn()}
        onPromote={vi.fn()}
        isConverting={false}
      />,
    );

    // "Promote to Feature" appears in both the title and the confirm button
    expect(screen.getAllByText("Promote to Feature").length).toBeGreaterThan(0);
    // Description mentions the idea title
    expect(screen.getByText(/Auth redesign/)).toBeInTheDocument();
  });

  // ─── Default form values ────────────────────────────────────────────────────

  it('defaults target column to "backlog" (FR-004 default options)', () => {
    render(
      <PromoteModal
        idea={makeReadyIdea()}
        open={true}
        onOpenChange={vi.fn()}
        onPromote={vi.fn()}
        isConverting={false}
      />,
    );

    const select = screen.getByRole("combobox");
    expect((select as unknown as { value: string }).value).toBe("backlog");
  });

  it("defaults keepIdea checkbox to unchecked", () => {
    render(
      <PromoteModal
        idea={makeReadyIdea()}
        open={true}
        onOpenChange={vi.fn()}
        onPromote={vi.fn()}
        isConverting={false}
      />,
    );

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  // ─── Submit behaviour ───────────────────────────────────────────────────────

  it("calls onPromote with default options when confirm is clicked", () => {
    const onPromote = vi.fn();
    render(
      <PromoteModal
        idea={makeReadyIdea()}
        open={true}
        onOpenChange={vi.fn()}
        onPromote={onPromote}
        isConverting={false}
      />,
    );

    // Click the primary confirm button (the one that says "Promote to Feature")
    const confirmButton = screen.getByRole("button", {
      name: "Promote to Feature",
    });
    fireEvent.click(confirmButton);

    expect(onPromote).toHaveBeenCalledWith("idea-ready", {
      column: "backlog",
      keepIdea: false,
      tags: undefined,
    });
  });

  it("passes tags as array when tags input has values", () => {
    const onPromote = vi.fn();
    render(
      <PromoteModal
        idea={makeReadyIdea()}
        open={true}
        onOpenChange={vi.fn()}
        onPromote={onPromote}
        isConverting={false}
      />,
    );

    const tagsInput = screen.getByPlaceholderText("e.g. auth, mvp");
    fireEvent.change(tagsInput, { target: { value: "auth, mvp" } });

    fireEvent.click(screen.getByRole("button", { name: "Promote to Feature" }));

    expect(onPromote).toHaveBeenCalledWith("idea-ready", {
      column: "backlog",
      keepIdea: false,
      tags: ["auth", "mvp"],
    });
  });

  it("passes keepIdea=true when checkbox is checked", () => {
    const onPromote = vi.fn();
    render(
      <PromoteModal
        idea={makeReadyIdea()}
        open={true}
        onOpenChange={vi.fn()}
        onPromote={onPromote}
        isConverting={false}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Promote to Feature" }));

    expect(onPromote).toHaveBeenCalledWith("idea-ready", {
      column: "backlog",
      keepIdea: true,
      tags: undefined,
    });
  });

  it("disables confirm button while isConverting is true", () => {
    render(
      <PromoteModal
        idea={makeReadyIdea()}
        open={true}
        onOpenChange={vi.fn()}
        onPromote={vi.fn()}
        isConverting={true}
      />,
    );

    const confirmButton = screen.getByRole("button", { name: "Promoting…" });
    expect(confirmButton).toBeDisabled();
  });
});
