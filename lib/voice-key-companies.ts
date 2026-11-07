/**
 * The speech companies a person can add a voice key for (#749). A fixed catalog that matches the game's connectors: `adapter` is
 * the name the bot server runs a provider with (lowercase, exactly as the server's own voice providers name it). Free of server
 * code, so the Add a key page and the routes read the same entries.
 *
 * Every company here is offered to everyone, with no setup by a super admin (lib/voice-keys.ts, voiceKeyCompanies). One entry per
 * company carries everything about it (Orbit #844): each job it does (`jobs.recognition`, `jobs.speech`) with its own host, the
 * models a key starts with, where it lists models and where it lists voices. What it does (`does`) and its starting models
 * (`models`) follow from its jobs. If the server has its own provider for a company switched on (the one Universe AI runs on), that
 * provider's jobs and model list are used instead of the entry's models, so an operator can keep them current without a deploy.
 * Adding a company, or a job to one, is one entry here plus its connector in the game, never `if (adapter === ...)` in the logic.
 *
 * `modelList` is where a company lists a job's models (GET, the same key header): Soniox GET /v1/models (real-time ones), Deepgram
 * GET /v1/models (streaming listening ones), ElevenLabs GET /v1/models (speaking ones), Cartesia GET /models?capability=stt|tts. Fish
 * Audio has no such list, so its models are typed on New voice provider. `voices` is where a speaking job lists its voices
 * (lib/voice-voices.ts reads every company's the same way).
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
 * - assemblyai: GET /v2/transcript?limit=1, Authorization with the key as it is (no Bearer). It lists the account's own past
 *   transcripts: nothing is transcribed. A wrong key is 401.
 * - async: POST /voices with { limit: 1 }, x-api-key and version: v1. It lists voices: nothing is spoken. A wrong key is 401.
 * - bland: GET /v1/voices, Authorization: Bearer. It lists voices: nothing is spoken.
 * - camb: GET /apis/list-voices, x-api-key. It lists voices: nothing is spoken.
 * - fal: GET https://api.fal.ai/v1/account/billing, Authorization: Key. Free (it reads the account's name). A key without the
 *   billing permission (the usual API key) is answered 403, not 401: fal knows the key, so that counts as accepted.
 * - gladia: GET /v2/live?limit=1, x-gladia-key. It lists the account's past live sessions: nothing is transcribed. A wrong key is 401.
 * - gradium: GET /api/usages/credits, x-api-key. Free (it reads the account's credit), nothing is generated.
 * - groq: GET /openai/v1/models, Authorization: Bearer. It lists models: nothing is run. A wrong key is 401.
 * - fish: GET /wallet/self/api-credit, Authorization: Bearer. Free (it reads the account's API credit, nothing is generated). A
 *   free account with no credit still has the answer, and that is fine: the free model needs none.
 */
/** A model a key can be used with, as the bot server calls it. The first one of a job is the one a bot starts on. */
export interface VoiceKeyCompanyModel {
  id: string;
  label: string;
  kind: 'recognition' | 'speech';
}

/**
 * A job a company does in Universe, named as the bot server's providers name it. Each is its own entry under `jobs`, so another
 * (a talking model that listens and speaks in one, game #1910) joins as one more key there.
 */
export type VoiceCompanyJobName = 'recognition' | 'speech';

/**
 * Where a company lists its models for one job, read with the same key header as `check` (free: nothing is heard or spoken), so a
 * super admin ticks models on New voice provider instead of typing ids. `list` is the field holding the list (none: the answer is
 * the list), `id` and `label` the fields of one model, and `where` what a model must say to be one Universe can run for this job.
 */
export interface VoiceModelListSpec {
  url: string;
  list?: string;
  id: string;
  label?: string;
  where?: Record<string, string | boolean>;
  /** Fields that help a person choose, shown under the model (never saved): the model it always points to, the languages it covers, the company's own description of it. */
  aliasOf?: string;
  languages?: string;
  about?: string;
}

/**
 * Where a company lists its voices, read page by page at its own address with the key (free). Field names are paths into one voice:
 * `a.b` is a field inside a field, `a[].b` that field of every entry of a list. A company with no list has no `voices`; its voice id
 * is typed.
 */
