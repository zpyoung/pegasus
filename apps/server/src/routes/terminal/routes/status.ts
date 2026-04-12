/**
 * GET /status endpoint - Get terminal status
 */

import type { Request, Response } from "express";
import { getTerminalService } from "../../../services/terminal-service.js";
import {
  getTerminalEnabledConfigValue,
  isTerminalPasswordRequired,
} from "../common.js";

export function createStatusHandler() {
  return (_req: Request, res: Response): void => {
    const terminalService = getTerminalService();
    res.json({
      success: true,
      data: {
        enabled: getTerminalEnabledConfigValue(),
        passwordRequired: isTerminalPasswordRequired(),
        platform: terminalService.getPlatformInfo(),
      },
    });
  };
}
