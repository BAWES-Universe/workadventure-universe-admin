import type { Prisma, VoiceProvider } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { lendAccess } from '@/lib/ai-key-lend';
import { readModels, universeAiDefaults } from '@/lib/voice-providers';
import { lendModelId, readLendModels } from '@/lib/voice-keys';
import { isOwnSpeechAdapter } from '@/lib/voice-own-server';
import { fixedVoiceModel } from '@/lib/voice-key-companies';
import { claimVoiceKeyTry, healthOf, tryIsDue } from '@/lib/voice-key-health';
import { startOfMonth } from '@/lib/ai-keys';
import { getVoiceLimits, servedVoiceLimits } from '@/lib/voice-limits';
import { LISTENING_KEY_LIMITS, SPEAKING_KEY_LIMITS, readVoiceKeyLimits, savedVoiceKeyLimits } from '@/lib/voice-limit-values';

/**
 * A bot's voice (#740): on or off (off until a person with Manage bots turns it on), a draft voice profile, and published
 * revisions of it. A bot speaks with the revision named in `bots.voice_revision`: publishing makes a new revision and rolling
 * back names an earlier one, so a revision never changes once it is published.
 *
 * The profile names the providers by id (lib/voice-providers.ts) with a model for each, and the voice (a part on one of the server's
 * own providers speaks with that provider's current model, see followUniverseAi). A provider is
 * one a super admin runs, so Universe AI pays, or a key (lib/voice-keys.ts) that the bot's maker lent to its universe, so the
 * maker pays; the person talking never does. A bot never speaks on anyone else's key, and when the key stops being usable
 * (pulled, deleted, a model taken off it, its owner no longer able to manage bots there) the bot carries on in text.
 * Nothing here calls a provider.
 */

const text = (max: number) => z.string().trim().min(1).max(max);

const recognitionPart = z.object({ providerId: text(100), model: text(255) }).strict();
const speechPart = z.object({ providerId: text(100), model: text(255), voiceId: text(255), voiceName: text(255).optional() }).strict();
const expression = z.enum(['restrained', 'natural', 'expressive']);
const language = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('follow') }).strict(),
  z.object({ mode: z.literal('fixed'), code: z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'language code looks wrong') }).strict(),
]);

/** A finished profile: what a revision holds. */
export const voiceProfileSchema = z
  .object({ recognition: recognitionPart, speech: speechPart, expression: expression.default('natural'), language: language.default({ mode: 'follow' }) })
  .strict();

/** A draft: the same, with any part not chosen yet. */
export const voiceDraftSchema = z
  .object({ recognition: recognitionPart.partial().strict(), speech: speechPart.partial().strict(), expression, language })
  .partial()
  .strict();

export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

const readDraft = (value: unknown) => {
  const parsed = voiceDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
};

/** For a key that is lent: the models the lend allows (as "kind:id"), or null for all of them. */
type Lends = Map<string, string[] | null>;

/**
 * A part that runs on one of the server's own providers (Universe AI) uses the model that provider starts from for the job, which
 * is the first one it lists, whatever model the bot was turned on with: a super admin moving Universe AI to a newer model of the same
 * company moves every such bot with it, and a model taken off no longer silences them. The voice and the company stay as published.
 * A part on a person's lent key keeps the model its maker picked (their key, their choice). A provider that lists no model for the
 * job leaves the published one, so `profileProblem` still says so.
 */
export function followUniverseAi(profile: VoiceProfile, providers: Map<string, VoiceProvider>): VoiceProfile {
  const follow = <P extends 'recognition' | 'speech'>(part: P): VoiceProfile[P] => {
    const choice = profile[part];
    const provider = providers.get(choice.providerId);
    if (!provider || provider.ownerId !== null) return choice;
    const models = readModels(provider.models).filter((model) => model.kind === part);
    // A voice tied to one model (Groq's Orpheus) speaks only with that model: kept while the provider lists it, and when it
    // doesn't the published one stays, so profileProblem says so rather than the voice going to a model it can't speak with
    const tied = part === 'speech' ? fixedVoiceModel(provider.adapter, (choice as VoiceProfile['speech']).voiceId) : undefined;
    const current = tied ? models.find((model) => model.id === tied) : models[0];
    return current && current.id !== choice.model ? { ...choice, model: current.id } : choice;
  };
  const recognition = follow('recognition');
  const speech = follow('speech');
  return recognition === profile.recognition && speech === profile.speech ? profile : { ...profile, recognition, speech };
}

