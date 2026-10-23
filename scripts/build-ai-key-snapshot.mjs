#!/usr/bin/env node
/**
 * Rebuilds lib/ai-key-snapshot.json, the "More providers" on the Add a key page (#374).
 *
 * It reads each provider's file from the models.dev project (providers/<id>/provider.toml), keeps the ones that speak the
 * OpenAI chat format at a plain https address, and writes the few facts the page needs: id, name, address, docs.
 * Providers the page already names by hand (Qwen, Kimi, Mistral, ...) are not listed again. Run it when you want new
 * providers: `node scripts/build-ai-key-snapshot.mjs`. It needs raw.githubusercontent.com and models.dev; edit IDS to add or
 * drop one.
 *
 * For each provider it also keeps what the Add a key page says under the name (how many models, how many are open, how many
 * are free: read from models.dev's api.json) and its logo (`public/ai-providers/<id>.svg`, only when it is one colour, so
 * it can take the page's ink). A logo that models.dev lacks can be added to that folder by hand and is picked up here.
 * Set MODELS_DEV_API to a local file to read the provider data from there instead of the web.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPlainSvg } from './plain-svg.mjs';

const SOURCE = 'https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers';
const LOGOS = fileURLToPath(new URL('../public/ai-providers/', import.meta.url));

/** models.dev's api.json: every provider with its models (a local file when MODELS_DEV_API is set). */
async function readApi() {
  const where = process.env.MODELS_DEV_API;
  const text = where ? readFileSync(where, 'utf8') : await (await fetch('https://models.dev/api.json')).text();
  const api = JSON.parse(text);
  return api.providers ?? api;
}

/** The numbers the line under a provider's name is made of. */
function modelFacts(provider) {
  const models = Object.values(provider?.models ?? {});
  return {
    models: models.length,
    open: models.filter((model) => model.open_weights === true).length,
    free: models.filter((model) => model.cost?.input === 0 && model.cost?.output === 0).length,
  };
}

/** Keeps a provider's logo when it is one colour (it uses currentColor) and plain shapes only, so it can be drawn in the page's ink. */
async function keepLogo(id) {
  const file = `${LOGOS}${id}.svg`;
  if (!existsSync(file)) {
    const response = await fetch(`${SOURCE}/${id}/logo.svg`);
    if (!response.ok) return false;
    const svg = await response.text();
    if (!isPlainSvg(svg) || !svg.includes('currentColor')) return false;
    // Written aside and renamed, so an interrupted run never leaves a half-written logo that the next run would trust.
    const partial = `${file}.partial`;
    writeFileSync(partial, svg);
    renameSync(partial, file);
  }
  return true;
}

const IDS = [
  '302ai', 'baseten', 'berget', 'chutes', 'cortecs', 'fastrouter', 'helicone', 'inference', 'io-net', 'llama', 'llmgateway',
  'lucidquery', 'modelscope', 'morph', 'nano-gpt', 'nebius', 'novita-ai', 'ollama-cloud', 'opencode', 'ovhcloud', 'requesty',
  'sambanova', 'scaleway', 'siliconflow', 'siliconflow-cn', 'stackit', 'synthetic', 'upstage', 'vultr', 'wandb', 'xiaomi', 'zenmux',
];

/** `key = "value"` lines at the top level of a provider.toml. */
function field(toml, key) {
  const match = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : null;
}

const api = await readApi();
mkdirSync(LOGOS, { recursive: true });
const providers = [];
for (const id of IDS) {
  const response = await fetch(`${SOURCE}/${id}/provider.toml`);
  if (!response.ok) {
    console.warn(`skip ${id}: ${response.status}`);
    continue;
  }
  const toml = await response.text();
  const name = field(toml, 'name');
  const apiUrl = field(toml, 'api');
  const npm = field(toml, 'npm') ?? '';
  const doc = field(toml, 'doc');
  // Only the OpenAI chat format, at a fixed https address (a ${...} in it means the address needs an account id)
  if (!name || !apiUrl || !npm.includes('openai-compatible') || !apiUrl.startsWith('https://') || apiUrl.includes('$')) {
    console.warn(`skip ${id}: not an OpenAI-format provider at a fixed https address`);
    continue;
  }
  providers.push({
    id,
    label: name,
    base: apiUrl.replace(/\/+$/, ''),
    ...(doc && doc.startsWith('https://') ? { docs: doc } : {}),
    ...modelFacts(api[id]),
    ...((await keepLogo(id)) ? { logo: true } : {}),
  });
}

providers.sort((a, b) => a.label.localeCompare(b.label));
const out = fileURLToPath(new URL('../lib/ai-key-snapshot.json', import.meta.url));
writeFileSync(out, `${JSON.stringify({ source: 'models.dev', generatedAt: new Date().toISOString().slice(0, 10), providers }, null, 2)}\n`);
console.log(`wrote ${providers.length} providers to ${out}`);
