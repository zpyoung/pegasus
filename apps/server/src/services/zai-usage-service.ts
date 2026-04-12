import { createLogger } from "@pegasus/utils";
import { createEventEmitter } from "../lib/events.js";
import type { SettingsService } from "./settings-service.js";

const logger = createLogger("ZaiUsage");

/** Default timeout for fetch requests in milliseconds */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * z.ai quota limit entry from the API
 */
export interface ZaiQuotaLimit {
  limitType: "TOKENS_LIMIT" | "TIME_LIMIT" | string;
  limit: number;
  used: number;
  remaining: number;
  usedPercent: number;
  nextResetTime: number; // epoch milliseconds
}

/**
 * z.ai usage details by model (for MCP tracking)
 */
export interface ZaiUsageDetail {
  modelId: string;
  used: number;
  limit: number;
}

/**
 * z.ai plan types
 */
export type ZaiPlanType =
  | "free"
  | "basic"
  | "standard"
  | "professional"
  | "enterprise"
  | "unknown";

/**
 * z.ai usage data structure
 */
export interface ZaiUsageData {
  quotaLimits: {
    tokens?: ZaiQuotaLimit;
    mcp?: ZaiQuotaLimit;
    planType: ZaiPlanType;
  } | null;
  usageDetails?: ZaiUsageDetail[];
  lastUpdated: string;
}

/**
 * z.ai API limit entry - supports multiple field naming conventions
 */
interface ZaiApiLimit {
  // Type field (z.ai uses 'type', others might use 'limitType')
  type?: string;
  limitType?: string;
  // Limit value (z.ai uses 'usage' for total limit, others might use 'limit')
  usage?: number;
  limit?: number;
  // Used value (z.ai uses 'currentValue', others might use 'used')
  currentValue?: number;
  used?: number;
  // Remaining
  remaining?: number;
  // Percentage (z.ai uses 'percentage', others might use 'usedPercent')
  percentage?: number;
  usedPercent?: number;
  // Reset time
  nextResetTime?: number;
  // Additional z.ai fields
  unit?: number;
  number?: number;
  usageDetails?: Array<{ modelCode: string; usage: number }>;
}

/**
 * z.ai API response structure
 * Flexible to handle various possible response formats
 */
interface ZaiApiResponse {
  code?: number;
  success?: boolean;
  data?: {
    limits?: ZaiApiLimit[];
    // Alternative: limits might be an object instead of array
    tokensLimit?: {
      limit: number;
      used: number;
      remaining?: number;
      usedPercent?: number;
      nextResetTime?: number;
    };
    timeLimit?: {
      limit: number;
      used: number;
      remaining?: number;
      usedPercent?: number;
      nextResetTime?: number;
    };
    // Quota-style fields
    quota?: number;
    quotaUsed?: number;
    quotaRemaining?: number;
    planName?: string;
    plan?: string;
    plan_type?: string;
    packageName?: string;
    usageDetails?: Array<{
      modelId: string;
      used: number;
      limit: number;
    }>;
  };
  // Root-level alternatives
  limits?: ZaiApiLimit[];
  quota?: number;
  quotaUsed?: number;
  message?: string;
}

/** Result from configure method */
interface ConfigureResult {
  success: boolean;
  message: string;
  isAvailable: boolean;
}

/** Result from verifyApiKey method */
interface VerifyResult {
  success: boolean;
  authenticated: boolean;
  message?: string;
  error?: string;
}

/**
 * z.ai Usage Service
 *
 * Fetches usage quota data from the z.ai API.
 * Uses API token authentication stored via environment variable or settings.
 */
export class ZaiUsageService {
  private apiToken: string | null = null;
  private apiHost: string = "https://api.z.ai";

  /**
   * Set the API token for authentication
   */
  setApiToken(token: string): void {
    this.apiToken = token;
    logger.info("[setApiToken] API token configured");
  }

  /**
   * Get the current API token
   */
  getApiToken(): string | null {
    // Priority: 1. Instance token, 2. Environment variable
    return this.apiToken || process.env.Z_AI_API_KEY || null;
  }

  /**
   * Set the API host (for BigModel CN region support)
   */
  setApiHost(host: string): void {
    this.apiHost = host.startsWith("http") ? host : `https://${host}`;
    logger.info(`[setApiHost] API host set to: ${this.apiHost}`);
  }