/**
 * A part that runs on one of the server's own providers that a super admin turned off borrows what Universe AI uses now for that
 * job (#840): Universe AI's default provider with its starting model and, for speaking, its starting voice. Nothing is saved, so
 * when the provider is on again the bot has its own voice back, and its maker can pick another voice any time. A part on a lent
 * key never borrows (the maker pays for that one), and nothing is borrowed when Universe AI has no usable default for the job, or
 * no starting voice to speak with: then the bot answers in text as before. `providers` must hold the server's defaults
 * (providersFor loads them).
 */
export function borrowUniverseAi(profile: VoiceProfile, providers: Map<string, VoiceProvider>): VoiceProfile {
  const borrow = <P extends 'recognition' | 'speech'>(part: P): VoiceProfile[P] => {
    const choice = profile[part];
    const own = providers.get(choice.providerId);
    if (!own || own.ownerId !== null || own.enabled) return choice;
    const now = [...providers.values()].find((row) => row.ownerId === null && row.enabled && row[part] && (part === 'recognition' ? row.defaultRecognition : row.defaultSpeech));
    const models = now?.apiKeyEncrypted ? readModels(now.models).filter((entry) => entry.kind === part) : [];
    if (!now || !models.length) return choice;
    if (part === 'recognition') return { providerId: now.id, model: models[0].id } as VoiceProfile[P];
    if (!now.defaultVoiceId) return choice;
    // The starting voice speaks with its own model when the company ties voices to models (Groq's Orpheus)
    const tied = fixedVoiceModel(now.adapter, now.defaultVoiceId);
    const model = tied ? models.find((entry) => entry.id === tied) : models[0];
    if (!model) return choice;
    return { providerId: now.id, model: model.id, voiceId: now.defaultVoiceId, ...(now.defaultVoiceName ? { voiceName: now.defaultVoiceName } : {}) } as VoiceProfile[P];
  };
  const recognition = borrow('recognition');
  const speech = borrow('speech');
  return recognition === profile.recognition && speech === profile.speech ? profile : { ...profile, recognition, speech };
}

/** The first reason a finished profile can't be used with the providers as they are now, or null. */
export function profileProblem(profile: VoiceProfile, providers: Map<string, VoiceProvider>, lent: Lends = new Map()): string | null {
  for (const part of ['recognition', 'speech'] as const) {
    const choice = profile[part];
    const provider = providers.get(choice.providerId);
    const job = part === 'recognition' ? 'listening' : 'speaking';
    if (!provider) return `The provider chosen for ${job} doesn't exist`;
    if (!provider.enabled) return `${provider.name} is off`;
    if (!provider[part]) return `${provider.name} doesn't do ${job}`;
    // A speech server on a person's own computer may have no key (game #1874)
    if (!provider.apiKeyEncrypted && !isOwnSpeechAdapter(provider.adapter)) return `${provider.name} has no key`;
    if (!readModels(provider.models).some((model) => model.kind === part && model.id === choice.model)) return `${provider.name} doesn't list the model ${choice.model} for ${job}`;
    const allowed = lent.get(provider.id);
    if (allowed && !allowed.includes(lendModelId({ kind: part, id: choice.model }))) return `${provider.name} isn't lent to this universe for the model ${choice.model}`;
  }
  return null;
}

/** Where a bot lives and who made it: what decides whose keys it may speak on. */
interface Home {
  createdById: string | null;
  universeId: string;
}

async function homeOf(botId: string): Promise<Home> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { createdById: true, room: { select: { world: { select: { universeId: true } } } } } });
  if (!bot) throw new BotSettingsError(404, 'Bot not found');
  return { createdById: bot.createdById, universeId: bot.room.world.universeId };
}

