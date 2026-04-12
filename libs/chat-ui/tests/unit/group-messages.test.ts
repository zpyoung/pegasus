import { describe, it, expect } from "vitest";
import { groupMessages } from "../../src/utils/group-messages.js";
import type { ChatMessage } from "../../src/types.js";

// ============================================================================
// Helpers
// ============================================================================

let idCounter = 0;
function msg(
  role: ChatMessage["role"],
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: `msg-${++idCounter}`,
    role,
    content: "test content",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("groupMessages", () => {
  it("returns empty array for empty input", () => {
    expect(groupMessages([])).toEqual([]);
  });

  it("wraps a single user message as a message item", () => {
    const m = msg("user");
    const result = groupMessages([m]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "message", message: m });
  });

  it("wraps a single assistant message as a message item", () => {
    const m = msg("assistant");
    const result = groupMessages([m]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "message", message: m });
  });

  it("wraps a single tool message as a tool_group", () => {
    const t = msg("tool");
    const result = groupMessages([t]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "tool_group", messages: [t] });
  });

  it("groups consecutive tool messages between assistant messages", () => {
    const a1 = msg("assistant");
    const t1 = msg("tool");
    const t2 = msg("tool");
    const a2 = msg("assistant");

    const result = groupMessages([a1, t1, t2, a2]);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "message", message: a1 });
    expect(result[1]).toEqual({ type: "tool_group", messages: [t1, t2] });
    expect(result[2]).toEqual({ type: "message", message: a2 });
  });

  it("groups tools at the end (after last assistant message)", () => {
    const a = msg("assistant");
    const t1 = msg("tool");
    const t2 = msg("tool");

    const result = groupMessages([a, t1, t2]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "message", message: a });
    expect(result[1]).toEqual({ type: "tool_group", messages: [t1, t2] });
  });

  it("handles a user message followed by tools (unusual but valid)", () => {
    const u = msg("user");
    const t = msg("tool");

    const result = groupMessages([u, t]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "message", message: u });
    expect(result[1]).toEqual({ type: "tool_group", messages: [t] });
  });

  it("keeps each non-tool message as a separate item", () => {
    const u = msg("user");
    const a = msg("assistant");
    const s = msg("system");

    const result = groupMessages([u, a, s]);

    expect(result).toHaveLength(3);
    expect(result.every((item) => item.type === "message")).toBe(true);
  });

  it("creates separate tool groups when separated by non-tool messages", () => {
    const t1 = msg("tool");
    const a = msg("assistant");
    const t2 = msg("tool");

    const result = groupMessages([t1, a, t2]);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "tool_group", messages: [t1] });
    expect(result[1]).toEqual({ type: "message", message: a });
    expect(result[2]).toEqual({ type: "tool_group", messages: [t2] });
  });

  it("does not mutate the input array", () => {
    const messages: ChatMessage[] = [msg("user"), msg("tool")];
    const copy = [...messages];
    groupMessages(messages);
    expect(messages).toEqual(copy);
  });

  it("returns independent tool_group message arrays (not shared references)", () => {
    const t = msg("tool");
    const result = groupMessages([t]);
    const group = result[0];
    if (group.type !== "tool_group") throw new Error("Expected tool_group");

    group.messages.push(msg("tool"));
    // Second call should not see the mutation
    const result2 = groupMessages([t]);
    const group2 = result2[0];
    if (group2.type !== "tool_group") throw new Error("Expected tool_group");
    expect(group2.messages).toHaveLength(1);
  });

  it("handles a complex realistic conversation", () => {
    const user1 = msg("user", { content: "What does the auth module do?" });
    const asst1 = msg("assistant", { content: "Let me check..." });
    const tool1 = msg("tool", { toolName: "Read", toolStatus: "completed" });
    const tool2 = msg("tool", { toolName: "Grep", toolStatus: "completed" });
    const asst2 = msg("assistant", { content: "The auth module handles JWT." });
    const user2 = msg("user", { content: "What about refresh tokens?" });

    const result = groupMessages([user1, asst1, tool1, tool2, asst2, user2]);

    expect(result).toHaveLength(5);
    expect(result[0]).toMatchObject({ type: "message", message: user1 });
    expect(result[1]).toMatchObject({ type: "message", message: asst1 });
    expect(result[2]).toMatchObject({
      type: "tool_group",
      messages: [tool1, tool2],
    });
    expect(result[3]).toMatchObject({ type: "message", message: asst2 });
    expect(result[4]).toMatchObject({ type: "message", message: user2 });
  });
});
