/**
 * QuestionHelperService — ephemeral read-only sub-agent for helper chat.
 *
 * Spawns a helper sub-agent via ClaudeProvider when the user sends a chat
 * message while a feature is in `waiting_question` status.  In-memory
 * chat history is stored per featureId (ADR-6 — no feature.json writes).
 * Tool access is hard-capped to Read/Grep/Glob (ADR-5).
 *
 * No turn/cost/timeout guardrails at MVP (ADR-8).  WARN/ERROR log tripwires
 * are the only signal for runaway sessions (Risk R-2).
 */

import type { ConversationMessage, PhaseModelEntry } from "@pegasus/types";
import { createLogger, isAbortError } from "@pegasus/utils";
import type { HelperChatPayload } from "@pegasus/types";
import type { EventEmitter } from "../lib/events.js";
import type { FeatureLoader } from "./feature-loader.js";
import type { SettingsService } from "./settings-service.js";
import { ProviderFactory } from "../providers/provider-factory.js";
import { stripProviderPrefix } from "@pegasus/types";
import { getProviderByModelId } from "../lib/settings-helpers.js";

const logger = createLogger("question-helper-service");

// Tools available to the helper — capability filter (load-bearing, ADR-5).
// Both `tools` and `allowedTools` must be set; `tools` is the SDK capability
// whitelist, `allowedTools` is the Pegasus approval list (Codex CRITICAL C-1).
const HELPER_TOOLS = ["Read", "Grep", "Glob"] as const;

// Default model for helper sessions when the client does not specify one.
// Intentionally separate from DEFAULT_MODELS.claude (which is Opus) — the
// helper uses read-only tools, so Sonnet is cheaper/faster and sufficient.
const HELPER_DEFAULT_MODEL = "claude-sonnet";

// Cost-runaway tripwire thresholds (Risk R-2).  No hard guardrails at MVP.
const TURN_WARN_THRESHOLD = 5;
const TURN_ERROR_THRESHOLD = 20;

interface HelperSession {
  sessionId: string;
  history: ConversationMessage[];
  abortController: AbortController;
  projectPath: string;
  turnCount: number;
  messageCount: number;
  toolCallCount: number;
}

export class QuestionHelperService {
  private readonly sessions = new Map<string, HelperSession>();

  constructor(
    private readonly settingsService: SettingsService,
    private readonly eventBus: EventEmitter,
    private readonly featureLoader: FeatureLoader,
  ) {}

  /**
   * Handle a user chat message for the helper attached to featureId.
   * Creates a session on first call and appends to it on subsequent calls.
   *
   * @param modelEntry Optional full model selection (model + thinkingLevel +
   *                   providerId). Falls back to HELPER_DEFAULT_MODEL when
   *                   omitted. Accepts the same shape as PhaseModelEntry so
   *                   the UI can forward its Zustand-stored selection
   *                   unchanged (including Claude thinking level and
   *                   claude-compatible provider override).
   */
  async sendMessage(
    featureId: string,
    message: string,
    projectPath: string,
    modelEntry?: PhaseModelEntry,
  ): Promise<void> {
    const session = this.getOrCreateSession(featureId, projectPath);
    session.turnCount += 1;
    session.messageCount += 1;

    // R-2 tripwires — no hard stop, just logs
    if (session.turnCount > TURN_ERROR_THRESHOLD) {
      logger.error(
        { featureId, turnCount: session.turnCount },
        "helper session exceeded error threshold — possible runaway session",
      );
    } else if (session.turnCount > TURN_WARN_THRESHOLD) {
      logger.warn(
        { featureId, turnCount: session.turnCount },
        "helper session exceeded warn threshold",
      );
    }

    logger.info(
      { featureId, sessionId: session.sessionId },
      "helper sendMessage",
    );

    // Emit started
    this.emitPayload(featureId, {
      kind: "started",
      sessionId: session.sessionId,
    });

    // Add user message to history
    session.history.push({ role: "user", content: message });

    const previousHistory = session.history.slice(0, -1); // all except last user msg

    try {
      // Get model and provider configuration
      let credentials = await this.settingsService.getCredentials();
      const modelId = modelEntry?.model ?? HELPER_DEFAULT_MODEL;
      const thinkingLevel = modelEntry?.thinkingLevel;

      // Resolve claude-compatible provider by model ID (mirrors IdeationService
      // pattern). For native Claude models this is undefined; for GLM/MiniMax/
      // etc. models it returns the matching provider config.
      const providerResult = await getProviderByModelId(
        modelId,
        this.settingsService,
        "[QuestionHelperService]",
      );
      const claudeCompatibleProvider = providerResult.provider;
      if (providerResult.credentials) {
        credentials = providerResult.credentials;
      }

      const bareModel = stripProviderPrefix(modelId);
      const provider = ProviderFactory.getProviderForModel(modelId);
      logger.debug(
        {
          featureId,
          sessionId: session.sessionId,
          modelId,
          bareModel,
          thinkingLevel,
          providerName: claudeCompatibleProvider?.name,
        },
        "helper resolved model for sendMessage",
      );

      // Build scoped system prompt (TRACE-level to avoid leaking sensitive data)
      const feature = await this.featureLoader
        .get(projectPath, featureId)
        .catch(() => null);
      const systemPrompt = this.buildScopedSystemPrompt(featureId, feature);
      logger.debug({ featureId }, "helper system prompt built");

      const stream = provider.executeQuery({
        prompt: message,
        model: bareModel,
        cwd: projectPath,
        systemPrompt,
        maxTurns: 20,
        tools: HELPER_TOOLS as unknown as string[],
        allowedTools: HELPER_TOOLS as unknown as string[],
        abortController: session.abortController,
        conversationHistory:
          previousHistory.length > 0 ? previousHistory : undefined,
        claudeCompatibleProvider,
        thinkingLevel,
        credentials,
      });

      let assistantText = "";

      for await (const msg of stream) {
        if (session.abortController.signal.aborted) break;

        if (msg.type === "assistant" && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) {
              assistantText += block.text;
              this.emitPayload(featureId, { kind: "delta", text: block.text });
            } else if (block.type === "tool_use") {
              const toolName = block.name ?? "unknown";
              const toolId = block.tool_use_id ?? crypto.randomUUID();
              const input =
                block.input != null ? JSON.stringify(block.input) : "";

              session.toolCallCount += 1;
              this.emitPayload(featureId, {
                kind: "tool_call",
                toolName,
                toolId,
                input,
              });
              // Since we get whole blocks (not deltas), complete fires immediately (M-1)
              this.emitPayload(featureId, { kind: "tool_complete", toolId });
            }
          }
        } else if (msg.type === "result") {
          if (msg.subtype === "success") {
            // complete is emitted after the loop
          } else if (msg.subtype && msg.subtype.startsWith("error")) {
            this.emitPayload(featureId, {
              kind: "error",
              message: msg.error ?? msg.subtype ?? "Unknown error",
            });
            return;
          }
        } else if (msg.type === "error") {
          this.emitPayload(featureId, {
            kind: "error",
            message: msg.error ?? "Stream error",
          });
          return;
        }
      }

