/**
 * GET / endpoint - Basic health check
 */

import type { Request, Response } from "express";
import { getRuntimeInstanceMetadata } from "../../../lib/version.js";

export function createIndexHandler() {
  return (_req: Request, res: Response): void => {
    const runtimeMetadata = getRuntimeInstanceMetadata();

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: runtimeMetadata.version,
      runtime: {
        bannerVersion: runtimeMetadata.bannerVersion,
        bannerBranch: runtimeMetadata.bannerBranch,
        runtimeChannel: runtimeMetadata.runtimeChannel,
        isPackagedRelease: runtimeMetadata.isPackagedRelease,
      },
    });
  };
}
