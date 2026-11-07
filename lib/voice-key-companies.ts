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
 * GET /v1/models (streaming listening ones), ElevenLabs GET /v1/models (speaking ones), Cartesia GET /models?capability=stt|tts, Soniox
 * GET /v1/tts-models (speaking ones). Fish
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
 * - fish: GET /wallet/self/api-credit, Authorization: Bearer. Free (it reads the account's API credit, nothing is generated). A
 *   free account with no credit still has the answer, and that is fine: the free model needs none.
 * - azure: GET {address}/openai/v1/models on the person's own resource, api-key.
 * - google: GET /v1beta/models, x-goog-api-key (a wrong key is 400 API_KEY_INVALID).
 * - openai: GET /v1/models, Authorization: Bearer.
 * - xai: GET /v1/tts/voices, Authorization: Bearer (lists the built-in voices; a wrong key is 401).
 */
/** A model a key can be used with, as the bot server calls it. The first one of a job is the one a bot starts on. */
export interface VoiceKeyCompanyModel {
  id: string;
  label: string;
  kind: VoiceCompanyJobName;
}

/**
 * A job a company does in Universe, named as the bot server's providers name it. Each is its own entry under `jobs`.
 *
 * `talk` is a talking model (game #1910): one live model that listens and speaks in one, in place of a company that listens and
 * one that speaks. The bot's own Mind still writes every answer: the talking model hears the person, and says the answer the Mind
 * wrote in the voice the bot's maker picked. A bot on one names it for both listening and speaking (see `talksLive`).
 */
export type VoiceCompanyJobName = 'recognition' | 'speech' | 'talk';

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
  /** The field holding the voices; `a[].b[]` gathers them from inside a list (Soniox lists voices inside each model). */
  list: string;
  /** The host voices are listed at, when it isn't the job's own (Soniox speaks at tts-rt.soniox.com, lists at api.soniox.com). */
  host?: string;
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

/** A voice a company offers but has no list call for (OpenAI's talking voices): the same for every key. */
export interface FixedVoice {
  id: string;
  name: string;
}

/** One job a company does: its own address for it, the models a key starts with, and where it lists models and voices. */
export interface VoiceCompanyJob {
  /** The company's own host for this job, as the bot server calls it when no address is typed. */
  host: string;
  /** The models a key starts with, checked against the company's own docs on 7 Nov 2026. The first is the one a bot starts on. */
  models: { id: string; label: string }[];
  modelList?: VoiceModelListSpec;
  /** Speaking and talking only. */
  voices?: VoiceListSpec;
  /** Speaking and talking only, for a company with no list call: its voices, in the order the company's own docs list them. */
  fixedVoices?: FixedVoice[];
}

/**
 * What a key needs besides the key, for a company whose keys live at the person's own address (Azure: their resource), with the
 * model named as they deployed it. Each is one more field on Add a key, in its own words.
 */
export interface VoiceKeyAccount {
  /**
   * The address of the person's own account. Only an https address on one of `hosts` (host endings) is taken, so the key only
   * ever goes to the company. It is kept as its origin (scheme and host), the address the bot server calls.
   */
  address?: { label: string; example: string; hint: string; hosts: string[] };
  /** The model is typed, as the person named it at the company (Azure: the deployment name), for this job. */
  typedModel?: { title: string; label: string; hint: string; kind: VoiceCompanyJobName };
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
  account?: VoiceKeyAccount;
  check: {
    /** `{address}` stands for the person's own address, for a company with one (`account.address`). */
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
    /** An answer other than 401 or 403 that still means the key is wrong (Google: 400 with API_KEY_INVALID), only with that text. */
    alsoRefused?: { status: number; includes: string };
  };
}

/** A company with what follows from its jobs filled in: what it does, and every job's starting models with their kind. */
export interface VoiceKeyCompanyInfo extends VoiceKeyCompanyEntry {
  does: { recognition: boolean; speech: boolean; talk: boolean };
  /** Every job's starting models, listening first. Used when the server has no provider of its own for the company with models listed. */
  models: VoiceKeyCompanyModel[];
}

/** The jobs in the order they are shown and listed. */
export const VOICE_COMPANY_JOBS: VoiceCompanyJobName[] = ['recognition', 'speech', 'talk'];

const company = (entry: VoiceKeyCompanyEntry): VoiceKeyCompanyInfo => ({
  ...entry,
  does: { recognition: Boolean(entry.jobs.recognition), speech: Boolean(entry.jobs.speech), talk: Boolean(entry.jobs.talk) },
  models: VOICE_COMPANY_JOBS.flatMap((kind) => (entry.jobs[kind]?.models ?? []).map((model) => ({ ...model, kind }))),
});

/** xAI's built-in voices, Eve (its default) first, then as its text to speech docs list them. Every one speaks every language. */
const XAI_VOICES: FixedVoice[] = [
  { id: 'eve', name: 'Eve' },
  { id: 'ara', name: 'Ara' },
  { id: 'leo', name: 'Leo' },
  { id: 'rex', name: 'Rex' },
  { id: 'sal', name: 'Sal' },
  { id: 'carina', name: 'Carina' },
  { id: 'zagan', name: 'Zagan' },
  { id: 'helix', name: 'Helix' },
  { id: 'orion', name: 'Orion' },
  { id: 'luna', name: 'Luna' },
  { id: 'iris', name: 'Iris' },
  { id: 'altair', name: 'Altair' },
  { id: 'zenith', name: 'Zenith' },
  { id: 'perseus', name: 'Perseus' },
  { id: 'helios', name: 'Helios' },
  { id: 'lux', name: 'Lux' },
  { id: 'kepler', name: 'Kepler' },
  { id: 'rigel', name: 'Rigel' },
  { id: 'cosmo', name: 'Cosmo' },
  { id: 'celeste', name: 'Celeste' },
  { id: 'ursa', name: 'Ursa' },
  { id: 'sirius', name: 'Sirius' },
  { id: 'lumen', name: 'Lumen' },
  { id: 'castor', name: 'Castor' },
  { id: 'naksh', name: 'Naksh' },
  { id: 'atlas', name: 'Atlas' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'liora', name: 'Liora' },
];

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
    adapter: 'azure',
    label: 'Azure OpenAI',
    jobs: {
      talk: {
        // The person's own resource address is always typed (`account.address`): there is no one host for every key
        host: 'openai.azure.com',
        // Typed: an Azure model is called by the name it was deployed under
        models: [],
        // The same realtime voices as OpenAI's, from Azure's realtime docs
        fixedVoices: [
          { id: 'marin', name: 'Marin' },
          { id: 'cedar', name: 'Cedar' },
          { id: 'alloy', name: 'Alloy' },
          { id: 'ash', name: 'Ash' },
          { id: 'ballad', name: 'Ballad' },
          { id: 'coral', name: 'Coral' },
          { id: 'echo', name: 'Echo' },
          { id: 'sage', name: 'Sage' },
          { id: 'shimmer', name: 'Shimmer' },
          { id: 'verse', name: 'Verse' },
        ],
      },
    },
    benefit: '{does}. Uses your Azure OpenAI resource.',
    step: 'In the Azure portal, open your Azure OpenAI resource, deploy gpt-realtime-2.1 or gpt-realtime-2.1-mini, then copy Key 1 and the Endpoint from Keys and Endpoint.',
    docs: 'https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-websockets',
    account: {
      address: {
        label: 'Endpoint',
        example: 'https://your-resource.openai.azure.com',
        hint: 'From Keys and Endpoint on your resource. It ends in openai.azure.com, cognitiveservices.azure.com or services.ai.azure.com.',
        hosts: ['.openai.azure.com', '.cognitiveservices.azure.com', '.services.ai.azure.com'],
      },
      typedModel: {
        title: 'Name its deployment',
        label: 'Deployment name',
        hint: 'The name you gave the gpt-realtime deployment, as Azure shows it under Deployments.',
        kind: 'talk',
      },
    },
    // GET /openai/v1/models on the person's own resource: free, and a wrong key is 401
    check: { url: '{address}/openai/v1/models', header: 'api-key', prefix: '' },
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
    adapter: 'google',
    label: 'Google',
    jobs: {
      talk: {
        host: 'generativelanguage.googleapis.com',
        // From Google's Live API docs (7 Nov 2026): the older live models shut on 17 Nov 2026
        models: [{ id: 'gemini-3.8-live', label: 'Gemini 3.8 Live' }],
        // Google has no call that lists live voices: these are the 30 prebuilt voices its speech docs list, in that order
        fixedVoices: [
          { id: 'Zephyr', name: 'Zephyr' },
          { id: 'Puck', name: 'Puck' },
          { id: 'Charon', name: 'Charon' },
          { id: 'Kore', name: 'Kore' },
          { id: 'Fenrir', name: 'Fenrir' },
          { id: 'Leda', name: 'Leda' },
          { id: 'Orus', name: 'Orus' },
          { id: 'Aoede', name: 'Aoede' },
          { id: 'Callirrhoe', name: 'Callirrhoe' },
          { id: 'Autonoe', name: 'Autonoe' },
          { id: 'Enceladus', name: 'Enceladus' },
          { id: 'Iapetus', name: 'Iapetus' },
          { id: 'Umbriel', name: 'Umbriel' },
          { id: 'Algieba', name: 'Algieba' },
          { id: 'Despina', name: 'Despina' },
          { id: 'Erinome', name: 'Erinome' },
          { id: 'Algenib', name: 'Algenib' },
          { id: 'Rasalgethi', name: 'Rasalgethi' },
          { id: 'Laomedeia', name: 'Laomedeia' },
          { id: 'Achernar', name: 'Achernar' },
          { id: 'Alnilam', name: 'Alnilam' },
          { id: 'Schedar', name: 'Schedar' },
          { id: 'Gacrux', name: 'Gacrux' },
          { id: 'Pulcherrima', name: 'Pulcherrima' },
          { id: 'Achird', name: 'Achird' },
          { id: 'Zubenelgenubi', name: 'Zubenelgenubi' },
          { id: 'Vindemiatrix', name: 'Vindemiatrix' },
          { id: 'Sadachbia', name: 'Sadachbia' },
          { id: 'Sadaltager', name: 'Sadaltager' },
          { id: 'Sulafat', name: 'Sulafat' },
        ],
      },
    },
    logo: 'google',
    benefit: '{does}. Uses your account at aistudio.google.com.',
    step: 'In Google AI Studio, open Get API key and create a key.',
    docs: 'https://ai.google.dev/gemini-api/docs',
    // GET /v1beta/models lists the models the key may use: free. Google answers a wrong key 400 with API_KEY_INVALID, not 401
    check: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      header: 'x-goog-api-key',
      prefix: '',
      alsoRefused: { status: 400, includes: 'API_KEY_INVALID' },
    },
  }),
  company({
    adapter: 'openai',
    label: 'OpenAI',
    jobs: {
      talk: {
        host: 'api.openai.com',
        // gpt-realtime-2.1 and its mini, from OpenAI's model pages (7 Nov 2026). The older realtime snapshots shut on 20 Jan 2027.
        models: [
          { id: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1' },
          { id: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 mini' },
        ],
        // OpenAI has no call that lists voices: these are the realtime voices its docs list
        fixedVoices: [
          { id: 'marin', name: 'Marin' },
          { id: 'cedar', name: 'Cedar' },
          { id: 'alloy', name: 'Alloy' },
          { id: 'ash', name: 'Ash' },
          { id: 'ballad', name: 'Ballad' },
          { id: 'coral', name: 'Coral' },
          { id: 'echo', name: 'Echo' },
          { id: 'sage', name: 'Sage' },
          { id: 'shimmer', name: 'Shimmer' },
          { id: 'verse', name: 'Verse' },
        ],
      },
    },
    logo: 'openai',
    benefit: '{does}. Uses your account at platform.openai.com.',
    step: 'On platform.openai.com, open API keys and create a key.',
    docs: 'https://platform.openai.com/docs',
    // GET /v1/models lists the models the key may use: free, and a wrong key is 401. A restricted key without the models permission
    // is a working key that gets 403 naming the missing scope
    check: { url: 'https://api.openai.com/v1/models', header: 'Authorization', prefix: 'Bearer ', alsoAccepted: { status: 403, includes: 'api.model.read' } },
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
      speech: {
        host: 'tts-rt.soniox.com',
        // tts-rt-v2: the model Pipecat's Soniox service starts on
        models: [{ id: 'tts-rt-v2', label: 'Soniox TTS v2' }],
        modelList: { url: 'https://api.soniox.com/v1/tts-models', list: 'models', id: 'id', label: 'name', aliasOf: 'aliased_model_id', languages: 'languages' },
        // GET /v1/tts-models: every model with its voices, in one answer. A voice is named by its id; there are no samples
        voices: {
          host: 'api.soniox.com',
          path: '/v1/tts-models',
          list: 'models[].voices[]',
          paging: { kind: 'none' },
          id: 'id',
          name: 'id',
          description: ['description', 'gender'],
          languages: [],
        },
      },
    },
    benefit: '{does}. Uses your account at soniox.com.',
    step: 'On console.soniox.com, open API Keys and create a key.',
    docs: 'https://soniox.com/docs',
    check: { url: 'https://api.soniox.com/v1/models', header: 'Authorization', prefix: 'Bearer ' },
  }),
  company({
    adapter: 'xai',
    label: 'xAI',
    jobs: {
      recognition: {
        // Live hearing over xAI's speech to text socket (wss://api.x.ai/v1/stt), as Pipecat's XAISTTService does. Grok Voice
        // Transcribe 2.0 is xAI's default and the one model its docs name (#1907)
        host: 'api.x.ai',
        models: [{ id: 'grok-voice-transcribe-2.0', label: 'Grok Voice Transcribe 2.0' }],
      },
      speech: {
        // Text to speech, one request per reply (POST /v1/tts), as Pipecat's XAIHttpTTSService does. xAI names no model for it:
        // this id only tells it apart from the talking models
        host: 'api.x.ai',
        models: [{ id: 'grok-tts', label: 'Grok Text to Speech' }],
        fixedVoices: XAI_VOICES,
      },
      talk: {
        host: 'api.x.ai',
        // From xAI's voice agent docs (7 Nov 2026): grok-voice-latest always points to the current model, grok-voice-3.0 stays put
        models: [
          { id: 'grok-voice-latest', label: 'Grok Voice (latest)' },
          { id: 'grok-voice-3.0', label: 'Grok Voice 3.0' },
        ],
        fixedVoices: XAI_VOICES,
      },
    },
    logo: 'xai',
    benefit: '{does}. Uses your account at console.x.ai.',
    step: 'On console.x.ai, open API Keys and create a key.',
    docs: 'https://docs.x.ai',
    // GET /v1/tts/voices lists the built-in voices: free, and a wrong key is 401
    check: { url: 'https://api.x.ai/v1/tts/voices', header: 'Authorization', prefix: 'Bearer ' },
  }),
];

