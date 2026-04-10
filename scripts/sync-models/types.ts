/**
 * Shared types for the model registry sync system
 */

export interface ProviderAdapter {
  readonly name: string;
  readonly tier: 'ci' | 'local'; // ci = runs in GitHub Actions; local = requires interactive auth
  fetchModels(): Promise<ModelEntry[]>;
}

export interface ModelEntry {
  id: string; // Full model ID (e.g., 'claude-opus-4-6')
  name: string; // Display name (e.g., 'Claude Opus 4.6')
  provider: string; // Provider key (e.g., 'anthropic')
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsThinking?: boolean;
  reasoningCapable?: boolean;
  stabilityTier?: 'ga' | 'preview' | 'deprecated';
  pricing?: { inputPerMToken?: number; outputPerMToken?: number };
  aliases?: string[]; // Short names this model is known by
  defaultFor?: string; // If this is the default model for its provider
}

export interface RegistrySchema {
  version: string;
  generatedAt: string;
  providers: Record<string, ModelEntry[]>;
}

export interface ProviderSnapshot {
  provider: string;
  fetchedAt: string;
  models: ModelEntry[];
  error?: string;
}

export interface DiffSummary {
  added: string[];
  removed: string[];
  updated: string[];
  aliasChanges: Array<{ model: string; before: string[]; after: string[] }>;
  staleProviders: string[];
  failedProviders: Array<{ provider: string; error: string }>;
}
