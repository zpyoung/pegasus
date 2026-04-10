/**
 * Sync Engine
 *
 * Orchestrates adapters, manages per-provider snapshots,
 * merges overrides, generates TypeScript files, and produces diff summary.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderAdapter, ModelEntry, ProviderSnapshot, DiffSummary } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TYPES_SRC = path.join(PROJECT_ROOT, 'libs', 'types', 'src');
const SNAPSHOTS_DIR = path.join(TYPES_SRC, 'snapshots');
const REGISTRY_JSON = path.join(TYPES_SRC, 'model-registry.json');
const OVERRIDES_JSON = path.join(TYPES_SRC, 'model-overrides.json');
const REGISTRY_GEN = path.join(TYPES_SRC, 'model-registry.gen.ts');
const CAPABILITIES_GEN = path.join(TYPES_SRC, 'model-capabilities.gen.ts');
const DISPLAY_GEN = path.join(TYPES_SRC, 'model-display.gen.ts');
const SUMMARY_FILE = '/tmp/sync-models-summary.md';

const DEFAULT_TTL_DAYS = 30;

export interface RunOptions {
  ciOnly: boolean;
  dryRun: boolean;
  ttlDays: number;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runSync(adapters: ProviderAdapter[], options: RunOptions): Promise<void> {
  const { ciOnly, dryRun, ttlDays } = options;

  // Filter adapters by tier if running in CI mode
  const activeAdapters = ciOnly ? adapters.filter((a) => a.tier === 'ci') : adapters;
  console.log(`Running ${activeAdapters.length} adapters (ciOnly=${ciOnly})`);

  // Ensure snapshots directory exists
  if (!dryRun) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  // Step 1: Run all adapters in parallel
  const results = await Promise.allSettled(
    activeAdapters.map((adapter) => runAdapter(adapter))
  );

  const failedProviders: Array<{ provider: string; error: string }> = [];

  // Step 2: Persist successful snapshots, log failures
  for (let i = 0; i < activeAdapters.length; i++) {
    const adapter = activeAdapters[i];
    const result = results[i];

    if (result.status === 'fulfilled') {
      const snapshot: ProviderSnapshot = {
        provider: adapter.name,
        fetchedAt: new Date().toISOString(),
        models: result.value,
      };
      console.log(`  [${adapter.name}] SUCCESS: ${result.value.length} models`);
      if (!dryRun) {
        writeSnapshot(adapter.name, snapshot);
      }
    } else {
      const err = result.reason as Error;
      console.warn(`  [${adapter.name}] FAILED: ${err.message}`);
      failedProviders.push({ provider: adapter.name, error: err.message });
    }
  }

  // Step 3: Check if all adapters failed
  if (failedProviders.length === activeAdapters.length) {
    throw new Error('All adapters failed — aborting sync to prevent registry wipeout');
  }

  // Step 4: Load all valid snapshots (fresh + within TTL)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - ttlDays);

  const allSnapshots = loadAllSnapshots(cutoffDate);
  const staleProviders = allSnapshots.filter((s) => s.stale).map((s) => s.provider);
  const validSnapshots = allSnapshots.filter((s) => !s.stale);

  if (staleProviders.length > 0) {
    console.warn(`Excluding stale providers (>${ttlDays} days): ${staleProviders.join(', ')}`);
  }

  // Step 5: Merge all valid model entries, sorted by ID for deterministic output
  const allModels = mergeModels(validSnapshots.map((s) => s.models).flat());

  // Step 6: Load and apply overrides
  const overrides = loadOverrides();
  const mergedModels = applyOverrides(allModels, overrides);

  // Step 7: Load old registry for diff calculation
  const oldRegistry = loadOldRegistry();

  // Step 8: Build provider map
  const providerMap = buildProviderMap(mergedModels);

  // Step 9: Write registry JSON
  const registryData = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    providers: providerMap,
  };

  if (!dryRun) {
    fs.writeFileSync(REGISTRY_JSON, JSON.stringify(registryData, null, 2) + '\n');
    console.log(`Wrote ${REGISTRY_JSON}`);
  }

  // Step 10: Generate TypeScript files
  if (!dryRun) {
    generateRegistryFile(mergedModels, providerMap);
    generateCapabilitiesFile(mergedModels);
    generateDisplayFile(mergedModels);
  } else {
    console.log('[dry-run] Would generate: model-registry.gen.ts, model-capabilities.gen.ts, model-display.gen.ts');
  }

  // Step 11: Compute and write diff summary
  const diff = computeDiff(oldRegistry, mergedModels, staleProviders, failedProviders);
  const summary = formatSummary(diff, failedProviders, staleProviders);
  console.log('\n' + summary);

  if (!dryRun) {
    fs.writeFileSync(SUMMARY_FILE, summary);
    console.log(`Wrote diff summary to ${SUMMARY_FILE}`);
  }
}

// ---------------------------------------------------------------------------
// Adapter runner
// ---------------------------------------------------------------------------

async function runAdapter(adapter: ProviderAdapter): Promise<ModelEntry[]> {
  console.log(`  [${adapter.name}] fetching...`);
  return adapter.fetchModels();
}

// ---------------------------------------------------------------------------
// Snapshot management
// ---------------------------------------------------------------------------

function snapshotPath(provider: string): string {
  return path.join(SNAPSHOTS_DIR, `${provider}.json`);
}

function writeSnapshot(provider: string, snapshot: ProviderSnapshot): void {
  fs.writeFileSync(snapshotPath(provider), JSON.stringify(snapshot, null, 2) + '\n');
}

interface LoadedSnapshot {
  provider: string;
  models: ModelEntry[];
  fetchedAt: Date;
  stale: boolean;
}

function loadAllSnapshots(cutoff: Date): LoadedSnapshot[] {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];

  const files = fs.readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith('.json'));
  const result: LoadedSnapshot[] = [];

  for (const file of files) {
    const provider = file.replace('.json', '');
    try {
      const raw = fs.readFileSync(path.join(SNAPSHOTS_DIR, file), 'utf-8');
      const snapshot = JSON.parse(raw) as ProviderSnapshot;
      const fetchedAt = new Date(snapshot.fetchedAt);
      const stale = fetchedAt < cutoff;
      result.push({ provider, models: snapshot.models, fetchedAt, stale });
    } catch (err) {
      console.warn(`  [snapshot] Failed to load ${file}: ${(err as Error).message}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Model merging
// ---------------------------------------------------------------------------

export function mergeModels(models: ModelEntry[]): ModelEntry[] {
  // Deduplicate by ID, last-write wins, then sort
  const map = new Map<string, ModelEntry>();
  for (const m of models) {
    map.set(m.id, m);
  }
  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function buildProviderMap(models: ModelEntry[]): Record<string, ModelEntry[]> {
  const map: Record<string, ModelEntry[]> = {};
  for (const m of models) {
    if (!map[m.provider]) map[m.provider] = [];
    map[m.provider].push(m);
  }
  return map;
}

/** Pure TTL filter — exported for testing (NFR-004) */
export function filterSnapshotsByTTL(
  snapshots: Array<{ provider: string; models: ModelEntry[]; fetchedAt: string }>,
  cutoff: Date
): { valid: Array<{ provider: string; models: ModelEntry[] }>; stale: string[] } {
  const valid: Array<{ provider: string; models: ModelEntry[] }> = [];
  const stale: string[] = [];
  for (const s of snapshots) {
    if (new Date(s.fetchedAt) < cutoff) {
      stale.push(s.provider);
    } else {
      valid.push({ provider: s.provider, models: s.models });
    }
  }
  return { valid, stale };
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

function loadOverrides(): Record<string, Partial<ModelEntry>> {
  if (!fs.existsSync(OVERRIDES_JSON)) return {};
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_JSON, 'utf-8')) as Record<string, Partial<ModelEntry>>;
  } catch {
    return {};
  }
}

