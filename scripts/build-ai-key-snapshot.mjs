#!/usr/bin/env node
/**
 * Rebuilds lib/ai-key-snapshot.json, the "More providers" on the Add a key page (#374).
 *
 * It reads each provider's file from the models.dev project (providers/<id>/provider.toml), keeps the ones that speak the
 * OpenAI chat format at a plain https address, and writes the few facts the page needs: id, name, address, docs.
 * Providers the page already names by hand (Qwen, Kimi, Mistral, ...) are not listed again. Run it when you want new
 * providers: `node scripts/build-ai-key-snapshot.mjs`. It needs raw.githubusercontent.com; edit IDS to add or drop one.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers';

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

const providers = [];
for (const id of IDS) {
  const response = await fetch(`${SOURCE}/${id}/provider.toml`);
  if (!response.ok) {
    console.warn(`skip ${id}: ${response.status}`);
    continue;
  }
  const toml = await response.text();
  const name = field(toml, 'name');
  const api = field(toml, 'api');
  const npm = field(toml, 'npm') ?? '';
  const doc = field(toml, 'doc');
  // Only the OpenAI chat format, at a fixed https address (a ${...} in it means the address needs an account id)
  if (!name || !api || !npm.includes('openai-compatible') || !api.startsWith('https://') || api.includes('$')) {
    console.warn(`skip ${id}: not an OpenAI-format provider at a fixed https address`);
    continue;
  }
  providers.push({ id, label: name, base: api.replace(/\/+$/, ''), ...(doc && doc.startsWith('https://') ? { docs: doc } : {}) });
}

providers.sort((a, b) => a.label.localeCompare(b.label));
const out = fileURLToPath(new URL('../lib/ai-key-snapshot.json', import.meta.url));
writeFileSync(out, `${JSON.stringify({ source: 'models.dev', generatedAt: new Date().toISOString().slice(0, 10), providers }, null, 2)}\n`);
console.log(`wrote ${providers.length} providers to ${out}`);
