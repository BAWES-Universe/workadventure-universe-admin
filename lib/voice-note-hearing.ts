import type { VoiceProvider } from '@prisma/client';
import { prisma } from '@/lib/db';
import { borrowUniverseAi, followUniverseAi, homeOf, providersFor, voiceProfileSchema, type VoiceProfile } from '@/lib/bot-voice';
import { readModels } from '@/lib/voice-providers';
import { modelDoes } from '@/lib/voice-key-companies';
import { lendModelId } from '@/lib/voice-keys';

/**
 * What a bot hears voice notes with (game: every bot hears voice notes). Hearing a note is apart from talking live: a bot's Voice
 * switch, its universe's "Allow voice bots" and a broken speaking provider only change live voice (lib/bot-voice.ts
 * effectiveBotVoice), never whether a note is heard.
 *
 * Three routes, decided here and nowhere else:
 * - `owner-key`: the bot's published voice profile names a key of its maker (or of a Brick's owner) for listening, the key is
 *   theirs to use for this bot (lent here, with the model), it is on, has a key, lists the model and is not Down for listening,
 *   and the bot server can send it a file. The key's owner pays, as for live voice.
 * - `universe-ai`: Universe AI's own listening provider (Soniox today) that can read a file. Universe AI pays, out of the
 *   person's allowances (the bot server reserves them before anything is paid).
 * - `none`: no listening the bot server can use. The mic hides, as it does today.
 *
 * A key that is named but can't be used now (pulled, Down, no file call) is never used, and Universe AI hears instead: no bot hears
 * less than a bot with no voice at all. A Universe AI that is off is never used, and never stops a working owner key.
 *
 * The answer carries the key, still encrypted, for the bot server only (service token). Nothing here calls a provider.
 */

export type HearingRoute = 'owner-key' | 'universe-ai' | 'none';

/**
 * Why the route is what it is. `own-key-unusable`: the profile names a key of the owner's that can't hear a file now, so Universe AI
 * hears. `universe-ai-off`: Universe AI has no listening provider that is on with a key and a listening model. `no-file-hearer`: it
 * has one, but not one the bot server can send a file to.
 */
export type HearingReason = 'own-key-unusable' | 'universe-ai-off' | 'no-file-hearer';

export interface NoteHearing {
  /** The shape of this answer, for the bot server to check. */
  v: 1;
  route: HearingRoute;
  reason: HearingReason | null;
  /** Who pays for hearing: the key's owner, Universe AI, or nobody when nothing hears. */
  payer: 'owner' | 'universe-ai' | null;
  provider: { id: string; adapter: string; name: string; endpoint: string | null; region: string | null; apiKeyEncrypted: string } | null;
  /** The listening model to hear with, as the provider lists it (the bot server picks the file variant). */
  model: string | null;
  /** A language the maker fixed for the bot, or null to follow the person. */
  language: string | null;
}

/** The adapters the bot server can send a file to, from `?adapters=soniox,deepgram`. Null when the bot server did not say. */
export function readAdapters(value: string | null): Set<string> | null {
  if (value === null) return null;
  return new Set(
    value
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => /^[a-z0-9][a-z0-9-]{0,48}$/.test(name))
  );
}

const NOTHING = (reason: HearingReason): NoteHearing => ({ v: 1, route: 'none', reason, payer: null, provider: null, model: null, language: null });

const served = (row: VoiceProvider) => ({ id: row.id, adapter: row.adapter, name: row.name, endpoint: row.endpoint, region: row.region, apiKeyEncrypted: row.apiKeyEncrypted! });

/** The first listening model a provider lists, or one it lists by this id. A talking model listens too. */
const listeningModel = (row: VoiceProvider, id?: string) => {
  const models = readModels(row.models).filter((model) => modelDoes(model, 'recognition'));
  return id === undefined ? (models.find((model) => model.kind === 'recognition') ?? models[0]) : models.find((model) => model.id === id);
};

