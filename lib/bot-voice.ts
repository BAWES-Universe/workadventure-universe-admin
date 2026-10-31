import type { Prisma, VoiceProvider } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { lendAccess } from '@/lib/ai-key-lend';
import { readModels } from '@/lib/voice-providers';
import { lendModelId, readLendModels } from '@/lib/voice-keys';
import { claimVoiceKeyTry, healthOf, tryIsDue } from '@/lib/voice-key-health';

/**
 * A bot's voice (#740): on or off (off until a person with Manage bots turns it on), a draft voice profile, and published
 * revisions of it. A bot speaks with the revision named in `bots.voice_revision`: publishing makes a new revision and rolling
 * back names an earlier one, so a revision never changes once it is published.
 *
 * The profile names the providers by id (lib/voice-providers.ts) with an exact model for each, and the voice. A provider is
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

/** The first reason a finished profile can't be used with the providers as they are now, or null. */
export function profileProblem(profile: VoiceProfile, providers: Map<string, VoiceProvider>, lent: Lends = new Map()): string | null {
  for (const part of ['recognition', 'speech'] as const) {
    const choice = profile[part];
    const provider = providers.get(choice.providerId);
    const job = part === 'recognition' ? 'listening' : 'speaking';
    if (!provider) return `The provider chosen for ${job} doesn't exist`;
    if (!provider.enabled) return `${provider.name} is off`;
    if (!provider[part]) return `${provider.name} doesn't do ${job}`;
    if (!provider.apiKeyEncrypted) return `${provider.name} has no key`;
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
 * out, so the profile reads as naming a provider that doesn't exist.
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
  return { providers, lent };
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
    revision: bot.voiceRevision,
    draft: { profile: readDraft(bot.voiceDraft?.profile), updatedAt: bot.voiceDraft?.updatedAt ?? null },
    revisions,
    lentKeys: await lentKeysFor({ createdById: bot.createdById, universeId: bot.room.world.universeId }),
  };
}

/**
 * The keys this bot's profile may name besides the server's providers: the ones its maker lent to its universe, with only the
 * models the lend allows. Never the key itself.
 */
async function lentKeysFor(home: Home) {
  if (!home.createdById || !(await lendAccess(home.createdById, home.universeId))) return [];
  const rows = await prisma.voiceProvider.findMany({
    where: { ownerId: home.createdById, lends: { some: { universeId: home.universeId } } },
    orderBy: { createdAt: 'asc' },
    include: { lends: { where: { universeId: home.universeId }, select: { models: true } } },
  });
  return rows.map((row) => {
    const allowed = readLendModels(row.lends[0]?.models);
    return {
      id: row.id,
      adapter: row.adapter,
      name: row.name,
      recognition: row.recognition,
      speech: row.speech,
      last4: row.apiKeyLast4,
      models: readModels(row.models).filter((model) => !allowed || allowed.includes(lendModelId(model))),
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
    const problem = profileProblem(parsed.data, providers, lent);
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
    const problem = profileProblem(parsed.data, providers, lent);
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
  ) => ({
    speaks: reason === null,
    reason,
    ...(await payersOf(profile)),
    revision,
    profile,
    // Only for "key-down": since when and why the key is down, for the line a person reads
    down: down ? { since: down.downSince, reason: down.downReason } : null,
  });
  if (!bot.voiceEnabled && !options.ignoreSwitch) return result('off');
  if (!bot.room.world.universe.allowVoiceBots) return result('universe');
  if (bot.voiceRevision === null) return result('no-profile');
  const revision = await prisma.botVoiceRevision.findUnique({ where: { botId_number: { botId, number: bot.voiceRevision } } });
  const parsed = revision ? voiceProfileSchema.safeParse(revision.profile) : null;
  if (!revision || !parsed?.success) return result('no-profile');
  const { providers, lent } = await providersFor(parsed.data, { createdById: bot.createdById, universeId: bot.room.world.universeId });
  if (profileProblem(parsed.data, providers, lent)) return result('provider', revision.number);
  if (!options.ignoreKeyHealth) {
    const ids = [...new Set([parsed.data.recognition.providerId, parsed.data.speech.providerId])];
    // A key that went Down on one job holds back only a bot that uses it for that job
    const usedFor = (id: string) => (['recognition', 'speech'] as const).filter((part) => parsed.data[part].providerId === id);
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
  return result(null, revision.number, parsed.data);
}
