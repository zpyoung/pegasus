/**
 * Unit tests for IdeaCard
 *
 * Tests:
 *  - FR-002: card renders title and description
 *  - FR-004: promote button is only visible when status === 'ready'
 *  - Clicking delete calls onDelete
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IdeaCard } from "../../../src/components/views/ideation-view/idea-card";
import type { Idea } from "@pegasus/types";

// Mock @dnd-kit/core — useDraggable requires a DndContext which is not
// present in a plain unit test; stub it out with inert defaults.
vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
}));

const makeIdea = (overrides: Partial<Idea> = {}): Idea => ({
  id: "idea-1",
  title: "Auth redesign",
  description: "Rework the login flow",
  category: "feature",
  status: "raw",
  impact: "high",
  effort: "medium",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const defaultProps = {
  onEdit: vi.fn(),
  onPromote: vi.fn(),
  onDelete: vi.fn(),
  isSaving: false,
};

describe("IdeaCard", () => {
  // ─── Rendering ─────────────────────────────────────────────────────────────

  it("renders the idea title", () => {
    render(<IdeaCard idea={makeIdea()} {...defaultProps} />);
    expect(screen.getByText("Auth redesign")).toBeInTheDocument();
  });

  it("renders the idea description when provided", () => {
    render(
      <IdeaCard
        idea={makeIdea({ description: "Rework the login flow" })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText("Rework the login flow")).toBeInTheDocument();
  });

  it("does not render a description paragraph when description is empty", () => {
    const { container } = render(
      <IdeaCard idea={makeIdea({ description: "" })} {...defaultProps} />,
    );
    // The description <p> is only rendered when idea.description is truthy.
    // The component uses a <p class="...text-muted-foreground..."> only for description.
    const descParagraph = container.querySelector("p.text-muted-foreground");
    expect(descParagraph).toBeNull();
  });

  // ─── FR-004: promote button visibility ─────────────────────────────────────

  it("renders the promote button when status is ready", () => {
    render(<IdeaCard idea={makeIdea({ status: "ready" })} {...defaultProps} />);
    expect(screen.getByTestId("promote-idea-idea-1")).toBeInTheDocument();
  });

  it("does not render the promote button when status is raw", () => {
    render(<IdeaCard idea={makeIdea({ status: "raw" })} {...defaultProps} />);
    expect(screen.queryByTestId("promote-idea-idea-1")).not.toBeInTheDocument();
  });

  it("does not render the promote button when status is refined", () => {
    render(
      <IdeaCard idea={makeIdea({ status: "refined" })} {...defaultProps} />,
    );
    expect(screen.queryByTestId("promote-idea-idea-1")).not.toBeInTheDocument();
  });

  // ─── Interactions ──────────────────────────────────────────────────────────

  it("calls onDelete when delete button is clicked", () => {
    const onDelete = vi.fn();
    const idea = makeIdea();
    render(<IdeaCard idea={idea} {...defaultProps} onDelete={onDelete} />);

    fireEvent.click(screen.getByTestId("delete-idea-idea-1"));
    expect(onDelete).toHaveBeenCalledWith(idea);
  });

  it("calls onPromote when promote button is clicked (status=ready)", () => {
    const onPromote = vi.fn();
    const idea = makeIdea({ status: "ready" });
    render(<IdeaCard idea={idea} {...defaultProps} onPromote={onPromote} />);

    fireEvent.click(screen.getByTestId("promote-idea-idea-1"));
    expect(onPromote).toHaveBeenCalledWith(idea);
  });
});
