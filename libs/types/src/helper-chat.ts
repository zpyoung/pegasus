/**
 * Types for the Question Helper Chat feature.
 *
 * A single wrapper event type (helper_chat_event) carries all helper traffic
 * via a discriminated payload — ADR-7.
 */

export type HelperChatPayload =
  | { kind: "started"; sessionId: string }
  | { kind: "delta"; text: string }
  | { kind: "tool_call"; toolName: string; toolId: string; input: string }
  | { kind: "tool_complete"; toolId: string }
  | { kind: "complete" }
  | { kind: "error"; message: string }
  | { kind: "session_terminated" };

export interface HelperChatEvent {
  featureId: string;
  payload: HelperChatPayload;
}
