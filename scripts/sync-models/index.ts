#!/usr/bin/env tsx
/**
 * Model Registry Sync — Entry Point
 *
 * Usage:
 *   pnpm sync-models              # Run all adapters (local + ci)
 *   pnpm sync-models --ci         # Run only ci-tier adapters (used in GitHub Actions)
 *   pnpm sync-models --dry-run    # Fetch and compute diff without writing files
 *   pnpm sync-models --all-adapters  # Force all adapters regardless of tier (same as default)
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   - Required for anthropic adapter
 *   OPENAI_API_KEY      - Required for openai adapter
 *   GOOGLE_API_KEY      - Required for google adapter
 *   GITHUB_TOKEN        - Required for copilot adapter
 *   SYNC_MODELS_TTL_DAYS - Freshness TTL in days (default: 30)
 */

import { runSync } from './engine.js';
import { anthropicAdapter } from './adapters/anthropic.js';
import { openaiAdapter } from './adapters/openai.js';
import { googleAdapter } from './adapters/google.js';
import { copilotAdapter } from './adapters/copilot.js';
import { cursorAdapter } from './adapters/cursor.js';
import { opencodeAdapter } from './adapters/opencode.js';
import type { ProviderAdapter } from './types.js';

const args = process.argv.slice(2);

const ciOnly = args.includes('--ci');
const dryRun = args.includes('--dry-run');
const ttlDays = parseInt(process.env.SYNC_MODELS_TTL_DAYS ?? '30', 10);

const adapters: ProviderAdapter[] = [
  anthropicAdapter,
  openaiAdapter,
  googleAdapter,
  copilotAdapter,
  cursorAdapter,
  opencodeAdapter,
];

console.log(`\n🔄 Model Registry Sync`);
console.log(`   CI mode: ${ciOnly}`);
console.log(`   Dry run: ${dryRun}`);
console.log(`   Freshness TTL: ${ttlDays} days\n`);

runSync(adapters, { ciOnly, dryRun, ttlDays }).catch((err) => {
  console.error(`\n❌ Sync failed: ${(err as Error).message}`);
  process.exit(1);
});