/**
 * The providers a profile may use for this bot: the server's own, and a key only when the bot's maker owns it, lent it to
 * this universe, and still owns the universe or has Manage bots in it (the same rules as a text key). Anything else is left
 * out, so the profile reads as naming a provider that doesn't exist. When a part names a server provider that is off, the server's
 * providers that are on come too, so it can borrow Universe AI's current default (borrowUniverseAi).
 */
async function providersFor(profile: VoiceProfile, home: Home): Promise<{ providers: Map<string, VoiceProvider>; lent: Lends }> {
  const ids = [...new Set([profile.recognition.providerId, profile.speech.providerId])];
  const rows = await prisma.voiceProvider.findMany({
    where: { id: { in: ids } },
    include: { lends: { where: { universeId: home.universeId }, select: { models: true } } },
  });
  const providers = new Map<string, VoiceProvider>();
  const lent: Lends = new Map();
  for (const { lends, ...row } of rows) {
    if (row.ownerId === null) {
      providers.set(row.id, row);
    } else if (row.ownerId === home.createdById && lends.length > 0 && (await lendAccess(row.ownerId, home.universeId))) {
      providers.set(row.id, row);
      lent.set(row.id, readLendModels(lends[0].models));
    }
  }
  // A part on a server provider that is off borrows Universe AI's current default: load the server's providers that are on
  if ([...providers.values()].some((row) => row.ownerId === null && !row.enabled)) {
    for (const row of await prisma.voiceProvider.findMany({ where: { ownerId: null, enabled: true } })) if (!providers.has(row.id)) providers.set(row.id, row);
  }
  return { providers, lent };
}

/**
 * The voice limits a spoken turn runs under (#783): the server's, except that a part that runs on a lent personal key takes that
 * key's own values for what that job is limited by (how long a turn and a day of listening for the listening key, how long a
 * reply for the speaking key), wherever its owner changed them. A key never changes any other limit.
 */
async function limitsFor(profile: VoiceProfile | null, providers: Map<string, VoiceProvider>) {
  const { limits } = await getVoiceLimits();
  if (!profile) return limits;
  const ownedBy = (part: 'recognition' | 'speech') => {
    const row = providers.get(profile[part].providerId);
    return row && row.ownerId !== null ? savedVoiceKeyLimits(row.voiceLimits) : {};
  };
  const listening = ownedBy('recognition');
  const speaking = ownedBy('speech');
  const picked = (own: Partial<Record<string, number>>, names: readonly string[]) => Object.fromEntries(names.filter((name) => own[name] !== undefined).map((name) => [name, own[name]]));
  return { ...limits, ...picked(listening, LISTENING_KEY_LIMITS), ...picked(speaking, SPEAKING_KEY_LIMITS) };
}

/** Who pays for each part of a voice: Universe AI for a server provider, the key's owner for a key someone lent. */
async function payersOf(profile: VoiceProfile | null) {
  const universeAi = { recognition: 'universe-ai' as const, speech: 'universe-ai' as const };
  if (!profile) return { paidBy: 'universe-ai' as const, parts: universeAi };
  const rows = await prisma.voiceProvider.findMany({ where: { id: { in: [profile.recognition.providerId, profile.speech.providerId] } }, select: { id: true, ownerId: true } });
  const owned = new Set(rows.filter((row) => row.ownerId !== null).map((row) => row.id));
  const parts = {
    recognition: owned.has(profile.recognition.providerId) ? ('owner' as const) : ('universe-ai' as const),
    speech: owned.has(profile.speech.providerId) ? ('owner' as const) : ('universe-ai' as const),
  };
  const paidBy = parts.recognition === parts.speech ? parts.speech : ('mixed' as const);
  return { paidBy, parts };
}

/**
 * The server's own providers the live version names (#840). A bot can stay on one that is no longer Universe AI's default (the
 * operator switched company), so the bot page must not read it as a key that is no longer lent.
 */
