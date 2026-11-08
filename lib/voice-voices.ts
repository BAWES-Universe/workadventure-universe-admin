import type { VoiceProvider } from '@prisma/client';
import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { lendAccess } from '@/lib/ai-key-lend';
import { readModels } from '@/lib/voice-providers';
import { lendModelId, readLendModels } from '@/lib/voice-keys';
import { voiceKeyCompanyInfo, type VoiceKeyCompanyInfo, type VoiceListSpec } from '@/lib/voice-key-companies';
import { OWN_SPEECH_LABEL, isOwnSpeechAdapter, listOwnSpeechVoices } from '@/lib/voice-own-server';

/**
 * The voices a bot's maker can pick from on the bot page (game #1668): the speaking voices of one source, which is Universe AI
 * (the server's default speaking provider) or a voice key the bot's maker lent to the bot's universe. The list comes from the
 * voice company's own free "list voices" call; nothing is spoken and nothing is billed. A key is used only for that one call
 * (and for fetching a sample the company keeps behind the key), sent only to the company's fixed address, and is never logged
 * or returned.
 *
 * How a company lists its voices is data in its catalog entry (`jobs.speech.voices`, lib/voice-key-companies.ts), read by one
 * lister for every company. A company with no voice list (or one that only listens) answers "can't list voices", it never errors
 * out of the page. The lists are cached per provider for a while, since they
 * change rarely and are free to read; the cache is dropped when the provider row changes (a new key, a new endpoint).
 */

export const UNIVERSE_AI_SOURCE = 'universe-ai';

/** What the bot page shows for one voice. */
export interface VoiceChoice {
  voiceId: string;
  name: string;
  description: string;
  /** Lowercase language codes without region ("en", "ar"), as the company lists them; empty when it doesn't say. */
  languages: string[];
  /**
   * A free sample. Either the company's own public address, or an Orbit path (`/api/bots/:id/voice/voices/:voiceId/preview?source=…`)
   * when the company keeps the sample behind the key: that one is fetched the same way as the list, with the person's session.
   * null when the company has none.
   */
  previewUrl: string | null;
  providerId: string;
  /** The speaking model to use with this voice: the first one the source lists (and the lend allows). */
  model: string;
  /**
   * The model is a talking model (game #1910): it listens and speaks in one, so a bot that picks this voice names it for both
   * listening and speaking.
   */
  talk: boolean;
}

/** A voice as a company listed it. `preview` is the company's address for the sample, `previewNeedsKey` whether it wants the key. */
interface Listed {
  voiceId: string;
  name: string;
  description: string;
  languages: string[];
  preview: string | null;
  previewNeedsKey: boolean;
  /** The speaking models this voice belongs to, when the company ties voices to models (Groq's Orpheus, Rime): one of them is used. */
  models?: string[];
}

/** A source that can't be listed, with the line that says why (shown as it is). */
export class VoiceListRefused extends Error {
  /** `code` names a case a screen answers in its own way; it is sent next to the line, never instead of it. */
  constructor(message: string, readonly status: 404 | 409 | 502 = 409, readonly code?: 'no_voice_list') {
    super(message);
  }
}

export const MAX_VOICES = 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = MAX_VOICES / PAGE_SIZE;
export const LIST_TIMEOUT_MS = 8_000;
/** Samples are a few seconds of speech; anything much bigger is not one. */
export const MAX_PREVIEW_BYTES = 2_000_000;
export const CACHE_MS = 10 * 60_000;
const CACHE_ENTRIES = 100;

interface Call {
  company: VoiceKeyCompanyInfo;
  /** The company's address with no trailing slash. */
  base: string;
  headers: Record<string, string>;
}

/** Three-letter codes (ISO 639-2, as Rime lists them) of languages that have a two-letter one. */
const TWO_LETTER: Record<string, string> = {
  ara: 'ar', chi: 'zh', deu: 'de', dut: 'nl', eng: 'en', fra: 'fr', fre: 'fr', ger: 'de', hin: 'hi', ita: 'it', jpn: 'ja',
  kor: 'ko', nld: 'nl', por: 'pt', rus: 'ru', spa: 'es', tur: 'tr', zho: 'zh',
};