/** Whether a server provider can hear a file for Universe AI now: on, with a key, a listening model, and a file call. */
const universeAiCanHear = (row: VoiceProvider | undefined, adapters: Set<string>): row is VoiceProvider =>
  Boolean(row && row.ownerId === null && row.enabled && row.recognition && row.apiKeyEncrypted && adapters.has(row.adapter));

/**
 * Universe AI's hearing: the server's default listening provider with its first listening model. `prefer` is a server provider a
 * bot's profile names, heard with when it can hear a file (the model it names, which followUniverseAi already moved to the
 * provider's current one).
 */
export async function universeAiHearing(adapters: Set<string>, prefer?: { row: VoiceProvider; model: string }, language: string | null = null): Promise<NoteHearing> {
  if (prefer && universeAiCanHear(prefer.row, adapters)) {
    const model = listeningModel(prefer.row, prefer.model) ?? listeningModel(prefer.row);
    if (model) return { v: 1, route: 'universe-ai', reason: null, payer: 'universe-ai', provider: served(prefer.row), model: model.id, language };
  }
  const rows = await prisma.voiceProvider.findMany({ where: { enabled: true, ownerId: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  const row = rows.find((candidate) => candidate.defaultRecognition);
  const model = row && row.apiKeyEncrypted && row.recognition ? listeningModel(row) : undefined;
  if (!row || !model) return NOTHING('universe-ai-off');
  if (!universeAiCanHear(row, adapters)) return NOTHING('no-file-hearer');
  return { v: 1, route: 'universe-ai', reason: null, payer: 'universe-ai', provider: served(row), model: model.id, language };
}

/** Whether an owner's key named for listening can hear a file now. Health counts here: a Down key is never tried for a note. */
function ownerKeyCanHear(profile: VoiceProfile, row: VoiceProvider, lent: string[] | null | undefined, adapters: Set<string>): boolean {
  if (!row.enabled || !row.recognition || !row.apiKeyEncrypted || !adapters.has(row.adapter)) return false;
  if (row.downSince && (!row.downPart || row.downPart === 'recognition')) return false;
  const model = listeningModel(row, profile.recognition.model);
  if (!model) return false;
  return !lent || lent.includes(lendModelId(model));
}

/**
 * What this bot hears voice notes with now. Throws BotSettingsError(404) for a bot that isn't there (a deleted Brick, a room bot
 * with no room), as the voice routes do.
 */
export async function botHearing(botId: string, adapters: Set<string>): Promise<NoteHearing> {
  const home = await homeOf(botId);
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { voiceRevision: true } });
  const revision = bot?.voiceRevision != null ? await prisma.botVoiceRevision.findUnique({ where: { botId_number: { botId, number: bot.voiceRevision } } }) : null;
  const parsed = revision ? voiceProfileSchema.safeParse(revision.profile) : null;
  if (!parsed?.success) return universeAiHearing(adapters);
  const { providers, lent } = await providersFor(parsed.data, home);
  const profile = borrowUniverseAi(followUniverseAi(parsed.data, providers), providers);
  const language = profile.language.mode === 'fixed' ? profile.language.code : null;
  const row = providers.get(profile.recognition.providerId);
  if (row && row.ownerId !== null) {
    if (ownerKeyCanHear(profile, row, lent.get(row.id), adapters)) {
      return { v: 1, route: 'owner-key', reason: null, payer: 'owner', provider: served(row), model: profile.recognition.model, language };
    }
    const fallback = await universeAiHearing(adapters, undefined, language);
    return fallback.route === 'none' ? fallback : { ...fallback, reason: 'own-key-unusable' };
  }
  // A key of someone else's, or one no longer lent here, is left out by providersFor: the profile then reads as naming nothing
  return universeAiHearing(adapters, row ? { row, model: profile.recognition.model } : undefined, language);
}
