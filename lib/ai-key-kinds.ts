/**
 * What a person can add as an AI key (#374), and how each kind is reached. Free of server code, so the Add a key page
 * and the routes read the same list. Each kind is saved as a provider `type` the bot server already speaks: `lmstudio`
 * for a server on your own computer (it calls `{address}/v1/chat/completions`), `openai` for every hosted one (it calls
 * `{base}/chat/completions`), with the kind kept in `settings.kind`.
 *
 * This list is the catalog. There are a few protocols in code (only `openai` for now) and every provider is one entry of
 * data: where it lives, how a key is sent, how a key and a model are checked, and how a model id is written. A provider's
 * quirks are fields here, never `if (kind === ...)` in the checks, so adding a provider is adding an entry.
 */

export type AiKeyKind = 'lmstudio' | 'ollama' | 'openrouter' | 'gemini' | 'nim' | 'openai' | 'deepseek';

export interface SetupStep {
  text: string;
  /** A command to copy, shown under the step. */
  code?: string;
}

/** The wire format a provider speaks. Only the OpenAI chat format is built; Claude's own format comes with #975. */
export type KeyProtocol = 'openai';
/** How a key is sent: `Authorization: Bearer <key>`. */
export type KeyAuth = 'bearer';
/**
 * How a key is proven good when the model list can't. `models`: the model list needs the key, so a list that answers
 * proves it. `key-info`: the list is public (OpenRouter), so the provider's key-info addresses are asked too, and only a
 * clear 401/403 from one counts.
 */
export type KeyCheck = { type: 'models' } | { type: 'key-info'; paths: string[] };
/** How a model id is written for a chat call: as listed, or without the `models/` the list puts in front (Gemini). */
export type ModelIdRule = 'as-is' | 'strip-models-prefix';
/** Where the Add a key page shows it: by name, under More providers, or not at all. */
export type KeyTier = 'named' | 'more' | 'hidden';

export interface AiKeyKindInfo {
  kind: AiKeyKind;
  label: string;
  /** On your own computer, or hosted with an API key. */
  group: 'own-computer' | 'hosted';
  /** One line on why you would pick it. */
  benefit: string;
  steps: SetupStep[];
  /** The provider type the bot server uses for it. */
  providerType: 'lmstudio' | 'openai';
  /** Own-computer kinds always ask for an address; NVIDIA NIM may (your own NIM). */
  address: 'required' | 'optional' | 'none';
  /** Own-computer kinds only need a key if the server asks for one; hosted ones always do. */
  apiKey: 'required' | 'optional';
  /** Hosted kinds: where the bot server sends chat calls, and the list of models is read from `{base}/models`. */
  base?: string;
  /** What this provider calls the reply-length limit on a chat call (OpenAI's newer models refuse `max_tokens`). Default `max_tokens`. */
  tokenLimitField?: 'max_tokens' | 'max_completion_tokens';
  protocol: KeyProtocol;
  auth: KeyAuth;
  /** Typed addresses only: what is saved after the address's name. The bot server calls `{saved}/chat/completions` for `openai`, and adds `/v1` itself for `lmstudio`. */
  typedEndpointSuffix: '' | '/v1';
  keyCheck: KeyCheck;
  modelId: ModelIdRule;
  tier: KeyTier;
}

type Defaulted = 'protocol' | 'auth' | 'typedEndpointSuffix' | 'keyCheck' | 'modelId' | 'tier';

/** One catalog entry. What most providers share is the default, so an entry only says how it differs. */
function define(input: Omit<AiKeyKindInfo, Defaulted> & Partial<Pick<AiKeyKindInfo, Defaulted>>): AiKeyKindInfo {
  return { protocol: 'openai', auth: 'bearer', typedEndpointSuffix: '', keyCheck: { type: 'models' }, modelId: 'as-is', tier: 'named', ...input };
}

const TUNNEL = 'Make it reachable from the web. Run:';

export const AI_KEY_KINDS: AiKeyKindInfo[] = [
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
    steps: [{ text: 'On platform.deepseek.com, open API keys.' }],
  }),
];

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
  return { Authorization: `Bearer ${apiKey}` };
}

/** Whether a saved endpoint is an address a person typed (so the address guard applies), not the provider's own. */
export function isTypedEndpoint(info: AiKeyKindInfo | null, endpoint: string | null): boolean {
  return !info || info.group === 'own-computer' || endpoint !== info.base;
}

/** The most keys one person can hold. */
export const MAX_AI_KEYS = 10;