/** The primary language code of "en-GB", "ar_KW" or "ara" ("ar"), or null when it doesn't look like one. */
export function languageCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? (TWO_LETTER[primary] ?? primary) : null;
}

const languagesOf = (...values: unknown[]): string[] => [...new Set(values.flat().map(languageCode).filter((code): code is string => code !== null))];

const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
};

const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** A company that answered with something other than a list, a rejection or a failure to reach it. */
class Unreadable extends Error {}

async function getJson(call: Call, path: string, body?: Record<string, unknown>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${call.base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...call.headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // A redirect would carry the key somewhere the catalog never named
      redirect: 'manual',
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    // Nothing from the error is kept: it could carry the address with the key's header
    throw new VoiceListRefused(`Couldn’t reach ${call.company.label}. Try again in a moment.`, 502);
  }
  if (!response.ok) {
    // Nothing in the answer is read: let go of the connection instead of waiting for it to be collected
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) throw new VoiceListRefused(`${call.company.label} didn’t accept the key.`, 502);
    throw new VoiceListRefused(`Couldn’t reach ${call.company.label}. Try again in a moment.`, 502);
  }
  try {
    return await response.json();
  } catch {
    throw new Unreadable();
  }
}

/** Every value at a path into a voice: `a.b` a field inside a field, `a[].b` that field of every entry of a list. */
function valuesAt(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value];
  for (const part of path.split('.')) {
    const many = part.endsWith('[]');
    const name = many ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const item of current) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const field = name === '' ? item : (item as Record<string, unknown>)[name];
      if (field === undefined || field === null) continue;
      if (many) {
        if (Array.isArray(field)) next.push(...field);
      } else next.push(field);
    }
    current = next;
  }
  return current;
}

const textAt = (value: unknown, path: string, max: number) => clean(valuesAt(value, path).find((entry) => typeof entry === 'string'), max);

/** A voice's description: the first of the spec's choices that says something. */
function descriptionOf(voice: unknown, choices: VoiceListSpec['description']): string {
  for (const choice of choices) {
    // Joined, a list (`tags[]`) gives every entry, not only its first
    const text = typeof choice === 'string' ? textAt(voice, choice, 300) : clean(choice.join.flatMap((path) => (path.includes('[]') ? valuesAt(voice, path) : valuesAt(voice, path).slice(0, 1)).map((entry) => (typeof entry === 'string' ? clean(entry, 60) : ''))).filter(Boolean).join(', '), 300);
    if (text) return text;
  }
  return '';
}

const unreadable = (call: Call) => new VoiceListRefused(`${call.company.label} sent a voice list that can’t be read.`, 502);

/**
 * Lists a company's voices from its catalog spec (lib/voice-key-companies.ts, `jobs.speech.voices`), the same way for every company:
 * page after page while the company says there are more, up to MAX_VOICES, each voice read from the fields the spec names. A page
 * that isn't a list, or a voice without an id, is a list that can't be read.
 */
