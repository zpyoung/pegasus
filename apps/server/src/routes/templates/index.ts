/**
 * Templates routes
 * Provides API for cloning GitHub starter templates
 */

import { Router } from 'express';
import { createCloneHandler } from './routes/clone.js';

export function createTemplatesRoutes(): Router {
  const router = Router();

  router.post('/clone', createCloneHandler());

  return router;
}