  /**
   * Get the API host
   */
  getApiHost(): string {
    // Priority: 1. Instance host, 2. Z_AI_API_HOST env, 3. Default
    if (process.env.Z_AI_API_HOST) {
      const envHost = process.env.Z_AI_API_HOST.trim();
      return envHost.startsWith("http") ? envHost : `https://${envHost}`;
    }
    return this.apiHost;
  }

  /**
   * Check if z.ai API is available (has token configured)
   */
  isAvailable(): boolean {
    const token = this.getApiToken();
    return Boolean(token && token.length > 0);
  }

  /**
   * Configure z.ai API token and host.
   * Persists the token via settingsService and updates in-memory state.
   */
  async configure(
    options: { apiToken?: string; apiHost?: string },
    settingsService: SettingsService,
  ): Promise<ConfigureResult> {
    const emitter = createEventEmitter();

    if (options.apiToken !== undefined) {
      // Set in-memory token
      this.setApiToken(options.apiToken || "");

      // Persist to credentials
      try {
        await settingsService.updateCredentials({
          apiKeys: { zai: options.apiToken || "" },
        } as Parameters<typeof settingsService.updateCredentials>[0]);
        logger.info("[configure] Saved z.ai API key to credentials");
      } catch (persistError) {
        logger.error(
          "[configure] Failed to persist z.ai API key:",
          persistError,
        );
      }
    }

    if (options.apiHost) {
      this.setApiHost(options.apiHost);
    }

    const result: ConfigureResult = {
      success: true,
      message: "z.ai configuration updated",
      isAvailable: this.isAvailable(),
    };

    emitter.emit("notification:created", {
      type: "zai.configured",
      success: result.success,
      isAvailable: result.isAvailable,
    });

    return result;
  }

  /**
   * Verify an API key without storing it.
   * Makes a test request to the z.ai quota URL with the given key.
   */
  async verifyApiKey(apiKey: string | undefined): Promise<VerifyResult> {
    const emitter = createEventEmitter();

    if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return {
        success: false,
        authenticated: false,
        error: "Please provide an API key to test.",
      };
    }

    const quotaUrl =
      process.env.Z_AI_QUOTA_URL ||
      `${this.getApiHost()}/api/monitor/usage/quota/limit`;

    logger.info(`[verify] Testing API key against: ${quotaUrl}`);