async function listFromSpec(call: Call, spec: VoiceListSpec, speechModels: string[] = []): Promise<Listed[]> {
  const out: Listed[] = [];
  const seen = new Set<string>();
  const host = new URL(call.base).host;
  // Only the models set up on the key are asked for (Smallest AI): a model the account can't use may be refused, and its
  // voices couldn't be spoken here anyway
  const runs = spec.perModel
    ? spec.perModel.filter((run) => speechModels.includes(run.model)).map((run) => ({ path: run.path, pass: '', model: run.model }))
    : (spec.passes ?? ['']).map((pass) => ({ path: spec.path, pass, model: undefined }));
  for (const { path, pass, model: runModel } of runs) {
    let next: string | null = null;
    for (let page = 1; out.length < MAX_VOICES && page <= MAX_PAGES; page++) {
      const query = [path.replace('{size}', String(PAGE_SIZE)).replace('{page}', String(spec.paging.kind === 'page' && spec.paging.first === 0 ? page - 1 : page)), pass].filter(Boolean).join('&');
      const paged = (spec.paging.kind === 'token' || spec.paging.kind === 'after') && next !== null ? `${spec.paging.param}=${encodeURIComponent(next)}` : '';
      const body = spec.body ? Object.fromEntries(Object.entries(spec.body).map(([field, value]) => [field, value === '{size}' ? PAGE_SIZE : value])) : undefined;
      const answer = await getJson(call, [query, paged].filter(Boolean).join('&'), body);
      if (typeof answer !== 'object' || answer === null) throw unreadable(call);
      // An empty `list`: the answer is the list itself (CAMB.AI); `a[].b[]`: gathered from inside a list (Soniox); `a.b`: a field
      // inside a field (Neuphonic's data.voices)
      const voices = spec.list === '' ? answer : spec.list.endsWith('[]') ? valuesAt(answer, spec.list) : spec.list.split('.').reduce<unknown>((at, field) => (typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[field] : undefined), answer);
      if (!Array.isArray(voices)) throw unreadable(call);
      for (const voice of voices) {
        if (typeof voice !== 'object' || voice === null) throw unreadable(call);
        // A whole-number id (CAMB.AI) is kept as its digits
        const rawId = (Array.isArray(spec.id) ? spec.id : [spec.id]).map((field) => (voice as Record<string, unknown>)[field]).find((value) => value != null && value !== '');
        const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId >= 0 ? String(rawId) : rawId;
        if (typeof id !== 'string' || id.length === 0 || id.length > 255) throw unreadable(call);
        const fields = voice as Record<string, unknown>;
        if (spec.keep && Object.entries(spec.keep).some(([field, wanted]) => fields[field] != null && fields[field] !== wanted)) continue;
        if (spec.leaveOut?.some((start) => id.startsWith(start))) continue;
        // A voice the company lists once for each model it speaks in (Rime), or with all of them (Speechify), is kept once, with
        // every model it has
        const models = runModel ? [runModel] : spec.model ? [...new Set(valuesAt(voice, spec.model).map((entry) => clean(entry, 255)).filter(Boolean))] : [];
        if (seen.has(id)) {
          const kept = models.length ? out.find((entry) => entry.voiceId === id) : undefined;
          for (const model of models) if (kept?.models && !kept.models.includes(model)) kept.models.push(model);
          continue;
        }
        seen.add(id);
        const sample = (spec.preview ? valuesAt(voice, spec.preview) : []).map(httpsUrl).find((url): url is string => url !== null) ?? null;
        out.push({
          voiceId: id,
          name: textAt(voice, spec.name, 255) || id,
          description: descriptionOf(voice, spec.description),
          languages: languagesOf(...spec.languages.map((path) => valuesAt(voice, path))),
          // A sample served with the key must be at the company's own address: the key never goes to one a listing names
          preview: sample && (!spec.previewNeedsKey || new URL(sample).host === host) ? sample : null,
          previewNeedsKey: spec.previewNeedsKey === true,
          ...(models.length ? { models } : {}),
        });
      }
      if (spec.paging.kind === 'none') break;
      const more = spec.paging.more ? (answer as Record<string, unknown>)[spec.paging.more] : undefined;
      if (spec.paging.kind === 'page') {
        // The list says when it ends; a full page is the sign there may be more when it doesn't
        if (more === false || (typeof more !== 'boolean' && voices.length < PAGE_SIZE)) break;
        continue;
      }
      const given = (answer as Record<string, unknown>)[spec.paging.next];
      const token = spec.paging.nextIsLink ? linkParam(given, spec.paging.param) : given;
      // With no `more`, the token itself says there is another page (Mistral)
      if ((spec.paging.more && more !== true) || typeof token !== 'string' || token === '') break;
      next = token;
    }
  }
  return out.slice(0, MAX_VOICES);
}

/** The value of `param` in a next page's address, or null: the address itself is never followed. */
function linkParam(link: unknown, param: string): string | null {
  if (typeof link !== 'string' || link === '') return null;
  try {
    return new URL(link).searchParams.get(param);
  } catch {
    return null;
  }
}

type Cached = { at: number; voices: Listed[] };
const cache = new Map<string, Cached>();

/** For tests: forgets every list. */
export const clearVoiceListCache = () => cache.clear();

/** The job whose voices a provider's bots pick from: speaking, or talking (game #1910) for a company that only talks live. */
const voiceJobOf = (company: VoiceKeyCompanyInfo | null) => (company?.jobs.speech ? company.jobs.speech : company?.jobs.talk);

