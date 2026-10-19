import snapshot from '@/lib/ai-key-snapshot.json';

/**
 * What a person can add as an AI key (#374), and how each kind is reached. Free of server code, so the Add a key page
 * and the routes read the same list. Each kind is saved as a provider `type` the bot server already speaks: `lmstudio`
 * for a server on your own computer (it calls `{address}/v1/chat/completions`), `openai` for every hosted one (it calls
 * `{base}/chat/completions`), `anthropic` for Claude (it calls `{base}/messages`), with the kind kept in `settings.kind`.
 *
 * This list is the catalog. There are a few protocols in code (`openai`, and Claude's own `anthropic`) and every provider is one entry of
 * data: where it lives, how a key is sent, how a key and a model are checked, and how a model id is written. A provider's
 * quirks are fields here, never `if (kind === ...)` in the checks, so adding a provider is adding an entry.
 */

/** A catalog id, kept in a key's `settings.kind`. */
export type AiKeyKind = string;

export interface SetupStep {
  text: string;
  /** A command to copy, shown under the step. */
  code?: string;
}

/** The wire format a provider speaks: the OpenAI chat format (most of them), or Claude's own. */
export type KeyProtocol = 'openai' | 'anthropic';
/** How a key is sent: `Authorization: Bearer <key>`, or Claude's `x-api-key` with the API version. */
export type KeyAuth = 'bearer' | 'x-api-key';
/**
 * How a key is proven good when the model list can't. `models`: the model list needs the key, so a list that answers
 * proves it. `key-info`: the list is public (OpenRouter), so the provider's key-info addresses are asked too, and only a
 * clear 401/403 from one counts. `chat`: the list is public and has no key-info address (Vercel AI Gateway), so only a tiny chat
 * reply proves the key: every health check asks for one.
 */
export type KeyCheck = { type: 'models' } | { type: 'key-info'; paths: string[] } | { type: 'chat' };
/** How a model id is written for a chat call: as listed, or without the `models/` the list puts in front (Gemini). */
export type ModelIdRule = 'as-is' | 'strip-models-prefix';
/** Where the Add a key page shows it: by name, under More providers, or not at all. */
export type KeyTier = 'named' | 'more' | 'hidden';

/** One place a provider is served from (Qwen, Kimi and GLM have a Global and a China one, with keys that only work in their own). */
export interface KeyRegion {
  id: string;
  label: string;
  base: string;
}

export interface AiKeyKindInfo {
  kind: AiKeyKind;
  label: string;
  /** On your own computer, or hosted with an API key. */
  group: 'own-computer' | 'hosted';
  /** One line on why you would pick it. */
  benefit: string;
  steps: SetupStep[];
  /** The provider type the bot server uses for it. */
  providerType: 'lmstudio' | 'openai' | 'anthropic';
  /** Own-computer kinds always ask for an address; NVIDIA NIM may (your own NIM). */
  address: 'required' | 'optional' | 'none';
  /** Own-computer kinds only need a key if the server asks for one; hosted ones always do. */
  apiKey: 'required' | 'optional';
  /** Hosted kinds: where the bot server sends chat calls, and the list of models is read from `{base}/models`. */
  base?: string;
  /** Hosted kinds served from more than one place: the person picks one, and its base is used instead of `base`. */
  regions?: KeyRegion[];
  /** Where to read about the provider and get a key. */
  docs?: string;
  /** What this provider calls the reply-length limit on a chat call (OpenAI's newer models refuse `max_tokens`). Default `max_tokens`. */
  tokenLimitField?: 'max_tokens' | 'max_completion_tokens';
  protocol: KeyProtocol;
  auth: KeyAuth;
  /** Typed addresses only: what is saved after the address's name. The bot server calls `{saved}/chat/completions` for `openai`, and adds `/v1` itself for `lmstudio`. */
  typedEndpointSuffix: '' | '/v1';
  keyCheck: KeyCheck;
  modelId: ModelIdRule;
  tier: KeyTier;
  /** The model the Add a key page picks first, when the provider lists it (the one that gets a person started fastest). */
  suggestedModel?: string;
  /** What the provider's docs say about a model when its list says nothing (DeepSeek's list holds ids only). A fact the list does give wins. */
  knownFacts?: Record<string, { tools?: boolean; vision?: boolean; context?: number }>;
}

type Defaulted = 'protocol' | 'auth' | 'typedEndpointSuffix' | 'keyCheck' | 'modelId' | 'tier';