async function serverProvidersIn(profile: VoiceProfile | null): Promise<string[]> {
  if (!profile) return [];
  const rows = await prisma.voiceProvider.findMany({ where: { id: { in: [...new Set([profile.recognition.providerId, profile.speech.providerId])] }, ownerId: null }, select: { id: true } });
  return rows.map((row) => row.id);
}

const revisionView = (row: { number: number; profile: Prisma.JsonValue; note: string | null; publishedById: string | null; publishedAt: Date }) => ({
  number: row.number,
  profile: row.profile,
  note: row.note,
  publishedById: row.publishedById,
  publishedAt: row.publishedAt,
});

/** Everything a person managing the bot sees of its voice. */
export async function readBotVoice(botId: string) {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: {
      voiceEnabled: true,
      voiceRevision: true,
      createdById: true,
      voiceDraft: { select: { profile: true, updatedAt: true } },
      voiceRevisions: { orderBy: { number: 'desc' }, select: { number: true, profile: true, note: true, publishedById: true, publishedAt: true } },
      room: { select: { world: { select: { universeId: true, universe: { select: { allowVoiceBots: true } } } } } },
    },
  });
  if (!bot) throw new BotSettingsError(404, 'Bot not found');
  const revisions = bot.voiceRevisions.map(revisionView);
  const speaking = bot.voiceRevision === null ? undefined : bot.voiceRevisions.find((revision) => revision.number === bot.voiceRevision);
  const parsed = speaking ? voiceProfileSchema.safeParse(speaking.profile) : null;
  return {
    enabled: bot.voiceEnabled,
    universeAllows: bot.room.world.universe.allowVoiceBots,
    ...(await payersOf(parsed?.success ? parsed.data : null)),
    serverProviderIds: await serverProvidersIn(parsed?.success ? parsed.data : null),
    revision: bot.voiceRevision,
    draft: { profile: readDraft(bot.voiceDraft?.profile), updatedAt: bot.voiceDraft?.updatedAt ?? null },
    revisions,
    lentKeys: await lentKeysFor(botId, { createdById: bot.createdById, universeId: bot.room.world.universeId }),
    // What the bot page needs to show and start from Universe AI (game #1668): its default providers, models and voice, and the
    // server's voice limits with the voice replies a fair-usage window leaves
    universeAi: await universeAiDefaults(),
    voiceLimits: await servedVoiceLimits(),
  };
}

/**
 * The keys this bot's profile may name besides the server's providers: the ones its maker lent to its universe, with only the
 * models the lend allows, whether each works, what it paid for this month and its limits (#783). Never the key itself.
 */
async function lentKeysFor(botId: string, home: Home) {
  if (!home.createdById || !(await lendAccess(home.createdById, home.universeId))) return [];
  const rows = await prisma.voiceProvider.findMany({
    where: { ownerId: home.createdById, lends: { some: { universeId: home.universeId } } },
    orderBy: { createdAt: 'asc' },
    include: { lends: { where: { universeId: home.universeId }, select: { models: true } } },
  });
  if (rows.length === 0) return [];
  const [usage, { limits: server }] = await Promise.all([
    prisma.voiceKeyUsage.findMany({ where: { providerId: { in: rows.map((row) => row.id) }, month: startOfMonth() }, select: { providerId: true, botId: true, replies: true } }),
    getVoiceLimits(),
  ]);
  return rows.map((row) => {
    const allowed = readLendModels(row.lends[0]?.models);
    const spent = usage.filter((entry) => entry.providerId === row.id);
    return {
      id: row.id,
      adapter: row.adapter,
      name: row.name,
      recognition: row.recognition,
      speech: row.speech,
      last4: row.apiKeyLast4,
      models: readModels(row.models).filter((model) => !allowed || allowed.includes(lendModelId(model))),
      health: healthOf(row),
      // Voice replies this key paid for this month (UTC): all its bots', and this bot's
      month: { voiceReplies: spent.reduce((sum, entry) => sum + entry.replies, 0), botVoiceReplies: spent.find((entry) => entry.botId === botId)?.replies ?? 0 },
      limits: readVoiceKeyLimits(row.voiceLimits, server),
    };
  });
}