export function applyOverrides(
  models: ModelEntry[],
  overrides: Record<string, Partial<ModelEntry>>
): ModelEntry[] {
  return models.map((m) => {
    const override = overrides[m.id];
    if (!override) return m;
    return { ...m, ...override };
  });
}

// ---------------------------------------------------------------------------
// Old registry loader (for diff)
// ---------------------------------------------------------------------------

function loadOldRegistry(): ModelEntry[] {
  if (!fs.existsSync(REGISTRY_JSON)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_JSON, 'utf-8')) as {
      providers: Record<string, ModelEntry[]>;
    };
    return Object.values(data.providers).flat();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Code generators
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Content builders (pure, exported for testing — FR-002)
// ---------------------------------------------------------------------------

export function buildRegistryContent(
  models: ModelEntry[],
  providerMap: Record<string, ModelEntry[]>,
  timestamp: string
): string {
  const providerModelMapLines = Object.entries(providerMap).map(([provider, pModels]) => {
    const ids = pModels.map((m) => `    '${m.id}'`).join(',\n');
    return `  ${provider}: [\n${ids},\n  ] as const`;
  });

  const providerTypeLines = Object.entries(providerMap).map(([provider, pModels]) => {
    const typeName = `${capitalize(provider)}ModelId`;
    const ids = pModels.map((m) => `  | '${m.id}'`).join('\n');
    return `export type ${typeName} =\n${ids};`;
  });

  const modelIdTypes = Object.keys(providerMap)
    .map((p) => `${capitalize(p)}ModelId`)
    .join('\n  | ');

  const aliasEntries: string[] = [];
  for (const m of models) {
    if (m.aliases) {
      for (const alias of m.aliases) {
        aliasEntries.push(`  '${alias}': '${m.id}'`);
      }
    }
  }

  const providerForModelEntries = models.map((m) => `  '${m.id}': '${m.provider}'`);

  const defaultEntries = models
    .filter((m) => m.defaultFor)
    .map((m) => `  '${m.defaultFor}': '${m.id}'`);

  return `// @generated by sync-models on ${timestamp} — DO NOT EDIT
// To customize display metadata, edit libs/types/src/model-overrides.json
// Re-run: pnpm sync-models

export const PROVIDER_MODEL_MAP = {
${providerModelMapLines.join(',\n')},
} as const;

${providerTypeLines.join('\n\n')}

export type ModelId =
  | ${modelIdTypes};

export const MODEL_ALIASES: Record<string, string> = {
${aliasEntries.join(',\n')},
};

export const PROVIDER_FOR_MODEL: Record<string, string> = {
${providerForModelEntries.join(',\n')},
};

export const DEFAULT_MODELS_REGISTRY: Record<string, string> = {
${defaultEntries.join(',\n')},
};
`;
}

