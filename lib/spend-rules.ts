import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';
import {
  draftRule,
  holdToRules,
  periodStart,
  ruleWords,
  type Ask,
  type Allowed,
  type ChargeClass,
  type DraftInput,
  type Refused,
  type RuleCovers,
  type RulePeriod,
  type RuleScope,
  type SpendAttempt,
  type SpendRule,
  type SpentSoFar,
} from '@/lib/spend-rules-values';

/**
 * Rules said in chat, held by the server (paying spec 3, part O4). A person tells a Brick "only use my accounts" or "no more than
 * $1 a month for this Brick"; the bot server turns that into a rule here; and the paid step that would break it is refused where
 * the room for it is taken (lib/meter-allowance.ts), so it holds whatever the model says later.
 *
 * Only the person who pays (or a universe's owner, for a bot the universe pays for) can make, change or end a rule. A rule never
 * falls back to somebody else's credit and never lifts a limit: it only ever makes the allowed amount smaller.
 */

type Db = Pick<typeof prisma, 'spendRule' | 'meterEvent' | 'meterReservation'>;

const toNumber = (value: bigint | number | null): number => (value === null ? 0 : Number(value));

type Row = NonNullable<Awaited<ReturnType<typeof prisma.spendRule.findUnique>>>;

const viewOf = (row: Row): SpendRule => ({
  id: row.id,
  ownerPersonId: row.ownerPersonId,
  scope: row.scope as RuleScope,
  botId: row.botId,
  taskKey: row.taskKey,
  period: row.period as RulePeriod | null,
  capMicros: row.capMicros === null ? null : Number(row.capMicros),
  onlyOwnAccounts: row.onlyOwnAccounts,
  covers: row.covers as RuleCovers,
  words: row.words,
  version: row.version,
});

/** A rule as a person sees it in a list: the sentence, where it applies, and what it counts. */
export interface RuleCard {
  id: string;
  words: string;
  scope: RuleScope;
  botId: string | null;
  botName: string | null;
  period: RulePeriod | null;
  capMicros: number | null;
  onlyOwnAccounts: boolean;
  covers: RuleCovers;
  version: number;
  at: string;
}

async function cardOf(row: Row): Promise<RuleCard> {
  const bot = row.botId ? await prisma.bot.findUnique({ where: { id: row.botId }, select: { name: true } }) : null;
  return {
    id: row.id,
    words: ruleWords(viewOf(row), bot?.name),
    scope: row.scope as RuleScope,
    botId: row.botId,
    botName: bot?.name ?? null,
    period: row.period as RulePeriod | null,
    capMicros: row.capMicros === null ? null : Number(row.capMicros),
    onlyOwnAccounts: row.onlyOwnAccounts,
    covers: row.covers as RuleCovers,
    version: row.version,
    at: row.updatedAt.toISOString(),
  };
}

/**
 * Who a rule said to a bot protects, or null when the speaker may not make rules about it. A Brick's rules are its owner's. A room bot is
 * paid for by its universe, so its owner is the one who may make rules about it. A rule about "everything I pay for" is always the
 * speaker's own, whichever bot they said it to.
 */
export async function ruleOwnerFor(botId: string, speakerId: string, scope: RuleScope | null): Promise<{ ownerPersonId: string; botName: string | null } | null> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { name: true, roomId: true, ownerId: true, deletedAt: true, room: { select: { world: { select: { universe: { select: { ownerId: true } } } } } } },
  });
  if (!bot || bot.deletedAt !== null) return null;
  if (scope === 'person') return { ownerPersonId: speakerId, botName: bot.name };
  const payer = bot.roomId === null ? bot.ownerId : (bot.room?.world.universe.ownerId ?? null);
  return payer && payer === speakerId ? { ownerPersonId: speakerId, botName: bot.name } : null;
}

export type Proposed =
  | { ok: true; rule: RuleCard; created: boolean }
  | { ok: false; reason: 'invalid'; error: string }
  | { ok: false; reason: 'needs_answer'; ask: Ask }
  | { ok: false; reason: 'not_allowed' };

/**
 * Saves a rule a person said in chat, once per message: the same message again finds the rule it made. A rule that is missing one
 * thing to be clear gets back one short question (`needs_answer`) and nothing is saved until it is answered. `sayingKey` is the bot
 * server's own id for the message (or any id that stays the same when the same message is sent twice).
 */
