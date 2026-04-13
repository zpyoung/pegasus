/**
 * GET /detailed endpoint - Detailed health check
 */

import type { Request, Response } from "express";
import { getAuthStatus } from "../../../lib/auth.js";
import { getRuntimeInstanceMetadata } from "../../../lib/version.js";

export function createDetailedHandler() {
  return (_req: Request, res: Response): void => {
    const runtimeMetadata = getRuntimeInstanceMetadata();

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: runtimeMetadata.version,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      dataDir: process.env.DATA_DIR || "./data",
      auth: getAuthStatus(),
      runtime: {
        bannerVersion: runtimeMetadata.bannerVersion,
        bannerBranch: runtimeMetadata.bannerBranch,
        runtimeChannel: runtimeMetadata.runtimeChannel,
        isPackagedRelease: runtimeMetadata.isPackagedRelease,
      },
      env: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    });
  };
}
