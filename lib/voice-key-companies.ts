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
 * - async: POST /voices with { limit: 1 }, x-api-key and version: v1. It lists voices: nothing is spoken. A wrong key is 401.
 * - bland: GET /v1/voices, Authorization: Bearer. It lists voices: nothing is spoken.
 * - camb: GET /apis/list-voices, x-api-key. It lists voices: nothing is spoken.
 * - fal: GET https://api.fal.ai/v1/account/billing, Authorization: Key. Free (it reads the account's name). A key without the
 *   billing permission (the usual API key) is answered 403, not 401: fal knows the key, so that counts as accepted.
 * - gladia: GET /v2/live?limit=1, x-gladia-key. It lists the account's past live sessions: nothing is transcribed. A wrong key is 401.
 * - gradium: GET /api/usages/credits, x-api-key. Free (it reads the account's credit), nothing is generated.
 * - groq: GET /openai/v1/models, Authorization: Bearer. It lists models: nothing is run. A wrong key is 401.
 * - hume: GET /v0/tts/voices (the account's own, one), X-Hume-Api-Key. It lists voices: nothing is spoken.
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
  /** Set when the company lists its voices with a POST: this JSON body, a `'{size}'` value being the page size (Async). */
  body?: Record<string, unknown>;
  /**
   * The field holding the voices (`a.b` for a field inside a field: Neuphonic), or '' when the answer is the list itself (CAMB.AI);
   * `a[].b[]` gathers them from inside a list (Soniox lists voices inside each model).
   */
  list: string;
  /** The host voices are listed at, when it isn't the job's own (Soniox speaks at tts-rt.soniox.com, lists at api.soniox.com; Resemble speaks at f.cluster.resemble.ai, lists at app.resemble.ai). */
  host?: string;
  /**
   * How the next page is asked for: a token the answer gives (`token`) or the last voice's id (`after`), sent as `param`, while
   * `more` says there is more (with no `more`, while the answer gives a token: Mistral); or a page number (`page`, from 1, in the path) while `more` says so, or, when the company doesn't
   * say, while a page is full; `first` is the number of the first page when it is not 1 (Hume counts from 0). `none`: the whole
   * list comes in one answer.
   */
  paging: { kind: 'token' | 'after'; param: string; next: string; more?: string } | { kind: 'page'; more?: string; first?: 0 | 1 } | { kind: 'none' };
  /** Asked one after the other, each added to `path` (Fish: the person's own voices, then the public library). A voice met twice is kept once. */
  passes?: string[];
  /**
   * The company lists each model's voices at that model's own path (Smallest AI): each is asked in turn instead of `path`, and its
   * voices belong to that model. A voice met under two models is kept once, with both.
   */
  perModel?: { model: string; path: string }[];
  /**
   * Each entry of `list` is one model's group of voices (Together AI: `{model, voices: [...]}`): `voices` names the field holding
   * the group's voices and `model` the field naming its model. A voice met in two groups is kept once, with both models.
   */
  groups?: { voices: string; model: string };
  /** A voice is kept only when each of these fields, when the company sends it, has this value. */
  keep?: Record<string, string>;
  /**
   * The field naming the speaking model a voice is listed for (Rime lists each voice once a model), or `a[].b` for every model one
   * listing names (Speechify): the voice is kept once, with every model it has.
   */
  model?: string;
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

/**
 * A voice a company offers but has no list call for (OpenAI's talking voices, Groq's Orpheus voices): the same for every key.
 * `model`: the one speaking model the voice belongs to, when the company ties each voice to a model (Groq's Orpheus).
 */
export interface FixedVoice {
  id: string;
  name: string;
  description?: string;
  languages?: string[];
  model?: string;
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
  /** The regions a key may be in, one picked on Add a key (AWS), each with the host the bot server calls there. */
  regions?: { id: string; label: string; host: string }[];
  /** A key in two parts (AWS): this one shown as typed (the access key ID), the other kept secret like any key. */
  keyId?: { label: string; example: string; hint: string };
  /** What the secret part is called, when not "API key" (AWS: "Secret access key"). */
  keyLabel?: string;
}

/**
 * An AWS key as kept and sent on: the access key ID, a colon, then the secret access key. Only long-term keys (AKIA): a
 * temporary key needs a session token too, which nothing here keeps.
 */
export const AWS_KEY = /^AKIA[A-Z0-9]{12,124}:[A-Za-z0-9/+=]{20,128}$/;

/** A key in two parts kept as one: the ID part, a colon, the secret part (AWS). */
export const joinKey = (keyId: string, secret: string) => `${keyId.trim()}:${secret.trim()}`;

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
    /** Set when the free call is a POST (a list asked for with a body, as Async's voices are): this JSON body. */
    body?: Record<string, unknown>;
    /**
     * An answer that is not a 2xx but still means the company knows the key (a key limited to other endpoints): that status,
     * and when `includes` is given, only with that text in the answer.
     */
    alsoAccepted?: { status: number; includes?: string };
    /** An answer other than 401 or 403 that still means the key is wrong (Google: 400 with API_KEY_INVALID), only with that text. */
    alsoRefused?: { status: number; includes: string };
    /**
     * The call is signed with the key instead of carrying it (AWS Signature Version 4, for this service), in the region picked
     * (`{region}` in the url). Neither part of the key is ever sent.
     */
    sign?: { service: string };
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

/**
 * Bulbul v4 Flash's speakers, by the language each speaks (enhi: Hindi and English mixed), as Sarvam's voices page lists them
 * (docs.sarvam.ai, text-to-speech/voices, 7 Nov 2026). It takes none of Bulbul v3's names, and Sarvam has no call that lists them.
 */
const SARVAM_V4_SPEAKERS: Record<string, string> = {
  hi: `
      aayan_hi_conversational amit_hi_conversational ashutosh_hi_conversational kabir_hi_conversational
      kavya_hi_conversational manan_hi_conversational rahul_hi_conversational sumit_hi_conversational
      aditya_hi_conversational aditya_hi_sales anand_hi_documentary anand_hi_news aparna_hi_customer aparna_hi_kyc
      ashok_hi_character ashok_hi_news chhavi_hi_kids ishita_hi_ads ishita_hi_edtech ishita_hi_banking
      ishita_hi_ads_informal ishita_hi_devotional ishita_hi_numbers ishita_hi_social kunal_hi_kids
      mahesh_hi_documentary mani_hi_devotional mani_hi_conversational mohit_hi_conversational nachiket_hi_devotional
      priya_hi_recovery ratan_hi_latenight ratan_hi_customer_expressive ratan_hi_documentary ratan_hi_devotional
      ratan_hi_recovery ratan_hi_social ratan_hi_sports ratan_hi_latenight_warm rehan_hi_social
      ritu_hi_customer_utility ritu_hi_kids ritu_hi_conversation ritu_hi_customer ritu_hi_edtech ritu_hi_ads_formal
      ritu_hi_banking ritu_hi_ads_informal ritu_hi_insurance ritu_hi_edtech_bot ritu_hi_medical ritu_hi_sales
      ritu_hi_reels ritu_hi_social ritu_hi_customer_warm ritu_hi_social_lively roopa_hi_companion roopa_hi_narration
      roopa_hi_recovery roopa_hi_market roopa_hi_conversational sanchita_hi_assistant sanchita_hi_edtech
      sanchita_hi_banking sanchita_hi_feedback sanchita_hi_ads_formal sanchita_hi_ads_informal sanchita_hi_interview
      sanchita_hi_romantic sanchita_hi_market sanchita_hi_social sanchita_hi_kyc sarika_hi_conversation
      shalini_hi_companion shalini_hi_social shreya_hi_conversational shreya_hi_news shruti_hi_edtech
      shubh_hi_customer shubh_hi_ecomm shubh_hi_stories_mixed shubh_hi_devotional shubh_hi_ads shubh_hi_recovery
      shubh_hi_stories_dramatic simran_hi_assistant simran_hi_narration simran_hi_automobile simran_hi_conversation
      simran_hi_news_breaking simran_hi_social_energetic simran_hi_social_excited simran_hi_latenight simran_hi_news
      simran_hi_recovery simran_hi_sales suchitra_hi_ecomm suhani_hi_social sunny_hi_ads sunny_hi_reels
      tarun_hi_conversational tarun_hi_sales chaitra_hi_customer shilpa_hi_narration tanya_hi_narration
      aarti_hi_customer advait_hi_character aryaman_hi_ads chirag_hi_social girish_hi_devotional mukul_hi_ads
      mukul_hi_suspense suman_hi_companion vaibhav_hi_social vandana_hi_ecomm vipul_hi_social
  `,
  en: `
      aditi_en_stories aparna_en_companion aparna_en_edtech ashwin_en_sports ashwin_en_sports_energetic
      chandrika_en_stories dev_en_recovery dev_en_conversational deven_en_conversation ishita_en_customer
      ishita_en_medical ishita_en_numbers ishita_en_social ishita_en_stories kalpit_en_edtech nachiket_en_ads
      neha_en_customer neha_en_latenight nupur_en_kids ojas_en_social ritu_en_edtech ritu_en_latenight ritu_en_medical
      ritu_en_reels rohan_en_recovery roopa_en_conversational rustom_en_suspense sanchita_en_companion
      sanchita_en_insurance sanchita_en_recovery sanchita_en_market sanchita_en_social shabana_en_edtech
      shalini_en_companion shalini_en_customer shubh_en_narration shubh_en_numbers shubh_en_ads shubh_en_recovery
      shubh_en_audiobook shubh_en_narration_gentle shubh_en_sports simran_en_narration simran_en_automobile
      simran_en_conversation simran_en_customer simran_en_edtech simran_en_edtech_bot simran_en_sales
      simran_en_recovery simran_en_ads simran_en_therapist sunny_en_social varun_en_ads varun_en_suspense
      zarina_en_conversation amelia_en_conversational sophia_en_conversational girish_en_documentary
      girish_en_devotional payal_en_edtech sarang_en_narration
  `,
  enhi: `
      ishita_enhi_companion ishita_enhi_customer ishita_enhi_customer_expressive sanchita_enhi_companion
      shalini_enhi_companion shalini_enhi_customer shubh_enhi_companion shubh_enhi_ads shubh_enhi_banking
      simran_enhi_companion simran_enhi_customer simran_enhi_banking_expressive sunny_enhi_customer
  `,
  mr: `
      ishita_mr_conversational mrunal_mr_narration neha_mr_narration nilesh_mr_conversation ritu_mr_insurance
      ritu_mr_narration rupali_mr_stories soham_mr_narration mukul_mr_stories
  `,
  kn: `
      chaitra_kn_conversation chaitra_kn_narration chetan_kn_conversation suchitra_kn_narration
  `,
  pa: `
      anand_pa_conversation anand_pa_customer harpreet_pa_narration jaspal_pa_banking
  `,
  ta: `
      aravind_ta_ads aravind_ta_suspense gokul_ta_narration vijay_ta_narration
  `,
  te: `
      kavitha_te_conversation kavitha_te_narration pooja_te_conversation tarun_te_narration
  `,
  gu: `
      bhavik_gu_conversation pooja_gu_conversational pooja_gu_customer
  `,
  bn: `
      arnab_bn_conversation roopa_bn_conversational bimal_bn_suspense
  `,
};

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
    adapter: 'aws',
    label: 'AWS',
    jobs: {
      talk: {
        // The region picked on Add a key names the host: bedrock-runtime.<region>.amazonaws.com
        host: 'bedrock-runtime.us-east-1.amazonaws.com',
        // From Bedrock's Nova 2 Sonic model card (7 Nov 2026): in us-east-1, us-west-2, eu-north-1 and ap-northeast-1 only
        models: [{ id: 'amazon.nova-2-sonic-v1:0', label: 'Nova 2 Sonic' }],
        // AWS has no call that lists Nova Sonic voices: these are the voices its language table lists, in that order. Tiffany and
        // Matthew speak every language Nova Sonic does; Kiara and Arjun speak Indian English and Hindi
        fixedVoices: [
          { id: 'tiffany', name: 'Tiffany' },
          { id: 'matthew', name: 'Matthew' },
          { id: 'amy', name: 'Amy' },
          { id: 'olivia', name: 'Olivia' },
          { id: 'kiara', name: 'Kiara' },
          { id: 'arjun', name: 'Arjun' },
          { id: 'ambre', name: 'Ambre' },
          { id: 'florian', name: 'Florian' },
          { id: 'beatrice', name: 'Beatrice' },
          { id: 'lorenzo', name: 'Lorenzo' },
          { id: 'tina', name: 'Tina' },
          { id: 'lennart', name: 'Lennart' },
          { id: 'lupe', name: 'Lupe' },
          { id: 'carlos', name: 'Carlos' },
          { id: 'carolina', name: 'Carolina' },
          { id: 'leo', name: 'Leo' },
        ],
      },
    },
    benefit: '{does}. Uses your AWS account, in the region you pick.',
    step: 'In the AWS console, open IAM and create an access key for a user allowed bedrock:InvokeModelWithBidirectionalStream.',
    docs: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-sonic.html',
    account: {
      regions: [
        { id: 'us-east-1', label: 'US East (N. Virginia)', host: 'bedrock-runtime.us-east-1.amazonaws.com' },
        { id: 'us-west-2', label: 'US West (Oregon)', host: 'bedrock-runtime.us-west-2.amazonaws.com' },
        { id: 'eu-north-1', label: 'Europe (Stockholm)', host: 'bedrock-runtime.eu-north-1.amazonaws.com' },
        { id: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)', host: 'bedrock-runtime.ap-northeast-1.amazonaws.com' },
      ],
      keyId: { label: 'Access key ID', example: 'AKIA…', hint: 'Shown next to the secret when you create the access key. It starts with AKIA.' },
      keyLabel: 'Secret access key',
    },
    // STS GetCallerIdentity answers any valid key, needs no permission and is free; a wrong key is 403. The call is signed, so
    // neither part of the key leaves Universe
    check: { url: 'https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15', header: 'Authorization', prefix: '', sign: { service: 'sts' } },
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
        fixedVoices: [
            ...['Autumn', 'Diana', 'Hannah', 'Austin', 'Daniel', 'Troy'].map((name) => ({ id: name.toLowerCase(), name, description: 'Orpheus English', languages: ['en'], model: 'canopylabs/orpheus-v1-english' })),
            ...['Abdullah', 'Fahad', 'Sultan', 'Lulwa', 'Noura', 'Aisha'].map((name) => ({ id: name.toLowerCase(), name, description: 'Orpheus Arabic (Saudi)', languages: ['ar'], model: 'canopylabs/orpheus-arabic-saudi' })),
        ],
      },
    },
    benefit: '{does}. Uses your account at groq.com.',
    step: 'On console.groq.com, open API Keys and create a key.',
    docs: 'https://console.groq.com/docs/speech-to-text',
    check: { url: 'https://api.groq.com/openai/v1/models', header: 'Authorization', prefix: 'Bearer ' },
  }),
  company({
    adapter: 'hume',
    label: 'Hume',
    jobs: {
      speech: {
        // Text to speech with Octave, one streamed request per reply (POST /v0/tts/stream/json), as Pipecat's HumeTTSService does.
        // Hume has no model list a key can read. Octave 2 is its current model (https://dev.hume.ai/docs/text-to-speech-tts/overview)
        // and the one Pipecat asks for with a voice. Octave 1 isn't offered: Hume tells per voice which Octave models it speaks
        // (compatible_octave_models), so a voice picked for Octave 2 may not speak in Octave 1
        host: 'api.hume.ai',
        models: [{ id: 'octave-2', label: 'Octave 2' }],
        // GET /v0/tts/voices: the account's own voices, then Hume's library, page by page from page 0
        voices: {
          path: '/v0/tts/voices?page_size={size}&page_number={page}',
          passes: ['provider=CUSTOM_VOICE', 'provider=HUME_AI'],
          list: 'voices_page',
          paging: { kind: 'page', first: 0 },
          id: 'id',
          name: 'name',
          description: [],
          languages: [],
        },
      },
    },
    benefit: '{does}. Uses your account at hume.ai.',
    step: 'On platform.hume.ai, open API keys and copy your API key.',
    docs: 'https://dev.hume.ai/docs/text-to-speech-tts/overview',
    check: { url: 'https://api.hume.ai/v0/tts/voices?provider=CUSTOM_VOICE&page_size=1', header: 'X-Hume-Api-Key', prefix: '' },
  }),
  company({
    adapter: 'meta',
    label: 'Meta',
    jobs: {
      recognition: {
        // Muse Voice live hearing over a socket (wss://api.meta.ai/v1/asr/realtime), the key in its first message
        // (https://dev.meta.ai/docs/api-reference/voice/realtime). Billed by the second of audio
        host: 'api.meta.ai',
        models: [{ id: 'muse-voice-transcribe-1.0', label: 'Muse Voice Transcribe 1.0' }],
      },
    },
    benefit: '{does}. Uses your account at dev.meta.ai.',
    step: 'On dev.meta.ai, create a Model API key.',
    docs: 'https://dev.meta.ai/docs/api-reference/voice/realtime',
    // The Model API's model list (GET https://api.meta.ai/v1/models, https://dev.meta.ai/docs/models), free with the key as a bearer
    check: { url: 'https://api.meta.ai/v1/models', header: 'Authorization', prefix: 'Bearer ' },
  }),
  company({
    adapter: 'mistral',
    label: 'Mistral',
    jobs: {
      recognition: {
        // Voxtral's live hearing socket (wss://api.mistral.ai/v1/audio/transcriptions/realtime), Pipecat's MistralSTTService model
        host: 'api.mistral.ai',
        models: [{ id: 'voxtral-mini-transcribe-realtime-2602', label: 'Voxtral Mini Transcribe Realtime' }],
      },
      speech: {
        // POST /v1/audio/speech streamed (https://docs.mistral.ai/api/endpoint/audio/speech), Pipecat's MistralTTSService model
        host: 'api.mistral.ai',
        models: [{ id: 'voxtral-mini-tts-2603', label: 'Voxtral Mini TTS' }],
        // GET /v2/audio/voices: Mistral's preset voices and the account's own, page by page with the token it gives
        voices: {
          path: '/v2/audio/voices?page_size={size}',
          list: 'data',
          paging: { kind: 'token', param: 'page_token', next: 'next_page_token' },
          id: 'id',
          name: 'name',
          description: ['description', { join: ['gender', 'tags[]'] }],
          languages: ['languages[]'],
        },
      },
    },
    logo: 'mistral',
    benefit: '{does}. Uses your account at mistral.ai.',
    step: 'On console.mistral.ai, open API Keys and create a key.',
    docs: 'https://docs.mistral.ai/capabilities/audio/',
    check: { url: 'https://api.mistral.ai/v1/models', header: 'Authorization', prefix: 'Bearer ' },
  }),
  company({
    adapter: 'neuphonic',
    label: 'Neuphonic',
    jobs: {
      speech: {
        // Text to speech, one streamed request per reply (POST /sse/speak/{language}), as Pipecat's NeuphonicHttpTTSService does.
        // Neuphonic has no model to pick: the voice sets it (its own SDK, @neuphonic/neuphonic-js 0.10.2), so this only names it
        host: 'api.neuphonic.com',
        models: [{ id: 'neuphonic', label: 'Neuphonic TTS' }],
        // GET /voices: Neuphonic's voices and the account's own clones in one answer, each with its language
        voices: {
          path: '/voices',
          list: 'data.voices',
          paging: { kind: 'none' },
          id: 'voice_id',
          name: 'name',
          description: [{ join: ['tags[]'] }],
          languages: ['lang_code'],
        },
      },
    },
    benefit: '{does}. Uses your account at neuphonic.com.',
    step: 'On app.neuphonic.com, open API Keys and create a key.',
    docs: 'https://docs.neuphonic.com',
    check: { url: 'https://api.neuphonic.com/voices', header: 'X-API-KEY', prefix: '' },
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
    adapter: 'resemble',
    label: 'Resemble AI',
    jobs: {
      speech: {
        // Text to speech, one streamed request per reply (POST https://f.cluster.resemble.ai/stream), open to every plan; Pipecat's
        // ResembleAITTSService uses the socket, which Resemble keeps to Business plans. Resemble has no model to pick: the voice sets it
        host: 'f.cluster.resemble.ai',
        models: [{ id: 'resemble', label: 'Resemble TTS' }],
        // GET /api/v2/voices: the account's voices, page by page while a page is full, each with its languages
        voices: {
          host: 'app.resemble.ai',
          path: '/api/v2/voices?page={page}&page_size={size}',
          list: 'items',
          paging: { kind: 'page' },
          id: 'uuid',
          name: 'name',
          description: [],
          languages: ['default_language', 'supported_languages[]'],
        },
      },
    },
    benefit: '{does}. Uses your account at resemble.ai.',
    step: 'On app.resemble.ai, open Account, then API, and copy your API key.',
    docs: 'https://docs.resemble.ai',
    check: { url: 'https://app.resemble.ai/api/v2/voices?page=1&page_size=10', header: 'Authorization', prefix: 'Bearer ' },
  }),
  company({
    adapter: 'rime',
    label: 'Rime',
    jobs: {
      speech: {
        // Text to speech, one streamed request per reply (POST /v1/rime-tts, the model named in the request), as Pipecat's
        // RimeHttpTTSService does. Rime has no model list a key can read; Coda is Pipecat's default, Mist v3 and v2 Rime's earlier
        // models (https://docs.rime.ai)
        host: 'users.rime.ai',
        models: [
          { id: 'coda', label: 'Coda' },
          { id: 'mistv3', label: 'Mist v3' },
          { id: 'mistv2', label: 'Mist v2' },
        ],
        // Rime's voices, listed once for each model they speak in (one public file, the same for every key)
        voices: {
          path: '/data/voices/voice_details.json',
          list: '',
          paging: { kind: 'none' },
          id: 'speaker',
          name: 'speaker',
          model: 'modelId',
          description: ['description', { join: ['gender', 'age', 'country'] }],
          languages: ['lang'],
        },
      },
    },
    benefit: '{does}. Uses your account at rime.ai.',
    step: 'On app.rime.ai, open API Tokens and create a token.',
    docs: 'https://docs.rime.ai',
    // Rime's word coverage check: it lists the words Rime doesn't know, nothing is spoken (https://docs.rime.ai/api-reference/other/oov)
    check: { url: 'https://users.rime.ai/oov', header: 'Authorization', prefix: 'Bearer ', body: { text: 'Hello' } },
  }),
  company({
    adapter: 'sarvam',
    label: 'Sarvam AI',
    jobs: {
      recognition: {
        // Live hearing over Sarvam's socket (wss://api.sarvam.ai/speech-to-text/ws), as Pipecat's SarvamSTTService does: Indian
        // languages and Indian English. Saaras v4 is Pipecat's default (https://docs.sarvam.ai)
        host: 'api.sarvam.ai',
        models: [
          { id: 'saaras:v4', label: 'Saaras v4' },
          { id: 'saaras:v3', label: 'Saaras v3' },
        ],
      },
      speech: {
        // Text to speech over Sarvam's socket (wss://api.sarvam.ai/text-to-speech/ws), as Pipecat's SarvamTTSService does.
        // Bulbul v3 is Pipecat's default; Bulbul v4 Flash is faster, with its own voices (Pipecat's SarvamTTSService takes both)
        host: 'api.sarvam.ai',
        models: [
          { id: 'bulbul:v3', label: 'Bulbul v3' },
          { id: 'bulbul:v4-flash', label: 'Bulbul v4 Flash' },
        ],
        // Sarvam has no list of its own voices to ask. Bulbul v3's speakers as Pipecat names them, each speaking Sarvam's eleven
        // languages, then Bulbul v4 Flash's own, each in its language: a voice speaks only in its model
        fixedVoices: [
          ...[
            'shubh', 'aditya', 'ritu', 'priya', 'neha', 'rahul', 'pooja', 'rohan', 'simran', 'kavya', 'amit', 'dev', 'ishita',
            'shreya', 'ratan', 'varun', 'manan', 'sumit', 'roopa', 'kabir', 'aayan', 'ashutosh', 'advait', 'amelia', 'sophia',
          ].map((id) => ({
            id,
            name: id.charAt(0).toUpperCase() + id.slice(1),
            description: 'Bulbul v3',
            languages: ['bn', 'en', 'gu', 'hi', 'kn', 'ml', 'mr', 'or', 'pa', 'ta', 'te'],
            model: 'bulbul:v3',
          })),
          ...Object.entries(SARVAM_V4_SPEAKERS).flatMap(([language, ids]) =>
            ids.trim().split(/\s+/).map((id) => {
              const [speaker, , ...style] = id.split('_');
              return {
                id,
                name: `${speaker.charAt(0).toUpperCase()}${speaker.slice(1)} (${style.join(' ')})`,
                description: 'Bulbul v4 Flash',
                languages: language === 'enhi' ? ['en', 'hi'] : [language],
                model: 'bulbul:v4-flash',
              };
            }),
          ),
        ],
      },
    },
    benefit: '{does}. Uses your account at sarvam.ai.',
    step: 'On dashboard.sarvam.ai, open API Keys and create a key.',
    docs: 'https://docs.sarvam.ai',
    // The workspace's own cloned voices, free to read
    check: { url: 'https://api.sarvam.ai/voices?limit=1', header: 'api-subscription-key', prefix: '' },
  }),
  company({
    adapter: 'smallest',
    label: 'Smallest AI',
    jobs: {
      recognition: {
        // Pulse's live hearing socket (wss://api.smallest.ai/waves/v1/stt/live), as Pipecat's SmallestSTTService does. Pulse is
        // Pipecat's default; Pulse 2 hears English only (https://docs.smallest.ai)
        host: 'api.smallest.ai',
        models: [
          { id: 'pulse', label: 'Pulse' },
          { id: 'pulse-2', label: 'Pulse 2 (English)' },
        ],
      },
      speech: {
        // Lightning over Smallest's socket (wss://api.smallest.ai/waves/v1/tts/live), as Pipecat's SmallestTTSService does.
        // Lightning v3.1 Pro (Pipecat's default) speaks 29 languages, Arabic among them; Lightning v3.1 speaks 12
        host: 'api.smallest.ai',
        models: [
          { id: 'lightning_v3.1_pro', label: 'Lightning v3.1 Pro' },
          { id: 'lightning_v3.1', label: 'Lightning v3.1' },
        ],
        // GET /waves/v1/{model}/get_voices: each model's voices at its own path, a voice working only with its own model
        voices: {
          path: '/waves/v1/lightning-v3.1-pro/get_voices',
          perModel: [
            { model: 'lightning_v3.1_pro', path: '/waves/v1/lightning-v3.1-pro/get_voices' },
            { model: 'lightning_v3.1', path: '/waves/v1/lightning-v3.1/get_voices' },
          ],
          list: 'voices',
          paging: { kind: 'none' },
          id: 'voiceId',
          name: 'displayName',
          description: [{ join: ['tags.gender', 'tags.age', 'tags.accent', 'tags.usecases[]'] }],
          languages: ['tags.language[]', 'tags.language'],
        },
      },
    },
    benefit: '{does}. Uses your account at smallest.ai.',
    step: 'On app.smallest.ai, open API Keys and create a key.',
    docs: 'https://docs.smallest.ai',
    // Lightning v3.1 Pro's voice list, free with the key as a bearer
    check: { url: 'https://api.smallest.ai/waves/v1/lightning-v3.1-pro/get_voices', header: 'Authorization', prefix: 'Bearer ' },
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
    adapter: 'speechify',
    label: 'Speechify',
    jobs: {
      speech: {
        // Text to speech, one streamed request per reply (POST /v1/audio/stream/with-timestamps), as Pipecat's
        // SpeechifyHttpTTSService does. Simba 3.5 is Pipecat's default and speaks 48 languages; Simba 3.2 speaks English, Simba 3.0
        // English, German, Spanish, French, Italian and Portuguese (https://docs.speechify.ai)
        host: 'api.speechify.ai',
        models: [
          { id: 'simba-3.5', label: 'Simba 3.5' },
          { id: 'simba-3.2', label: 'Simba 3.2 (English)' },
          { id: 'simba-3.0', label: 'Simba 3.0' },
        ],
        // GET /v1/voices: the account's own voices and Speechify's shared ones, a page at a time by cursor. Each voice names the
        // models it speaks with and the languages of each
        voices: {
          path: '/v1/voices?limit={size}',
          list: 'voices',
          paging: { kind: 'token', param: 'cursor', next: 'next_cursor', more: 'has_more' },
          model: 'models[].name',
          id: 'id',
          name: 'display_name',
          description: [{ join: ['tags[]'] }],
          languages: ['locale', 'models[].languages[].locale'],
          preview: 'preview_audio',
        },
      },
    },
    benefit: '{does}. Uses your account at speechify.ai.',
    step: 'On platform.speechify.ai, open API Keys and create a key.',
    docs: 'https://docs.speechify.ai',
    // One voice from the voice list, free with the key as a bearer
    check: { url: 'https://api.speechify.ai/v1/voices?limit=1', header: 'Authorization', prefix: 'Bearer ' },
  }),
  company({
    adapter: 'speechmatics',
    label: 'Speechmatics',
    jobs: {
      recognition: {
        // Live hearing over Speechmatics' agent socket (wss://eu2.rt.speechmatics.com/v2/agent), as Pipecat's SpeechmaticsSTTService
        // does. Linden 1 is the agent socket's model and Pipecat's default (https://docs.speechmatics.com)
        host: 'eu2.rt.speechmatics.com',
        models: [{ id: 'linden-1', label: 'Linden 1' }],
      },
      speech: {
        // Text to speech, one streamed request per reply (POST /generate/{voice}), as Pipecat's SpeechmaticsTTSService does.
        // Speechmatics names no model; its speech is in preview, English only
        host: 'preview.tts.speechmatics.com',
        models: [{ id: 'speechmatics', label: 'Speechmatics TTS (preview)' }],
        // Speechmatics has no list of its voices to ask: these are the four its docs name
        fixedVoices: [
          { id: 'sarah', name: 'Sarah', description: 'Female, UK English', languages: ['en'] },
          { id: 'theo', name: 'Theo', description: 'Male, UK English', languages: ['en'] },
          { id: 'megan', name: 'Megan', description: 'Female, US English', languages: ['en'] },
          { id: 'jack', name: 'Jack', description: 'Male, US English', languages: ['en'] },
        ],
      },
    },
    benefit: '{does}. Uses your account at speechmatics.com.',
    step: 'On portal.speechmatics.com, open Settings, then API Keys, and create a key.',
    docs: 'https://docs.speechmatics.com',
    // The account's batch jobs, free to read with the same key as a bearer
    check: { url: 'https://asr.api.speechmatics.com/v2/jobs?limit=1', header: 'Authorization', prefix: 'Bearer ' },
  }),
  company({
    adapter: 'together',
    label: 'Together AI',
    jobs: {
      recognition: {
        // Live hearing over Together's realtime socket (wss://api.together.ai/v1/realtime), as Pipecat's TogetherSTTService does.
        // Whisper Large v3 is Pipecat's default (https://docs.together.ai)
        host: 'api.together.ai',
        models: [{ id: 'openai/whisper-large-v3', label: 'Whisper Large v3' }],
      },
      speech: {
        // Text to speech, one streamed request per reply (POST /v1/audio/speech). Kokoro is Pipecat's default, Orpheus the
        // other model Pipecat names
        host: 'api.together.ai',
        models: [
          { id: 'hexgrad/Kokoro-82M', label: 'Kokoro 82M' },
          { id: 'canopylabs/orpheus-3b-0.1-ft', label: 'Orpheus 3B' },
        ],
        // GET /v1/voices: one group of voices for each model, each voice used by its name
        voices: {
          path: '/v1/voices',
          list: 'data',
          groups: { voices: 'voices', model: 'model' },
          paging: { kind: 'none' },
          id: 'name',
          name: 'name',
          description: [],
          languages: [],
        },
      },
    },
    benefit: '{does}. Uses your account at together.ai.',
    step: 'On api.together.ai, open Settings, then API Keys, and create a key.',
    docs: 'https://docs.together.ai',
    // The voice list, free with the key as a bearer
    check: { url: 'https://api.together.ai/v1/voices', header: 'Authorization', prefix: 'Bearer ' },
  }),
  company({
    adapter: 'xai',
    label: 'xAI',
    jobs: {
      talk: {
        host: 'api.x.ai',
        // From xAI's voice agent docs (7 Nov 2026): grok-voice-latest always points to the current model, grok-voice-3.0 stays put
        models: [
          { id: 'grok-voice-latest', label: 'Grok Voice (latest)' },
          { id: 'grok-voice-3.0', label: 'Grok Voice 3.0' },
        ],
        // xAI's built-in voices, Eve (its default) first, then as its text to speech docs list them. Every one speaks every language.
        fixedVoices: [
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
        ],
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

/** The one speaking model a voice belongs to, when the company ties each voice to a model (Groq's Orpheus), or undefined. */
export const fixedVoiceModel = (adapter: unknown, voiceId: string): string | undefined =>
  voiceKeyCompanyInfo(adapter)?.jobs.speech?.fixedVoices?.find((voice) => voice.id === voiceId)?.model;

/** What a company's line says it does, from the jobs Universe's own providers of it run: "Listens and speaks", "Talks live"… */
export const voiceDoesLine = ({ recognition, speech, talk = false }: { recognition: boolean; speech: boolean; talk?: boolean }) => {
  const jobs = [recognition && 'listens', speech && 'speaks', talk && 'talks live'].filter((job): job is string => Boolean(job));
  const line = jobs.length > 1 ? `${jobs.slice(0, -1).join(', ')} and ${jobs[jobs.length - 1]}` : jobs[0] ?? 'speaks';
  return line.charAt(0).toUpperCase() + line.slice(1);
};

/** The company ties each voice to the models it speaks in (Groq's Orpheus, Rime, Smallest AI, Together): a voice can't be moved to any other model. */
export const voicesTiedToModels = (adapter: unknown): boolean => {
  const job = voiceKeyCompanyInfo(adapter)?.jobs.speech;
  return !!job && (!!job.fixedVoices?.some((voice) => voice.model) || !!job.voices?.model || !!job.voices?.perModel || !!job.voices?.groups);
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

/** The region a person picked for a company whose keys are made per region (AWS), when it is one of the company's own. */
export function accountRegion(info: Pick<VoiceKeyCompanyEntry, 'account'>, picked: unknown): string | null {
  const regions = info.account?.regions;
  if (!regions || typeof picked !== 'string') return null;
  return regions.find((region) => region.id === picked)?.id ?? null;
}
