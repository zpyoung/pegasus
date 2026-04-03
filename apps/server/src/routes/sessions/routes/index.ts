/**
 * GET / endpoint - List all sessions
 */

import type { Request, Response } from 'express';
import { AgentService } from '../../../services/agent-service.js';
import { getErrorMessage, logError } from '../common.js';

export function createIndexHandler(agentService: AgentService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const includeArchived = req.query.includeArchived === 'true';
      const sessionsRaw = await agentService.listSessions(includeArchived);

      // Transform to match frontend SessionListItem interface
      const sessions = await Promise.all(
        sessionsRaw.map(async (s) => {
          const messages = await agentService.loadSession(s.id);
          const lastMessage = messages[messages.length - 1];
          const preview = lastMessage?.content?.slice(0, 100) || '';

          return {
            id: s.id,
            name: s.name,
            projectPath: s.projectPath || s.workingDirectory,
            workingDirectory: s.workingDirectory,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            isArchived: s.archived || false,
            tags: s.tags || [],
            messageCount: messages.length,
            preview,
          };
        })
      );

      res.json({ success: true, sessions });
    } catch (error) {
      logError(error, 'List sessions failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