export interface VoiceListSpec {
  /** Path and query of one page, after the company's address. `{size}` is the page size, `{page}` the page number when paging by number. */
  path: string;
  /** Set when the company lists its voices with a POST: this JSON body, a `'{size}'` value being the page size (Async). */
  body?: Record<string, unknown>;
  /** The field holding the voices, or '' when the answer is the list itself (CAMB.AI). */
  list: string;
  /**
   * How the next page is asked for: a token the answer gives (`token`) or the last voice's id (`after`), sent as `param`, while
   * `more` says there is more; or a page number (`page`, from 1, in the path) while `more` says so, or, when the company doesn't
   * say, while a page is full. `none`: the whole list comes in one answer.
   */
  paging: { kind: 'token' | 'after'; param: string; next: string; more: string } | { kind: 'page'; more?: string } | { kind: 'none' };
  /** Asked one after the other, each added to `path` (Fish: the person's own voices, then the public library). A voice met twice is kept once. */
  passes?: string[];
  /** A voice is kept only when each of these fields, when the company sends it, has this value. */
  keep?: Record<string, string>;
  /** The field holding a voice's id: text, or a whole number kept as its digits (CAMB.AI). */
  id: string;
  name: string;
  /** The first of these that says something: a field, or several fields joined with commas. */
  description: (string | { join: string[] })[];
  /** Fields holding language codes or locales ("en", "ar-KW"). */
  languages: string[];
  /** The field holding a sample's address. */
  preview?: string;
  /** The sample is served only with the key: then it must be at the company's own address, and is fetched through Orbit. */
  previewNeedsKey?: boolean;
}

/** A company with no voice list to ask (Groq): its voices as its own docs name them, the same for every key. */
export interface FixedVoices {
  fixed: { id: string; name: string; description?: string; languages: string[] }[];
}

/** One job a company does: its own address for it, the models a key starts with, and where it lists models and voices. */
export interface VoiceCompanyJob {
  /** The company's own host for this job, as the bot server calls it when no address is typed. */
  host: string;
  /** The models a key starts with, checked against the company's own docs on 7 Nov 2026. The first is the one a bot starts on. */
  models: { id: string; label: string }[];
  modelList?: VoiceModelListSpec;
  /** Speaking only. */
  voices?: VoiceListSpec | FixedVoices;
}

/** One company, everything about it in one place. */
export interface VoiceKeyCompanyEntry {
  adapter: string;
  label: string;
  /** What the game's connectors for this company do, one entry per job. */
  jobs: Partial<Record<VoiceCompanyJobName, VoiceCompanyJob>>;
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
  check: {
    url: string;
    /** The header the key goes in, and what comes before it there (`Bearer `, `Token `, or nothing). */
    header: string;
    prefix: string;
    /** Other headers the call needs. */
    headers?: Record<string, string>;
    /** Set when the free call is a POST (a list asked for with a body, as Async's voices are): this JSON body. */
    body?: Record<string, unknown>;
    /**
     * An answer that is not a 2xx but still means the company knows the key (a key limited to other endpoints): that status,
     * and when `includes` is given, only with that text in the answer.
     */
    alsoAccepted?: { status: number; includes?: string };
  };
}

/** A company with what follows from its jobs filled in: what it does, and every job's starting models with their kind. */
export interface VoiceKeyCompanyInfo extends VoiceKeyCompanyEntry {
  does: { recognition: boolean; speech: boolean };
  /** Every job's starting models, listening first. Used when the server has no provider of its own for the company with models listed. */
  models: VoiceKeyCompanyModel[];
}

/** The jobs in the order they are shown and listed. */
export const VOICE_COMPANY_JOBS: VoiceCompanyJobName[] = ['recognition', 'speech'];

const company = (entry: VoiceKeyCompanyEntry): VoiceKeyCompanyInfo => ({
  ...entry,
  does: { recognition: Boolean(entry.jobs.recognition), speech: Boolean(entry.jobs.speech) },
  models: VOICE_COMPANY_JOBS.flatMap((kind) => (entry.jobs[kind]?.models ?? []).map((model) => ({ ...model, kind }))),
});