export const voiceKeyCompanyInfo = (adapter: unknown): VoiceKeyCompanyInfo | null =>
  VOICE_KEY_COMPANIES.find((entry) => entry.adapter === adapter) ?? null;

/** What a company's line says it does, from the jobs Universe's own providers of it run: "Listens and speaks", "Talks live"… */
export const voiceDoesLine = ({ recognition, speech, talk = false }: { recognition: boolean; speech: boolean; talk?: boolean }) => {
  const jobs = [recognition && 'listens', speech && 'speaks', talk && 'talks live'].filter((job): job is string => Boolean(job));
  const line = jobs.length > 1 ? `${jobs.slice(0, -1).join(', ')} and ${jobs[jobs.length - 1]}` : jobs[0] ?? 'speaks';
  return line.charAt(0).toUpperCase() + line.slice(1);
};

/** Whether a model can be used for a job: one of that job's own, or a talking model, which listens and speaks in one. */
export const modelDoes = (model: { kind: string }, part: 'recognition' | 'speech') => model.kind === part || model.kind === 'talk';

/**
 * Whether a bot's voice talks live (game #1910): listening and speaking name the same provider and the same talking model. A
 * talking model is never named for only one of the two.
 */
export const talksLive = (
  profile: { recognition: { providerId: string; model: string }; speech: { providerId: string; model: string } },
  models: { id: string; kind: string }[],
) =>
  profile.recognition.providerId === profile.speech.providerId &&
  profile.recognition.model === profile.speech.model &&
  models.some((model) => model.kind === 'talk' && model.id === profile.speech.model);

