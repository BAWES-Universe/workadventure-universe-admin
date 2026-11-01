/**
 * The speech companies a person can add a voice key for (#749). A fixed catalog that matches the game's connectors: `adapter` is
 * the name the bot server runs a provider with (lowercase, exactly as the server's own voice providers name it). Free of server
 * code, so the Add a key page and the routes read the same entries.
 *
 * Which of them a person can add is still the super admin's call (lib/voice-keys.ts, voiceKeyCompanies): only a company with at
 * least one enabled server provider is offered, and what it listens and speaks with is what those providers list. Everything
 * else about a company is data here, one entry each, never `if (adapter === ...)` in the logic.
 *
 * `check` is the one free, authenticated call "Load models" makes with a pasted key, to see that the company accepts it. It lists
 * something or returns the account's own details: nothing is transcribed or spoken, so nothing is billed. Chosen from each
 * company's current API reference (Nov 2026):
 * - soniox: GET /v1/models, Authorization: Bearer (documents a 401 for a bad key).
 * - elevenlabs: GET /v1/user, xi-api-key. (GET /v1/models takes the key as optional, so it would answer 200 to a wrong one.) A key
 *   limited to some endpoints is answered 401 "missing_permissions": the company recognised the key, so that counts as accepted.
 * - deepgram: GET /v1/projects, Authorization: Token.
 * - cartesia: GET /voices?limit=1, Authorization: Bearer with the Cartesia-Version header the reference lists.
 */
export interface VoiceKeyCompanyInfo {
  adapter: string;
  label: string;
  /** The provider's logo: a file in `public/ai-providers/` without `.svg`. Absent when we have none; then a chip is drawn. */
  logo?: string;
  /** One line on why you would pick it (on the card in step 1 of Add a key). */
  benefit: string;
  /** How to get a key, one step. */
  step: string;
  /** Where to read about the company and get a key. */
  docs: string;
  check: {
    url: string;
    /** The header the key goes in, and what comes before it there (`Bearer `, `Token `, or nothing). */
    header: string;
    prefix: string;
    /** Other headers the call needs. */
    headers?: Record<string, string>;
    /** An answer that is not a 2xx but still means the company knows the key (a key limited to other endpoints). */
    alsoAccepted?: { status: number; includes: string };
  };
}

export const VOICE_KEY_COMPANIES: VoiceKeyCompanyInfo[] = [
  {
    adapter: 'elevenlabs',
    label: 'ElevenLabs',
    logo: 'elevenlabs',
    benefit: 'Listens and speaks, with thousands of voices.',
    step: 'On elevenlabs.io, open Developers, then API keys, and create a key.',
    docs: 'https://elevenlabs.io/docs',
    check: { url: 'https://api.elevenlabs.io/v1/user', header: 'xi-api-key', prefix: '', alsoAccepted: { status: 401, includes: 'missing_permissions' } },
  },
  {
    adapter: 'deepgram',
    label: 'Deepgram',
    logo: 'deepgram',
    benefit: 'Listens and speaks. Known for fast listening.',
    step: 'On deepgram.com, open API Keys and create a key.',
    docs: 'https://developers.deepgram.com',
    check: { url: 'https://api.deepgram.com/v1/projects', header: 'Authorization', prefix: 'Token ' },
  },
  {
    adapter: 'cartesia',
    label: 'Cartesia',
    benefit: 'Listens and speaks. Known for fast speaking.',
    step: 'On play.cartesia.ai, open API keys and create a key.',
    docs: 'https://docs.cartesia.ai',
    check: { url: 'https://api.cartesia.ai/voices?limit=1', header: 'Authorization', prefix: 'Bearer ', headers: { 'Cartesia-Version': '2026-08-14' } },
  },
  {
    adapter: 'soniox',
    label: 'Soniox',
    benefit: 'Listens. Known for fast, accurate listening in many languages.',
    step: 'On console.soniox.com, open API Keys and create a key.',
    docs: 'https://soniox.com/docs',
    check: { url: 'https://api.soniox.com/v1/models', header: 'Authorization', prefix: 'Bearer ' },
  },
];

export const voiceKeyCompanyInfo = (adapter: unknown): VoiceKeyCompanyInfo | null =>
  VOICE_KEY_COMPANIES.find((entry) => entry.adapter === adapter) ?? null;