// In alphabetical order by name, so the list ranks no company over another
export const VOICE_KEY_COMPANIES: VoiceKeyCompanyInfo[] = [
  company({
    adapter: 'assemblyai',
    label: 'AssemblyAI',
    jobs: {
      recognition: {
        // Universal Streaming (/v3/ws). AssemblyAI has no model list, so its streaming models are typed; universal-3-6-pro is its default
        host: 'streaming.assemblyai.com',
        models: [
          { id: 'universal-3-6-pro', label: 'Universal-3.6 Pro' },
          { id: 'universal-streaming-multilingual', label: 'Universal Streaming Multilingual' },
          { id: 'universal-streaming-english', label: 'Universal Streaming English' },
        ],
      },
    },
    benefit: '{does}. Uses your account at assemblyai.com.',
    step: 'On assemblyai.com, open your dashboard, then API Keys, and copy a key.',
    docs: 'https://www.assemblyai.com/docs',
    check: { url: 'https://api.assemblyai.com/v2/transcript?limit=1', header: 'Authorization', prefix: '' },
  }),
  company({
    adapter: 'async',
    label: 'Async',
    jobs: {
      speech: {
        // Text to speech over a socket. Async has no model list, so its models are typed. async_flash_v1.0 covers the most
        // languages (Arabic among them); async_flash_v1.5 and async_pro_v1.0 cover fewer (https://docs.async.com/models-2161359m0)
        host: 'api.async.com',
        models: [
          { id: 'async_flash_v1.0', label: 'Async Flash v1.0' },
          { id: 'async_flash_v1.5', label: 'Async Flash v1.5' },
          { id: 'async_pro_v1.0', label: 'Async Pro v1.0' },
        ],
        // POST /voices with a page size. Its next-page cursor isn't documented, so the first 100 are listed; any other voice id is typed
        voices: {
          path: '/voices',
          body: { limit: '{size}' },
          list: 'voices',
          paging: { kind: 'none' },
          id: 'voice_id',
          name: 'name',
          description: ['description', { join: ['gender', 'language'] }],
          languages: ['language'],
        },
      },
    },
    benefit: '{does}. Uses your account at async.com.',
    step: 'On async.com, open your account settings, then API keys, and create a key.',
    docs: 'https://docs.async.com',
    check: { url: 'https://api.async.com/voices', header: 'x-api-key', prefix: '', headers: { version: 'v1' }, body: { limit: 1 } },
  }),
  company({
    adapter: 'bland',
    label: 'Bland',
    jobs: {
      speech: {
        // Text to speech, one streamed request per reply (POST /v2/tts). A Bland voice sets its own model, so the model here
        // only names the family; Bland has no model list a key can read for free (https://docs.bland.ai/tts/voices)
        host: 'api.bland.ai',
        models: [
          { id: 'btts-3', label: 'Bland TTS v3' },
          { id: 'btts-2', label: 'Bland TTS v2' },
        ],
        // GET /v1/voices: Bland's built-in voices, the account's own clones, and library voices it added, in one answer
        voices: {
          path: '/v1/voices',
          list: 'voices',
          paging: { kind: 'none' },
          id: 'id',
          name: 'name',
          description: ['description', 'tags[]'],
          languages: [],
        },
      },
    },
    benefit: '{does}. Uses your account at bland.ai.',
    step: 'On app.bland.ai, open Settings, then API keys, and copy your key.',
    docs: 'https://docs.bland.ai/tts/welcome',
    check: { url: 'https://api.bland.ai/v1/voices', header: 'Authorization', prefix: 'Bearer ' },
  }),
  company({
    adapter: 'camb',
    label: 'CAMB.AI',
    jobs: {
      speech: {
        // Text to speech, one streamed request per reply (POST /apis/tts-stream). CAMB.AI has no model list, so its models are
        // typed, from its own SDK (camb-sdk 1.6.6): MARS Flash, Pro and Instruct. Its 62 languages include Kuwaiti Arabic (ar-kw)
        host: 'client.camb.ai',
        models: [
          { id: 'mars-flash', label: 'MARS Flash' },
          { id: 'mars-pro', label: 'MARS Pro' },
          { id: 'mars-instruct', label: 'MARS Instruct' },
        ],
        // GET /apis/list-voices: the account's voices and CAMB.AI's own, all in one answer that is the list itself
        voices: {
          path: '/apis/list-voices',
          list: '',
          paging: { kind: 'none' },
          id: 'id',
          name: 'voice_name',
          description: ['description'],
          languages: [],
        },
      },
    },
    benefit: '{does}. Uses your account at camb.ai.',
    step: 'On studio.camb.ai, open your account settings, then API, and create a key.',
    docs: 'https://docs.camb.ai',
    check: { url: 'https://client.camb.ai/apis/list-voices', header: 'x-api-key', prefix: '' },
  }),
  company({
    adapter: 'cartesia',
    label: 'Cartesia',
    jobs: {
      recognition: {
        host: 'api.cartesia.ai',
        // ink-whisper: the one that takes a language; ink-2 and newer detect it
        models: [{ id: 'ink-whisper', label: 'Ink Whisper' }],
        modelList: { url: 'https://api.cartesia.ai/models?capability=stt', list: 'data', id: 'id', where: { capability: 'stt' } },
      },
      speech: {
        host: 'api.cartesia.ai',
        // sonic-3.6 follows Cartesia's latest stable snapshot
        models: [{ id: 'sonic-3.6', label: 'Sonic 3.6' }],
        modelList: { url: 'https://api.cartesia.ai/models?capability=tts', list: 'data', id: 'id', where: { capability: 'tts' }, languages: 'supported_languages' },
        // GET /voices, 100 a page, `starting_after` the last id while `has_more`. A sample is only served with the key.
        voices: {
          path: '/voices?limit={size}&expand%5B%5D=preview_file_url',
          list: 'data',
          paging: { kind: 'after', param: 'starting_after', next: 'next_page', more: 'has_more' },
          id: 'id',
          name: 'name',
          description: ['description', 'tagline'],
          languages: ['language', 'accents[].locale'],
          preview: 'preview_file_url',
          previewNeedsKey: true,
        },
      },
    },
    benefit: '{does}. Uses your account at cartesia.ai.',
    step: 'On play.cartesia.ai, open API keys and create a key.',
    docs: 'https://docs.cartesia.ai',
    check: { url: 'https://api.cartesia.ai/voices?limit=1', header: 'Authorization', prefix: 'Bearer ', headers: { 'Cartesia-Version': '2026-08-14' } },
  }),
  company({
    adapter: 'deepgram',
    label: 'Deepgram',
    jobs: {
      recognition: {
        host: 'api.deepgram.com',
        models: [{ id: 'nova-3', label: 'Nova 3' }],
        modelList: { url: 'https://api.deepgram.com/v1/models', list: 'stt', id: 'canonical_name', where: { streaming: true }, languages: 'languages' },
      },
      speech: {
        host: 'api.deepgram.com',
        // A Deepgram voice is its own model (aura-2-thalia-en): the game sends the voice picked, and the model names its family
        models: [{ id: 'aura-2', label: 'Aura 2' }],
        // GET /v1/models: every voice in one answer, each with its languages and a public sample
        voices: {
          path: '/v1/models',
          list: 'tts',
          paging: { kind: 'none' },
          id: 'canonical_name',
          name: 'name',
          description: [{ join: ['metadata.accent', 'metadata.age', 'metadata.tags[]'] }],
          languages: ['languages[]'],
          preview: 'metadata.sample',
        },
      },
    },
    logo: 'deepgram',
    benefit: '{does}. Uses your account at deepgram.com.',
    step: 'On deepgram.com, open API Keys and create a key.',
    docs: 'https://developers.deepgram.com',
    check: { url: 'https://api.deepgram.com/v1/projects', header: 'Authorization', prefix: 'Token ', alsoAccepted: { status: 403 } },
  }),
  company({
    adapter: 'elevenlabs',
    label: 'ElevenLabs',
    jobs: {
      recognition: {
        host: 'api.elevenlabs.io',
        // Scribe v2 Realtime: ElevenLabs' real-time listening model. Its model list (GET /v1/models) holds speaking models only, so
        // listening models are typed
        models: [{ id: 'scribe_v2_realtime', label: 'Scribe v2 Realtime' }],
      },
      speech: {
        host: 'api.elevenlabs.io',
        // eleven_v4_turbo: ElevenLabs' recommended real-time model, served over its Text to Dialogue socket (game #1848)
        models: [
          { id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo' },
          { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5' },
        ],
        modelList: { url: 'https://api.elevenlabs.io/v1/models', id: 'model_id', label: 'name', where: { can_do_text_to_speech: true }, languages: 'languages', about: 'description' },
        // GET /v2/voices, 100 a page, `next_page_token` while `has_more`. A voice's sample is a public address.
        voices: {
          path: '/v2/voices?page_size={size}',
          list: 'voices',
          paging: { kind: 'token', param: 'next_page_token', next: 'next_page_token', more: 'has_more' },
          id: 'voice_id',
          name: 'name',
          // The company's own description, else what it labels the voice with
          description: ['description', { join: ['labels.descriptive', 'labels.accent', 'labels.gender', 'labels.age'] }],
          languages: ['verified_languages[].language', 'verified_languages[].locale', 'labels.language'],
          preview: 'preview_url',
        },
      },
    },
    logo: 'elevenlabs',
    benefit: '{does}. Uses your account at elevenlabs.io.',
    step: 'On elevenlabs.io, open Developers, then API keys, and create a key.',
    docs: 'https://elevenlabs.io/docs',
    check: { url: 'https://api.elevenlabs.io/v1/user', header: 'xi-api-key', prefix: '', alsoAccepted: { status: 401, includes: 'missing_permissions' } },
  }),
  company({
    adapter: 'fal',
    label: 'fal',
    jobs: {
      recognition: {
        // Hearing by upload: each stretch of speech is sent as one file to fal's Whisper apps, as Pipecat's FalSTTService does.
        // A model is the fal app it goes to. Wizper is fal's faster Whisper large v3 (https://fal.ai/models/fal-ai/wizper)
        host: 'fal.run',
        models: [
          { id: 'fal-ai/wizper', label: 'Wizper (Whisper large v3)' },
          { id: 'fal-ai/whisper', label: 'Whisper' },
        ],
      },
    },
    benefit: '{does}. Uses your account at fal.ai.',
    step: 'On fal.ai, open your dashboard, then Keys, and create a key.',
    docs: 'https://fal.ai/docs',
    check: { url: 'https://api.fal.ai/v1/account/billing', header: 'Authorization', prefix: 'Key ', alsoAccepted: { status: 403 } },
  }),
  company({
    adapter: 'fish',
    label: 'Fish Audio',
    jobs: {
      speech: {
        host: 'api.fish.audio',
        // s2.1-pro-free costs nothing (fair use, no speed guarantee); s2.1-pro is billed by Fish per byte of text. Fish has no model list.
        models: [
          { id: 's2.1-pro-free', label: 'S2.1 Pro (free)' },
          { id: 's2.1-pro', label: 'S2.1 Pro' },
        ],
        // GET /model, 100 a page: the person's own voices first, then the public library by score. Only a voice that speaks and is
        // finished training is kept. A sample is a public address, so the key never goes with it.
        voices: {
          path: '/model?page_size={size}&page_number={page}&sort_by=score',
          passes: ['self=true', 'self=false'],
          list: 'items',
          paging: { kind: 'page', more: 'has_more' },
          keep: { type: 'tts', state: 'trained' },
          id: '_id',
          name: 'title',
          description: ['description'],
          languages: ['languages[]'],
          preview: 'samples[].audio',
        },
      },
    },
    logo: 'fish-audio',
    benefit: '{does}. Uses your account at fish.audio.',
    step: 'On fish.audio, open API Keys and create a key.',
    docs: 'https://docs.fish.audio',
    check: { url: 'https://api.fish.audio/wallet/self/api-credit', header: 'Authorization', prefix: 'Bearer ' },
  }),
  company({
    adapter: 'gladia',
    label: 'Gladia',
    jobs: {
      recognition: {
        // Live speech to text (POST /v2/live for a session, then its socket). Solaria-1 is Gladia's only live model
        // (https://docs.gladia.io/api-reference/v2/live/init)
        host: 'api.gladia.io',
        models: [{ id: 'solaria-1', label: 'Solaria-1' }],
      },
    },
    benefit: '{does}. Uses your account at gladia.io.',
    step: 'On app.gladia.io, open API keys and create a key.',
    docs: 'https://docs.gladia.io',
    check: { url: 'https://api.gladia.io/v2/live?limit=1', header: 'x-gladia-key', prefix: '' },
  }),
  company({
    adapter: 'gradium',
    label: 'Gradium',
    jobs: {
      recognition: {
        // Live speech to text over a socket (/api/speech/asr). "default" is Gradium's current model
        // (https://docs.gradium.ai/api-reference/endpoint/stt-websocket). It hears English, French, German, Spanish and Portuguese
        host: 'api.gradium.ai',
        models: [{ id: 'default', label: 'Gradium (current)' }],
      },
      speech: {
        // Text to speech over a socket (/api/speech/tts). "default" is the current model; "gradium-tts-beta" follows its betas
        host: 'api.gradium.ai',
        models: [
          { id: 'default', label: 'Gradium TTS (current)' },
          { id: 'gradium-tts-beta', label: 'Gradium TTS beta' },
        ],
        // GET /api/voices/ with the catalog: the account's own voices first, then Gradium's, in one answer that is the list itself
        voices: {
          path: '/api/voices/?include_catalog=true&limit=1000',
          list: '',
          paging: { kind: 'none' },
          id: 'uid',
          name: 'name',
          description: ['description', 'tags[].value'],
          languages: ['language'],
        },
      },
    },
    benefit: '{does}. Uses your account at gradium.ai.',
    step: 'On gradium.ai, open your account, then API keys, and create a key.',
    docs: 'https://docs.gradium.ai',
    check: { url: 'https://api.gradium.ai/api/usages/credits', header: 'x-api-key', prefix: '' },
  }),
  company({
    adapter: 'groq',
    label: 'Groq',
    jobs: {
      recognition: {
        // Hearing by upload: each stretch of speech is sent as one file to Groq's Whisper (/openai/v1/audio/transcriptions), as
        // Pipecat's GroqSTTService does (https://console.groq.com/docs/speech-to-text)
        host: 'api.groq.com',
        models: [
          { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' },
          { id: 'whisper-large-v3', label: 'Whisper Large v3' },
        ],
      },
      speech: {
        // Text to speech (/openai/v1/audio/speech) with Canopy Labs' Orpheus: one model for English, one for Saudi Arabic
        // (https://console.groq.com/docs/text-to-speech/orpheus). A voice belongs to one of them, and the game uses its model
        host: 'api.groq.com',
        models: [
          { id: 'canopylabs/orpheus-v1-english', label: 'Orpheus English' },
          { id: 'canopylabs/orpheus-arabic-saudi', label: 'Orpheus Arabic (Saudi)' },
        ],
        // Groq has no voice list to ask: these are the voices its Orpheus page names
        voices: {
          fixed: [
            ...['Autumn', 'Diana', 'Hannah', 'Austin', 'Daniel', 'Troy'].map((name) => ({ id: name.toLowerCase(), name, description: 'Orpheus English', languages: ['en'] })),
            ...['Abdullah', 'Fahad', 'Sultan', 'Lulwa', 'Noura', 'Aisha'].map((name) => ({ id: name.toLowerCase(), name, description: 'Orpheus Arabic (Saudi)', languages: ['ar'] })),
          ],
        },
      },
    },
    benefit: '{does}. Uses your account at groq.com.',
    step: 'On console.groq.com, open API Keys and create a key.',
    docs: 'https://console.groq.com/docs/speech-to-text',
    check: { url: 'https://api.groq.com/openai/v1/models', header: 'Authorization', prefix: 'Bearer ' },
  }),
  company({
    adapter: 'soniox',
    label: 'Soniox',
    jobs: {
      recognition: {
        host: 'stt-rt.soniox.com',
        // stt-rt-v6: stt-rt-v5 is removed on 15 Dec 2026 and stt-rt-v4 is only its alias
        models: [{ id: 'stt-rt-v6', label: 'Soniox real-time v6' }],
        modelList: { url: 'https://api.soniox.com/v1/models', list: 'models', id: 'id', label: 'name', where: { transcription_mode: 'real_time' }, aliasOf: 'aliased_model_id', languages: 'languages' },
      },
    },
    benefit: '{does}. Uses your account at soniox.com.',
    step: 'On console.soniox.com, open API Keys and create a key.',
    docs: 'https://soniox.com/docs',
    check: { url: 'https://api.soniox.com/v1/models', header: 'Authorization', prefix: 'Bearer ' },
  }),
];

export const voiceKeyCompanyInfo = (adapter: unknown): VoiceKeyCompanyInfo | null =>
  VOICE_KEY_COMPANIES.find((entry) => entry.adapter === adapter) ?? null;

/** What a company's line says it does, from the jobs Universe's own providers of it run. */
export const voiceDoesLine = ({ recognition, speech }: { recognition: boolean; speech: boolean }) =>
  recognition && speech ? 'Listens and speaks' : recognition ? 'Listens' : 'Speaks';

/** The jobs a company does, in the order they are shown. */
export const companyJobs = (info: Pick<VoiceKeyCompanyEntry, 'jobs'>): VoiceCompanyJobName[] => VOICE_COMPANY_JOBS.filter((job) => info.jobs[job]);

/** The company's own host for a job (its first job when none is named), as the bot server calls it when no address is typed. */
export const companyHost = (adapter: string, job?: VoiceCompanyJobName): string | undefined => {
  const info = voiceKeyCompanyInfo(adapter);
  if (!info) return undefined;
  return info.jobs[job ?? companyJobs(info)[0]]?.host;
};
