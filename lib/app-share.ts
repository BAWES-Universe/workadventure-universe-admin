import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { startOfDay } from '@/lib/app-uses';
import { getBrickLimits } from '@/lib/bot-limits';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { recordMeterEvent } from '@/lib/meter';
import { personKeyOf } from '@/lib/meter-values';

/**
 * Other people asking a Brick for a job from its owner's app (game #2006, mock Part 17, plan F4.3 and H3 change 3). Written once
 * here, and read again by the owner's pages (lib/app-share-owner.ts).
 *
 * What is shared is a job, never the app: the owner picks tools, the names of the inputs people may fill in, and the names of what
 * may come back. Everything else of the app stays the owner's, and every ask is checked here, on every use, so stopping,
 * un-picking a job or taking the app away reaches a chat that is already open (checks 32 and 54).
 *
 * A use is one try by someone else that runs a shared job. A try is written once under the bot server's call id, inside the same
 * transaction as its meter event (check 23), after the day's room is taken under a lock, so two last uses at once can never both
 * run. The same call id again never runs the job again (check 31). A try that failed gives its use back only when the bot server
 * says it is confirmed failed (it looked up what happened first); a timeout is no refund by itself, and what the try cost is
 * still recorded.
 */

/** The tool headings a job can sit under: looking something up or making something new. Changing, deleting and sending stay the owner's. */
export const SHAREABLE_HEADINGS = ['looksUp', 'makesNew'] as const;

/** Only an app added with a link and a key, a token or nothing can be shared. One signed in as the person stays theirs alone. */
export function isAppShareable(connection: { ownerId: string | null; source: string; authType: string }): boolean {
  return !!connection.ownerId && connection.source === 'link' && connection.authType !== 'oauth';
}

export type SharedRefusal = 'not_shared' | 'incomplete' | 'limit_reached' | 'busy' | 'already_asked' | 'gone';

export type SharedVerdict =
  | { allowed: true; ownerId: string; /** Names of the fields that may come back, or null for the whole answer. */ returns: string[] | null; ownerNote?: OwnerNote }
  | { allowed: false; reason: SharedRefusal; /** When today's uses are back, for the kind line the asker reads. */ resetsAt?: Date; /** For `already_asked`: what the first try came to. */ earlier?: string; ownerNote?: OwnerNote };

/**
 * What the bot server needs to tell the owner, in their own chat with the Brick, that today's uses for other people ran out (game
 * #2006, mock Part 17 picture 6). Only on the ask that made the day's note (once a day, never one per person): it is the same moment
 * the owner's notice in Orbit is made.
 */
export interface OwnerNote {
  /** The owner's chat id, for the direct chat the two share. */
  matrixUserId: string;
  appName: string;
  botName: string;
  limit: number;
  connectionId: string;
  /** The day (UTC, YYYY-MM-DD) whose uses ran out, as decided here: the bot server makes its message id from it, so the same day's note is one message and the next day's is another. */
  day: string;
}

export interface SharedAsk {
  requesterKey?: string;
  callId?: string;
  tool?: string;
  /** Names of the inputs this ask carries, never their values. */
  argumentNames?: string[];
}

/** A job still counts as shared only while its tool is confirmed, is the same tool that was picked, and sits under a heading that may be shared. One rule for what is listed and what runs. */
const isSharedTool = (tool: { fingerprint: string; heading: string | null; confirmedAt: Date | null } | null | undefined, pickedFingerprint: string): boolean =>
  !!tool && !!tool.confirmedAt && tool.fingerprint === pickedFingerprint && (SHAREABLE_HEADINGS as readonly string[]).includes(tool.heading ?? '');

