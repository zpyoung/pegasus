/**
 * Terminal routes with password protection
 *
 * Provides REST API for terminal session management and authentication.
 * WebSocket connections for real-time I/O are handled separately in index.ts.
 */

import { Router } from "express";
import {
  terminalAuthMiddleware,
  validateTerminalToken,
  isTerminalEnabled,
  isTerminalPasswordRequired,
} from "./common.js";
import { createStatusHandler } from "./routes/status.js";
import { createAuthHandler } from "./routes/auth.js";
import { createLogoutHandler } from "./routes/logout.js";
import {
  createSessionsListHandler,
  createSessionsCreateHandler,
} from "./routes/sessions.js";
import { createSessionDeleteHandler } from "./routes/session-delete.js";
import { createSessionResizeHandler } from "./routes/session-resize.js";
import {
  createSettingsGetHandler,
  createSettingsUpdateHandler,
} from "./routes/settings.js";

// Re-export for use in main index.ts
export { validateTerminalToken, isTerminalEnabled, isTerminalPasswordRequired };

export function createTerminalRoutes(): Router {
  const router = Router();

  router.get("/status", createStatusHandler());
  router.post("/auth", createAuthHandler());
  router.post("/logout", createLogoutHandler());

  // Apply terminal auth middleware to all routes below
  router.use(terminalAuthMiddleware);

  router.get("/sessions", createSessionsListHandler());
  router.post("/sessions", createSessionsCreateHandler());
  router.delete("/sessions/:id", createSessionDeleteHandler());
  router.post("/sessions/:id/resize", createSessionResizeHandler());
  router.get("/settings", createSettingsGetHandler());
  router.put("/settings", createSettingsUpdateHandler());

  return router;
}
