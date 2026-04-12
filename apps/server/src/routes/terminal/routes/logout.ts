/**
 * POST /logout endpoint - Invalidate a session token
 */

import type { Request, Response } from "express";
import { deleteToken } from "../common.js";

export function createLogoutHandler() {
  return (req: Request, res: Response): void => {
    const token = (req.headers["x-terminal-token"] as string) || req.body.token;

    if (token) {
      deleteToken(token);
    }

    res.json({
      success: true,
    });
  };
}
