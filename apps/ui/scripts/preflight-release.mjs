#!/usr/bin/env node

/**
 * Pre-build check for build:electron:publish.
 *
 * Fails fast (~1s) if the current package.json version is already published
 * on GitHub, so we don't waste 5+ minutes on a build that will collide with
 * existing release assets.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('❌ GH_TOKEN / GITHUB_TOKEN not set — cannot preflight release.');
  process.exit(1);
}

const publishCfg = Array.isArray(PKG.build?.publish) ? PKG.build.publish[0] : PKG.build?.publish;
if (!publishCfg || publishCfg.provider !== 'github') {
  console.error('❌ Expected a github publish config in package.json build.publish');
  process.exit(1);
}

const { owner, repo } = publishCfg;
const version = PKG.version;
const tag = `v${version}`;

console.log(`🛫 Preflight: checking ${owner}/${repo} for existing release ${tag}...`);

const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

if (res.status === 404) {
  console.log(`✅ No existing release for ${tag} — safe to build.`);
  process.exit(0);
}

if (!res.ok) {
  console.error(`❌ Unexpected GitHub API response: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const release = await res.json();
if (release.draft) {
  console.log(`⚠️  Draft release for ${tag} exists — build will upload to it. Proceeding.`);
  process.exit(0);
}

console.error(`❌ ${tag} is already published at ${release.html_url}`);
console.error(`   Bump the version in apps/ui/package.json before publishing.`);
process.exit(1);
