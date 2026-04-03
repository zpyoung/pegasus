/**
 * GET/PUT /settings endpoint - Get/Update terminal settings
 */

import type { Request, Response } from 'express';
import {
  getTerminalService,
  MIN_MAX_SESSIONS,
  MAX_MAX_SESSIONS,
} from '../../../services/terminal-service.js';
import { getErrorMessage, logError } from '../common.js';

export function createSettingsGetHandler() {
  return (_req: Request, res: Response): void => {
    try {
      const terminalService = getTerminalService();
      res.json({
        success: true,
        data: {
          maxSessions: terminalService.getMaxSessions(),
          currentSessions: terminalService.getSessionCount(),
        },
      });
    } catch (error) {
      logError(error, 'Get terminal settings failed');
      res.status(500).json({
        success: false,
        error: 'Failed to get terminal settings',
        details: getErrorMessage(error),
      });
    }
  };
}

export function createSettingsUpdateHandler() {
  return (req: Request, res: Response): void => {
    try {
      const terminalService = getTerminalService();
      const { maxSessions } = req.body;

      // Validate maxSessions if provided
      if (maxSessions !== undefined) {
        if (typeof maxSessions !== 'number') {
          res.status(400).json({
            success: false,
            error: 'maxSessions must be a number',
          });
          return;
        }
        if (!Number.isInteger(maxSessions)) {
          res.status(400).json({
            success: false,
            error: 'maxSessions must be an integer',
          });
          return;
        }
        if (maxSessions < MIN_MAX_SESSIONS || maxSessions > MAX_MAX_SESSIONS) {
          res.status(400).json({
            success: false,
            error: `maxSessions must be between ${MIN_MAX_SESSIONS} and ${MAX_MAX_SESSIONS}`,
          });
          return;
        }
        terminalService.setMaxSessions(maxSessions);
      }

      res.json({
        success: true,
        data: {
          maxSessions: terminalService.getMaxSessions(),
          currentSessions: terminalService.getSessionCount(),
        },
      });
    } catch (error) {
      logError(error, 'Update terminal settings failed');
      res.status(500).json({
        success: false,
        error: 'Failed to update terminal settings',
        details: getErrorMessage(error),
      });
    }
  };
}