/** Where a source's calls go and how they are signed: the company's own address, the key in its one header. */
function callFor(provider: VoiceProvider): Call & { spec: VoiceListSpec } {
  const company = voiceKeyCompanyInfo(provider.adapter);
  const job = voiceJobOf(company);
  const spec = job?.voices;
  if (!company || !job || !spec) throw new VoiceListRefused(`${company?.label ?? provider.name}’s voices can’t be listed here.`, 409);
  if (!provider.apiKeyEncrypted) throw new VoiceListRefused(`${provider.name} has no key.`, 409);
  // The server's own provider may name another address (a proxy); a person's key never does
  // A list kept at another host than the job's (Resemble) is always read there: a proxy for speaking is not a voice list
  const base = (spec.host ? `https://${spec.host}` : provider.ownerId === null && provider.endpoint ? provider.endpoint : `https://${job.host}`).replace(/\/+$/, '');
  const { check } = company;
  let key: string;
  try {
    key = decryptApiKey(provider.apiKeyEncrypted);
  } catch {
    throw new VoiceListRefused(`${provider.name}’s key can’t be read.`, 409);
  }
  return { company, spec, base, headers: { ...check.headers, [check.header]: `${check.prefix}${key}` } };
}

/**
 * The voices of a speech server on a person's own computer (game #1874): its own list at /audio/voices when it has one. A server
 * with no list answers "can't list voices", and the bot's maker types the voice's name instead. The checks on the address run again
 * on every list, so a name that later points inside a network is never reached.
 */
async function listOwnVoices(provider: VoiceProvider): Promise<Listed[]> {
  // `no_voice_list`: the game shows a field to type the voice's name instead of Try again
  const noList = () => new VoiceListRefused(`${provider.name} doesn’t list its voices. Type the voice’s name.`, 409, 'no_voice_list');
  if (!provider.endpoint) throw noList();
  let key = '';
  if (provider.apiKeyEncrypted) {
    try {
      key = decryptApiKey(provider.apiKeyEncrypted);
    } catch {
      throw new VoiceListRefused(`${provider.name}’s key can’t be read.`, 409);
    }
  }
  const listed = await listOwnSpeechVoices(provider.endpoint, key);
  // A server that can't be asked is said so: only a server that answers with no list tells the maker to type the name
  if (!listed.ok) throw new VoiceListRefused(listed.message, listed.reason === 'unreachable' ? 502 : listed.reason === 'refused' ? 502 : 409);
  const voices = listed.voices;
  if (!voices) throw noList();
  return voices.map(({ voiceId }) => ({ voiceId, name: voiceId, description: '', languages: [], preview: null, previewNeedsKey: false }));
}