/** The jobs on a grant read with its share, its jobs and its tools, as the bot server is told them: only a job whose tool is still the one that was picked. Nothing when it is not shared. */
export function sharedJobsOf(grant: { share?: { jobs: { toolName: string; fingerprint: string; inputs: Prisma.JsonValue; returns: Prisma.JsonValue | null }[] } | null; tools?: { name: string; fingerprint: string; heading: string | null; confirmedAt: Date | null }[] }): { shared?: { jobs: { tool: string; inputs: string[]; returns: string[] | null }[] } } {
  if (!grant.share) return {};
  const tools = new Map((grant.tools ?? []).map((tool) => [tool.name, tool]));
  const jobs = grant.share.jobs
    .filter((job) => isSharedTool(tools.get(job.toolName), job.fingerprint))
    .map((job) => ({ tool: job.toolName, inputs: stringList(job.inputs) ?? [], returns: stringList(job.returns) }));
  return { shared: { jobs } };
}

/** Midnight UTC after `now`: when a day's uses are back. */
export const nextDay = (now: Date): Date => new Date(startOfDay(now).getTime() + 24 * 60 * 60 * 1000);

const stringList = (value: Prisma.JsonValue | null | undefined): string[] | null =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null;

/** Who is asking, as the meter keeps them: a signed-in person, a guest by their own id, or nobody we could name. */
export async function askerKeyOf(requesterKey: string | undefined): Promise<string> {
  if (!requesterKey) return personKeyOf({});
  const user = await findUserByIdentifier(requesterKey);
  if (user && !user.isGuest) return personKeyOf({ personId: user.id });
  return personKeyOf({ guestId: requesterKey });
}

/**
 * The check for someone else asking a Brick for a shared job, or null when this grant has no share (the caller refuses it as it
 * always has). `grant` is the Brick's use of the app. Never says what is in the app or whose it is.
 */
export async function checkSharedUse(
  grant: { id: string; botId: string; connectionId: string },
  connectionName: string,
  botName: string,
  ask: SharedAsk,
): Promise<SharedVerdict | null> {
  const found = await prisma.appShare.findUnique({ where: { serverId: grant.id }, select: { id: true } });
  if (!found) return null;
  // A use that cannot be counted, or held to what was picked, never runs
  // ... nor does one that cannot say who is asking: unnamed askers would all share one "unknown" person's day
  if (!ask.callId || !ask.tool || !ask.argumentNames || !ask.requesterKey) return { allowed: false, reason: 'incomplete' };
  const owner = await prisma.appConnection.findUnique({ where: { id: grant.connectionId }, select: { ownerId: true } });
  if (!owner?.ownerId) return { allowed: false, reason: 'gone' };
  const askerKey = await askerKeyOf(ask.requesterKey);
  const limits = await getBrickLimits();
  // What was picked and the limits are read again inside, under the share's lock: an owner who changes them while an ask is on its
  // way is never answered with the old ones
  const outcome = await reserve({ shareId: found.id, grant, ownerId: owner.ownerId, askerKey, callId: ask.callId, tool: ask.tool, argumentNames: ask.argumentNames, limits });
  switch (outcome.kind) {
    case 'gone':
      return { allowed: false, reason: 'gone' };
    case 'not_shared':
      return { allowed: false, reason: 'not_shared' };
    case 'again':
      return { allowed: false, reason: outcome.busy ? 'busy' : 'already_asked', earlier: outcome.status };
    case 'busy':
      return { allowed: false, reason: 'busy' };
    case 'limit': {
      const ownerNote = outcome.which === 'everyone' ? await tellOwnerOfLimit({ shareId: found.id, ownerId: owner.ownerId, connectionId: grant.connectionId, botId: grant.botId, serverId: grant.id, appName: connectionName, botName, limit: outcome.limit, at: outcome.at }) : undefined;
      return { allowed: false, reason: 'limit_reached', resetsAt: nextDay(outcome.at), ...(ownerNote ? { ownerNote } : {}) };
    }
    default: {
      // The use that takes the last of the day's uses tells the owner now, not only when someone is turned away
      const ownerNote = outcome.lastOfDay !== null ? await tellOwnerOfLimit({ shareId: found.id, ownerId: owner.ownerId, connectionId: grant.connectionId, botId: grant.botId, serverId: grant.id, appName: connectionName, botName, limit: outcome.lastOfDay, at: outcome.at }) : undefined;
      return { allowed: true, ownerId: owner.ownerId, returns: outcome.returns, ...(ownerNote ? { ownerNote } : {}) };
    }
  }
}

