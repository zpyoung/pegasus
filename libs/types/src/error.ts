/**
 * Error type classification
 */
export type ErrorType =
  | 'authentication'
  | 'cancellation'
  | 'abort'
  | 'execution'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'model_not_found'
  | 'stream_disconnected'
  | 'unknown';

/**
 * Classified error information
 */
export interface ErrorInfo {
  type: ErrorType;
  message: string;
  isAbort: boolean;
  isAuth: boolean;
  isCancellation: boolean;
  isRateLimit: boolean;
  isQuotaExhausted: boolean; // Session/weekly usage limit reached
  isModelNotFound: boolean; // Model does not exist or user lacks access
  isStreamDisconnected: boolean; // Stream disconnected before completion
  retryAfter?: number; // Seconds to wait before retrying (for rate limit errors)
  originalError: unknown;
}