async function listedFor(provider: VoiceProvider): Promise<Listed[]> {
  // A company with no list call (OpenAI's talking voices) has its voices in the catalog: nothing to call, nothing to cache
  const fixed = voiceJobOf(voiceKeyCompanyInfo(provider.adapter))?.fixedVoices;
  if (fixed) {
    return fixed.map((voice) => ({
      voiceId: voice.id,
      name: voice.name,
      description: voice.description ?? '',
      languages: voice.languages ?? [],
      preview: null,
      previewNeedsKey: false,
      ...(voice.model ? { models: [voice.model] } : {}),
    }));
  }
  // A new key or address is a new row version, so it is never served an older list
  const id = `${provider.id}:${provider.updatedAt.getTime()}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.voices;
  let voices: Listed[];
  try {
    if (isOwnSpeechAdapter(provider.adapter)) {
      voices = (await listOwnVoices(provider)).slice(0, MAX_VOICES);
    } else {
      const call = callFor(provider);
      // A lister stops at its page limit, but never trusts that: no more than MAX_VOICES are kept or sent on
      const speechModels = readModels(provider.models).filter((entry) => entry.kind === 'speech').map((entry) => entry.id);
      voices = (await listFromSpec(call, call.spec, speechModels)).slice(0, MAX_VOICES);
    }
  } catch (error) {
    if (error instanceof Unreadable) throw new VoiceListRefused(`${isOwnSpeechAdapter(provider.adapter) ? OWN_SPEECH_LABEL : (voiceKeyCompanyInfo(provider.adapter)?.label ?? provider.name)} sent a voice list that can’t be read.`, 502);
    throw error;
  }
  cache.delete(id);
  cache.set(id, { at: Date.now(), voices });
  // Oldest first, since a deleted-then-set entry goes last
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  return voices;
}

interface Source {
  provider: VoiceProvider;
  /** The speaking model a bot starts on: the first one set up and allowed here. */
  model: string;
  talk: boolean;
  /** Every model of the same kind set up and allowed here, first to last: a voice tied to one model (Groq) is offered only with it. */
  models: string[];
}

/**
 * The provider a bot's maker may pick voices from: Universe AI's default speaking provider, or a voice key that speaks, is on,
 * belongs to the bot's maker, is lent to the bot's universe and that the maker may still lend there (the rule that decides
 * whose keys a bot speaks on, lib/bot-voice.ts). Anything else reads as "not found", so a key's existence is never confirmed.
 */
async function sourceFor(botId: string, source: string): Promise<Source> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { createdById: true, room: { select: { world: { select: { universeId: true } } } } } });
  if (!bot) throw new BotSettingsError(404, 'Bot not found');
  const universeId = bot.room.world.universeId;
  let provider: (VoiceProvider & { lends?: { models: unknown }[] }) | null;
  if (source === UNIVERSE_AI_SOURCE) {
    provider = await prisma.voiceProvider.findFirst({ where: { ownerId: null, enabled: true, speech: true, defaultSpeech: true } });
    if (!provider || !provider.apiKeyEncrypted) throw new VoiceListRefused('Universe AI has no voice set up on this server.', 409);
  } else {
    provider = bot.createdById
      ? await prisma.voiceProvider.findFirst({
          where: { id: source, ownerId: bot.createdById, enabled: true, speech: true, lends: { some: { universeId } } },
          include: { lends: { where: { universeId }, select: { models: true } } },
        })
      : null;
    if (!provider || !bot.createdById || !(await lendAccess(bot.createdById, universeId))) throw new VoiceListRefused('Voice key not found.', 404);
  }
  const allowed = provider.lends?.length ? readLendModels(provider.lends[0].models) : null;
  // A speaking model first; a key whose only speaking is a talking model (game #1910) gives that one
  const usable = readModels(provider.models).filter((entry) => !allowed || allowed.includes(lendModelId(entry)));
  const model = usable.find((entry) => entry.kind === 'speech') ?? usable.find((entry) => entry.kind === 'talk');
  if (!model) throw new VoiceListRefused(`${provider.name} has no speaking model set up here.`, 409);
  return { provider, model: model.id, talk: model.kind === 'talk', models: usable.filter((entry) => entry.kind === model.kind).map((entry) => entry.id) };
}

const previewPath = (botId: string, source: string, voiceId: string) =>
  `/api/bots/${encodeURIComponent(botId)}/voice/voices/${encodeURIComponent(voiceId)}/preview?source=${encodeURIComponent(source)}`;

/** The speaking voices of one source (`universe-ai` or a voice key's id) for a bot, in the order the company lists them. */
export async function listBotVoices(botId: string, source: string): Promise<VoiceChoice[]> {
  const { provider, model, talk, models } = await sourceFor(botId, source);
  const listed = await listedFor(provider);
  // A voice tied to models (Groq, Rime) comes with the first of them set up and allowed here, and not at all when none is
  return listed.flatMap((voice) => {
    const own = voice.models ? models.find((id) => voice.models!.includes(id)) : model;
    return own ? [{ ...voice, own }] : [];
  }).map((voice) => ({
    voiceId: voice.voiceId,
    name: voice.name,
    description: voice.description,
    languages: voice.languages,
    previewUrl: !voice.preview ? null : voice.previewNeedsKey ? previewPath(botId, source, voice.voiceId) : voice.preview,
    providerId: provider.id,
    model: voice.own,
    talk,
  }));
}

export interface VoiceSample {
  bytes: ArrayBuffer;
  contentType: string;
}

/** One voice's sample from the company, for a provider already found: the address is the one the company's own list named. */
async function sampleFor(provider: VoiceProvider, voiceId: string): Promise<VoiceSample> {
  const voice = (await listedFor(provider)).find((entry) => entry.voiceId === voiceId);
  if (!voice?.preview) throw new VoiceListRefused('That voice has no sample.', 404);
  const call = callFor(provider);
  let response: Response;
  try {
    response = await fetch(voice.preview, {
      method: 'GET',
      headers: voice.previewNeedsKey ? call.headers : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new VoiceListRefused(`Couldn’t reach ${call.company.label}. Try again in a moment.`, 502);
  }
  const type = response.headers.get('content-type') ?? '';
  const unusable = () => new VoiceListRefused(`Couldn’t get that sample from ${call.company.label}.`, 502);
  if (!response.ok || !/^audio\//i.test(type) || Number(response.headers.get('content-length') ?? 0) > MAX_PREVIEW_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw unusable();
  }
  const bytes = await readCapped(response, MAX_PREVIEW_BYTES);
  if (!bytes || bytes.byteLength === 0) throw unusable();
  return { bytes, contentType: type.split(';')[0].trim() };
}

/**
 * The body of a response, read chunk by chunk and given up on (and cancelled) as soon as it goes past `max` bytes, so a company
 * that leaves out Content-Length can't make this hold more than `max`. Null when it is too big or can't be read.
 */
async function readCapped(response: Response, max: number): Promise<ArrayBuffer | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * One voice's free sample, fetched for a company that keeps it behind the key. The address is the one the company's own list
 * named (never one the caller sends), and the key goes only to that company's address.
 */
export async function fetchVoiceSample(botId: string, source: string, voiceId: string): Promise<VoiceSample> {
  const { provider } = await sourceFor(botId, source);
  return sampleFor(provider, voiceId);
}

/** What the Universe AI page shows for one voice of a server provider. */
export interface ServerVoiceChoice {
  voiceId: string;
  name: string;
  description: string;
  languages: string[];
  previewUrl: string | null;
  /** The speaking model the voice speaks in as the starting voice, when the company ties voices to models (Groq's Orpheus, Rime). */
  model?: string;
}

/** The server's own speaking provider that a super admin looks at (never a person's key): anything else reads as not found. */
async function serverSpeaker(providerId: string): Promise<VoiceProvider> {
  const provider = await prisma.voiceProvider.findFirst({ where: { id: providerId, ownerId: null, speech: true } });
  if (!provider) throw new VoiceListRefused('Voice provider not found', 404);
  return provider;
}

const serverPreviewPath = (providerId: string, voiceId: string) => `/api/admin/voice-providers/${encodeURIComponent(providerId)}/voices/${encodeURIComponent(voiceId)}/preview`;

/**
 * The speaking voices of one of the server's providers, for the Universe AI page's starting voice (#792). Works for a provider
 * that is not the default yet, so a super admin hears a company's voices before choosing it. Free: the company's own list, nothing
 * spoken. Cached like the bot page's list.
 */
export async function listServerVoices(providerId: string): Promise<ServerVoiceChoice[]> {
  const provider = await serverSpeaker(providerId);
  const models = readModels(provider.models).filter((entry) => entry.kind === 'speech').map((entry) => entry.id);
  const named = !!voiceKeyCompanyInfo(provider.adapter)?.jobs.speech?.fixedVoices;
  // A voice tied to models is offered only with the model it would speak in as the starting voice (borrowUniverseAi): its own
  // model when the catalog names it (Groq's Orpheus) and the provider lists it, or else the provider's starting model when the
  // voice speaks in it (Rime)
  const speaksWith = (voice: Listed) =>
    !voice.models ? undefined : named ? models.find((id) => voice.models!.includes(id)) : models[0] && voice.models.includes(models[0]) ? models[0] : undefined;
  return (await listedFor(provider)).flatMap((voice) => {
    const model = speaksWith(voice);
    if (voice.models && !model) return [];
    return [
      {
        voiceId: voice.voiceId,
        name: voice.name,
        description: voice.description,
        languages: voice.languages,
        previewUrl: !voice.preview ? null : voice.previewNeedsKey ? serverPreviewPath(provider.id, voice.voiceId) : voice.preview,
        ...(model ? { model } : {}),
      },
    ];
  });
}

/** One voice's free sample from a server provider that keeps it behind its key. */
export async function fetchServerVoiceSample(providerId: string, voiceId: string): Promise<VoiceSample> {
  return sampleFor(await serverSpeaker(providerId), voiceId);
}
