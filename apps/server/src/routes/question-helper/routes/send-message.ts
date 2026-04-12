/**
 * POST /send-message — forward a user chat message to the helper sub-agent.
 */

import type { Request, Response } from "express";
import type { PhaseModelEntry } from "@pegasus/types";
import type { QuestionHelperService } from "../../../services/question-helper-service.js";
import { createLogger } from "@pegasus/utils";

const logger = createLogger("question-helper");

/**
 * Validate and narrow an untrusted request payload to a PhaseModelEntry.
 * Returns `undefined` when the input is absent, or a validation error string
 * when it is present but malformed.
 */
function parseModelEntry(
  raw: unknown,
): { ok: true; value?: PhaseModelEntry } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object") {
    return { ok: false, error: "modelEntry must be an object when provided" };
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.model !== "string" || entry.model.trim().length === 0) {
    return { ok: false, error: "modelEntry.model must be a non-empty string" };
  }
  if (
    entry.thinkingLevel !== undefined &&
    typeof entry.thinkingLevel !== "string"
  ) {
    return {
      ok: false,
      error: "modelEntry.thinkingLevel must be a string when provided",
    };
  }
  if (entry.providerId !== undefined && typeof entry.providerId !== "string") {
    return {
      ok: false,
      error: "modelEntry.providerId must be a string when provided",
    };
  }
  return { ok: true, value: entry as unknown as PhaseModelEntry };
}

export function createSendMessageHandler(helperService: QuestionHelperService) {
  return async (req: Request, res: Response): Promise<void> => {
    const { featureId, message, projectPath, modelEntry } = req.body as {
      featureId?: string;
      message?: string;
      projectPath?: string;
      modelEntry?: unknown;
    };

    if (!featureId) {
      res.status(400).json({ success: false, error: "featureId is required" });
      return;
    }
    if (!projectPath) {
      res
        .status(400)
        .json({ success: false, error: "projectPath is required" });
      return;
    }
    if (typeof message !== "string" || message.trim().length === 0) {
      res
        .status(400)
        .json({ success: false, error: "message must be a non-empty string" });
      return;
    }
    const modelEntryResult = parseModelEntry(modelEntry);
    if (!modelEntryResult.ok) {
      res.status(400).json({ success: false, error: modelEntryResult.error });
      return;
    }

    // Respond immediately; streaming arrives via SSE helper_chat_event
    res.json({ success: true });

    // Fire-and-forget — errors are emitted as helper_chat_event 'error' payloads
    helperService
      .sendMessage(
        featureId,
        message.trim(),
        projectPath,
        modelEntryResult.value,
      )
      .catch((err: unknown) => {
        logger.error({ featureId, err }, "sendMessage unhandled rejection");
      });
  };
}