/** Saves the draft in place of the one there. It only has to be well formed: finishing it is for publishing. */
export async function saveVoiceDraft(botId: string, profile: z.infer<typeof voiceDraftSchema>, userId: string) {
  await prisma.botVoiceDraft.upsert({
    where: { botId },
    create: { botId, profile: profile as Prisma.InputJsonValue, updatedById: userId },
    update: { profile: profile as Prisma.InputJsonValue, updatedById: userId },
  });
  return readBotVoice(botId);
}

/** Publishes the draft as the next revision, which the bot speaks with from now on. */
export async function publishVoiceDraft(botId: string, note: string | null, userId: string) {
  await prisma.$transaction(async (tx) => {
    const draft = await tx.botVoiceDraft.findUnique({ where: { botId } });
    const parsed = voiceProfileSchema.safeParse(draft?.profile ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BotSettingsError(400, `The voice profile isn't finished: ${issue?.path.join('.') || 'profile'} is ${issue?.code === 'invalid_type' ? 'missing' : 'not valid'}`);
    }
    const { providers, lent } = await providersFor(parsed.data, await homeOf(botId));
    const problem = profileProblem(followUniverseAi(parsed.data, providers), providers, lent);
    if (problem) throw new BotSettingsError(409, problem);
    const last = await tx.botVoiceRevision.findFirst({ where: { botId }, orderBy: { number: 'desc' }, select: { number: true } });
    const number = (last?.number ?? 0) + 1;
    await tx.botVoiceRevision.create({ data: { botId, number, profile: parsed.data as Prisma.InputJsonValue, note, publishedById: userId } });
    await tx.bot.update({ where: { id: botId }, data: { voiceRevision: number } });
  });
  return readBotVoice(botId);
}

/** Goes back to an earlier revision, if the providers it names still work as it says. */
export async function rollBackVoice(botId: string, number: number) {
  await prisma.$transaction(async (tx) => {
    const revision = await tx.botVoiceRevision.findUnique({ where: { botId_number: { botId, number } } });
    if (!revision) throw new BotSettingsError(404, 'That revision doesn\'t exist');
    const parsed = voiceProfileSchema.safeParse(revision.profile);
    if (!parsed.success) throw new BotSettingsError(409, 'That revision can\'t be read');
    const { providers, lent } = await providersFor(parsed.data, await homeOf(botId));
    const problem = profileProblem(followUniverseAi(parsed.data, providers), providers, lent);
    if (problem) throw new BotSettingsError(409, problem);
    await tx.bot.update({ where: { id: botId }, data: { voiceRevision: number } });
  });
  return readBotVoice(botId);
}

/** Turns voice on or off. On needs the universe to allow it and a published profile that works now; off always works. */
export async function setBotVoiceEnabled(botId: string, enabled: boolean) {
  if (enabled) {
    // A key that is Down for now doesn't stop voice being turned on: the bot replies in text until the key answers again
    const state = await effectiveBotVoice(botId, { ignoreSwitch: true, ignoreKeyHealth: true });
    if (state.reason && state.reason !== 'key-down') throw new BotSettingsError(409, voiceReasonLine(state.reason));
  }
  await prisma.bot.update({ where: { id: botId }, data: { voiceEnabled: enabled }, select: { id: true } });
  return readBotVoice(botId);
}

export type VoiceOffReason = 'off' | 'universe' | 'no-profile' | 'provider' | 'key-down';

// "key-down" has no line: it never stops voice being turned on, it only keeps the bot in text for now
const REASON_LINES: Record<Exclude<VoiceOffReason, 'key-down'>, string> = {
  off: 'Voice is off for this bot',
  universe: 'This universe doesn\'t allow voice bots',
  'no-profile': 'Publish a voice profile first',
  provider: 'The providers in the voice profile don\'t work right now',
};

/** The line a person is told when voice can't be turned on. */
export const voiceReasonLine = (reason: Exclude<VoiceOffReason, 'key-down'>) => REASON_LINES[reason];

