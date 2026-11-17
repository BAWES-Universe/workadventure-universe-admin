import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
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
  type RuleDraft,
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

type Db = Pick<typeof prisma, 'spendRule' | 'meterEvent' | 'meterReservation' | 'creditHold' | 'appSetting'> & Partial<Pick<Prisma.TransactionClient, '$executeRaw'>>;

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
  | { ok: false; reason: 'not_allowed' }
  /** The same message id already made a rule that means something else: it is not that message again, so nothing is saved or shown. */
  | { ok: false; reason: 'key_reused' };

/**
 * Whether a stored rule is what this message says (a replay of it). A rule the person has corrected since (a later version) is theirs
 * to have changed, and the same message again still finds it.
 */
function isReplayOf(row: Prisma.SpendRuleGetPayload<object>, draft: RuleDraft, ownerPersonId: string): boolean {
  if (row.ownerPersonId !== ownerPersonId) return false;
  if (row.version > 1) return true;
  return (
    row.scope === draft.scope &&
    row.botId === draft.botId &&
    row.taskKey === draft.taskKey &&
    row.period === draft.period &&
    (row.capMicros === null ? null : Number(row.capMicros)) === draft.capMicros &&
    row.onlyOwnAccounts === draft.onlyOwnAccounts &&
    row.covers === draft.covers
  );
}

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
  // The speaker is in the key: the same message id said by two people (on a Brick they both talk to) is two different rules, and one
  // person's replay never finds, or shows, another person's rule
  const ruleKey = input.sayingKey ? `chat:${input.botId}:${input.speakerId}:${input.sayingKey}`.slice(0, 255) : null;
  if (ruleKey) {
    const seen = await prisma.spendRule.findUnique({ where: { ruleKey } });
    if (seen) return isReplayOf(seen, draft, owner.ownerPersonId) ? { ok: true, rule: await cardOf(seen), created: false } : { ok: false, reason: 'key_reused' };
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
      if (winner) return isReplayOf(winner, draft, owner.ownerPersonId) ? { ok: true, rule: await cardOf(winner), created: false } : { ok: false, reason: 'key_reused' };
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

/**
 * What a rule counts, by the class of credit it covers. A computer's time is in the meter's books (events and reservations); Instant
 * Apps credit is in the funding books (credit holds: held room, and what a settled hold really took from credit, less what was given
 * back). Each class is counted from the books that charge it, so the rule sees exactly what the person's credit paid.
 */
const wantsComputer = (covers: RuleCovers): boolean => covers === 'computer' || covers === 'all';
const wantsApps = (covers: RuleCovers): boolean => covers === 'apps' || covers === 'all';

/**
 * A model call whose price was not known settled the room it held and wrote its event with no cost: it still took that room, so a rule
 * counts the room, never 0. The reservation of a call is named from its event (see lib/computer-calls.ts).
 */
async function unpricedCallRoom(db: Db, events: Prisma.MeterEventWhereInput[]): Promise<number> {
  const unpriced = await db.meterEvent.findMany({ where: { AND: [...events, { kind: 'model_call', costMicros: null }] }, select: { eventId: true } });
  const keys = unpriced
    .map((row) => /^computer:(.+):call:(.+)$/.exec(row.eventId))
    .filter((found): found is RegExpExecArray => found !== null)
    .map((found) => `computer:call:${found[1]}:${found[2]}`);
  if (keys.length === 0) return 0;
  const rooms = await db.meterReservation.aggregate({ where: { reservationKey: { in: keys }, state: 'settled' }, _sum: { settledMicros: true } });
  return toNumber(rooms._sum.settledMicros);
}

/**
 * What held room can still cost, for a rule. A job that keeps running renews its room so that it always holds the time already used plus one
 * more stretch (lib/meter-allowance.ts `renewRoom`, R9: a renewal adds only what is not held yet), so the room IS what the task can still cost
 * and counts whole, whether it was taken once (a model call, a first stretch) or renewed. `renewMinutes`, `now` and the dates stay in the
 * signature for callers; they no longer change the figure.
 */
export function exposureOf(rows: ReadonlyArray<{ amountMicros: bigint; renewals: number; createdAt: Date; expiresAt: Date }>, _renewMinutes: number, _now: Date): number {
  let total = 0;
  for (const row of rows) total += toNumber(row.amountMicros);
  return total;
}

/** What a rule counts for a step: taken (in the books) and held (room not yet settled), for the rule's own scope and period. */
async function spentFor(db: Db, rule: SpendRule, attempt: SpendAttempt, now: Date): Promise<SpentSoFar> {
  const personKey = `person:${rule.ownerPersonId}`;
  // Only what the platform's credit paid: a call on someone's own key (or paid by another person) took none of this person's credit
  const events: Prisma.MeterEventWhereInput[] = [{ personKey }, { pool: 'computer' }, { payerKind: 'universe' }];
  const holds: Prisma.MeterReservationWhereInput[] = [{ personKey, state: 'held' }];
  const credit: Prisma.CreditHoldWhereInput[] = [{ personId: rule.ownerPersonId, category: 'instant_apps' }];
  if (rule.scope === 'bot' && rule.botId) {
    events.push({ botId: rule.botId });
    holds.push({ botId: rule.botId });
    credit.push({ botId: rule.botId });
  }
  if (rule.scope === 'task') {
    events.push({ jobId: rule.taskKey });
    holds.push({ jobId: rule.taskKey });
    credit.push({ jobKey: rule.taskKey });
  }
  if (rule.period === 'task' && rule.scope !== 'task') {
    // "For each task": this step's own task. A step that belongs to no task has only itself to count
    if (!attempt.taskKey) return { spentMicros: 0, heldMicros: 0 };
    events.push({ jobId: attempt.taskKey });
    holds.push({ jobId: attempt.taskKey });
    credit.push({ jobKey: attempt.taskKey });
  }
  const start = rule.period ? periodStart(rule.period, now) : null;
  if (start) {
    events.push({ occurredAt: { gte: start } });
    // Room that lapsed without being settled still counts, in the period it was taken in
    holds.push({ createdAt: { gte: start } });
    credit.push({ createdAt: { gte: start } });
  }
  let spentMicros = 0;
  let heldMicros = 0;
  if (wantsComputer(rule.covers)) {
    const [taken, held, unpriced, settings] = await Promise.all([
      db.meterEvent.aggregate({ where: { AND: events }, _sum: { costMicros: true } }),
      db.meterReservation.findMany({ where: { AND: holds }, select: { amountMicros: true, renewals: true, createdAt: true, expiresAt: true } }),
      unpricedCallRoom(db, events),
      getMeterSettings(db),
    ]);
    spentMicros += toNumber(taken._sum.costMicros) + unpriced;
    heldMicros += exposureOf(held, settings.renewMinutes, now);
  }
  if (wantsApps(rule.covers)) {
    const [settled, held] = await Promise.all([
      db.creditHold.aggregate({ where: { AND: [...credit, { state: 'settled' }] }, _sum: { customerMicros: true, refundedMicros: true } }),
      db.creditHold.aggregate({ where: { AND: [...credit, { state: 'held' }] }, _sum: { amountMicros: true } }),
    ]);
    spentMicros += Math.max(0, toNumber(settled._sum.customerMicros) - toNumber(settled._sum.refundedMicros));
    heldMicros += toNumber(held._sum.amountMicros);
  }
  return { spentMicros, heldMicros };
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
  // One rule can cover both computers and Instant Apps, whose rooms are taken under different locks (the meter's pool, the person's
  // credit). Every step that is held to a rule meets here first, on the paying person, so two of them never read the same totals
  // and both pass. The lock lasts to the end of the caller's transaction, which also writes the room, so the next one sees it.
  // Always taken after the caller's own lock and never before it, so it cannot make a cycle.
  if (db !== prisma && db.$executeRaw) await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`spend-check:${attempt.payerPersonId}`}))`;
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

export type { ChargeClass };