export function buildCapabilitiesContent(models: ModelEntry[], timestamp: string): string {
  const reasoningModels = models.filter((m) => m.reasoningCapable).map((m) => `  '${m.id}'`);
  const visionModels = models.filter((m) => m.supportsVision).map((m) => `  '${m.id}'`);
  const toolModels = models.filter((m) => m.supportsTools).map((m) => `  '${m.id}'`);
  const thinkingModels = models.filter((m) => m.supportsThinking).map((m) => `  '${m.id}'`);

  const contextWindowEntries = models
    .filter((m) => m.contextWindow != null)
    .map((m) => `  '${m.id}': ${m.contextWindow}`);

  const maxOutputEntries = models
    .filter((m) => m.maxOutputTokens != null)
    .map((m) => `  '${m.id}': ${m.maxOutputTokens}`);

  return `// @generated by sync-models on ${timestamp} — DO NOT EDIT
// To customize, edit libs/types/src/model-overrides.json
// Re-run: pnpm sync-models

export const REASONING_CAPABLE_MODEL_IDS = new Set<string>([
${reasoningModels.join(',\n')},
]);

export const VISION_CAPABLE_MODEL_IDS = new Set<string>([
${visionModels.join(',\n')},
]);

export const TOOL_CAPABLE_MODEL_IDS = new Set<string>([
${toolModels.join(',\n')},
]);

export const THINKING_CAPABLE_MODEL_IDS = new Set<string>([
${thinkingModels.join(',\n')},
]);

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
${contextWindowEntries.join(',\n')},
};

export const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
${maxOutputEntries.join(',\n')},
};
`;
}

export function buildDisplayContent(models: ModelEntry[], timestamp: string): string {
  const displayNameEntries = models.map(
    (m) => `  '${m.id}': '${m.name.replace(/'/g, "\\'")}'`
  );

  return `// @generated by sync-models on ${timestamp} — DO NOT EDIT
// To customize display metadata, edit libs/types/src/model-overrides.json
// Re-run: pnpm sync-models

export const MODEL_DISPLAY_NAMES: Record<string, string> = {
${displayNameEntries.join(',\n')},
};

export function getRegistryModelDisplayName(modelId: string): string | undefined {
  return MODEL_DISPLAY_NAMES[modelId];
}
`;
}

