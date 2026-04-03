import { Router, Request, Response } from 'express';
import { ZaiUsageService } from '../../services/zai-usage-service.js';
import type { SettingsService } from '../../services/settings-service.js';
import { createLogger } from '@pegasus/utils';

const logger = createLogger('Zai');

export function createZaiRoutes(
  usageService: ZaiUsageService,
  settingsService: SettingsService
): Router {
  const router = Router();

  // Initialize z.ai API token from credentials on startup
  (async () => {
    try {
      const credentials = await settingsService.getCredentials();
      if (credentials.apiKeys?.zai) {
        usageService.setApiToken(credentials.apiKeys.zai);
        logger.info('[init] Loaded z.ai API key from credentials');
      }
    } catch (error) {
      logger.error('[init] Failed to load z.ai API key from credentials:', error);
    }
  })();

  // Get current usage (fetches from z.ai API)
  router.get('/usage', async (_req: Request, res: Response) => {
    try {
      // Check if z.ai API is configured
      const isAvailable = usageService.isAvailable();
      if (!isAvailable) {
        // Use a 200 + error payload so the UI doesn't interpret it as session auth error
        res.status(200).json({
          error: 'z.ai API not configured',
          message: 'Set Z_AI_API_KEY environment variable to enable z.ai usage tracking',
        });
        return;
      }

      const usage = await usageService.fetchUsageData();
      res.json(usage);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (message.includes('not configured') || message.includes('API token')) {
        res.status(200).json({
          error: 'API token required',
          message: 'Set Z_AI_API_KEY environment variable to enable z.ai usage tracking',
        });
      } else if (message.includes('failed') || message.includes('request')) {
        res.status(200).json({
          error: 'API request failed',
          message: message,
        });
      } else {
        logger.error('Error fetching z.ai usage:', error);
        res.status(500).json({ error: message });
      }
    }
  });

  // Configure API token (for settings page)
  router.post('/configure', async (req: Request, res: Response) => {
    try {
      const { apiToken, apiHost } = req.body;

      // Validate apiToken: must be present and a string
      if (apiToken === undefined || apiToken === null || typeof apiToken !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Invalid request: apiToken is required and must be a string',
        });
        return;
      }

      // Validate apiHost if provided: must be a string and a well-formed URL
      if (apiHost !== undefined && apiHost !== null) {
        if (typeof apiHost !== 'string') {
          res.status(400).json({
            success: false,
            error: 'Invalid request: apiHost must be a string',
          });
          return;
        }
        // Validate that apiHost is a well-formed URL
        try {
          const parsedUrl = new URL(apiHost);
          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            res.status(400).json({
              success: false,
              error: 'Invalid request: apiHost must be a valid HTTP or HTTPS URL',
            });
            return;
          }
        } catch {
          res.status(400).json({
            success: false,
            error: 'Invalid request: apiHost must be a well-formed URL',
          });
          return;
        }
      }

      // Pass only the sanitized values to the service
      const sanitizedToken = apiToken.trim();
      const sanitizedHost = typeof apiHost === 'string' ? apiHost.trim() : undefined;

      const result = await usageService.configure(
        { apiToken: sanitizedToken, apiHost: sanitizedHost },
        settingsService
      );
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error configuring z.ai:', error);
      res.status(500).json({ error: message });
    }
  });

  // Verify API key without storing it (for testing in settings)
  router.post('/verify', async (req: Request, res: Response) => {
    try {
      const { apiKey } = req.body;
      const result = await usageService.verifyApiKey(apiKey);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error verifying z.ai API key:', error);
      res.json({
        success: false,
        authenticated: false,
        error: `Network error: ${message}`,
      });
    }
  });

  // Check if z.ai is available
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const isAvailable = usageService.isAvailable();
      const hasEnvApiKey = Boolean(process.env.Z_AI_API_KEY);
      const hasApiKey = usageService.getApiToken() !== null;

      res.json({
        success: true,
        available: isAvailable,
        hasApiKey,
        hasEnvApiKey,
        message: isAvailable ? 'z.ai API is configured' : 'z.ai API token not configured',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: message });
    }
  });

  return router;
}
