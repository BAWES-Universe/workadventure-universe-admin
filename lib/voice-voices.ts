import type { VoiceProvider } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { lendAccess } from '@/lib/ai-key-lend';
import { readModels } from '@/lib/voice-providers';
import { lendModelId, readLendModels } from '@/lib/voice-keys';
import { voiceKeyCompanyInfo, type VoiceKeyCompanyInfo } from '@/lib/voice-key-companies';

/**
 * The voices a bot's maker can pick from on the bot page (game #1668): the speaking voices of one source, which is Universe AI
 * (the server's default speaking provider) or a voice key the bot's maker lent to the bot's universe. The list comes from the
 * voice company's own free "list voices" call; nothing is spoken and nothing is billed. A key is used only for that one call
 * (and for fetching a sample the company keeps behind the key), sent only to the company's fixed address, and is never logged
 * or returned.
 *
 * Which company lists how is one entry per adapter in LISTERS. A company that speaks but has no entry (or one that only listens)
 * answers "can't list voices", it never errors out of the page. The lists are cached per provider for a while, since they
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
}

/** A voice as a company listed it. `preview` is the company's address for the sample, `previewNeedsKey` whether it wants the key. */
interface Listed {
  voiceId: string;
  name: string;
  description: string;
  languages: string[];
  preview: string | null;
  previewNeedsKey: boolean;
}

/** A source that can't be listed, with the line that says why (shown as it is). */
export class VoiceListRefused extends Error {
  constructor(message: string, readonly status: 404 | 409 | 502 = 409) {
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

const BASES: Record<string, string> = { elevenlabs: 'https://api.elevenlabs.io', cartesia: 'https://api.cartesia.ai' };

/** The primary language code of "en-GB", "ar_KW" or "ara", or null when it doesn't look like one. */
export function languageCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
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

async function getJson(call: Call, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${call.base}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...call.headers },
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

const elevenlabsPage = z.object({
  voices: z.array(
    z
      .object({
        voice_id: z.string().min(1).max(255),
        name: z.string().optional(),
        description: z.string().nullish(),
        labels: z.record(z.string(), z.unknown()).nullish(),
        preview_url: z.string().nullish(),
        verified_languages: z.array(z.object({ language: z.string().nullish(), locale: z.string().nullish() }).passthrough()).nullish(),
      })
      .passthrough()
  ),
  has_more: z.boolean().nullish(),
  next_page_token: z.string().nullish(),
});

/** ElevenLabs: GET /v2/voices, 100 a page, `next_page_token` while `has_more`. A voice's sample is a public address. */
async function listElevenLabs(call: Call): Promise<Listed[]> {
  const out: Listed[] = [];
  let token: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const parsed = elevenlabsPage.safeParse(await getJson(call, `/v2/voices?page_size=${PAGE_SIZE}${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`));
    if (!parsed.success) throw new VoiceListRefused(`${call.company.label} sent a voice list that can’t be read.`, 502);
    for (const voice of parsed.data.voices) {
      const labels = voice.labels ?? {};
      const label = (name: string) => clean(labels[name], 60);
      // The company's own description, else what it labels the voice with
      const description = clean(voice.description, 300) || [label('descriptive'), label('accent'), label('gender'), label('age')].filter(Boolean).join(', ');
      out.push({
        voiceId: voice.voice_id,
        name: clean(voice.name, 255) || voice.voice_id,
        description,
        languages: languagesOf(
          (voice.verified_languages ?? []).flatMap((entry) => [entry.language, entry.locale]),
          labels.language
        ),
        preview: httpsUrl(voice.preview_url),
        previewNeedsKey: false,
      });
    }
    if (!parsed.data.has_more || !parsed.data.next_page_token) break;
    token = parsed.data.next_page_token;
  }
  return out;
}

const cartesiaPage = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1).max(255),
        name: z.string().optional(),
        description: z.string().nullish(),
        tagline: z.string().nullish(),
        language: z.string().nullish(),
        accents: z.array(z.object({ locale: z.string().nullish() }).passthrough()).nullish(),
        preview_file_url: z.string().nullish(),
      })
      .passthrough()
  ),
  has_more: z.boolean().nullish(),
  next_page: z.string().nullish(),
});

