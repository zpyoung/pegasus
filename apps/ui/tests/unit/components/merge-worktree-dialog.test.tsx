/**
 * Tests for MergeWorktreeDialog squash mode
 * Verifies that:
 * - Squash checkbox appears and is unchecked by default
 * - Selecting squash shows explanatory info text
 * - Squash option is passed through to the API call
 * - Default (non-squash) behavior remains unchanged
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MergeWorktreeDialog } from '../../../src/components/views/board-view/dialogs/merge-worktree-dialog';
import { getElectronAPI } from '@pegasus/ui/lib/electron';
import type { WorktreeInfo } from '../../../src/components/views/board-view/worktree-panel/types';

// Mock dependencies
vi.mock('@pegasus/ui/lib/electron');
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const mockGetElectronAPI = vi.mocked(getElectronAPI);

const mockWorktree: WorktreeInfo = {
  path: '/test/worktrees/feature-branch',
  branch: 'feature/test-branch',
  isMainWorktree: false,
  hasChanges: false,
  changedFilesCount: 0,
};

const mockMergeFeature = vi.fn();
const mockListBranches = vi.fn();

describe('MergeWorktreeDialog - squash mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMergeFeature.mockResolvedValue({
      success: true,
      mergedBranch: 'feature/test-branch',
      targetBranch: 'main',
    });
    mockListBranches.mockResolvedValue({
      success: true,
      result: {
        branches: [
          { name: 'main', isRemote: false },
          { name: 'develop', isRemote: false },
        ],
      },
    });
    mockGetElectronAPI.mockReturnValue({
      worktree: {
        mergeFeature: mockMergeFeature,
        listBranches: mockListBranches,
      },
    } as ReturnType<typeof getElectronAPI>);
  });

  it('renders the squash checkbox unchecked by default', () => {
    render(
      <MergeWorktreeDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath="/test/project"
        worktree={mockWorktree}
        onIntegrated={vi.fn()}
      />
    );

    const squashCheckbox = screen.getByLabelText(/squash commits/i);
    expect(squashCheckbox).toBeInTheDocument();
    expect(squashCheckbox).not.toBeChecked();
  });

  it('shows explanatory text when squash is selected', async () => {
    const user = userEvent.setup();
    render(
      <MergeWorktreeDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath="/test/project"
        worktree={mockWorktree}
        onIntegrated={vi.fn()}
      />
    );

    const squashCheckbox = screen.getByLabelText(/squash commits/i);
    await user.click(squashCheckbox);

    expect(
      screen.getByText(/all commits from this branch will be condensed/i)
    ).toBeInTheDocument();
  });

  it('does not show explanatory text when squash is not selected', () => {
    render(
      <MergeWorktreeDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath="/test/project"
        worktree={mockWorktree}
        onIntegrated={vi.fn()}
      />
    );

    expect(
      screen.queryByText(/all commits from this branch will be condensed/i)
    ).not.toBeInTheDocument();
  });

  it('passes squash option to API when squash is selected', async () => {
    const user = userEvent.setup();
    const onIntegrated = vi.fn();

    render(
      <MergeWorktreeDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath="/test/project"
        worktree={mockWorktree}
        onIntegrated={onIntegrated}
      />
    );

    // Check the squash checkbox
    const squashCheckbox = screen.getByLabelText(/squash commits/i);
    await user.click(squashCheckbox);

    // Click integrate button
    const integrateButton = screen.getByRole('button', { name: /integrate/i });
    await user.click(integrateButton);

    await waitFor(() => {
      expect(mockMergeFeature).toHaveBeenCalledWith(
        '/test/project',
        'feature/test-branch',
        '/test/worktrees/feature-branch',
        'main',
        expect.objectContaining({ squash: true })
      );
    });
  });

  it('does not pass squash option by default', async () => {
    const user = userEvent.setup();

    render(
      <MergeWorktreeDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath="/test/project"
        worktree={mockWorktree}
        onIntegrated={vi.fn()}
      />
    );

    const integrateButton = screen.getByRole('button', { name: /integrate/i });
    await user.click(integrateButton);

    await waitFor(() => {
      expect(mockMergeFeature).toHaveBeenCalledWith(
        '/test/project',
        'feature/test-branch',
        '/test/worktrees/feature-branch',
        'main',
        expect.objectContaining({ squash: false })
      );
    });
  });

  it('resets squash state when dialog reopens', async () => {
    const { rerender } = render(
      <MergeWorktreeDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath="/test/project"
        worktree={mockWorktree}
        onIntegrated={vi.fn()}
      />
    );

    // Close
    rerender(
      <MergeWorktreeDialog
        open={false}
        onOpenChange={vi.fn()}
        projectPath="/test/project"
        worktree={mockWorktree}
        onIntegrated={vi.fn()}
      />
    );

    // Reopen
    rerender(
      <MergeWorktreeDialog
        open={true}
        onOpenChange={vi.fn()}
        projectPath="/test/project"
        worktree={mockWorktree}
        onIntegrated={vi.fn()}
      />
    );

    const squashCheckbox = screen.getByLabelText(/squash commits/i);
    expect(squashCheckbox).not.toBeChecked();
  });
});
