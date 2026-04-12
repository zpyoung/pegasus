/**
 * Unit tests for showAllWorktrees store state and actions.
 * Verifies per-project all-worktrees toggle persistence in Zustand store.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import { useAppStore } from "../../../src/store/app-store";

const PROJECT_A = "/projects/alpha";
const PROJECT_B = "/projects/beta";

describe("showAllWorktrees store", () => {
  beforeEach(() => {
    useAppStore.setState({ showAllWorktreesByProject: {} });
  });

  describe("initial state", () => {
    it("should start with an empty record", () => {
      const { showAllWorktreesByProject } = useAppStore.getState();
      expect(showAllWorktreesByProject).toEqual({});
    });
  });

  describe("getShowAllWorktrees", () => {
    it("should return false for an unknown project path", () => {
      const { getShowAllWorktrees } = useAppStore.getState();
      expect(getShowAllWorktrees("/nonexistent/project")).toBe(false);
    });

    it("should return the stored value after setting", () => {
      const { setShowAllWorktrees, getShowAllWorktrees } =
        useAppStore.getState();

      act(() => {
        setShowAllWorktrees(PROJECT_A, true);
      });

      expect(getShowAllWorktrees(PROJECT_A)).toBe(true);
    });

    it("should return false after toggling back off", () => {
      const { setShowAllWorktrees, getShowAllWorktrees } =
        useAppStore.getState();

      act(() => {
        setShowAllWorktrees(PROJECT_A, true);
        setShowAllWorktrees(PROJECT_A, false);
      });

      expect(getShowAllWorktrees(PROJECT_A)).toBe(false);
    });
  });

  describe("setShowAllWorktrees", () => {
    it("should set true for a project", () => {
      const { setShowAllWorktrees } = useAppStore.getState();

      act(() => {
        setShowAllWorktrees(PROJECT_A, true);
      });

      expect(useAppStore.getState().showAllWorktreesByProject[PROJECT_A]).toBe(
        true,
      );
    });

    it("should set false for a project", () => {
      const { setShowAllWorktrees } = useAppStore.getState();

      act(() => {
        setShowAllWorktrees(PROJECT_A, true);
        setShowAllWorktrees(PROJECT_A, false);
      });

      expect(useAppStore.getState().showAllWorktreesByProject[PROJECT_A]).toBe(
        false,
      );
    });

    it("should isolate state between different projects", () => {
      const { setShowAllWorktrees } = useAppStore.getState();

      act(() => {
        setShowAllWorktrees(PROJECT_A, true);
        setShowAllWorktrees(PROJECT_B, false);
      });

      const state = useAppStore.getState();
      expect(state.showAllWorktreesByProject[PROJECT_A]).toBe(true);
      expect(state.showAllWorktreesByProject[PROJECT_B]).toBe(false);
    });

    it("should not overwrite other projects when updating one", () => {
      const { setShowAllWorktrees } = useAppStore.getState();

      act(() => {
        setShowAllWorktrees(PROJECT_A, true);
        setShowAllWorktrees(PROJECT_B, true);
      });

      // Toggle A off — B should be unaffected
      act(() => {
        setShowAllWorktrees(PROJECT_A, false);
      });

      const state = useAppStore.getState();
      expect(state.showAllWorktreesByProject[PROJECT_A]).toBe(false);
      expect(state.showAllWorktreesByProject[PROJECT_B]).toBe(true);
    });

    it("should produce a new object reference on each update (immutability)", () => {
      const { setShowAllWorktrees } = useAppStore.getState();
      const before = useAppStore.getState().showAllWorktreesByProject;

      act(() => {
        setShowAllWorktrees(PROJECT_A, true);
      });

      const after = useAppStore.getState().showAllWorktreesByProject;
      expect(after).not.toBe(before);
    });
  });
});