/** Cartesia: GET /voices, 100 a page, `starting_after` the last id while `has_more`. A sample is only served with the key. */
async function listCartesia(call: Call): Promise<Listed[]> {
  const out: Listed[] = [];
  let after: string | null = null;
  const host = new URL(call.base).host;
  for (let page = 0; page < MAX_PAGES; page++) {
    const parsed = cartesiaPage.safeParse(await getJson(call, `/voices?limit=${PAGE_SIZE}&expand%5B%5D=preview_file_url${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`));
    if (!parsed.success) throw new VoiceListRefused(`${call.company.label} sent a voice list that can’t be read.`, 502);
    for (const voice of parsed.data.data) {
      // The key goes only to the company's own address, never to one a listing names
      const preview = httpsUrl(voice.preview_file_url);
      out.push({
        voiceId: voice.id,
        name: clean(voice.name, 255) || voice.id,
        description: clean(voice.description, 300) || clean(voice.tagline, 60),
        languages: languagesOf(voice.language, (voice.accents ?? []).map((accent) => accent.locale)),
        preview: preview && new URL(preview).host === host ? preview : null,
        previewNeedsKey: true,
      });
    }
    if (!parsed.data.has_more || !parsed.data.next_page) break;
    after = parsed.data.next_page;
  }
  return out;
}

/** The companies whose voices can be listed. Data, not a branch: add a company by adding its entry. */
const LISTERS: Record<string, (call: Call) => Promise<Listed[]>> = { elevenlabs: listElevenLabs, cartesia: listCartesia };

type Cached = { at: number; voices: Listed[] };
const cache = new Map<string, Cached>();

/** For tests: forgets every list. */
export const clearVoiceListCache = () => cache.clear();

/** Where a source's calls go and how they are signed: the company's own address, the key in its one header. */
function callFor(provider: VoiceProvider): Call {
  const company = voiceKeyCompanyInfo(provider.adapter);
  if (!company || !LISTERS[provider.adapter]) throw new VoiceListRefused(`${company?.label ?? provider.name}’s voices can’t be listed here.`, 409);
  if (!provider.apiKeyEncrypted) throw new VoiceListRefused(`${provider.name} has no key.`, 409);
  // The server's own provider may name another address (a proxy); a person's key never does
  const base = (provider.ownerId === null && provider.endpoint ? provider.endpoint : BASES[provider.adapter]).replace(/\/+$/, '');
  const { check } = company;
  let key: string;
  try {
    key = decryptApiKey(provider.apiKeyEncrypted);
  } catch {
    throw new VoiceListRefused(`${provider.name}’s key can’t be read.`, 409);
  }
  return { company, base, headers: { ...check.headers, [check.header]: `${check.prefix}${key}` } };
}

async function listedFor(provider: VoiceProvider): Promise<Listed[]> {
  // A new key or address is a new row version, so it is never served an older list
  const id = `${provider.id}:${provider.updatedAt.getTime()}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.voices;
  let voices: Listed[];
  try {
    const call = callFor(provider);
    // A lister stops at its page limit, but never trusts that: no more than MAX_VOICES are kept or sent on
    voices = (await LISTERS[provider.adapter](call)).slice(0, MAX_VOICES);
  } catch (error) {
    if (error instanceof Unreadable) throw new VoiceListRefused(`${voiceKeyCompanyInfo(provider.adapter)?.label ?? provider.name} sent a voice list that can’t be read.`, 502);
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
  model: string;
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
  const model = readModels(provider.models).find((entry) => entry.kind === 'speech' && (!allowed || allowed.includes(lendModelId(entry))));
  if (!model) throw new VoiceListRefused(`${provider.name} has no speaking model set up here.`, 409);
  return { provider, model: model.id };
}

const previewPath = (botId: string, source: string, voiceId: string) =>
  `/api/bots/${encodeURIComponent(botId)}/voice/voices/${encodeURIComponent(voiceId)}/preview?source=${encodeURIComponent(source)}`;

/** The speaking voices of one source (`universe-ai` or a voice key's id) for a bot, in the order the company lists them. */
export async function listBotVoices(botId: string, source: string): Promise<VoiceChoice[]> {
  const { provider, model } = await sourceFor(botId, source);
  const listed = await listedFor(provider);
  return listed.map((voice) => ({
    voiceId: voice.voiceId,
    name: voice.name,
    description: voice.description,
    languages: voice.languages,
    previewUrl: !voice.preview ? null : voice.previewNeedsKey ? previewPath(botId, source, voice.voiceId) : voice.preview,
    providerId: provider.id,
    model,
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
  return (await listedFor(provider)).map((voice) => ({
    voiceId: voice.voiceId,
    name: voice.name,
    description: voice.description,
    languages: voice.languages,
    previewUrl: !voice.preview ? null : voice.previewNeedsKey ? serverPreviewPath(provider.id, voice.voiceId) : voice.preview,
  }));
}

/** One voice's free sample from a server provider that keeps it behind its key. */
export async function fetchServerVoiceSample(providerId: string, voiceId: string): Promise<VoiceSample> {
  return sampleFor(await serverSpeaker(providerId), voiceId);
}
