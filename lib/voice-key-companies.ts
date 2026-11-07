/**
 * The speech companies a person can add a voice key for (#749). A fixed catalog that matches the game's connectors: `adapter` is
 * the name the bot server runs a provider with (lowercase, exactly as the server's own voice providers name it). Free of server
 * code, so the Add a key page and the routes read the same entries.
 *
 * Every company here is offered to everyone, with no setup by a super admin (lib/voice-keys.ts, voiceKeyCompanies): what it does
 * (`does`) and the models a key starts with (`models`) are data in its entry. If the server has its own provider for a company
 * switched on (the one Universe AI runs on), that provider's job and model list are used instead of the entry's models, so an
 * operator can keep them current without a deploy. Everything else about a company is data here, one entry each, never
 * `if (adapter === ...)` in the logic.
 *
 * `modelList` is where a company lists its models (GET, the same key header): Soniox GET /v1/models (real-time ones), Deepgram GET
 * /v1/models (streaming listening ones), ElevenLabs GET /v1/models (speaking ones), Cartesia GET /models?capability=tts. Fish Audio
 * has no such list, so its models are typed on New voice provider.
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
/** A model a key can be used with, as the bot server calls it. The first one of a job is the one a bot starts on. */
export interface VoiceKeyCompanyModel {
  id: string;
  label: string;
  kind: 'recognition' | 'speech';
}

export interface VoiceKeyCompanyInfo {
  adapter: string;
  label: string;
  /** What the game's connector for this company does: listens, speaks, or both. */
  does: { recognition: boolean; speech: boolean };
  /**
   * The models a key for this company starts with, checked against the company's own docs on 7 Nov 2026. Used when the server
   * has no provider of its own for the company with models listed.
   */
  models: VoiceKeyCompanyModel[];
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
   * Where the company lists its models, read with the same key header as `check` (free: nothing is heard or spoken), so a super
   * admin ticks models on New voice provider instead of typing ids. Absent for a company with no list (Fish Audio picks its model by
   * name only). `list` is the field holding the list (none: the answer is the list), `id` and `label` the fields of one model, and
   * `where` what a model must say to be one Universe can run for the company's job (real-time listening, or speaking).
   */
  modelList?: {
    url: string;
    list?: string;
    id: string;
    label?: string;
    where?: Record<string, string | boolean>;
    /** Fields that help a person choose, shown under the model (never saved): the model it always points to, the languages it covers, the company's own description of it. */
    aliasOf?: string;
    languages?: string;
    about?: string;
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
    does: { recognition: false, speech: true },
    // sonic-3.6 follows Cartesia's latest stable snapshot
    models: [{ id: 'sonic-3.6', label: 'Sonic 3.6', kind: 'speech' }],
    benefit: '{does}. Uses your account at cartesia.ai.',
    step: 'On play.cartesia.ai, open API keys and create a key.',
    docs: 'https://docs.cartesia.ai',
    modelList: { url: 'https://api.cartesia.ai/models?capability=tts', list: 'data', id: 'id', where: { capability: 'tts' }, languages: 'supported_languages' },
    check: { url: 'https://api.cartesia.ai/voices?limit=1', header: 'Authorization', prefix: 'Bearer ', headers: { 'Cartesia-Version': '2026-08-14' } },
  },
  {
    adapter: 'deepgram',
    label: 'Deepgram',
    does: { recognition: true, speech: false },
    models: [{ id: 'nova-3', label: 'Nova 3', kind: 'recognition' }],
    logo: 'deepgram',
    benefit: '{does}. Uses your account at deepgram.com.',
    step: 'On deepgram.com, open API Keys and create a key.',
    docs: 'https://developers.deepgram.com',
    modelList: { url: 'https://api.deepgram.com/v1/models', list: 'stt', id: 'canonical_name', where: { streaming: true }, languages: 'languages' },
    check: { url: 'https://api.deepgram.com/v1/projects', header: 'Authorization', prefix: 'Token ', alsoAccepted: { status: 403 } },
  },
  {
    adapter: 'elevenlabs',
    label: 'ElevenLabs',
    does: { recognition: false, speech: true },
    // eleven_v4_turbo: ElevenLabs' recommended real-time model, served over its Text to Dialogue socket (game #1848)
    models: [
      { id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo', kind: 'speech' },
      { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5', kind: 'speech' },
    ],
    logo: 'elevenlabs',
    benefit: '{does}. Uses your account at elevenlabs.io.',
    step: 'On elevenlabs.io, open Developers, then API keys, and create a key.',
    docs: 'https://elevenlabs.io/docs',
    modelList: { url: 'https://api.elevenlabs.io/v1/models', id: 'model_id', label: 'name', where: { can_do_text_to_speech: true }, languages: 'languages', about: 'description' },
    check: { url: 'https://api.elevenlabs.io/v1/user', header: 'xi-api-key', prefix: '', alsoAccepted: { status: 401, includes: 'missing_permissions' } },
  },
  {
    adapter: 'fish',
    label: 'Fish Audio',
    does: { recognition: false, speech: true },
    // s2.1-pro-free costs nothing (fair use, no speed guarantee); s2.1-pro is billed by Fish per byte of text
    models: [
      { id: 's2.1-pro-free', label: 'S2.1 Pro (free)', kind: 'speech' },
      { id: 's2.1-pro', label: 'S2.1 Pro', kind: 'speech' },
    ],
    logo: 'fish-audio',
    benefit: '{does}. Uses your account at fish.audio.',
    step: 'On fish.audio, open API Keys and create a key.',
    docs: 'https://docs.fish.audio',
    check: { url: 'https://api.fish.audio/wallet/self/api-credit', header: 'Authorization', prefix: 'Bearer ' },
  },
  {
    adapter: 'soniox',
    label: 'Soniox',
    does: { recognition: true, speech: false },
    // stt-rt-v6: stt-rt-v5 is removed on 15 Dec 2026 and stt-rt-v4 is only its alias
    models: [{ id: 'stt-rt-v6', label: 'Soniox real-time v6', kind: 'recognition' }],
    benefit: '{does}. Uses your account at soniox.com.',
    step: 'On console.soniox.com, open API Keys and create a key.',
    docs: 'https://soniox.com/docs',
    modelList: { url: 'https://api.soniox.com/v1/models', list: 'models', id: 'id', label: 'name', where: { transcription_mode: 'real_time' }, aliasOf: 'aliased_model_id', languages: 'languages' },
    check: { url: 'https://api.soniox.com/v1/models', header: 'Authorization', prefix: 'Bearer ' },
  },
];

export const voiceKeyCompanyInfo = (adapter: unknown): VoiceKeyCompanyInfo | null =>
  VOICE_KEY_COMPANIES.find((entry) => entry.adapter === adapter) ?? null;

/** What a company's line says it does, from the jobs Universe's own providers of it run. */
export const voiceDoesLine = ({ recognition, speech }: { recognition: boolean; speech: boolean }) =>
  recognition && speech ? 'Listens and speaks' : recognition ? 'Listens' : 'Speaks';