type ReserveOutcome =
  | { kind: 'recorded'; returns: string[] | null; lastOfDay: number | null; at: Date }
  | { kind: 'not_shared' }
  | { kind: 'again'; status: string; busy: boolean }
  | { kind: 'busy' }
  | { kind: 'limit'; which: 'everyone' | 'person'; limit: number; at: Date }
  | { kind: 'gone' };

type Limits = Awaited<ReturnType<typeof getBrickLimits>>;

/**
 * Takes a place for one try, once. Under one lock for the share: the same call id again is `again` and runs nothing (and counts
 * against how many repeats are allowed); the quiet ceilings (tries in an hour, jobs at once) and the two daily limits are read and
 * the try is written together with its meter event, so a failed meter write leaves no try behind and nothing runs without being
 * written to the books. The share's own rows are held shared, so a stop that comes in waits for this one or finds the share gone.
 */
async function reserve(input: { shareId: string; grant: { id: string; botId: string; connectionId: string }; ownerId: string; askerKey: string; callId: string; tool: string; argumentNames: string[]; limits: Limits }): Promise<ReserveOutcome> {
  const { shareId, grant, askerKey, callId, limits } = input;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`app-share:${grant.id}`}))`;
    // The same first lock as taking an app back or removing a grant: the app's own row, then the grant's, then the share's
    const app = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "app_connections" WHERE "id" = ${grant.connectionId} FOR SHARE`;
    if (app.length === 0) return { kind: 'gone' } as const;
    const held = await tx.$queryRaw<{ id: string; enabled: boolean }[]>`SELECT s."id", g."enabled" FROM "app_shares" s JOIN "bot_mcp_servers" g ON g."id" = s."server_id" WHERE s."id" = ${shareId} AND g."id" = ${grant.id} AND g."bot_id" = ${grant.botId} FOR SHARE OF s, g`;
    // A grant switched off since the check before the lock is gone too
    if (held.length === 0 || !held[0].enabled) return { kind: 'gone' } as const;

    // The share as it is now (a change holds it for update, so it is never half done here): the picked job, its inputs and the limits
    const share = await tx.appShare.findUniqueOrThrow({ where: { id: shareId }, include: { jobs: true } });
    const job = share.jobs.find((entry) => entry.toolName === input.tool);
    if (!job) return { kind: 'not_shared' } as const;
    const tool = await tx.botMcpTool.findUnique({ where: { serverId_name: { serverId: grant.id, name: input.tool } } });
    // A tool that changed since it was picked, was moved to a heading that is not shareable, or is not confirmed any more, is not shared
    if (!isSharedTool(tool, job.fingerprint)) return { kind: 'not_shared' } as const;
    const inputs = stringList(job.inputs) ?? [];
    if (input.argumentNames.some((name) => !inputs.includes(name))) return { kind: 'not_shared' } as const;

    const now = new Date();
    const seen = await tx.appShareUse.findUnique({ where: { serverId_callId: { serverId: grant.id, callId } } });
    if (seen) {
      // A repeat never runs the job. Past the number of repeats allowed it is turned away as busy, so a loop of retries stops
      if (seen.retries >= limits.sharedRetries) return { kind: 'again', status: seen.status, busy: true } as const;
      await tx.appShareUse.update({ where: { id: seen.id }, data: { retries: { increment: 1 } } });
      return { kind: 'again', status: seen.status, busy: false } as const;
    }

    // The books outlast a share. If sharing was stopped and started again after this call was accepted, a retry of it finds no use
    // row under the new share but finds its meter event: it is a repeat, and runs nothing.
    const earlier = await tx.meterEvent.findUnique({ where: { eventId: `app:${grant.botId}:${callId}` }, select: { id: true } });
    if (earlier) return { kind: 'again', status: 'unknown', busy: false } as const;

    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const staleBefore = new Date(now.getTime() - limits.sharedJobMinutes * 60 * 1000);
    const [tries, running] = await Promise.all([
      tx.appShareUse.count({ where: { serverId: grant.id, createdAt: { gte: hourAgo } } }),
      tx.appShareUse.count({ where: { serverId: grant.id, status: { in: ['running', 'unknown'] }, createdAt: { gte: staleBefore } } }),
    ]);
    if (tries >= limits.sharedTriesPerHour || running >= limits.sharedJobsAtOnce) return { kind: 'busy' } as const;

    // A use given back (refunded) is not counted; a running, done or unknown try is
    const counted = { serverId: grant.id, createdAt: { gte: startOfDay(now) }, status: { not: 'refunded' } };
    const [everyone, person] = await Promise.all([tx.appShareUse.count({ where: counted }), tx.appShareUse.count({ where: { ...counted, askerKey } })]);
    if (everyone >= share.usesPerDayEveryone) return { kind: 'limit', which: 'everyone', limit: share.usesPerDayEveryone, at: now } as const;
    if (person >= share.usesPerDayPerson) return { kind: 'limit', which: 'person', limit: share.usesPerDayPerson, at: now } as const;

    await tx.appShareUse.create({ data: { serverId: grant.id, callId, askerKey, toolName: input.tool, status: 'running', createdAt: now } });
    // The books, in the same step. The tool is the owner's, so what it costs is the owner's; the cost of an app added by a link is not
    // known to us, so it is said as not known and paid by someone else, never as free. A repeat of this id writes nothing.
    await recordMeterEvent(
      {
        eventId: `app:${grant.botId}:${callId}`,
        kind: 'app_use',
        pool: 'chat',
        occurredAt: now,
        personKey: askerKey,
        personId: askerKey.startsWith('person:') ? askerKey.slice('person:'.length) : null,
        botId: grant.botId,
        brick: true,
        payerKind: 'person',
        payerPersonId: input.ownerId,
        route: 'app',
        jobId: null,
        quantity: 1,
        unit: 'use',
        costMicros: null,
        basis: 'paid_by_other',
        sourceRef: null,
        // Which tool was asked for, never what it was asked with
        detail: { shared: true, tool: input.tool },
      },
      tx,
    );
    return { kind: 'recorded', returns: stringList(job.returns), lastOfDay: everyone + 1 >= share.usesPerDayEveryone ? share.usesPerDayEveryone : null, at: now } as const;
  });
}