/** The jobs a company does, in the order they are shown. */
export const companyJobs = (info: Pick<VoiceKeyCompanyEntry, 'jobs'>): VoiceCompanyJobName[] => VOICE_COMPANY_JOBS.filter((job) => info.jobs[job]);

/** The company's own host for a job (its first job when none is named), as the bot server calls it when no address is typed. */
export const companyHost = (adapter: string, job?: VoiceCompanyJobName): string | undefined => {
  const info = voiceKeyCompanyInfo(adapter);
  if (!info) return undefined;
  return info.jobs[job ?? companyJobs(info)[0]]?.host;
};

/**
 * The person's own account address for a company that has one, as kept: its https origin. Null when it is not an https address on
 * one of the company's hosts (the key only ever goes there), with no user, password or port.
 */
export function accountAddress(info: Pick<VoiceKeyCompanyEntry, 'account'>, typed: unknown): string | null {
  const spec = info.account?.address;
  if (!spec || typeof typed !== 'string') return null;
  let url: URL;
  try {
    url = new URL(typed.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  // A host name is letters, digits, dots and dashes: anything else ($, ', &) would read as more than a host further on
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (!spec.hosts.some((ending) => host.endsWith(ending) && host.length > ending.length)) return null;
  return `https://${host}`;
}

/** A model name a person typed (an Azure deployment name): letters, digits, dot, dash and underscore, up to 64. */
export const TYPED_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
