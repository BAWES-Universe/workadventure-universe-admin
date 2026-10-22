/**
 * What a person can add as an AI key (#374), and how each kind is reached. Free of server code, so the Add a key page
 * and the routes read the same list. Each kind is saved as a provider `type` the bot server already speaks: `lmstudio`
 * for a server on your own computer (it calls `{address}/v1/chat/completions`), `openai` for every hosted one (it calls
 * `{base}/chat/completions`), with the kind kept in `settings.kind`.
 */

export type AiKeyKind = 'lmstudio' | 'ollama' | 'openrouter' | 'gemini' | 'nim' | 'openai' | 'deepseek';

export interface SetupStep {
  text: string;
  /** A command to copy, shown under the step. */
  code?: string;
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
  providerType: 'lmstudio' | 'openai';
  /** Own-computer kinds always ask for an address; NVIDIA NIM may (your own NIM). */
  address: 'required' | 'optional' | 'none';
  /** Own-computer kinds only need a key if the server asks for one; hosted ones always do. */
  apiKey: 'required' | 'optional';
  /** Hosted kinds: where the bot server sends chat calls, and the list of models is read from `{base}/models`. */
  base?: string;
}

const TUNNEL = 'Make it reachable from the web. Run:';

export const AI_KEY_KINDS: AiKeyKindInfo[] = [
  {
    kind: 'lmstudio', label: 'LM Studio', group: 'own-computer', providerType: 'lmstudio', address: 'required', apiKey: 'optional',
    benefit: 'Free. Runs on your computer, so conversations go only there.',
    steps: [
      { text: 'In LM Studio, load a model and start the server (Developer tab).' },
      { text: TUNNEL, code: 'cloudflared tunnel --url http://localhost:1234' },
      { text: 'Paste the https address it prints below.' },
    ],
  },
  {
    kind: 'ollama', label: 'Ollama or llama.cpp', group: 'own-computer', providerType: 'lmstudio', address: 'required', apiKey: 'optional',
    benefit: 'Free, open models like Llama on your computer.',
    steps: [
      { text: 'Start Ollama (port 11434) or llama-server (port 8080).' },
      { text: `${TUNNEL} (use 8080 for llama-server)`, code: 'cloudflared tunnel --url http://localhost:11434' },
      { text: 'Paste the https address it prints below.' },
    ],
  },
  {
    kind: 'openrouter', label: 'OpenRouter', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Hundreds of models with one key, some of them free.', base: 'https://openrouter.ai/api/v1',
    steps: [{ text: 'On openrouter.ai, open Keys and create a key.' }],
  },
  {
    kind: 'gemini', label: 'Gemini', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Google’s models, with a free tier to start.', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    steps: [{ text: 'On aistudio.google.com, choose Get API key.' }],
  },
  {
    kind: 'nim', label: 'NVIDIA NIM', group: 'hosted', providerType: 'openai', address: 'optional', apiKey: 'required',
    benefit: 'Many open models hosted by NVIDIA, free to try. Or your own NIM on your GPU.', base: 'https://integrate.api.nvidia.com/v1',
    steps: [
      { text: 'On build.nvidia.com, open a model and choose Get API key.' },
      { text: 'Running NIM yourself? Put its https address below instead.' },
    ],
  },
  {
    kind: 'openai', label: 'OpenAI', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'The GPT models.', base: 'https://api.openai.com/v1',
    steps: [{ text: 'On platform.openai.com, open API keys.' }],
  },
  {
    kind: 'deepseek', label: 'DeepSeek', group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required',
    benefit: 'Low prices.', base: 'https://api.deepseek.com',
    steps: [{ text: 'On platform.deepseek.com, open API keys.' }],
  },
];

export function kindInfo(kind: unknown): AiKeyKindInfo | null {
  return AI_KEY_KINDS.find((entry) => entry.kind === kind) ?? null;
}

/** The most keys one person can hold. */
export const MAX_AI_KEYS = 10;
