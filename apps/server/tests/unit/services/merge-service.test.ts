import { describe, it, expect, vi, beforeEach } from "vitest";
import { performMerge } from "../../../src/services/merge-service.js";

// Mock @pegasus/git-utils
const mockExecGitCommand = vi.fn();
vi.mock("@pegasus/git-utils", () => ({
  execGitCommand: (...args: unknown[]) => mockExecGitCommand(...args),
}));

// Mock @pegasus/utils
vi.mock("@pegasus/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  isValidBranchName: (name: string) =>
    /^[a-zA-Z0-9._/-]+$/.test(name) && !name.startsWith("-"),
  isValidRemoteName: (name: string) => /^[a-zA-Z0-9._-]+$/.test(name),
}));

// Mock simple-query-service so auto-fix doesn't hit the real provider
const mockStreamingQuery = vi.fn();
vi.mock("../../../src/providers/simple-query-service.js", () => ({
  streamingQuery: (...args: unknown[]) => mockStreamingQuery(...args),
}));

describe("merge-service", () => {
  const projectPath = "/test/project";
  const branchName = "feature/my-branch";
  const worktreePath = "/test/worktrees/my-branch";
  const targetBranch = "main";
  const mockEmitter = {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
  };

  // Default porcelain output: projectPath has 'main' checked out
  const defaultWorktreeList = [
    `worktree ${projectPath}`,
    "HEAD abc1234",
    "branch refs/heads/main",
    "",
    `worktree ${worktreePath}`,
    "HEAD def5678",
    `branch refs/heads/${branchName}`,
    "",
  ].join("\n");

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all git commands succeed; worktree list returns realistic output
    mockExecGitCommand.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return Promise.resolve(defaultWorktreeList);
      }
      return Promise.resolve("");
    });
  });

  describe("standard merge (non-squash)", () => {
    it("performs a regular merge and returns success", async () => {
      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        targetBranch,
        undefined,
        mockEmitter as never,
      );

      expect(result.success).toBe(true);
      expect(result.mergedBranch).toBe(branchName);
      expect(result.targetBranch).toBe(targetBranch);

      // Should have called merge without --squash
      const mergeCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) => Array.isArray(call[0]) && call[0][0] === "merge",
      );
      expect(mergeCalls).toHaveLength(1);
      expect(mergeCalls[0][0]).toEqual([
        "merge",
        branchName,
        "-m",
        `Merge ${branchName} into ${targetBranch}`,
      ]);

      // Should NOT have called commit (that's only for squash)
      const commitCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) => Array.isArray(call[0]) && call[0][0] === "commit",
      );
      expect(commitCalls).toHaveLength(0);

      // Should emit merge:start and merge:success
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        "merge:start",
        expect.any(Object),
      );
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        "merge:success",
        expect.any(Object),
      );
    });

    it("uses default target branch when not specified", async () => {
      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        "main",
        undefined,
        mockEmitter as never,
      );

      expect(result.success).toBe(true);
      expect(result.targetBranch).toBe("main");
    });
  });

  describe("squash merge", () => {
    it("performs a squash merge with --squash flag and commits", async () => {
      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        targetBranch,
        { squash: true },
        mockEmitter as never,
      );

      expect(result.success).toBe(true);

      // Should have called merge WITH --squash
      const mergeCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) => Array.isArray(call[0]) && call[0][0] === "merge",
      );
      expect(mergeCalls).toHaveLength(1);
      expect(mergeCalls[0][0]).toEqual(["merge", "--squash", branchName]);

      // Should have called commit after squash (squash requires explicit commit)
      const commitCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) => Array.isArray(call[0]) && call[0][0] === "commit",
      );
      expect(commitCalls).toHaveLength(1);
      expect(commitCalls[0][0]).toEqual([
        "commit",
        "-m",
        `Merge ${branchName} (squash)`,
      ]);
    });

    it("uses custom message for squash commit", async () => {
      const customMessage = "feat: integrate new feature";
      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        targetBranch,
        { squash: true, message: customMessage },
        mockEmitter as never,
      );

      expect(result.success).toBe(true);

      const commitCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) => Array.isArray(call[0]) && call[0][0] === "commit",
      );
      expect(commitCalls).toHaveLength(1);
      expect(commitCalls[0][0]).toEqual(["commit", "-m", customMessage]);
    });

    it("squash: false behaves like standard merge", async () => {
      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        targetBranch,
        { squash: false },
        mockEmitter as never,
      );

      expect(result.success).toBe(true);

      const mergeCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) => Array.isArray(call[0]) && call[0][0] === "merge",
      );
      expect(mergeCalls[0][0]).not.toContain("--squash");

      const commitCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) => Array.isArray(call[0]) && call[0][0] === "commit",
      );
      expect(commitCalls).toHaveLength(0);
    });
  });

  describe("validation", () => {
    it("rejects missing required parameters", async () => {
      const result = await performMerge("", branchName, worktreePath);
      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });

    it("rejects invalid branch names", async () => {
      const result = await performMerge(
        projectPath,
        "-invalid",
        worktreePath,
        targetBranch,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid source branch name");
    });

    it("rejects invalid target branch names", async () => {
      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        "-invalid",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid target branch name");
    });

    it("returns error when source branch does not exist", async () => {
      mockExecGitCommand.mockImplementation((args: string[]) => {
        if (args[0] === "rev-parse" && args[2] === branchName) {
          throw new Error("not a valid ref");
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(defaultWorktreeList);
        }
        return Promise.resolve("");
      });

      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        targetBranch,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });
  });

  describe("conflict detection", () => {
    it("detects conflicts from merge output", async () => {
      mockExecGitCommand.mockImplementation((args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(defaultWorktreeList);
        }
        if (args[0] === "merge" && args[1] !== "--abort") {
          const err = new Error(
            "CONFLICT (content): Merge conflict in file.ts",
          );
          (err as Record<string, unknown>).stdout =
            "CONFLICT (content): Merge conflict in file.ts";
          throw err;
        }
        if (args[0] === "diff") return Promise.resolve("file.ts\n");
        if (args[0] === "status") return Promise.resolve("UU file.ts\n");
        return Promise.resolve("");
      });

      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        targetBranch,
        undefined,
        mockEmitter as never,
      );

      expect(result.success).toBe(false);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflictFiles).toContain("file.ts");
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        "merge:conflict",
        expect.any(Object),
      );
    });
  });

  describe("deleteWorktreeAndBranch", () => {
    it("deletes worktree and branch when option is set", async () => {
      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        targetBranch,
        { deleteWorktreeAndBranch: true },
        mockEmitter as never,
      );

      expect(result.success).toBe(true);
      expect(result.deleted).toBeDefined();

      // Check worktree remove was called
      const worktreeCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) =>
          Array.isArray(call[0]) && call[0][0] === "worktree",
      );
      expect(worktreeCalls.length).toBeGreaterThanOrEqual(1);

      // Check branch delete was called
      const branchCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) =>
          Array.isArray(call[0]) &&
          call[0][0] === "branch" &&
          call[0][1] === "-D",
      );
      expect(branchCalls).toHaveLength(1);
    });

    it("does not delete worktree/branch when option is not set", async () => {
      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        targetBranch,
        undefined,
        mockEmitter as never,
      );

      expect(result.success).toBe(true);
      expect(result.deleted).toBeUndefined();

      // worktree list is always called to find the target branch;
      // verify no worktree *removal* commands were issued
      const worktreeRemoveCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) =>
          Array.isArray(call[0]) &&
          call[0][0] === "worktree" &&
          call[0][1] === "remove",
      );
      expect(worktreeRemoveCalls).toHaveLength(0);
    });
  });

  describe("auto-fix for pre-commit hook failures", () => {
    const preCommitError = [
      "husky - pre-commit script failed (code 2)",
      "error TS2305: Module has no exported member 'Foo'.",
    ].join("\n");

    it("invokes agent and retries commit when pre-commit hook fails", async () => {
      let mergeCallCount = 0;
      mockExecGitCommand.mockImplementation((args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(defaultWorktreeList);
        }
        if (args[0] === "merge" && args[1] !== "--abort") {
          mergeCallCount += 1;
          if (mergeCallCount === 1) {
            const err = new Error(preCommitError);
            (err as Record<string, unknown>).stderr = preCommitError;
            throw err;
          }
          return Promise.resolve("");
        }
        if (args[0] === "commit") return Promise.resolve("");
        return Promise.resolve("");
      });

      mockStreamingQuery.mockResolvedValue({ text: "fixed" });

      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        targetBranch,
        undefined,
        mockEmitter as never,
      );

      expect(result.success).toBe(true);
      expect(mockStreamingQuery).toHaveBeenCalledTimes(1);
      expect(mockStreamingQuery.mock.calls[0][0].cwd).toBe(projectPath);
      const commitCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) => Array.isArray(call[0]) && call[0][0] === "commit",
      );
      expect(commitCalls.length).toBeGreaterThanOrEqual(1);

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        "merge:auto-fix-start",
        expect.any(Object),
      );
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        "merge:auto-fix-success",
        expect.any(Object),
      );
    });

    it("skips auto-fix when autoFix option is false", async () => {
      mockExecGitCommand.mockImplementation((args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(defaultWorktreeList);
        }
        if (args[0] === "merge" && args[1] !== "--abort") {
          const err = new Error(preCommitError);
          (err as Record<string, unknown>).stderr = preCommitError;
          throw err;
        }
        return Promise.resolve("");
      });

      mockStreamingQuery.mockResolvedValue({ text: "fixed" });

      await expect(
        performMerge(
          projectPath,
          branchName,
          worktreePath,
          targetBranch,
          { autoFix: false },
          mockEmitter as never,
        ),
      ).rejects.toThrow();

      expect(mockStreamingQuery).not.toHaveBeenCalled();
    });

    it("gives up after maxAttempts and returns failure", async () => {
      mockExecGitCommand.mockImplementation((args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return Promise.resolve(defaultWorktreeList);
        }
        if (args[0] === "merge" && args[1] !== "--abort") {
          const err = new Error(preCommitError);
          (err as Record<string, unknown>).stderr = preCommitError;
          throw err;
        }
        if (args[0] === "commit") {
          const err = new Error(preCommitError);
          (err as Record<string, unknown>).stderr = preCommitError;
          throw err;
        }
        return Promise.resolve("");
      });

      mockStreamingQuery.mockResolvedValue({ text: "couldn't fix" });

      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        targetBranch,
        { autoFixMaxAttempts: 2 },
        mockEmitter as never,
      );

      expect(result.success).toBe(false);
      expect(mockStreamingQuery).toHaveBeenCalledTimes(2);
      expect(mockEmitter.emit).toHaveBeenCalledWith(
        "merge:auto-fix-failed",
        expect.any(Object),
      );
    });
  });

  describe("squash + deleteWorktreeAndBranch combined", () => {
    it("performs squash merge then deletes worktree and branch", async () => {
      const result = await performMerge(
        projectPath,
        branchName,
        worktreePath,
        targetBranch,
        { squash: true, deleteWorktreeAndBranch: true },
        mockEmitter as never,
      );

      expect(result.success).toBe(true);
      expect(result.deleted).toBeDefined();

      // Verify squash merge happened
      const mergeCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) => Array.isArray(call[0]) && call[0][0] === "merge",
      );
      expect(mergeCalls[0][0]).toContain("--squash");

      // Verify commit happened
      const commitCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) => Array.isArray(call[0]) && call[0][0] === "commit",
      );
      expect(commitCalls).toHaveLength(1);

      // Verify cleanup happened
      const branchCalls = mockExecGitCommand.mock.calls.filter(
        (call: unknown[]) =>
          Array.isArray(call[0]) &&
          call[0][0] === "branch" &&
          call[0][1] === "-D",
      );
      expect(branchCalls).toHaveLength(1);
    });
  });
});
