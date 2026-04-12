/**
 * Codex SDK client - Executes Codex queries via official @openai/codex-sdk
 *
 * Used for programmatic control of Codex from within the application.
 * Provides cleaner integration than spawning CLI processes.
 */

import { Codex } from "@openai/codex-sdk";
import {
  formatHistoryAsText,
  classifyError,
  getUserFriendlyErrorMessage,
} from "@pegasus/utils";
import { supportsReasoningEffort } from "@pegasus/types";
import type { ExecuteOptions, ProviderMessage } from "./types.js";

const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const SDK_HISTORY_HEADER = "Current request:\n";
const DEFAULT_RESPONSE_TEXT = "";
const SDK_ERROR_DETAILS_LABEL = "Details:";

type SdkReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
const SDK_REASONING_EFFORTS = new Set<string>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

type PromptBlock = {
  type: string;
  text?: string;
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
  };
};

function resolveApiKey(): string {
  const apiKey = process.env[OPENAI_API_KEY_ENV];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set.");
  }
  return apiKey;
}

function normalizePromptBlocks(
  prompt: ExecuteOptions["prompt"],
): PromptBlock[] {
  if (Array.isArray(prompt)) {
    return prompt as PromptBlock[];
  }
  return [{ type: "text", text: prompt }];
}

function buildPromptText(
  options: ExecuteOptions,
  systemPrompt: string | null,
): string {
  const historyText =
    options.conversationHistory && options.conversationHistory.length > 0
      ? formatHistoryAsText(options.conversationHistory)
      : "";

  const promptBlocks = normalizePromptBlocks(options.prompt);
  const promptTexts: string[] = [];

  for (const block of promptBlocks) {
    if (
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim()
    ) {
      promptTexts.push(block.text);
    }
  }

  const promptContent = promptTexts.join("\n\n");
  if (!promptContent.trim()) {
    throw new Error("Codex SDK prompt is empty.");
  }

  const parts: string[] = [];
  if (systemPrompt) {
    parts.push(`System: ${systemPrompt}`);
  }
  if (historyText) {
    parts.push(historyText);
  }
  parts.push(`${SDK_HISTORY_HEADER}${promptContent}`);

  return parts.join("\n\n");
}

function buildSdkErrorMessage(rawMessage: string, userMessage: string): string {
  if (!rawMessage) {
    return userMessage;
  }
  if (!userMessage || rawMessage === userMessage) {
    return rawMessage;
  }
  return `${userMessage}\n\n${SDK_ERROR_DETAILS_LABEL} ${rawMessage}`;
}

/**
 * Execute a query using the official Codex SDK
 *
 * The SDK provides a cleaner interface than spawning CLI processes:
 * - Handles authentication automatically
 * - Provides TypeScript types
 * - Supports thread management and resumption
 * - Better error handling
 */
export async function* executeCodexSdkQuery(
  options: ExecuteOptions,
  systemPrompt: string | null,
): AsyncGenerator<ProviderMessage> {
  try {
    const apiKey = resolveApiKey();
    const codex = new Codex({ apiKey });

    // Build thread options with model
    // The model must be passed to startThread/resumeThread so the SDK
    // knows which model to use for the conversation. Without this,
    // the SDK may use a default model that the user doesn't have access to.
    const threadOptions: {
      model?: string;
      modelReasoningEffort?: SdkReasoningEffort;
    } = {};

    if (options.model) {
      threadOptions.model = options.model;
    }

    // Add reasoning effort to thread options if model supports it
    if (
      options.reasoningEffort &&
      options.model &&
      supportsReasoningEffort(options.model) &&
      options.reasoningEffort !== "none" &&
      SDK_REASONING_EFFORTS.has(options.reasoningEffort)
    ) {
      threadOptions.modelReasoningEffort =
        options.reasoningEffort as SdkReasoningEffort;
    }

    // Resume existing thread or start new one
    let thread;
    if (options.sdkSessionId) {
      try {
        thread = codex.resumeThread(options.sdkSessionId, threadOptions);
      } catch {
        // If resume fails, start a new thread
        thread = codex.startThread(threadOptions);
      }
    } else {
      thread = codex.startThread(threadOptions);
    }

    const promptText = buildPromptText(options, systemPrompt);

    // Build run options
    const runOptions: {
      signal?: AbortSignal;
    } = {
      signal: options.abortController?.signal,
    };

    // Run the query
    const result = await thread.run(promptText, runOptions);

    // Extract response text (from finalResponse property)
    const outputText = result.finalResponse ?? DEFAULT_RESPONSE_TEXT;

    // Get thread ID (may be null if not populated yet)
    const threadId = thread.id ?? undefined;

    // Yield assistant message
    yield {
      type: "assistant",
      session_id: threadId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: outputText }],
      },
    };

    // Yield result
    yield {
      type: "result",
      subtype: "success",
      session_id: threadId,
      result: outputText,
    };
  } catch (error) {
    const errorInfo = classifyError(error);
    const userMessage = getUserFriendlyErrorMessage(error);
    let combinedMessage = buildSdkErrorMessage(errorInfo.message, userMessage);

    // Enhance error messages with actionable tips for common Codex issues
    // Normalize inputs to avoid crashes from nullish values
    const errorLower = (errorInfo?.message ?? "").toLowerCase();
    const modelLabel = options?.model ?? "<unknown model>";

    if (
      errorLower.includes("does not exist") ||
      errorLower.includes("model_not_found") ||
      errorLower.includes("invalid_model")
    ) {
      // Model not found - provide helpful guidance
      combinedMessage +=
        `\n\nTip: The model '${modelLabel}' may not be available on your OpenAI plan. ` +
        `Some models (like gpt-5.3-codex) require a ChatGPT Pro/Plus subscription and OAuth login via 'codex login'. ` +
        `Try using a different model (e.g., gpt-5.1 or gpt-5.2), or authenticate with 'codex login' instead of an API key.`;
    } else if (
      errorLower.includes("stream disconnected") ||
      errorLower.includes("stream ended") ||
      errorLower.includes("connection reset") ||
      errorLower.includes("socket hang up")
    ) {
      // Stream disconnection - provide helpful guidance
      combinedMessage +=
        `\n\nTip: The connection to OpenAI was interrupted. This can happen due to:\n` +
        `- Network instability\n` +
        `- The model not being available on your plan (try 'codex login' for OAuth authentication)\n` +
        `- Server-side timeouts for long-running requests\n` +
        `Try again, or switch to a different model.`;
    }

    console.error("[CodexSDK] executeQuery() error during execution:", {
      type: errorInfo.type,
      message: errorInfo.message,
      model: options.model,
      isRateLimit: errorInfo.isRateLimit,
      retryAfter: errorInfo.retryAfter,
      stack: error instanceof Error ? error.stack : undefined,
    });
    yield { type: "error", error: combinedMessage };
  }
}