/**
 * The owner is told once a day that today's uses ran out for other people, with what they need to change the limit. Never throws.
 * Returns what the bot server needs to say it in the owner's own chat with the Brick, only for the one ask that made the day's note
 * (and only when the owner has a chat id): every other ask that day returns nothing, so the owner is told once, not once per person.
 */
async function tellOwnerOfLimit(input: { shareId: string; ownerId: string; connectionId: string; botId: string; serverId: string; appName: string; botName: string; limit: number; at: Date }): Promise<OwnerNote | undefined> {
  try {
    // The day is the one whose uses ran out (when the ask was decided), even when this runs a moment after midnight
    const day = input.at.toISOString().slice(0, 10);
    // The owner's chat is read before the notice is claimed: when this fails nothing was claimed, so a later ask tries again
    const owner = await prisma.user.findUnique({ where: { id: input.ownerId }, select: { matrixChatId: true } });
    // The day's uses are counted again under the share's lock, the one a refund settles under: a use given back between taking the
    // last place and getting here leaves the day open, and then no note is made (taking it back would find nothing to take)
    const added = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`app-share:${input.serverId}`}))`;
      const share = await tx.appShare.findUnique({ where: { id: input.shareId }, select: { usesPerDayEveryone: true } });
      if (!share) return false;
      const used = await tx.appShareUse.count({ where: { serverId: input.serverId, createdAt: { gte: startOfDay(input.at), lt: nextDay(input.at) }, status: { not: 'refunded' } } });
      if (used < share.usesPerDayEveryone) return false;
      // Skipping a duplicate (rather than catching it) keeps this step usable inside the transaction
      const made = await tx.userNotice.createMany({
        data: [
          {
            userId: input.ownerId,
            kind: 'app-share-limit',
            dedupeKey: `app-share-limit:${input.shareId}:${day}`,
            title: `${input.appName} used up today's ${input.limit} uses for other people`.slice(0, 200),
            body: `${input.botName} carries on without it for them until tomorrow. You can change the limit.`.slice(0, 1000),
            data: { connectionId: input.connectionId, botId: input.botId, serverId: input.serverId },
          },
        ],
        skipDuplicates: true,
      });
      return made.count > 0;
    });
    if (!added || !owner?.matrixChatId) return undefined;
    return { matrixUserId: owner.matrixChatId, appName: input.appName, botName: input.botName, limit: input.limit, connectionId: input.connectionId, day };
  } catch (error) {
    console.error('[AppShare] Could not tell the owner about the limit:', error instanceof Error ? error.message : 'unknown');
    return undefined;
  }
}

