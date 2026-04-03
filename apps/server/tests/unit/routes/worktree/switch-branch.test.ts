import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createMockExpressContext } from '../../../utils/mocks.js';

vi.mock('@/services/worktree-branch-service.js', () => ({
  performSwitchBranch: vi.fn(),
}));

import { performSwitchBranch } from '@/services/worktree-branch-service.js';
import { createSwitchBranchHandler } from '@/routes/worktree/routes/switch-branch.js';

const mockPerformSwitchBranch = vi.mocked(performSwitchBranch);

describe('switch-branch route', () => {
  let req: Request;
  let res: Response;

  beforeEach(() => {
    vi.clearAllMocks();
    const context = createMockExpressContext();
    req = context.req;
    res = context.res;
  });

  it('should return 400 when branchName is missing', async () => {
    req.body = { worktreePath: '/repo/path' };

    const handler = createSwitchBranchHandler();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'branchName required',
    });
    expect(mockPerformSwitchBranch).not.toHaveBeenCalled();
  });

  it('should return 400 when branchName starts with a dash', async () => {
    req.body = { worktreePath: '/repo/path', branchName: '-flag' };

    const handler = createSwitchBranchHandler();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Invalid branch name',
    });
    expect(mockPerformSwitchBranch).not.toHaveBeenCalled();
  });

  it('should return 400 when branchName starts with double dash', async () => {
    req.body = { worktreePath: '/repo/path', branchName: '--option' };

    const handler = createSwitchBranchHandler();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Invalid branch name',
    });
    expect(mockPerformSwitchBranch).not.toHaveBeenCalled();
  });

  it('should return 400 when branchName contains invalid characters', async () => {
    req.body = { worktreePath: '/repo/path', branchName: 'branch name with spaces' };

    const handler = createSwitchBranchHandler();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Invalid branch name',
    });
    expect(mockPerformSwitchBranch).not.toHaveBeenCalled();
  });

  it('should allow switching when only untracked files exist', async () => {
    req.body = {
      worktreePath: '/repo/path',
      branchName: 'feature/test',
    };

    mockPerformSwitchBranch.mockResolvedValue({
      success: true,
      result: {
        previousBranch: 'main',
        currentBranch: 'feature/test',
        message: "Switched to branch 'feature/test'",
        hasConflicts: false,
        stashedChanges: false,
      },
    });

    const handler = createSwitchBranchHandler();
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      result: {
        previousBranch: 'main',
        currentBranch: 'feature/test',
        message: "Switched to branch 'feature/test'",
        hasConflicts: false,
        stashedChanges: false,
      },
    });
    expect(mockPerformSwitchBranch).toHaveBeenCalledWith('/repo/path', 'feature/test', undefined);
  });

  it('should stash changes and switch when tracked files are modified', async () => {
    req.body = {
      worktreePath: '/repo/path',
      branchName: 'feature/test',
    };

    mockPerformSwitchBranch.mockResolvedValue({
      success: true,
      result: {
        previousBranch: 'main',
        currentBranch: 'feature/test',
        message: "Switched to branch 'feature/test' (local changes stashed and reapplied)",
        hasConflicts: false,
        stashedChanges: true,
      },
    });

    const handler = createSwitchBranchHandler();
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      result: {
        previousBranch: 'main',
        currentBranch: 'feature/test',
        message: "Switched to branch 'feature/test' (local changes stashed and reapplied)",
        hasConflicts: false,
        stashedChanges: true,
      },
    });
  });
});
