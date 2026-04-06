/**
 * Unit tests for CardContentSections component.
 * Verifies branch badge rendering logic, especially the showAllWorktrees
 * mode that displays a branch label on every card (normalising null to mainBranch).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CardContentSections } from '../../../src/components/views/board-view/components/kanban-card/card-content-sections';
import type { Feature } from '@pegasus/types';

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'feat-1',
    title: 'Test Feature',
    category: 'test',
    description: '',
    status: 'backlog',
    ...overrides,
  };
}

describe('CardContentSections — branch badge', () => {
  // ─── useWorktrees=false ───────────────────────────────────────────────────

  describe('when useWorktrees is false', () => {
    it('never renders a branch badge', () => {
      render(
        <CardContentSections
          feature={makeFeature({ branchName: 'feature/x' })}
          useWorktrees={false}
          showAllWorktrees={true}
          mainBranch="main"
        />
      );
      expect(screen.queryByText('feature/x')).toBeNull();
      expect(screen.queryByText('main')).toBeNull();
    });
  });

  // ─── useWorktrees=true, showAllWorktrees=false ────────────────────────────

  describe('when useWorktrees=true and showAllWorktrees=false (normal mode)', () => {
    it('hides badge when feature has no branchName', () => {
      render(
        <CardContentSections
          feature={makeFeature()}
          useWorktrees={true}
          showAllWorktrees={false}
        />
      );
      // No git-branch icon text or branch text
      const badge = document.querySelector('.font-mono');
      expect(badge).toBeNull();
    });

    it('shows badge with the feature branch when branchName is set', () => {
      render(
        <CardContentSections
          feature={makeFeature({ branchName: 'feature/my-feature' })}
          useWorktrees={true}
          showAllWorktrees={false}
        />
      );
      expect(screen.getByText('feature/my-feature')).toBeInTheDocument();
    });

    it('uses muted-foreground styling in normal mode', () => {
      const { container } = render(
        <CardContentSections
          feature={makeFeature({ branchName: 'feature/x' })}
          useWorktrees={true}
          showAllWorktrees={false}
        />
      );
      const badgeWrapper = container.querySelector('.text-muted-foreground');
      expect(badgeWrapper).not.toBeNull();
    });
  });

  // ─── useWorktrees=true, showAllWorktrees=true ─────────────────────────────

  describe('when useWorktrees=true and showAllWorktrees=true (all-worktrees mode)', () => {
    it('shows badge with the feature branchName when set', () => {
      render(
        <CardContentSections
          feature={makeFeature({ branchName: 'feature/a' })}
          useWorktrees={true}
          showAllWorktrees={true}
        />
      );
      expect(screen.getByText('feature/a')).toBeInTheDocument();
    });

    it('shows mainBranch when feature has no branchName and mainBranch is provided', () => {
      render(
        <CardContentSections
          feature={makeFeature()}
          useWorktrees={true}
          showAllWorktrees={true}
          mainBranch="main"
        />
      );
      expect(screen.getByText('main')).toBeInTheDocument();
    });

    it('falls back to "main" when feature has no branchName and mainBranch is undefined', () => {
      render(
        <CardContentSections
          feature={makeFeature()}
          useWorktrees={true}
          showAllWorktrees={true}
        />
      );
      expect(screen.getByText('main')).toBeInTheDocument();
    });

    it('falls back to "main" when both branchName and mainBranch are null', () => {
      render(
        <CardContentSections
          feature={makeFeature({ branchName: undefined })}
          useWorktrees={true}
          showAllWorktrees={true}
          mainBranch={null}
        />
      );
      expect(screen.getByText('main')).toBeInTheDocument();
    });

    it('renders a pill badge (rounded-full) in all-worktrees mode', () => {
      render(
        <CardContentSections
          feature={makeFeature({ branchName: 'feature/x' })}
          useWorktrees={true}
          showAllWorktrees={true}
        />
      );
      const pill = screen.getByTestId('branch-badge-pill');
      expect(pill).toBeInTheDocument();
      expect(pill.classList.contains('rounded-full')).toBe(true);
    });

    it('applies per-branch inline background color derived from branch name', () => {
      render(
        <CardContentSections
          feature={makeFeature({ branchName: 'feature/x' })}
          useWorktrees={true}
          showAllWorktrees={true}
        />
      );
      const pill = screen.getByTestId('branch-badge-pill');
      // jsdom normalizes hsl() to rgb(), so accept either format
      expect(pill.style.backgroundColor).toMatch(/^(hsl|rgb)\(/);
    });

    it('different branches get different badge background colors', () => {
      const { rerender } = render(
        <CardContentSections
          feature={makeFeature({ branchName: 'feature/alpha' })}
          useWorktrees={true}
          showAllWorktrees={true}
        />
      );
      const colorAlpha = screen.getByTestId('branch-badge-pill').style.backgroundColor;

      rerender(
        <CardContentSections
          feature={makeFeature({ branchName: 'feature/beta' })}
          useWorktrees={true}
          showAllWorktrees={true}
        />
      );
      const colorBeta = screen.getByTestId('branch-badge-pill').style.backgroundColor;

      expect(colorAlpha).not.toBe(colorBeta);
    });

    it('does NOT use muted-foreground styling in all-worktrees mode', () => {
      const { container } = render(
        <CardContentSections
          feature={makeFeature({ branchName: 'feature/x' })}
          useWorktrees={true}
          showAllWorktrees={true}
        />
      );
      const mutedWrapper = container.querySelector('.text-muted-foreground');
      expect(mutedWrapper).toBeNull();
    });
  });

  // ─── PR URL section (unrelated to branch, regression guard) ──────────────

  describe('PR URL section', () => {
    it('renders a PR link when prUrl is a valid http URL', () => {
      render(
        <CardContentSections
          feature={makeFeature({ prUrl: 'https://github.com/org/repo/pull/42' })}
          useWorktrees={false}
        />
      );
      expect(screen.getByTestId('pr-url-feat-1')).toBeInTheDocument();
      expect(screen.getByText('Pull Request #42')).toBeInTheDocument();
    });

    it('does not render a PR link when prUrl is absent', () => {
      render(
        <CardContentSections
          feature={makeFeature()}
          useWorktrees={false}
        />
      );
      expect(screen.queryByTestId('pr-url-feat-1')).toBeNull();
    });

    it('does not render a PR link when prUrl is not a valid http URL', () => {
      render(
        <CardContentSections
          feature={makeFeature({ prUrl: 'not-a-url' })}
          useWorktrees={false}
        />
      );
      expect(screen.queryByTestId('pr-url-feat-1')).toBeNull();
    });
  });
});