/** Takes back today's "used up" note for a share when a refund leaves uses over. Only today's: a note of a day that is past stays. */
async function takeBackDayNote(tx: Prisma.TransactionClient, serverId: string, tookAt: Date, now: Date): Promise<void> {
  if (startOfDay(tookAt).getTime() !== startOfDay(now).getTime()) return;
  const share = await tx.appShare.findUnique({ where: { serverId }, select: { id: true, usesPerDayEveryone: true } });
  if (!share) return;
  const used = await tx.appShareUse.count({ where: { serverId, createdAt: { gte: startOfDay(now) }, status: { not: 'refunded' } } });
  if (used >= share.usesPerDayEveryone) return;
  await tx.userNotice.deleteMany({ where: { kind: 'app-share-limit', dedupeKey: `app-share-limit:${share.id}:${now.toISOString().slice(0, 10)}` } });
}

/** What the bot server says a try came to, once it knows. `failed` means confirmed failed: it looked up what happened and nothing was done. */
export const SETTLE_OUTCOMES = ['done', 'failed', 'unknown'] as const;
export type SettleOutcome = (typeof SETTLE_OUTCOMES)[number];

export type SettleResult = { status: 'settled'; now: string } | { status: 'not_found' } | { status: 'conflict'; now: string };

/**
 * Settles a try. `done` keeps the use. `unknown` (a timeout, a lost answer) keeps it too and never gives it back by itself: the
 * try stays counted and is never run again. `failed`, only once the failure is confirmed and anything uncertain is settled, gives
 * the use back (what the try cost stays in the books). A try that finished cannot be given back, and one given back cannot finish.
 */
export async function settleSharedUse(botId: string, serverId: string, callId: string, outcome: SettleOutcome): Promise<SettleResult> {
  return prisma.$transaction(async (tx) => {
    // By the Brick's use of the app, not by the share: a job that was on its way when sharing was stopped still settles
    const grant = await tx.botMcpServer.findFirst({ where: { id: serverId, botId }, select: { id: true } });
    if (!grant) return { status: 'not_found' } as const;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`app-share:${serverId}`}))`;
    const use = await tx.appShareUse.findUnique({ where: { serverId_callId: { serverId, callId } } });
    if (!use) return { status: 'not_found' } as const;
    const now = new Date();
    const to = outcome === 'failed' ? 'refunded' : outcome;
    if (use.status === to) return { status: 'settled', now: use.status } as const;
    if (outcome === 'failed') {
      if (use.status === 'done') return { status: 'conflict', now: use.status } as const;
    } else if (outcome === 'done') {
      if (use.status === 'refunded') return { status: 'conflict', now: use.status } as const;
    } else if (use.status !== 'running') {
      // "Unknown" never overrides a try that is already settled either way
      return { status: 'settled', now: use.status } as const;
    }
    await tx.appShareUse.update({ where: { id: use.id }, data: { status: to, settledAt: now } });
    // The day's note ("used up for today") was made when the last use was taken. A use given back, because the job never ran, leaves
    // the day open: that note is taken back (what the owner was told is no longer so), and the next time the day runs out it is made again
    if (to === 'refunded') await takeBackDayNote(tx, serverId, use.createdAt, now);
    return { status: 'settled', now: to } as const;
  });
}
