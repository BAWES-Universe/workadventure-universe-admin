import { createHash } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { UNIVERSE_AI_REF } from '@/lib/universe-ai';
import { readMeterSettings, basisOfCall, personKeyOf, type MeterEventInput, type MeterSettings } from '@/lib/meter-values';

/**
 * The meter's books (game #1998, Brick 7), written. Every writer goes through `recordMeterEvent`: the one write path, once
 * under an event id. It runs in shadow: it records, nothing waits for it and nothing new is stopped by it.
 */

type Db = Pick<typeof prisma, 'meterEvent'>;

const SETTING_KEY = 'meter';

/** The meter's settings as a super admin saved them: empty where nothing was set. A read that fails is logged and reads as empty, so a reply never fails over the books. */
export async function getMeterSettings(db: Pick<typeof prisma, 'appSetting'> = prisma): Promise<MeterSettings> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: SETTING_KEY } });
    return readMeterSettings(row?.value);
  } catch (error) {
    console.error('[Meter] Could not read the settings:', error instanceof Error ? error.message : 'unknown');
    return readMeterSettings(null);
  }
}

/** Saves a super admin's change on top of what is saved (only the names it carries change) and returns all of them. */
export async function saveMeterSettings(change: Partial<MeterSettings>, userId: string): Promise<MeterSettings> {
  return prisma.$transaction(async (tx) => {
    // One super admin's save at a time, so two saves of different values never undo each other
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('meter:settings'))`;
    const row = await tx.appSetting.findUnique({ where: { key: SETTING_KEY } });
    const saved = row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? (row.value as Record<string, unknown>) : {};
    const next: Record<string, unknown> = { ...saved };
    for (const [key, value] of Object.entries(change)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    const value = next as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
    return readMeterSettings(next);
  });
}

export interface RecordedEvent {
  /** False when this event id was written before: nothing was added. */
  recorded: boolean;
  /** True when the id was written before with different figures. The first write stands, and the writer has a bug to find. */
  conflict: boolean;
}

/**
 * Writes one event once. The same event id again (a retry, a reconnect, a second server) adds nothing and says so; the same id
 * with other figures adds nothing either, and says that too, so a writer that reuses an id shows up instead of hiding.
 */
export async function recordMeterEvent(input: MeterEventInput, db: Db = prisma): Promise<RecordedEvent> {
  const { count } = await db.meterEvent.createMany({
    data: [
      {
        eventId: input.eventId,
        kind: input.kind,
        pool: input.pool,
        occurredAt: input.occurredAt,
        personKey: input.personKey,
        personId: input.personId,
        botId: input.botId,
        brick: input.brick,
        payerKind: input.payerKind,
        payerPersonId: input.payerPersonId,
        route: input.route,
        jobId: input.jobId,
        quantity: BigInt(input.quantity),
        unit: input.unit,
        costMicros: input.costMicros === null ? null : BigInt(input.costMicros),
        basis: input.basis,
        sourceRef: input.sourceRef,
        detail: (input.detail ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    ],
    skipDuplicates: true,
  });
  if (count > 0) return { recorded: true, conflict: false };
  const first = await db.meterEvent.findUnique({ where: { eventId: input.eventId } });
  const same =
    !!first &&
    first.kind === input.kind &&
    first.personKey === input.personKey &&
    first.botId === input.botId &&
    first.unit === input.unit &&
    Number(first.quantity) === input.quantity &&
    (first.costMicros === null ? null : Number(first.costMicros)) === input.costMicros &&
    first.jobId === input.jobId;
  return { recorded: false, conflict: !same };
}

/** What the books say about a bot: whether it is a Brick (it has no room) and whose. Null when it is not found. */
export async function describeBot(botId: string, db: Pick<typeof prisma, 'bot'> = prisma): Promise<{ brick: boolean; ownerId: string | null } | null> {
  const bot = await db.bot.findUnique({ where: { id: botId }, select: { roomId: true, ownerId: true } });
  return bot ? { brick: bot.roomId === null, ownerId: bot.ownerId } : null;
}

/** The usage row and its request, as the ai-usage route has them after saving. */
export interface ModelCallFacts {
  usageRowId: number | string;
  botId: string;
  /** The bot server's own id for this call, when it sends one, so a retried report is one event. */
  clientEventId?: string | null;
  providerId: string;
  /** What the bot asked to run on: Universe AI, a provider of ours or a key someone lent or owns. */
  sentProviderId?: string | null;
  keyOwnerId: string | null;
  talkedUserId: string | null;
  talkedPersonId: string | null;
  talkedGuest: boolean | null;
  channel: string | null;
  tokensUsed: number;
  apiCalls: number;
  error: boolean;
  greeting: boolean;
  costBasis: string | null;
  costMicros: number | null;
  tokens?: { input?: number | null; cached?: number | null; cacheWrite?: number | null; output?: number | null; reasoning?: number | null };
  occurredAt: Date;
  /** The run the bot server named for the call, as it sent it: the event's id is made from it, so a retried report has the same id whatever a lookup said. */
  runKey?: string | null;
  /** That run, once checked to be this Brick's own: only this goes in the event's detail. Empty when it was not checked or could not be (a lookup that failed once). */
  runId?: string | null;
}

/**
 * The event id of a call a run made: the Brick, the run as the bot server sent it (with its length) and the call's own id, so two Bricks can never share one
 * even when they send the same run and call ids. One that would not fit is made from a hash of all three, never cut short (a cut could join two).
 */
export function runCallEventId(botId: string, runKey: string, callId: string): string {
  // The run key's length goes in front of it, so what comes after it can never be read as part of it (and two different pairs never make one id)
  const whole = `run:${botId}:${runKey.length}:${runKey}:model:${callId}`;
  return whole.length <= 255 ? whole : `run:${createHash('sha256').update(whole).digest('hex')}`;
}

/**
 * Writes a model call from the place it is already counted (the usage row of POST /api/bots/ai-usage). The person is who talked
 * (a Brick's own person when nobody did), the payer is whoever's key ran it or us, and the figure says how sure its cost is.
 * Never throws: the books are never a reason a reply or its usage report fails.
 */
export async function recordModelCall(facts: ModelCallFacts, db: Db & Pick<typeof prisma, 'bot'> = prisma): Promise<RecordedEvent | null> {
  try {
    const bot = await describeBot(facts.botId, db);
    // Who asked: the person who talked; for a Brick nobody talked to (a job it ran on its own), its owner
    const personId = facts.talkedPersonId ?? (!facts.talkedUserId && bot?.brick ? bot.ownerId : null);
    const guestId = !personId && facts.talkedGuest !== false ? facts.talkedUserId : null;
    const paidByOther = facts.keyOwnerId !== null;
    const route = facts.sentProviderId === UNIVERSE_AI_REF ? 'universe-ai' : paidByOther ? 'own-key' : 'provider';
    return await recordMeterEvent(
      {
        // A call a run made is under the run's own id as the bot server sent it (never as a lookup answered it), so a retried report is still one event
        eventId: facts.runKey
          ? runCallEventId(facts.botId, facts.runKey, facts.clientEventId ?? `row-${facts.usageRowId}`)
          : facts.clientEventId
            ? `model:${facts.botId}:${facts.clientEventId}`.slice(0, 255)
            : `ai-usage:${facts.usageRowId}`,
        kind: 'model_call',
        pool: 'chat',
        occurredAt: facts.occurredAt,
        personKey: personKeyOf({ personId, guestId }),
        personId,
        botId: facts.botId,
        brick: bot ? bot.brick : null,
        payerKind: paidByOther ? 'person' : 'universe',
        payerPersonId: facts.keyOwnerId,
        route,
        jobId: null,
        quantity: Math.max(0, Math.trunc(facts.apiCalls)),
        unit: 'call',
        costMicros: facts.costMicros,
        basis: basisOfCall(facts.costBasis, paidByOther, facts.costMicros),
        sourceRef: `bots_ai_usage:${facts.usageRowId}`,
        // Enough to compare with today's counts and the provider's own figures; never anything anybody said
        detail: {
          providerId: facts.providerId,
          channel: facts.channel,
          error: facts.error,
          greeting: facts.greeting,
          ...(facts.runId ? { runId: facts.runId } : {}),
          // Attributed to a Brick's owner because nobody talked to it: today's reply counts have no person for these, so shadow checks leave them out
          byOwner: !facts.talkedPersonId && personId !== null,
          tokensUsed: facts.tokensUsed,
          ...(facts.tokens ? { tokens: facts.tokens } : {}),
        },
      },
      db,
    );
  } catch (error) {
    console.error('[Meter] Could not record a model call:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/**
 * The provider's settlement covered everything recorded up to this moment: those events are settled and no longer "not yet
 * settled" in the envelope. Safe to say twice. Returns how many it settled.
 */
export async function settleEventsThrough(through: Date, db: Db = prisma): Promise<number> {
  const { count } = await db.meterEvent.updateMany({ where: { settledAt: null, occurredAt: { lte: through } }, data: { settledAt: new Date() } });
  return count;
}
