#!/usr/bin/env node

/**
 * Promotes the GitHub Release that electron-builder just created from
 * draft → published + latest. Runs as the final step of build:electron:publish.
 *
 * Reads version from apps/ui/package.json, finds the matching draft release
 * for owner/repo from the electron-builder publish config, and flips draft:false.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('❌ GH_TOKEN / GITHUB_TOKEN not set — cannot promote release.');
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
const api = `https://api.github.com/repos/${owner}/${repo}/releases`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

console.log(`🚀 Promoting release ${tag} for ${owner}/${repo}...`);

const listRes = await fetch(api, { headers });
if (!listRes.ok) {
  console.error(`❌ Failed to list releases: ${listRes.status} ${await listRes.text()}`);
  process.exit(1);
}
const releases = await listRes.json();
const target = releases.find((r) => r.tag_name === tag);

if (!target) {
  console.error(`❌ No release found with tag ${tag}`);
  process.exit(1);
}

if (!target.draft) {
  console.log(`✅ Release ${tag} already published: ${target.html_url}`);
  process.exit(0);
}

const patchRes = await fetch(`${api}/${target.id}`, {
  method: 'PATCH',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ draft: false, make_latest: 'true', tag_name: tag }),
});

if (!patchRes.ok) {
  console.error(`❌ Failed to promote release: ${patchRes.status} ${await patchRes.text()}`);
  process.exit(1);
}

const published = await patchRes.json();
console.log(`✅ Released ${tag}: ${published.html_url}`);