    try {
      const response = await fetch(quotaUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      let result: VerifyResult;

      if (response.ok) {
        result = {
          success: true,
          authenticated: true,
          message: "Connection successful! z.ai API responded.",
        };
      } else if (response.status === 401 || response.status === 403) {
        result = {
          success: false,
          authenticated: false,
          error: "Invalid API key. Please check your key and try again.",
        };
      } else {
        result = {
          success: false,
          authenticated: false,
          error: `API request failed: ${response.status} ${response.statusText}`,
        };
      }

      emitter.emit("notification:created", {
        type: "zai.verify.result",
        success: result.success,
        authenticated: result.authenticated,
      });

      return result;
    } catch (error) {
      // Handle abort/timeout errors specifically
      if (error instanceof Error && error.name === "AbortError") {
        const result: VerifyResult = {
          success: false,
          authenticated: false,
          error: "Request timed out. The z.ai API did not respond in time.",
        };
        emitter.emit("notification:created", {
          type: "zai.verify.result",
          success: false,
          error: "timeout",
        });
        return result;
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Error verifying z.ai API key:", error);

      emitter.emit("notification:created", {
        type: "zai.verify.result",
        success: false,
        error: message,
      });

      return {
        success: false,
        authenticated: false,
        error: `Network error: ${message}`,
      };
    }
  }

  /**
   * Fetch usage data from z.ai API
   */
  async fetchUsageData(): Promise<ZaiUsageData> {
    logger.info("[fetchUsageData] Starting...");
    const emitter = createEventEmitter();

    emitter.emit("notification:created", { type: "zai.usage.start" });

    const token = this.getApiToken();
    if (!token) {
      logger.error("[fetchUsageData] No API token configured");
      const error = new Error(
        "z.ai API token not configured. Set Z_AI_API_KEY environment variable.",
      );
      emitter.emit("notification:created", {
        type: "zai.usage.error",
        error: error.message,
      });
      throw error;
    }

    const quotaUrl =
      process.env.Z_AI_QUOTA_URL ||
      `${this.getApiHost()}/api/monitor/usage/quota/limit`;

    logger.info(`[fetchUsageData] Fetching from: ${quotaUrl}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(quotaUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          logger.error(
            `[fetchUsageData] HTTP ${response.status}: ${response.statusText}`,
          );
          throw new Error(
            `z.ai API request failed: ${response.status} ${response.statusText}`,
          );
        }

        const data = (await response.json()) as unknown as ZaiApiResponse;
        logger.info(
          "[fetchUsageData] Response received:",
          JSON.stringify(data, null, 2),
        );

        const result = this.parseApiResponse(data);

        emitter.emit("notification:created", {
          type: "zai.usage.success",
          data: result,
        });

        return result;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      // Handle abort/timeout errors
      if (error instanceof Error && error.name === "AbortError") {
        const timeoutError = new Error(
          `z.ai API request timed out after ${FETCH_TIMEOUT_MS}ms`,
        );
        emitter.emit("notification:created", {
          type: "zai.usage.error",
          error: timeoutError.message,
        });
        throw timeoutError;
      }

      if (error instanceof Error && error.message.includes("z.ai API")) {
        emitter.emit("notification:created", {
          type: "zai.usage.error",
          error: error.message,
        });
        throw error;
      }

      logger.error("[fetchUsageData] Failed to fetch:", error);
      const fetchError = new Error(
        `Failed to fetch z.ai usage data: ${error instanceof Error ? error.message : String(error)}`,
      );
      emitter.emit("notification:created", {
        type: "zai.usage.error",
        error: fetchError.message,
      });
      throw fetchError;
    }
  }

  /**
   * Parse the z.ai API response into our data structure
   * Handles multiple possible response formats from z.ai API
   */
  private parseApiResponse(response: ZaiApiResponse): ZaiUsageData {
    const result: ZaiUsageData = {
      quotaLimits: {
        planType: "unknown",
      },
      lastUpdated: new Date().toISOString(),
    };

    logger.info(
      "[parseApiResponse] Raw response:",
      JSON.stringify(response, null, 2),
    );

    // Try to find data - could be in response.data or at root level
    let data = response.data;

    // Check for root-level limits array
    if (!data && response.limits) {
      logger.info("[parseApiResponse] Found limits at root level");
      data = { limits: response.limits };
    }

    // Check for root-level quota fields
    if (
      !data &&
      (response.quota !== undefined || response.quotaUsed !== undefined)
    ) {
      logger.info("[parseApiResponse] Found quota fields at root level");
      data = { quota: response.quota, quotaUsed: response.quotaUsed };
    }

    if (!data) {
      logger.warn("[parseApiResponse] No data found in response");
      return result;
    }

    logger.info("[parseApiResponse] Data keys:", Object.keys(data));

    // Parse plan type from various possible field names
    const planName =
      data.planName || data.plan || data.plan_type || data.packageName;

    if (planName) {
      const normalizedPlan = String(planName).toLowerCase();
      if (
        ["free", "basic", "standard", "professional", "enterprise"].includes(
          normalizedPlan,
        )
      ) {
        result.quotaLimits!.planType = normalizedPlan as ZaiPlanType;
      }
      logger.info(
        `[parseApiResponse] Plan type: ${result.quotaLimits!.planType}`,
      );
    }

    // Parse quota limits from array format
    if (data.limits && Array.isArray(data.limits)) {
      logger.info(
        "[parseApiResponse] Parsing limits array with",
        data.limits.length,
        "entries",
      );
      for (const limit of data.limits) {
        logger.info(
          "[parseApiResponse] Processing limit:",
          JSON.stringify(limit),
        );

        // Handle different field naming conventions from z.ai API:
        // - 'usage' is the total limit, 'currentValue' is the used amount
        // - OR 'limit' is the total limit, 'used' is the used amount
        const limitVal = limit.usage ?? limit.limit ?? 0;
        const usedVal = limit.currentValue ?? limit.used ?? 0;

        // Get percentage from 'percentage' or 'usedPercent' field, or calculate it
        const apiPercent = limit.percentage ?? limit.usedPercent;
        const calculatedPercent = limitVal > 0 ? (usedVal / limitVal) * 100 : 0;
        const usedPercent =
          apiPercent !== undefined && apiPercent > 0
            ? apiPercent
            : calculatedPercent;

        // Get limit type from 'type' or 'limitType' field
        const rawLimitType = limit.type ?? limit.limitType ?? "";

        const quotaLimit: ZaiQuotaLimit = {
          limitType: rawLimitType || "TOKENS_LIMIT",
          limit: limitVal,
          used: usedVal,
          remaining: limit.remaining ?? limitVal - usedVal,
          usedPercent,
          nextResetTime: limit.nextResetTime ?? 0,
        };

        // Match various possible limitType values
        const limitType = String(rawLimitType).toUpperCase();
        if (limitType.includes("TOKEN") || limitType === "TOKENS_LIMIT") {
          result.quotaLimits!.tokens = quotaLimit;
          logger.info(
            `[parseApiResponse] Tokens: ${quotaLimit.used}/${quotaLimit.limit} (${quotaLimit.usedPercent.toFixed(1)}%)`,
          );
        } else if (limitType.includes("TIME") || limitType === "TIME_LIMIT") {
          result.quotaLimits!.mcp = quotaLimit;
          logger.info(
            `[parseApiResponse] MCP: ${quotaLimit.used}/${quotaLimit.limit} (${quotaLimit.usedPercent.toFixed(1)}%)`,
          );
        } else {
          // If limitType is unknown, use as tokens by default (first one)
          if (!result.quotaLimits!.tokens) {
            quotaLimit.limitType = "TOKENS_LIMIT";
            result.quotaLimits!.tokens = quotaLimit;
            logger.info(
              `[parseApiResponse] Unknown limit type '${rawLimitType}', using as tokens`,
            );
          }
        }
      }
    }

    // Parse alternative object-style limits
    if (data.tokensLimit) {
      const t = data.tokensLimit;
      const limitVal = t.limit ?? 0;
      const usedVal = t.used ?? 0;
      const calculatedPercent = limitVal > 0 ? (usedVal / limitVal) * 100 : 0;
      result.quotaLimits!.tokens = {
        limitType: "TOKENS_LIMIT",
        limit: limitVal,
        used: usedVal,
        remaining: t.remaining ?? limitVal - usedVal,
        usedPercent:
          t.usedPercent !== undefined && t.usedPercent > 0
            ? t.usedPercent
            : calculatedPercent,
        nextResetTime: t.nextResetTime ?? 0,
      };
      logger.info("[parseApiResponse] Parsed tokensLimit object");
    }

    if (data.timeLimit) {
      const t = data.timeLimit;
      const limitVal = t.limit ?? 0;
      const usedVal = t.used ?? 0;
      const calculatedPercent = limitVal > 0 ? (usedVal / limitVal) * 100 : 0;
      result.quotaLimits!.mcp = {
        limitType: "TIME_LIMIT",
        limit: limitVal,
        used: usedVal,
        remaining: t.remaining ?? limitVal - usedVal,
        usedPercent:
          t.usedPercent !== undefined && t.usedPercent > 0
            ? t.usedPercent
            : calculatedPercent,
        nextResetTime: t.nextResetTime ?? 0,
      };
      logger.info("[parseApiResponse] Parsed timeLimit object");
    }

    // Parse simple quota/quotaUsed format as tokens
    if (
      data.quota !== undefined &&
      data.quotaUsed !== undefined &&
      !result.quotaLimits!.tokens
    ) {
      const limitVal = Number(data.quota) || 0;
      const usedVal = Number(data.quotaUsed) || 0;
      result.quotaLimits!.tokens = {
        limitType: "TOKENS_LIMIT",
        limit: limitVal,
        used: usedVal,
        remaining:
          data.quotaRemaining !== undefined
            ? Number(data.quotaRemaining)
            : limitVal - usedVal,
        usedPercent: limitVal > 0 ? (usedVal / limitVal) * 100 : 0,
        nextResetTime: 0,
      };
      logger.info("[parseApiResponse] Parsed simple quota format");
    }

    // Parse usage details (MCP tracking)
    if (data.usageDetails && Array.isArray(data.usageDetails)) {
      result.usageDetails = data.usageDetails.map((detail) => ({
        modelId: detail.modelId,
        used: detail.used,
        limit: detail.limit,
      }));
      logger.info(
        `[parseApiResponse] Usage details for ${result.usageDetails.length} models`,
      );
    }

    logger.info(
      "[parseApiResponse] Final result:",
      JSON.stringify(result, null, 2),
    );
    return result;
  }
}
