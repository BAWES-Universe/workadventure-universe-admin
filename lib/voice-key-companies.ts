/**
 * The speech companies a person can add a voice key for (#749). A fixed catalog that matches the game's connectors: `adapter` is
 * the name the bot server runs a provider with (lowercase, exactly as the server's own voice providers name it). Free of server
 * code, so the Add a key page and the routes read the same entries.
 *
 * Which of them a person can add is still the super admin's call (lib/voice-keys.ts, voiceKeyCompanies): only a company with at
 * least one enabled server provider is offered, and what it listens and speaks with is what those providers list. Everything
 * else about a company is data here, one entry each, never `if (adapter === ...)` in the logic.
 *
 * `models` is where a company lists its models (GET, the same key header): Soniox GET /v1/models (real-time ones), Deepgram GET
 * /v1/models (streaming listening ones), ElevenLabs GET /v1/models (speaking ones), Cartesia GET /models?capability=tts. Fish Audio
 * has no such list, so its models are typed.
 *
 * `check` is the one free, authenticated call "Load models" makes with a pasted key, to see that the company accepts it. It lists
 * something or returns the account's own details: nothing is transcribed or spoken, so nothing is billed. Chosen from each
 * company's current API reference (Nov 2026):
 * - soniox: GET /v1/models, Authorization: Bearer (documents a 401 for a bad key).
 * - elevenlabs: GET /v1/user, xi-api-key. (GET /v1/models takes the key as optional, so it would answer 200 to a wrong one.) A key
 *   limited to some endpoints is answered 401 "missing_permissions": the company recognised the key, so that counts as accepted.
 * - deepgram: GET /v1/projects, Authorization: Token. A key without projects:read (scoped to other jobs) is answered 403, not
 *   401: Deepgram knows the key, so that counts as accepted. A wrong key is 401.
 * - cartesia: GET /voices?limit=1, Authorization: Bearer with the Cartesia-Version header the reference lists.
 * - fish: GET /wallet/self/api-credit, Authorization: Bearer. Free (it reads the account's API credit, nothing is generated). A
 *   free account with no credit still has the answer, and that is fine: the free model needs none.
 */
export interface VoiceKeyCompanyInfo {
  adapter: string;
  label: string;
  /** The provider's logo: a file in `public/ai-providers/` without `.svg`. Absent when we have none; then a chip is drawn. */
  logo?: string;
  /**
   * One neutral line on its card (step 1 of Add a key and New voice provider): what it does here and where its account is, the same
   * shape for every company. No company is ranked or praised over another: every company competes on its own offer, and whoever
   * runs the server picks. `{does}` is filled in from what Universe's own providers of this company do ("Listens and speaks",
   * "Listens" or "Speaks"), so the line never claims a job Universe can't run.
   */
  benefit: string;
  /** How to get a key, one step. */
  step: string;
  /** Where to read about the company and get a key. */
  docs: string;
  /**
   * Where the company lists its models, read with the same key header as `check` (free: nothing is heard or spoken). Absent for a
   * company with no list (Fish Audio picks its model by name only), so its models are typed. `list` is the field holding the list
   * (none: the answer is the list), `id` and `label` the fields of one model, and `where` what a model must say to be one Universe
   * can run for the company's job (real-time listening, or speaking).
   */
  models?: {
    /** The job the listed models do in Universe (the game's connector for this company does only that one). */
    kind: 'recognition' | 'speech';
    url: string;
    list?: string;
    id: string;
    label?: string;
    where?: Record<string, string | boolean>;
  };
  check: {
    url: string;
    /** The header the key goes in, and what comes before it there (`Bearer `, `Token `, or nothing). */
    header: string;
    prefix: string;
    /** Other headers the call needs. */
    headers?: Record<string, string>;
    /**
     * An answer that is not a 2xx but still means the company knows the key (a key limited to other endpoints): that status,
     * and when `includes` is given, only with that text in the answer.
     */
    alsoAccepted?: { status: number; includes?: string };
  };
}

// In alphabetical order by name, so the list ranks no company over another
export const VOICE_KEY_COMPANIES: VoiceKeyCompanyInfo[] = [
  {
    adapter: 'cartesia',
    label: 'Cartesia',
    benefit: '{does}. Uses your account at cartesia.ai.',
    step: 'On play.cartesia.ai, open API keys and create a key.',
    docs: 'https://docs.cartesia.ai',
    models: { kind: 'speech', url: 'https://api.cartesia.ai/models?capability=tts', list: 'data', id: 'id', where: { capability: 'tts' } },
    check: { url: 'https://api.cartesia.ai/voices?limit=1', header: 'Authorization', prefix: 'Bearer ', headers: { 'Cartesia-Version': '2026-08-14' } },
  },
  {
    adapter: 'deepgram',
    label: 'Deepgram',
    logo: 'deepgram',
    benefit: '{does}. Uses your account at deepgram.com.',
    step: 'On deepgram.com, open API Keys and create a key.',
    docs: 'https://developers.deepgram.com',
    models: { kind: 'recognition', url: 'https://api.deepgram.com/v1/models', list: 'stt', id: 'canonical_name', where: { streaming: true } },
    check: { url: 'https://api.deepgram.com/v1/projects', header: 'Authorization', prefix: 'Token ', alsoAccepted: { status: 403 } },
  },
  {
    adapter: 'elevenlabs',
    label: 'ElevenLabs',
    logo: 'elevenlabs',
    benefit: '{does}. Uses your account at elevenlabs.io.',
    step: 'On elevenlabs.io, open Developers, then API keys, and create a key.',
    docs: 'https://elevenlabs.io/docs',
    models: { kind: 'speech', url: 'https://api.elevenlabs.io/v1/models', id: 'model_id', label: 'name', where: { can_do_text_to_speech: true } },
    check: { url: 'https://api.elevenlabs.io/v1/user', header: 'xi-api-key', prefix: '', alsoAccepted: { status: 401, includes: 'missing_permissions' } },
  },
  {
    adapter: 'fish',
    label: 'Fish Audio',
    logo: 'fish-audio',
    benefit: '{does}. Uses your account at fish.audio.',
    step: 'On fish.audio, open API Keys and create a key.',
    docs: 'https://docs.fish.audio',
    check: { url: 'https://api.fish.audio/wallet/self/api-credit', header: 'Authorization', prefix: 'Bearer ' },
  },
  {
    adapter: 'soniox',
    label: 'Soniox',
    benefit: '{does}. Uses your account at soniox.com.',
    step: 'On console.soniox.com, open API Keys and create a key.',
    docs: 'https://soniox.com/docs',
    models: { kind: 'recognition', url: 'https://api.soniox.com/v1/models', list: 'models', id: 'id', label: 'name', where: { transcription_mode: 'real_time' } },
    check: { url: 'https://api.soniox.com/v1/models', header: 'Authorization', prefix: 'Bearer ' },
  },
];

export const voiceKeyCompanyInfo = (adapter: unknown): VoiceKeyCompanyInfo | null =>
  VOICE_KEY_COMPANIES.find((entry) => entry.adapter === adapter) ?? null;

/** What a company's line says it does, from the jobs Universe's own providers of it run. */
export const voiceDoesLine = ({ recognition, speech }: { recognition: boolean; speech: boolean }) =>
  recognition && speech ? 'Listens and speaks' : recognition ? 'Listens' : 'Speaks';