/**
 * Whether the bot speaks right now and with what: voice is on for it, its universe allows voice bots, it has a published
 * profile and the providers in it still work. `reason` says which of those is not so. The bot server reads this before it
 * speaks, so a super admin turning a provider off, or a universe turning voice bots off, stops it at once.
 *
 * A person's key that is Down (lib/voice-key-health.ts) reads as "key-down": the bot replies in text. `recheck` is the bot
 * server asking whether it may try the key again: it may once every 5 minutes (or when the owner asked), and then `speaks`
 * is true for that one turn; the bot server reports how the call went. `ignoreKeyHealth` leaves key health out (turning voice
 * on, serving the key to a turn that was allowed to try it).
 */
export async function effectiveBotVoice(botId: string, options: { ignoreSwitch?: boolean; recheck?: boolean; ignoreKeyHealth?: boolean } = {}) {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: {
      voiceEnabled: true,
      voiceRevision: true,
      createdById: true,
      room: { select: { world: { select: { universeId: true, universe: { select: { allowVoiceBots: true } } } } } },
    },
  });
  if (!bot) throw new BotSettingsError(404, 'Bot not found');
  const result = async (
    reason: VoiceOffReason | null,
    revision: number | null = null,
    profile: VoiceProfile | null = null,
    down: ReturnType<typeof healthOf> | null = null,
    keys: Map<string, VoiceProvider> = new Map(),
  ) => ({
    speaks: reason === null,
    reason,
    ...(await payersOf(profile)),
    revision,
    profile,
    // Only for "key-down": since when and why the key is down, for the line a person reads
    down: down ? { since: down.downSince, reason: down.downReason } : null,
    // The voice limits this bot's turns run under: the server's, with a lent key's own for the job it does (#783)
    limits: await limitsFor(profile, keys),
  });
  if (!bot.voiceEnabled && !options.ignoreSwitch) return result('off');
  if (!bot.room.world.universe.allowVoiceBots) return result('universe');
  if (bot.voiceRevision === null) return result('no-profile');
  const revision = await prisma.botVoiceRevision.findUnique({ where: { botId_number: { botId, number: bot.voiceRevision } } });
  const parsed = revision ? voiceProfileSchema.safeParse(revision.profile) : null;
  if (!revision || !parsed?.success) return result('no-profile');
  const { providers, lent } = await providersFor(parsed.data, { createdById: bot.createdById, universeId: bot.room.world.universeId });
  // A bot on Universe AI speaks with the models Universe AI uses now, not the ones it was turned on with, and a part on a
  // company a super admin turned off borrows what Universe AI uses now until it is on again
  const profile = borrowUniverseAi(followUniverseAi(parsed.data, providers), providers);
  if (profileProblem(profile, providers, lent)) return result('provider', revision.number);
  if (!options.ignoreKeyHealth) {
    const ids = [...new Set([profile.recognition.providerId, profile.speech.providerId])];
    // A key that went Down on one job holds back only a bot that uses it for that job
    const usedFor = (id: string) => (['recognition', 'speech'] as const).filter((part) => profile[part].providerId === id);
    const down = ids
      .map((id) => providers.get(id))
      .filter((row): row is VoiceProvider => Boolean(row && row.ownerId !== null && row.downSince && (!row.downPart || usedFor(row.id).includes(row.downPart as 'recognition' | 'speech'))));
    if (down.length > 0) {
      // Each Down key gets one try per wait. Nothing is claimed unless every Down key can be tried, so a key whose wait
      // is not over does not use up the wait of the other
      let mayTry = options.recheck === true && down.every((row) => tryIsDue(row));
      for (const row of down) {
        if (!mayTry) break;
        mayTry = await claimVoiceKeyTry(row.id);
      }
      if (!mayTry) return result('key-down', revision.number, null, healthOf([...down].sort((a, b) => a.downSince!.getTime() - b.downSince!.getTime())[0]));
    }
  }
  return result(null, revision.number, profile, null, providers);
}
