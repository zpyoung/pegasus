import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../src/store/app-store";
import { MAX_INIT_OUTPUT_LINES } from "../../../src/store/defaults";

const PROJECT_PATH = "/tmp/project";
const BRANCH = "feature/test-output";

describe("init script output store", () => {
  beforeEach(() => {
    useAppStore.setState({ initScriptState: {} });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("preserves blank lines, tabs, and stream type metadata", () => {
    const { setInitScriptState, appendInitScriptOutput } =
      useAppStore.getState();

    act(() => {
      setInitScriptState(PROJECT_PATH, BRANCH, {
        status: "running",
        branch: BRANCH,
        output: [],
      });

      appendInitScriptOutput(PROJECT_PATH, BRANCH, {
        type: "stdout",
        content: "step 1\n\n\tindented line\n",
      });

      appendInitScriptOutput(PROJECT_PATH, BRANCH, {
        type: "stderr",
        content: "warning: something happened\n",
      });
    });

    const state = useAppStore
      .getState()
      .getInitScriptState(PROJECT_PATH, BRANCH);

    expect(state?.output).toEqual([
      {
        type: "stdout",
        content: "step 1\n\n\tindented line\n",
      },
      {
        type: "stderr",
        content: "warning: something happened\n",
      },
    ]);
  });

  it("limits retained output to the most recent chunks", () => {
    const { setInitScriptState, appendInitScriptOutput } =
      useAppStore.getState();

    act(() => {
      setInitScriptState(PROJECT_PATH, BRANCH, {
        status: "running",
        branch: BRANCH,
        output: [],
      });

      for (let index = 0; index < MAX_INIT_OUTPUT_LINES + 5; index += 1) {
        appendInitScriptOutput(PROJECT_PATH, BRANCH, {
          type: index % 2 === 0 ? "stdout" : "stderr",
          content: `chunk-${index}\n`,
        });
      }
    });

    const output =
      useAppStore.getState().getInitScriptState(PROJECT_PATH, BRANCH)?.output ??
      [];

    expect(output).toHaveLength(MAX_INIT_OUTPUT_LINES);
    expect(output[0]?.content).toBe("chunk-5\n");
    expect(output.at(-1)?.content).toBe(`chunk-${MAX_INIT_OUTPUT_LINES + 4}\n`);
  });
});
