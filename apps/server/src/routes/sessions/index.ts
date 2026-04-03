/**
 * Sessions routes - HTTP API for session management
 */

import { Router } from 'express';
import { AgentService } from '../../services/agent-service.js';
import { createIndexHandler } from './routes/index.js';
import { createCreateHandler } from './routes/create.js';
import { createUpdateHandler } from './routes/update.js';
import { createArchiveHandler } from './routes/archive.js';
import { createUnarchiveHandler } from './routes/unarchive.js';
import { createDeleteHandler } from './routes/delete.js';

export function createSessionsRoutes(agentService: AgentService): Router {
  const router = Router();

  router.get('/', createIndexHandler(agentService));
  router.post('/', createCreateHandler(agentService));
  router.put('/:sessionId', createUpdateHandler(agentService));
  router.post('/:sessionId/archive', createArchiveHandler(agentService));
  router.post('/:sessionId/unarchive', createUnarchiveHandler(agentService));
  router.delete('/:sessionId', createDeleteHandler(agentService));

  return router;
}
