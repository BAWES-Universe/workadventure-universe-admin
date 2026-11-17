#!/usr/bin/env node
// Command line for prune-images.mjs: reads one package from GitHub and its registry, prints the plan,
// and deletes only when --live is given.
//
//   node prune-images-cli.mjs --package play-universe --prod-branch universe --dev-branch universe-develop [--keep 10] [--live] [--closed-branch <head ref>]
//
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), and, to protect what dev and production run now (optional):
//   DEV_COOLIFY_BASE, DEV_COOLIFY_TOKEN, DEV_APPS and PROD_COOLIFY_BASE, PROD_COOLIFY_TOKEN, PROD_APPS ("<package> <uuid>" per line).
import { appendFileSync } from 'node:fs';
import { DEFAULT_KEEP, isProtectedBranch, prunePackage, sanitizeBranch, tagRules } from './prune-images.mjs';

function parseArgs(argv) {
  const out = { live: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') out.live = true;
    else if (arg.startsWith('--')) out[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
for (const required of ['package', 'prodBranch', 'devBranch']) {
  if (!args[required]) {
    console.error(`missing --${required.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`);
    process.exit(2);
  }
}
const keep = args.keep === undefined ? DEFAULT_KEEP : Number(args.keep);
if (!Number.isInteger(keep) || keep < 1) {
  console.error(`--keep must be a whole number of at least 1, got: ${args.keep}`);
  process.exit(2);
}
const token = process.env.GITHUB_TOKEN;
const [owner, repo] = String(process.env.GITHUB_REPOSITORY ?? '').split('/');
if (!token || !owner || !repo) {
  console.error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  process.exit(2);
}
const packageName = args.package;
const packagePath = `/orgs/${owner}/packages/container/${encodeURIComponent(packageName)}`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';
const github = (path, init = {}) => fetch(`${apiBase}${path}`, { ...init, headers: { ...headers, ...init.headers } });

async function pages(path) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const response = await github(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}: ${(await response.text()).slice(0, 200)}`);
    const items = await response.json();
    all.push(...items);
    if (items.length < 100) return all;
  }
}

async function registryToken() {
  const response = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${owner.toLowerCase()}/${packageName}:pull`, {
    headers: { Authorization: `Basic ${Buffer.from(`${owner}:${token}`).toString('base64')}` },
  });
  if (!response.ok) throw new Error(`the registry refused a pull token (${response.status})`);
  return (await response.json()).token;
}

let cachedRegistryToken;
const api = {
  listVersions: () => pages(`${packagePath}/versions`),
  // Branches that still have an open PR, tagged the way their images are.
  openBranches: async () => {
    const open = await pages(`/repos/${owner}/${repo}/pulls?state=open`);
    return new Set(open.map((pull) => sanitizeBranch(pull.head.ref)));
  },
  // The tags dev and production run for this package, read from Coolify. An environment with no server configured runs nothing.
  runningTags: async () => {
    const tags = new Set();
    for (const side of ['DEV', 'PROD']) {
      const base = process.env[`${side}_COOLIFY_BASE`];
      const coolifyToken = process.env[`${side}_COOLIFY_TOKEN`];
      const apps = String(process.env[`${side}_APPS`] ?? '')
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([name, uuid]) => name === packageName && uuid);
      if (!coolifyToken || !base || apps.length === 0) {
        console.log(`${packageName}: no ${side.toLowerCase()} server to ask, so no build is protected there.`);
        continue;
      }
      for (const [, uuid] of apps) {
        const response = await fetch(`${base}/api/v1/applications/${uuid}`, { headers: { Authorization: `Bearer ${coolifyToken}` }, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Coolify answered ${response.status} when asked which build ${side.toLowerCase()} runs for ${packageName}; nothing was deleted`);
        const tag = (await response.json()).docker_registry_image_tag;
        if (!tag) throw new Error(`Coolify gave no image tag for ${packageName} on ${side.toLowerCase()}; nothing was deleted`);
        tags.add(tag);
        console.log(`${packageName}: ${side.toLowerCase()} runs ${tag}`);
      }
    }
    return tags;
  },
  // The digests an image points to (its platform images and attestations).
  children: async (version) => {
    cachedRegistryToken ??= await registryToken();
    const response = await fetch(`https://ghcr.io/v2/${owner.toLowerCase()}/${packageName}/manifests/${version.name}`, {
      headers: {
        Authorization: `Bearer ${cachedRegistryToken}`,
        Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
      },
    });
    if (!response.ok) throw new Error(`the registry answered ${response.status}`);
    const manifest = await response.json();
    return (manifest.manifests ?? []).map((entry) => entry.digest);
  },
  deleteVersion: async (version) => {
    const response = await github(`${packagePath}/versions/${version.id}`, { method: 'DELETE' });
    if (response.status === 404) return; // already gone
    if (!response.ok) {
      const hint = response.status === 403 ? ` Give this repository the Write role under the package's "Manage Actions access" (package settings) and run it again.` : '';
      throw new Error(`could not delete version ${version.id} of ${packageName}: GitHub answered ${response.status}.${hint}`);
    }
  },
};

const lines = [];
const log = (line) => {
  console.log(line);
  lines.push(line);
};

const rules = tagRules({ prodBranch: args.prodBranch, devBranch: args.devBranch });
if (args.closedBranch && isProtectedBranch(rules, args.closedBranch)) {
  console.log(`${packageName}: the PR came from ${args.closedBranch}, which is the dev or production branch, so no images are cleared.`);
  process.exit(0);
}

try {
  await prunePackage({
    api,
    rules,
    packageName,
    keep,
    live: args.live,
    closedBranch: args.closedBranch || undefined,
    log,
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${packageName}${args.live ? '' : ' (dry run)'}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
  }
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