/** One catalog entry. What most providers share is the default, so an entry only says how it differs. */
function define(input: Omit<AiKeyKindInfo, Defaulted> & Partial<Pick<AiKeyKindInfo, Defaulted>>): AiKeyKindInfo {
  return { protocol: 'openai', auth: 'bearer', typedEndpointSuffix: '', keyCheck: { type: 'models' }, modelId: 'as-is', tier: 'named', ...input };
}

const TUNNEL = 'Make it reachable from the web. Run:';

const NAMED_KINDS: AiKeyKindInfo[] = [
  define({
    kind: 'lmstudio', label: 'LM Studio', group: 'own-computer', providerType: 'lmstudio', address: 'required', apiKey: 'optional',
    benefit: 'Free. Runs on your computer, so conversations go only there.',
    steps: [
      { text: 'In LM Studio, load a model and start the server (Developer tab).' },
      { text: TUNNEL, code: 'cloudflared tunnel --url http://localhost:1234' },
      { text: 'Paste the https address it prints below.' },
    ],
  }),
  define({
    kind: 'ollama', label: 'Ollama or llama.cpp', group: 'own-computer', providerType: 'lmstudio', address: 'required', apiKey: 'optional',
    benefit: 'Free, open models like Llama on your computer.',
    steps: [
      { text: 'Start Ollama (port 11434) or llama-server (port 8080).' },
      { text: `${TUNNEL} (use 8080 for llama-server)`, code: 'cloudflared tunnel --url http://localhost:11434' },
      { text: 'Paste the https address it prints below.' },
    ],
  }),
  define({
    kind: 'openrouter', label: 'OpenRouter', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    // Its model list is public, so a wrong key still gets a 200 there: its key-info addresses decide
    keyCheck: { type: 'key-info', paths: ['/key', '/auth/key'] },
    benefit: 'Hundreds of models with one key, some of them free.', base: 'https://openrouter.ai/api/v1',
    steps: [{ text: 'On openrouter.ai, open Keys and create a key.' }],
  }),
  define({
    kind: 'gemini', label: 'Gemini', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    // It lists "models/gemini-flash-latest" but takes "gemini-flash-latest"
    modelId: 'strip-models-prefix',
    benefit: 'Google’s models, with a free tier to start.', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    steps: [{ text: 'On aistudio.google.com, choose Get API key.' }],
  }),
  define({
    kind: 'nim', label: 'NVIDIA NIM', group: 'hosted', providerType: 'openai', address: 'optional', apiKey: 'required',
    // A NIM you run yourself is called at `{address}/v1`, like the hosted one
    typedEndpointSuffix: '/v1',
    benefit: 'Many open models hosted by NVIDIA, free to try. Or your own NIM on your GPU.', base: 'https://integrate.api.nvidia.com/v1',
    steps: [
      { text: 'On build.nvidia.com, open a model and choose Get API key.' },
      { text: 'Running NIM yourself? Put its https address below instead.' },
    ],
  }),
  define({
    kind: 'openai', label: 'OpenAI', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'The GPT models.', base: 'https://api.openai.com/v1', tokenLimitField: 'max_completion_tokens',
    steps: [{ text: 'On platform.openai.com, open API keys.' }],
  }),
  define({
    kind: 'deepseek', label: 'DeepSeek', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Low prices.', base: 'https://api.deepseek.com',
    // Only deepseek-flash takes images (its docs: the Vision guide); V4 Pro does not. So a new key starts on it, with Vision.
    suggestedModel: 'deepseek-flash',
    knownFacts: { 'deepseek-flash': { vision: true }, 'deepseek-v4-pro': { vision: false } },
    steps: [{ text: 'On platform.deepseek.com, open API keys.' }],
  }),
  define({
    kind: 'claude', label: 'Claude', group: 'hosted', providerType: 'anthropic', address: 'none', apiKey: 'required',
    // Claude has its own format: the key goes in x-api-key, chat is /messages, the model list is paged
    protocol: 'anthropic', auth: 'x-api-key',
    benefit: 'Anthropic’s Claude models.', base: 'https://api.anthropic.com/v1', docs: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    steps: [
      { text: 'On console.anthropic.com, open API keys and create a key.' },
      { text: 'Add some credit to the account first: a key with no credit can’t reply.' },
    ],
  }),
  define({
    kind: 'vllm', label: 'vLLM', group: 'own-computer', providerType: 'lmstudio', address: 'required', apiKey: 'optional',
    benefit: 'Your own GPU server, fast for many chats at once.', docs: 'https://docs.vllm.ai',
    steps: [
      { text: 'Start the server with a model (it listens on port 8000).', code: 'vllm serve <model>' },
      { text: TUNNEL, code: 'cloudflared tunnel --url http://localhost:8000' },
      { text: 'Paste the https address it prints below.' },
    ],
  }),
  define({
    kind: 'custom', label: 'Any OpenAI-compatible server', group: 'own-computer', providerType: 'lmstudio', address: 'required', apiKey: 'optional',
    benefit: 'LiteLLM, text-generation-webui, KoboldCpp, your own gateway: anything that answers /v1/chat/completions.',
    steps: [
      { text: 'Start the server. It must answer /v1/models and /v1/chat/completions.' },
      { text: 'Make it reachable from the web, with an https address (a tunnel, or your own domain).' },
      { text: 'Paste the https address below, and a key if the server asks for one.' },
    ],
  }),
  define({
    kind: 'qwen', label: 'Qwen', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Alibaba’s Qwen models.', docs: 'https://www.alibabacloud.com/help/en/model-studio/models',
    regions: [
      { id: 'global', label: 'Global', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      { id: 'china', label: 'China', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    ],
    steps: [{ text: 'In Alibaba Cloud Model Studio, open API keys and create a key. Pick the region you made it in: a key only works in its own.' }],
  }),
  define({
    kind: 'kimi', label: 'Kimi', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Moonshot’s Kimi models.', docs: 'https://platform.moonshot.ai/docs/api/chat',
    regions: [
      { id: 'global', label: 'Global', base: 'https://api.moonshot.ai/v1' },
      { id: 'china', label: 'China', base: 'https://api.moonshot.cn/v1' },
    ],
    steps: [{ text: 'On platform.moonshot.ai (platform.moonshot.cn in China), open API Keys and create one. A key only works in the region it was made in.' }],
  }),
  define({
    kind: 'glm', label: 'GLM (Z.ai)', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Zhipu’s GLM models.', docs: 'https://docs.z.ai/guides/overview/pricing',
    regions: [
      { id: 'global', label: 'Global', base: 'https://api.z.ai/api/paas/v4' },
      { id: 'china', label: 'China', base: 'https://open.bigmodel.cn/api/paas/v4' },
    ],
    steps: [{ text: 'On z.ai (bigmodel.cn in China), open API keys and create one. A key only works in the region it was made in.' }],
  }),
  define({
    kind: 'xai', label: 'xAI', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'The Grok models.', base: 'https://api.x.ai/v1', docs: 'https://docs.x.ai/docs/models',
    steps: [{ text: 'On console.x.ai, open API Keys and create one.' }],
  }),
  define({
    kind: 'mistral', label: 'Mistral', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Mistral’s own models, hosted in Europe.', base: 'https://api.mistral.ai/v1', docs: 'https://docs.mistral.ai/getting-started/models/',
    steps: [{ text: 'On console.mistral.ai, open API keys and create one.' }],
  }),
  define({
    kind: 'groq', label: 'Groq', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Very fast replies, with a free tier.', base: 'https://api.groq.com/openai/v1', docs: 'https://console.groq.com/docs/models',
    steps: [{ text: 'On console.groq.com, open API Keys and create one.' }],
  }),
  define({
    kind: 'together', label: 'Together AI', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Many open models, priced per use.', base: 'https://api.together.xyz/v1', docs: 'https://docs.together.ai/docs/serverless-models',
    steps: [{ text: 'On api.together.ai, open Settings, then API keys.' }],
  }),
  define({
    kind: 'fireworks', label: 'Fireworks AI', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Fast open models, priced per use.', base: 'https://api.fireworks.ai/inference/v1', docs: 'https://fireworks.ai/docs/',
    steps: [{ text: 'On fireworks.ai, open your account’s API Keys and create one.' }],
  }),
  define({
    kind: 'deepinfra', label: 'DeepInfra', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Many open models at low prices.', base: 'https://api.deepinfra.com/v1/openai', docs: 'https://deepinfra.com/models',
    steps: [{ text: 'On deepinfra.com, open Dashboard, then API keys.' }],
  }),
  define({
    kind: 'cerebras', label: 'Cerebras', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Extremely fast replies, with a free tier.', base: 'https://api.cerebras.ai/v1', docs: 'https://inference-docs.cerebras.ai/models/overview',
    steps: [{ text: 'On cloud.cerebras.ai, open API Keys and create one.' }],
  }),
  define({
    kind: 'huggingface', label: 'Hugging Face', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Thousands of open models through one token.', base: 'https://router.huggingface.co/v1', docs: 'https://huggingface.co/docs/inference-providers',
    steps: [{ text: 'On huggingface.co, open Settings, then Access Tokens, and create a token that can make inference calls.' }],
  }),
  define({
    kind: 'vercel', label: 'Vercel AI Gateway', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required', keyCheck: { type: 'chat' },
    benefit: 'Models from many providers behind one key.', base: 'https://ai-gateway.vercel.sh/v1', docs: 'https://vercel.com/docs/ai-gateway',
    steps: [{ text: 'In your Vercel dashboard, open AI Gateway, then API Keys, and create one.' }],
  }),
];

/**
 * More providers, from lib/ai-key-snapshot.json (built by scripts/build-ai-key-snapshot.mjs from the models.dev project).
 * They only differ from each other by name and address, so each is a default entry; the ones listed by hand above win
 * if an id is ever the same.
 */
const NAMED_IDS = new Set(NAMED_KINDS.map((entry) => entry.kind));
const MORE_KINDS: AiKeyKindInfo[] = snapshot.providers
  .filter((provider) => !NAMED_IDS.has(provider.id))
  .map((provider) =>
    define({
      kind: provider.id,
      label: provider.label,
      group: 'hosted',
      providerType: 'openai',
      address: 'none',
      apiKey: 'required',
      benefit: 'Listed by models.dev; we haven’t tried it ourselves.',
      base: provider.base,
      docs: 'docs' in provider ? provider.docs : undefined,
      steps: [{ text: `Create an API key in ${provider.label}’s dashboard.` }],
      tier: 'more',
    }),
  );

export const AI_KEY_KINDS: AiKeyKindInfo[] = [...NAMED_KINDS, ...MORE_KINDS];

export function kindInfo(kind: unknown): AiKeyKindInfo | null {
  return AI_KEY_KINDS.find((entry) => entry.kind === kind) ?? null;
}

/** What is saved as a key's endpoint for an address a person typed (already reduced to its origin). */
export function typedEndpoint(info: AiKeyKindInfo, origin: string): string {
  return `${origin}${info.typedEndpointSuffix}`;
}

/** One model id as the bot server will use it, by the provider's rule. An unknown kind is left as listed. */
export function writeModelId(raw: string, kind: unknown): string {
  const rule = kindInfo(kind)?.modelId ?? 'as-is';
  return (rule === 'strip-models-prefix' ? raw.replace(/^models\//, '') : raw).trim();
}

/** The headers that carry a key, by the provider's way of sending one. No key, no header. */
export function authHeaders(info: AiKeyKindInfo, apiKey: string): Record<string, string> {
  if (!apiKey) return {};
  if (info.auth === 'x-api-key') return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  return { Authorization: `Bearer ${apiKey}` };
}

/** The API version Claude's calls name. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** Where a chat call goes, after the base. */
export function chatPath(info: AiKeyKindInfo): string {
  return info.protocol === 'anthropic' ? '/messages' : '/chat/completions';
}

/** The smallest chat call that gets one reply, in the provider's own format. */
export function chatProbeBody(info: AiKeyKindInfo, model: string): Record<string, unknown> {
  if (info.protocol === 'anthropic') return { model, max_tokens: 32, messages: [{ role: 'user', content: 'Say ok.' }] };
  return { model, messages: [{ role: 'user', content: 'Say ok.' }], stream: false, [info.tokenLimitField ?? 'max_tokens']: 16 };
}

const withoutSlash = (url: string) => url.replace(/\/+$/, '');

/** Every address the provider itself serves from: its one base, or the base of each region. */
export function providerBases(info: AiKeyKindInfo): string[] {
  return [...(info.base ? [info.base] : []), ...(info.regions ?? []).map((region) => region.base)];
}

/** Whether a saved endpoint is an address a person typed (so the address guard applies), not the provider's own. */
export function isTypedEndpoint(info: AiKeyKindInfo | null, endpoint: string | null): boolean {
  if (!info || info.group === 'own-computer' || !endpoint) return true;
  return !providerBases(info).map(withoutSlash).includes(withoutSlash(endpoint));
}

/**
 * Where a hosted kind is served from: its one base, or the region picked. A region is named by its id, or by the base it
 * was saved with (a saved key remembers only its endpoint). A kind with regions and no region is not guessed.
 */
export function hostedBase(info: AiKeyKindInfo, pick: { region?: unknown; address?: unknown }): { ok: true; base: string; region: string | null } | { ok: false; message: string } {
  if (!info.regions) return info.base ? { ok: true, base: info.base, region: null } : { ok: false, message: 'This provider has no address.' };
  const saved = typeof pick.address === 'string' ? withoutSlash(pick.address.trim()) : '';
  const found = info.regions.find((region) => region.id === pick.region) ?? (saved ? info.regions.find((region) => withoutSlash(region.base) === saved) : undefined);
  return found ? { ok: true, base: found.base, region: found.id } : { ok: false, message: 'Pick a region first.' };
}

/** The most keys one person can hold. */
export const MAX_AI_KEYS = 10;