      // Accumulate assistant response in history
      if (assistantText) {
        session.history.push({ role: "assistant", content: assistantText });
      }

      this.emitPayload(featureId, { kind: "complete" });
      logger.info(
        {
          featureId,
          sessionId: session.sessionId,
          toolCallCount: session.toolCallCount,
        },
        "helper sendMessage complete",
      );
    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.info({ featureId }, "helper sendMessage aborted");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ featureId, error: message }, "helper sendMessage error");
      this.emitPayload(featureId, { kind: "error", message });
    }
  }

  /**
   * Terminate a helper session and clear its in-memory history.
   * Called when the user closes the dialog or submits all answers (FR-006).
   */
  terminateSession(featureId: string): void {
    const session = this.sessions.get(featureId);
    if (!session) return;

    session.abortController.abort();
    this.sessions.delete(featureId);
    this.emitPayload(featureId, { kind: "session_terminated" });
    logger.info(
      { featureId, sessionId: session.sessionId },
      "helper session terminated",
    );
  }

  /**
   * Get in-memory chat history for a feature (for FR-005 restore on reopen).
   */
  getHistory(featureId: string): ConversationMessage[] {
    return this.sessions.get(featureId)?.history ?? [];
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private getOrCreateSession(
    featureId: string,
    projectPath: string,
  ): HelperSession {
    const existing = this.sessions.get(featureId);
    if (existing) return existing;

    const session: HelperSession = {
      sessionId: crypto.randomUUID(),
      history: [],
      abortController: new AbortController(),
      projectPath,
      turnCount: 0,
      messageCount: 0,
      toolCallCount: 0,
    };
    this.sessions.set(featureId, session);
    logger.info(
      { featureId, sessionId: session.sessionId },
      "helper session created",
    );
    return session;
  }

  private buildScopedSystemPrompt(
    featureId: string,
    feature: {
      title?: string;
      description?: string;
      questionState?: unknown;
    } | null,
  ): string {
    const lines: string[] = [
      "You are a read-only helper assistant attached to a paused AI coding agent.",
      "",
      "Your job is to help the user understand the codebase so they can answer the pending questions.",
      "",
      "## Constraints",
      "- You MUST NOT attempt to use Edit, Write, Bash, or any tool that modifies files.",
      "- You may ONLY use Read, Grep, and Glob to explore the codebase.",
      "- Do NOT attempt to resume, restart, or interfere with the main agent.",
      "- Do NOT read sensitive files: .env, .env.*, *.key, credentials.*, secrets.*",
      "",
    ];

    if (feature?.title) {
      lines.push(`## Feature Being Implemented`, `${feature.title}`, "");
    }

    if (typeof feature?.description === "string" && feature.description) {
      lines.push(`## Feature Description`, feature.description, "");
    }

    lines.push(
      "## Instructions",
      "Answer the user's questions by reading relevant source files. Keep your answers focused and concise.",
      `Feature ID: ${featureId}`,
    );

    return lines.join("\n");
  }

  private emitPayload(featureId: string, payload: HelperChatPayload): void {
    this.eventBus.emit("helper_chat_event", { featureId, payload });
  }
}
