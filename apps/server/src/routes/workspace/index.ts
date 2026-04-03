/**
 * Workspace routes
 * Provides API endpoints for workspace directory management
 */

import { Router } from 'express';
import { createConfigHandler } from './routes/config.js';
import { createDirectoriesHandler } from './routes/directories.js';

export function createWorkspaceRoutes(): Router {
  const router = Router();

  router.get('/config', createConfigHandler());
  router.get('/directories', createDirectoriesHandler());

  return router;
}
