import type { Prisma, VoiceProvider } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { readModels } from '@/lib/voice-providers';

/**
 * A bot's voice (#740): on or off (off until a person with Manage bots turns it on), a draft voice profile, and published
 * revisions of it. A bot speaks with the revision named in `bots.voice_revision`: publishing makes a new revision and rolling
 * back names an earlier one, so a revision never changes once it is published.
 *
 * The profile names the providers by id (lib/voice-providers.ts) with an exact model for each, and the voice. Every provider
 * today is one a super admin runs, so Universe AI pays; the person talking never does. Nothing here calls a provider.
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

/** The first reason a finished profile can't be used with the providers as they are now, or null. */
export function profileProblem(profile: VoiceProfile, providers: Map<string, VoiceProvider>): string | null {
  for (const part of ['recognition', 'speech'] as const) {
    const choice = profile[part];
    const provider = providers.get(choice.providerId);
    const job = part === 'recognition' ? 'listening' : 'speaking';
    if (!provider) return `The provider chosen for ${job} doesn't exist`;
    if (!provider.enabled) return `${provider.name} is off`;
    if (!provider[part]) return `${provider.name} doesn't do ${job}`;
    if (!provider.apiKeyEncrypted) return `${provider.name} has no key`;
    if (!readModels(provider.models).some((model) => model.kind === part && model.id === choice.model)) return `${provider.name} doesn't list the model ${choice.model} for ${job}`;
  }
  return null;
}

// Only the server's own providers for now: a key a person lent (#749) joins when a bot can be published with one
async function providersFor(profile: VoiceProfile): Promise<Map<string, VoiceProvider>> {
  const ids = [...new Set([profile.recognition.providerId, profile.speech.providerId])];
  const rows = await prisma.voiceProvider.findMany({ where: { id: { in: ids }, ownerId: null } });
  return new Map(rows.map((row) => [row.id, row]));
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
      voiceDraft: { select: { profile: true, updatedAt: true } },
      voiceRevisions: { orderBy: { number: 'desc' }, select: { number: true, profile: true, note: true, publishedById: true, publishedAt: true } },
      room: { select: { world: { select: { universe: { select: { allowVoiceBots: true } } } } } },
    },
  });
  if (!bot) throw new BotSettingsError(404, 'Bot not found');
  const revisions = bot.voiceRevisions.map(revisionView);
  return {
    enabled: bot.voiceEnabled,
    universeAllows: bot.room.world.universe.allowVoiceBots,
    paidBy: 'universe-ai' as const,
    revision: bot.voiceRevision,
    draft: { profile: readDraft(bot.voiceDraft?.profile), updatedAt: bot.voiceDraft?.updatedAt ?? null },
    revisions,
  };
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
    const providers = await providersFor(parsed.data);
    const problem = profileProblem(parsed.data, providers);
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
    const problem = profileProblem(parsed.data, await providersFor(parsed.data));
    if (problem) throw new BotSettingsError(409, problem);
    await tx.bot.update({ where: { id: botId }, data: { voiceRevision: number } });
  });
  return readBotVoice(botId);
}

/** Turns voice on or off. On needs the universe to allow it and a published profile that works now; off always works. */
export async function setBotVoiceEnabled(botId: string, enabled: boolean) {
  if (enabled) {
    const state = await effectiveBotVoice(botId, { ignoreSwitch: true });
    if (state.reason) throw new BotSettingsError(409, voiceReasonLine(state.reason));
  }
  await prisma.bot.update({ where: { id: botId }, data: { voiceEnabled: enabled }, select: { id: true } });
  return readBotVoice(botId);
}

export type VoiceOffReason = 'off' | 'universe' | 'no-profile' | 'provider';

const REASON_LINES: Record<VoiceOffReason, string> = {
  off: 'Voice is off for this bot',
  universe: 'This universe doesn\'t allow voice bots',
  'no-profile': 'Publish a voice profile first',
  provider: 'The providers in the voice profile don\'t work right now',
};

/** The line a person is told when voice can't be turned on. */
export const voiceReasonLine = (reason: VoiceOffReason) => REASON_LINES[reason];

/**
 * Whether the bot speaks right now and with what: voice is on for it, its universe allows voice bots, it has a published
 * profile and the providers in it still work. `reason` says which of those is not so. The bot server reads this before it
 * speaks, so a super admin turning a provider off, or a universe turning voice bots off, stops it at once.
 */
export async function effectiveBotVoice(botId: string, options: { ignoreSwitch?: boolean } = {}) {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: {
      voiceEnabled: true,
      voiceRevision: true,
      room: { select: { world: { select: { universe: { select: { allowVoiceBots: true } } } } } },
    },
  });
  if (!bot) throw new BotSettingsError(404, 'Bot not found');
  const result = (reason: VoiceOffReason | null, revision: number | null = null, profile: VoiceProfile | null = null) => ({
    speaks: reason === null,
    reason,
    paidBy: 'universe-ai' as const,
    revision,
    profile,
  });
  if (!bot.voiceEnabled && !options.ignoreSwitch) return result('off');
  if (!bot.room.world.universe.allowVoiceBots) return result('universe');
  if (bot.voiceRevision === null) return result('no-profile');
  const revision = await prisma.botVoiceRevision.findUnique({ where: { botId_number: { botId, number: bot.voiceRevision } } });
  const parsed = revision ? voiceProfileSchema.safeParse(revision.profile) : null;
  if (!revision || !parsed?.success) return result('no-profile');
  if (profileProblem(parsed.data, await providersFor(parsed.data))) return result('provider', revision.number);
  return result(null, revision.number, parsed.data);
}
