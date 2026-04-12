/**
 * Question Helper routes — ephemeral read-only sub-agent chat for paused features.
 *
 * All streaming events are delivered via the shared SSE bus (helper_chat_event).
 * These routes handle only HTTP control plane calls.
 */

import { Router } from "express";
import type { QuestionHelperService } from "../../services/question-helper-service.js";
import { validatePathParams } from "../../middleware/validate-paths.js";
import { createSendMessageHandler } from "./routes/send-message.js";
import { createEndSessionHandler } from "./routes/end-session.js";
import { createGetHistoryHandler } from "./routes/get-history.js";

export function createQuestionHelperRoutes(
  helperService: QuestionHelperService,
): Router {
  const router = Router();

  router.post(
    "/send-message",
    validatePathParams("projectPath"),
    createSendMessageHandler(helperService),
  );
  router.post("/end-session", createEndSessionHandler(helperService));
  router.get("/history/:featureId", createGetHistoryHandler(helperService));

  return router;
}
