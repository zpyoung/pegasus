/**
 * Models routes - HTTP API for model providers and availability
 */

import { Router } from 'express';
import { createAvailableHandler } from './routes/available.js';
import { createProvidersHandler } from './routes/providers.js';

export function createModelsRoutes(): Router {
  const router = Router();

  router.get('/available', createAvailableHandler());
  router.get('/providers', createProvidersHandler());

  return router;
}