// ---------------------------------------------------------------------------
// File generators (call content builders + write to disk)
// ---------------------------------------------------------------------------

function generateRegistryFile(
  models: ModelEntry[],
  providerMap: Record<string, ModelEntry[]>
): void {
  const content = buildRegistryContent(models, providerMap, new Date().toISOString());
  fs.writeFileSync(REGISTRY_GEN, content);
  console.log(`Wrote ${REGISTRY_GEN}`);
}

function generateCapabilitiesFile(models: ModelEntry[]): void {
  const content = buildCapabilitiesContent(models, new Date().toISOString());
  fs.writeFileSync(CAPABILITIES_GEN, content);
  console.log(`Wrote ${CAPABILITIES_GEN}`);
}

function generateDisplayFile(models: ModelEntry[]): void {
  const content = buildDisplayContent(models, new Date().toISOString());
  fs.writeFileSync(DISPLAY_GEN, content);
  console.log(`Wrote ${DISPLAY_GEN}`);
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

export function computeDiff(
  oldModels: ModelEntry[],
  newModels: ModelEntry[],
  staleProviders: string[],
  failedProviders: Array<{ provider: string; error: string }>
): DiffSummary {
  const oldIds = new Set(oldModels.map((m) => m.id));
  const newIds = new Set(newModels.map((m) => m.id));

  const added = newModels.filter((m) => !oldIds.has(m.id)).map((m) => m.id);
  const removed = oldModels.filter((m) => !newIds.has(m.id)).map((m) => m.id);

  const oldMap = new Map(oldModels.map((m) => [m.id, m]));
  const updated = newModels
    .filter((m) => oldIds.has(m.id) && JSON.stringify(m) !== JSON.stringify(oldMap.get(m.id)))
    .map((m) => m.id);

  const aliasChanges: DiffSummary['aliasChanges'] = [];
  for (const m of newModels) {
    const old = oldMap.get(m.id);
    if (old && JSON.stringify(old.aliases) !== JSON.stringify(m.aliases)) {
      aliasChanges.push({
        model: m.id,
        before: old.aliases ?? [],
        after: m.aliases ?? [],
      });
    }
  }

  return { added, removed, updated, aliasChanges, staleProviders, failedProviders };
}

export function formatSummary(
  diff: DiffSummary,
  failedProviders: Array<{ provider: string; error: string }>,
  staleProviders: string[]
): string {
  const lines: string[] = [
    '# Model Registry Sync Summary',
    '',
    `**Generated**: ${new Date().toISOString()}`,
    '',
  ];

  if (failedProviders.length > 0) {
    lines.push('## ⚠️ Failed Providers');
    for (const fp of failedProviders) {
      lines.push(`- **${fp.provider}**: ${fp.error}`);
    }
    lines.push('');
  }

  if (staleProviders.length > 0) {
    lines.push('## 🕐 Stale Providers (excluded from output)');
    for (const sp of staleProviders) {
      lines.push(`- ${sp}`);
    }
    lines.push('');
  }

  lines.push('## Changes');
  lines.push('');
  lines.push(`- **Added**: ${diff.added.length} models`);
  lines.push(`- **Removed**: ${diff.removed.length} models`);
  lines.push(`- **Updated**: ${diff.updated.length} models`);
  lines.push(`- **Alias changes**: ${diff.aliasChanges.length}`);
  lines.push('');

  if (diff.added.length > 0) {
    lines.push('### Added Models');
    for (const id of diff.added) lines.push(`- \`${id}\``);
    lines.push('');
  }

  if (diff.removed.length > 0) {
    lines.push('### Removed Models');
    for (const id of diff.removed) lines.push(`- \`${id}\``);
    lines.push('');
  }

  if (diff.updated.length > 0) {
    lines.push('### Updated Models');
    for (const id of diff.updated) lines.push(`- \`${id}\``);
    lines.push('');
  }

  if (diff.aliasChanges.length > 0) {
    lines.push('### Alias Changes');
    for (const ac of diff.aliasChanges) {
      lines.push(`- \`${ac.model}\`: [${ac.before.join(', ')}] → [${ac.after.join(', ')}]`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