export async function proposeRule(input: DraftInput & { speakerId: string; sayingKey?: string | null }): Promise<Proposed> {
  // The question names the Brick it is about ("just for Scout, or all your Bricks?"), so the bot's name is read before the rule is
  const named = await prisma.bot.findUnique({ where: { id: input.botId }, select: { name: true } });
  const drafted = draftRule({ ...input, botName: input.botName ?? named?.name ?? null });
  if (!drafted.ok) return drafted;
  const draft = drafted.draft;
  const owner = await ruleOwnerFor(input.botId, input.speakerId, draft.scope);
  if (!owner) return { ok: false, reason: 'not_allowed' };
  const words = ruleWords(draft, owner.botName);
  const ruleKey = input.sayingKey ? `chat:${input.botId}:${input.sayingKey}`.slice(0, 255) : null;
  if (ruleKey) {
    const seen = await prisma.spendRule.findUnique({ where: { ruleKey } });
    if (seen) return { ok: true, rule: await cardOf(seen), created: false };
  }
  try {
    const row = await prisma.spendRule.create({
      data: {
        ruleKey: ruleKey ?? `chat:${input.botId}:${randomUUID()}`,
        ownerPersonId: owner.ownerPersonId,
        scope: draft.scope,
        botId: draft.botId,
        taskKey: draft.taskKey,
        period: draft.period,
        capMicros: draft.capMicros === null ? null : BigInt(draft.capMicros),
        onlyOwnAccounts: draft.onlyOwnAccounts,
        covers: draft.covers,
        words,
        createdById: input.speakerId,
        via: 'chat',
      },
    });
    return { ok: true, rule: await cardOf(row), created: true };
  } catch (error) {
    // Two sends of the same message at once: the first made the rule, the second finds it
    const code = (error as { code?: string } | null)?.code;
    if (ruleKey && code === 'P2002') {
      const winner = await prisma.spendRule.findUnique({ where: { ruleKey } });
      if (winner) return { ok: true, rule: await cardOf(winner), created: false };
    }
    throw error;
  }
}

/** A person's active rules, newest first; with a bot, only the ones that reach that bot (its own, and the ones for everything). */
export async function listRules(personId: string, opts: { botId?: string | null } = {}): Promise<RuleCard[]> {
  const where: Prisma.SpendRuleWhereInput = { ownerPersonId: personId, state: 'active' };
  if (opts.botId) where.OR = [{ scope: 'person' }, { botId: opts.botId }];
  const rows = await prisma.spendRule.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return Promise.all(rows.map(cardOf));
}

export type Changed = { ok: true; rule: RuleCard } | { ok: false; reason: 'not_found' | 'invalid'; error?: string };

/**
 * Corrects a rule: its amount, how long it counts, what it covers, or "only my accounts". Only the person it protects. The rule keeps
 * its place and takes the next version; what was already taken is never undone, and the new figure counts what was taken since the
 * period began.
 */
export async function changeRule(
  ruleId: string,
  ownerId: string,
  change: { capMicros?: number | null; period?: RulePeriod | null; onlyOwnAccounts?: boolean; covers?: RuleCovers },
): Promise<Changed> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`spend-rule:${ruleId}`}))`;
    const row = await tx.spendRule.findUnique({ where: { id: ruleId } });
    if (!row || row.ownerPersonId !== ownerId || row.state !== 'active') return { ok: false, reason: 'not_found' };
    const next = viewOf(row);
    if (change.capMicros !== undefined) next.capMicros = change.capMicros;
    if (change.onlyOwnAccounts !== undefined) next.onlyOwnAccounts = change.onlyOwnAccounts;
    if (change.covers !== undefined) next.covers = change.covers;
    if (change.period !== undefined) next.period = change.period;
    if (next.capMicros !== null && (!Number.isSafeInteger(next.capMicros) || next.capMicros < 0)) return { ok: false, reason: 'invalid', error: 'A cap is a whole number of millionths of a dollar, 0 or more' };
    // A cap on one task counts that task; a cap on a Brick or on everything needs to say how long
    if (next.capMicros !== null && next.scope === 'task') next.period = 'task';
    if (next.capMicros !== null && next.period === null) return { ok: false, reason: 'invalid', error: 'A cap needs to say how long it counts' };
    if (next.capMicros === null) next.period = null;
    if (next.capMicros === null && !next.onlyOwnAccounts) return { ok: false, reason: 'invalid', error: 'A rule needs a cap or "only my own accounts"' };
    const bot = row.botId ? await tx.bot.findUnique({ where: { id: row.botId }, select: { name: true } }) : null;
    next.words = ruleWords(next, bot?.name);
    const saved = await tx.spendRule.update({
      where: { id: row.id },
      data: {
        capMicros: next.capMicros === null ? null : BigInt(next.capMicros),
        period: next.period,
        onlyOwnAccounts: next.onlyOwnAccounts,
        covers: next.covers,
        words: next.words,
        version: { increment: 1 },
      },
    });
    return { ok: true, rule: await cardOf(saved) };
  });
}

/** Ends a rule; it stays in the books as ended. Only the person it protects. Asked twice it is the same. */
export async function endRule(ruleId: string, ownerId: string, now: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  const row = await prisma.spendRule.findUnique({ where: { id: ruleId } });
  if (!row || row.ownerPersonId !== ownerId) return { ok: false, reason: 'not_found' };
  if (row.state === 'active') await prisma.spendRule.updateMany({ where: { id: ruleId, state: 'active' }, data: { state: 'ended', endedAt: now, endedById: ownerId, version: { increment: 1 } } });
  return { ok: true };
}

/** What the meter's books show for the class a rule covers: Instant runs are charged as apps, a computer's time as computer. */
const spentWhere = (covers: RuleCovers): Prisma.MeterEventWhereInput =>
  covers === 'apps'
    ? { kind: 'app_use', route: 'instant' }
    : covers === 'computer'
      ? { pool: 'computer' }
      : { OR: [{ kind: 'app_use', route: 'instant' }, { pool: 'computer' }] };

/** Room held for Instant runs has a key that starts "instant:"; everything else held is a computer's. */
const INSTANT_ROOM_PREFIX = 'instant:';

const heldWhere = (covers: RuleCovers): Prisma.MeterReservationWhereInput =>
  covers === 'apps' ? { reservationKey: { startsWith: INSTANT_ROOM_PREFIX } } : covers === 'computer' ? { NOT: { reservationKey: { startsWith: INSTANT_ROOM_PREFIX } } } : {};

/** What a rule counts for a step: taken (in the books) and held (room not yet settled), for the rule's own scope and period. */
async function spentFor(db: Db, rule: SpendRule, attempt: SpendAttempt, now: Date): Promise<SpentSoFar> {
  const personKey = `person:${rule.ownerPersonId}`;
  const events: Prisma.MeterEventWhereInput[] = [{ personKey }, spentWhere(rule.covers)];
  const holds: Prisma.MeterReservationWhereInput[] = [{ personKey, state: 'held' }, heldWhere(rule.covers)];
  if (rule.scope === 'bot' && rule.botId) {
    events.push({ botId: rule.botId });
    holds.push({ botId: rule.botId });
  }
  if (rule.scope === 'task') {
    events.push({ jobId: rule.taskKey });
    holds.push({ jobId: rule.taskKey });
  }
  if (rule.period === 'task' && rule.scope !== 'task') {
    // "For each task": this step's own task. A step that belongs to no task has only itself to count
    if (!attempt.taskKey) return { spentMicros: 0, heldMicros: 0 };
    events.push({ jobId: attempt.taskKey });
    holds.push({ jobId: attempt.taskKey });
  }
  const start = rule.period ? periodStart(rule.period, now) : null;
  if (start) {
    events.push({ occurredAt: { gte: start } });
    // Room that lapsed without being settled still counts, in the period it was taken in
    holds.push({ createdAt: { gte: start } });
  }
  const [taken, held] = await Promise.all([
    db.meterEvent.aggregate({ where: { AND: events }, _sum: { costMicros: true } }),
    db.meterReservation.aggregate({ where: { AND: holds }, _sum: { amountMicros: true } }),
  ]);
  return { spentMicros: toNumber(taken._sum.costMicros), heldMicros: toNumber(held._sum.amountMicros) };
}

/**
 * Whether the rules the paying person has said let this step take what it asks. Every rule that applies must pass: the strictest
 * decides (nothing is added up and no rule lifts another). `db` is the caller's transaction when it asks while holding a lock.
 * Never throws for "no": a refusal is an answer, and it carries the rule's own sentence.
 */
export async function checkSpend(attempt: SpendAttempt, now: Date = new Date(), db: Db = prisma): Promise<Allowed | Refused> {
  const where: Prisma.SpendRuleWhereInput = { ownerPersonId: attempt.payerPersonId, state: 'active', OR: [{ scope: 'person' }] };
  if (attempt.botId) (where.OR as Prisma.SpendRuleWhereInput[]).push({ scope: 'bot', botId: attempt.botId });
  if (attempt.taskKey) (where.OR as Prisma.SpendRuleWhereInput[]).push({ scope: 'task', taskKey: attempt.taskKey });
  const rows = await db.spendRule.findMany({ where });
  if (rows.length === 0) return { ok: true };
  const rules = rows.map(viewOf);
  const spent = new Map<string, SpentSoFar>();
  for (const rule of rules) {
    if (rule.capMicros !== null) spent.set(rule.id, await spentFor(db, rule, attempt, now));
  }
  return holdToRules(rules, attempt, (rule) => spent.get(rule.id) ?? { spentMicros: 0, heldMicros: 0 });
}

/**
 * Whether the Brick's own owner may start paid work at all under what they said: asked before a job exists, so Brick can say so at once
 * instead of leaving a job waiting for room it was never going to get. Only the owner starts work on a Brick, so anyone else is let
 * through here (the start itself answers "not the owner") and their rules, which are about their own credit, are not read for it.
 * The step's own room is held to the same rules again where it is taken.
 */
export async function ownerSpendAllowed(botId: string, personId: string, chargeClass: ChargeClass = 'computer', now: Date = new Date(), runId: string | null = null): Promise<Allowed | Refused> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  if (!bot || !ownsBrick(bot, personId)) return { ok: true };
  // A run that already has its job asks for nothing new: asked again it finds that job (and the room it holds is already counted, so a cap
  // that room used up exactly must not hide the job the person already has)
  if (runId && (await prisma.computerJob.findUnique({ where: { botId_runId: { botId, runId } }, select: { id: true } }))) return { ok: true };
  return checkSpend({ payerPersonId: personId, botId, taskKey: null, chargeClass, amountMicros: 1 }, now);
}

export { INSTANT_ROOM_PREFIX };
export type { ChargeClass };
