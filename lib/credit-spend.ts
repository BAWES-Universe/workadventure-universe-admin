import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { PLATFORM_ACCOUNT_ID } from '@/lib/credit-funding';
import { getMeterSettings } from '@/lib/meter';
import { ensureIssued, skipCovers, type IssueResult } from '@/lib/credit-issue';
import type { MeterSettings } from '@/lib/meter-values';
import { allocate, asNumber, categoryFor, monthEnd, monthStart, wholeMicros, type ChargeClass, type MoneyCategory } from '@/lib/credit-values';
import { lockAll, lockOfEffect, lockOfHoldKey, lockOfPerson, lockOfPool, lotBalances, usableLots, type LotRow, type Tx } from '@/lib/credit-store';

/**
 * Spending credit (paying spec v3, sections 4, 7 and 8): room is held before any paid effect, in one step under locks, from the lots
 * that may pay for it, earliest-ending first; then the step settles for what it really cost (the rest goes back), or is released if it
 * never ran. A refund goes back into the lot it came from. All of it is idempotent per key, and a hold never goes away: it ends settled
 * or released, so what happened stays in the books.
 *
 * Customer credit only. What a provider bills us is the meter's books (meter_events and the envelope), kept apart: a hold carries the
 * provider's cost beside the customer's amount, in a column of its own, once it is known.
 */

export type NoCredit =
  /** The credit that may pay for this is used up (or there never was any). Never offered as the fix for an outage or a refused permission. */
  | { ok: false; reason: 'credit_used_up'; availableMicros: number }
  /** Nothing is set up to give credit yet (no funded budget), so nothing was ever issued. */
  | { ok: false; reason: 'not_set'; availableMicros: 0 }
  /**
   * The person was due credit for this category this period and was not given it (this month's budget ran out, a cap was reached, two rules
   * clash, or the account is paused), and they have nothing else that pays for it. Never told as "used up": they never had it.
   */
  | { ok: false; reason: 'not_given'; availableMicros: 0 }
  /** The charge class is not one this category pays for, or nested work is in the wrong class (it would be charged twice). */
  | { ok: false; reason: 'wrong_class' }
  /** The key was used for someone else: the first stands, and whoever asked has a bug to find. */
  | { ok: false; reason: 'key_reused' }
  /** The hold is not one that is held and in time any more. */
  | { ok: false; reason: 'closed'; hold?: HoldView }
  /** The same execution was already charged under another key. */
  | { ok: false; reason: 'effect_charged' }
  /** A rule the person said in chat does not let this step take that much (see `HoldInput.guard`): the rule's own words, and nothing to ask more credit for. */
  | NoCreditRule;

export type NoCreditRule = { ok: false; reason: 'rule'; ruleId: string; why: 'own_accounts' | 'cap'; leftMicros: number | null; words: string };

export interface HoldAllocation {
  lotId: string;
  amountMicros: number;
  settledMicros: number | null;
  state: 'held' | 'settled' | 'released';
}

export interface HoldView {
  key: string;
  personId: string;
  botId: string | null;
  category: MoneyCategory;
  chargeClass: string;
  state: 'held' | 'settled' | 'released';
  amountMicros: number;
  customerMicros: number | null;
  refundedMicros: number;
  providerCostMicros: number | null;
  expiresAt: Date;
  jobKey: string | null;
  parentHoldKey: string | null;
  allocations: HoldAllocation[];
}

export type Held = { ok: true; hold: HoldView; created: boolean } | NoCredit;

export interface HoldInput {
  /** The operation and attempt. A retry of the same step uses the same key and takes nothing more. */
  holdKey: string;
  personId: string;
  category: MoneyCategory;
  amountMicros: number;
  chargeClass: ChargeClass;
  botId?: string | null;
  /** Who asked, when that is not the person whose credit pays (a schedule, a visitor). */
  askerKey?: string | null;
  priceVersion?: string | null;
  route?: string | null;
  /** composio, universe (our own version of an App), and so on. */
  provider?: string | null;
  jobKey?: string | null;
  /** Which stretch of the job this draw belongs to (a computer job that was paused and carried on is charged a stretch at a time: lib/computer-stretch). Left out for work that has no stretches. */
  jobStretch?: number | null;
  /** The hold of the job this step runs inside. A step inside a computer job is a computer_tool and is charged once, to that job's category. */
  parentHoldKey?: string | null;
  /** What happened in the world (an execution id): the same execution is never charged under two keys. */
  effectKey?: string | null;
  /** For work a named payer funds (a universe-paid service): only that account's lots count, and nothing falls back to anyone else's. */
  onlyAccountId?: string | null;
  /** Which of the person's lots may pay for this step (Computers: credit given on purpose, never the month's own allowance, which is counted apart). Leave out for all of them. */
  lotFilter?: (lot: LotRow) => boolean;
  /**
   * Asked inside the hold's own transaction, after the person's lock is taken and before anything is held: whatever it reads (what the
   * person has already spent or holds) cannot change under it, so two steps asked at the same moment meet here one after the other.
   * Answers the refusal, or null to go on. Not asked for a hold that already exists: that is the same step.
   */
  guard?: (tx: Tx) => Promise<NoCreditRule | null>;
}

type HoldRow = Awaited<ReturnType<typeof loadHold>>;

async function loadHold(db: Pick<Tx, 'creditHold'>, holdKey: string) {
  return db.creditHold.findUnique({ where: { holdKey }, include: { allocations: { orderBy: { position: 'asc' } } } });
}

type FullHold = NonNullable<HoldRow>;

const holdView = (row: FullHold): HoldView => ({
  key: row.holdKey,
  personId: row.personId,
  botId: row.botId,
  category: row.category as MoneyCategory,
  chargeClass: row.chargeClass,
  state: row.state as HoldView['state'],
  amountMicros: asNumber(row.amountMicros),
  customerMicros: row.customerMicros === null ? null : asNumber(row.customerMicros),
  refundedMicros: asNumber(row.refundedMicros),
  providerCostMicros: row.providerCostMicros === null ? null : asNumber(row.providerCostMicros),
  expiresAt: row.expiresAt,
  jobKey: row.jobKey,
  parentHoldKey: row.parentHoldKey,
  allocations: row.allocations.map((a) => ({ lotId: a.lotId, amountMicros: asNumber(a.amountMicros), settledMicros: a.settledMicros === null ? null : asNumber(a.settledMicros), state: a.state as HoldAllocation['state'] })),
});

/** The pool lots a person can draw on, so they can be locked before anything is counted. */
async function poolNames(tx: Tx, personId: string, category: MoneyCategory, now: Date, onlyAccountId: string | null | undefined, lotFilter?: (lot: LotRow) => boolean): Promise<string[]> {
  const lots = (await usableLots(tx, personId, category, now, { onlyAccountId })).filter((lot) => !lotFilter || lotFilter(lot.lot));
  return lots.filter((lot) => lot.lot.subjectKey.startsWith('pool:')).map((lot) => lockOfPool(lot.lot.programId ?? lot.lot.subjectKey));
}

/**
 * Holds room for a paid step, once per key: asking again for the same step finds the same hold and takes nothing more. It takes from
 * the lots that may pay for this category (the person's own, and shared pools they are recipients of), by earliest expiry first, all or
 * nothing. "No credit" is an answer, never a throw.
 */
export async function holdCredit(input: HoldInput, now: Date = new Date()): Promise<Held> {
  wholeMicros(input.amountMicros, 'amountMicros');
  if (!input.holdKey || input.holdKey.length > 255) throw new RangeError('holdKey is required (up to 255 characters)');
  const categories = await prisma.creditCategory.findMany({ select: { id: true, pays: true, status: true } });
  // The class decides who pays: anything the named category does not list is refused, so nested work is never charged as two things
  if (categoryFor(input.chargeClass, categories) !== input.category) return { ok: false, reason: 'wrong_class' };

  const existing = await loadHold(prisma, input.holdKey);
  if (existing) return alreadyHeld(existing, input, now);
  // A key the books were told to give up before anything was held under it never holds anything (checked again under the key's lock below)
  if (await prisma.creditClosedKey.findUnique({ where: { holdKey: input.holdKey }, select: { holdKey: true } })) return { ok: false, reason: 'closed' };
  if (input.effectKey) {
    const charged = await prisma.creditHold.findFirst({ where: { effectKey: input.effectKey, state: { not: 'released' } }, select: { holdKey: true } });
    if (charged && charged.holdKey !== input.holdKey) return { ok: false, reason: 'effect_charged' };
  }
  if (input.parentHoldKey) {
    const parent = await prisma.creditHold.findUnique({ where: { holdKey: input.parentHoldKey }, select: { personId: true, category: true } });
    if (parent && parent.personId !== input.personId) return { ok: false, reason: 'key_reused' };
    // Inside a computer job a paid App is a tool of that job, not an Instant run on top of it
    if (parent?.category === 'computers' && input.category !== 'computers') return { ok: false, reason: 'wrong_class' };
  }

  const settings = await getMeterSettings();
  const issued = await ensureIssued(input.personId, now);
  // The pools a person can draw on can change between reading them and holding their locks (a person is added to or leaves a pool); when the
  // lots counted under the locks include a pool that was not locked, nothing is taken and the whole thing is tried again with the full set
  for (let attempt = 0; attempt < 4; attempt++) {
    const held = await holdOnce(input, now, settings, issued);
    if (held !== 'again') return held;
  }
  throw new Error('Could not hold credit: the shared pools kept changing');
}

async function holdOnce(input: HoldInput, now: Date, settings: MeterSettings, issued: IssueResult): Promise<Held | 'again'> {
  return prisma.$transaction(async (tx): Promise<Held | 'again'> => {
    // The execution's own lock too: two asks for one execution under different keys (even for different people) meet here, not at the unique index
    const locked = [lockOfPerson(input.personId), lockOfHoldKey(input.holdKey), ...(input.effectKey ? [lockOfEffect(input.effectKey)] : []), ...(await poolNames(tx, input.personId, input.category, now, input.onlyAccountId, input.lotFilter))];
    await lockAll(tx, locked);
    const again = await loadHold(tx, input.holdKey);
    if (again) return alreadyHeld(again, input, now);
    if (await tx.creditClosedKey.findUnique({ where: { holdKey: input.holdKey }, select: { holdKey: true } })) return { ok: false, reason: 'closed' };
    if (input.effectKey) {
      const charged = await tx.creditHold.findFirst({ where: { effectKey: input.effectKey, state: { not: 'released' } }, select: { holdKey: true } });
      if (charged && charged.holdKey !== input.holdKey) return { ok: false, reason: 'effect_charged' };
    }
    if (input.guard) {
      const stopped = await input.guard(tx);
      if (stopped) return stopped;
    }
    const lots = (await usableLots(tx, input.personId, input.category, now, { onlyAccountId: input.onlyAccountId })).filter((lot) => !input.lotFilter || input.lotFilter(lot.lot));
    const lockedSet = new Set(locked);
    const unlocked = lots.some((lot) => lot.lot.subjectKey.startsWith('pool:') && !lockedSet.has(lockOfPool(lot.lot.programId ?? lot.lot.subjectKey)));
    if (unlocked) return 'again';
    const takes = allocate(lots, input.amountMicros);
    if (!takes) {
      const available = lots.reduce((sum, lot) => sum + lot.availableMicros, 0);
      // Nothing left at all (lots spent to nothing count as none) and what was due this period was not given: "not given", never "used up".
      // Some credit left that is not enough stays "used up"
      // Only a skip of a rule whose credit would have paid for this category counts (a gift can cover more than its own category): a rule
      // for other categories left out says nothing about this one
      const mine = issued.skipped.filter((s) => skipCovers(s, input.category));
      if (available <= 0 && mine.some((s) => s.reason === 'not_set')) return { ok: false, reason: 'not_set', availableMicros: 0 };
      if (available <= 0 && mine.length > 0) return { ok: false, reason: 'not_given', availableMicros: 0 };
      return { ok: false, reason: 'credit_used_up', availableMicros: available };
    }
    const row = await tx.creditHold.create({
      data: {
        holdKey: input.holdKey,
        personId: input.personId,
        botId: input.botId ?? null,
        askerKey: input.askerKey ?? null,
        category: input.category,
        chargeClass: input.chargeClass,
        priceVersion: input.priceVersion ?? null,
        route: input.route ?? null,
        provider: input.provider ?? null,
        jobKey: input.jobKey ?? null,
        jobStretch: input.jobStretch ?? null,
        parentHoldKey: input.parentHoldKey ?? null,
        effectKey: input.effectKey ?? null,
        onlyAccountId: input.onlyAccountId ?? null,
        state: 'held',
        amountMicros: BigInt(input.amountMicros),
        expiresAt: new Date(now.getTime() + settings.renewMinutes * 60_000),
        createdAt: now,
        allocations: { create: takes.map((take, position) => ({ lotId: take.lotId, amountMicros: BigInt(take.amountMicros), state: 'held', position })) },
      },
      include: { allocations: { orderBy: { position: 'asc' } } },
    });
    return { ok: true, hold: holdView(row), created: true };
  });
}

function alreadyHeld(row: FullHold, input: HoldInput, now: Date): Held {
  // A key belongs to one step: the same person, the same category, the same kind of work (a computers hold never stands for an Instant Apps step),
  // the same amount, and the same named payer (work one account alone funds never stands for work anyone's credit may pay)
  if (row.personId !== input.personId || row.category !== input.category || row.chargeClass !== input.chargeClass) return { ok: false, reason: 'key_reused' };
  // A hold made before its payer was stored (`payerKnown` false) is the same step for any payer: it was already taken, so it is found, never taken twice
  if (asNumber(row.amountMicros) !== input.amountMicros || (row.payerKnown && (row.onlyAccountId ?? null) !== (input.onlyAccountId ?? null))) return { ok: false, reason: 'key_reused' };
  // Asking again for room that is still held is the same room. Room that settled, was released or lapsed is not a place to start a paid step from
  if (row.state === 'held' && row.expiresAt > now) return { ok: true, hold: holdView(row), created: false };
  return { ok: false, reason: 'closed', hold: holdView(row) };
}

export interface ProviderCost {
  /** What the provider billed us for this step, in millionths of a dollar: a different number from what the customer was charged. */
  costMicros: number | null;
  basis: 'measured' | 'estimated' | 'unknown';
}

/** What lock names a hold needs: the person, and the pools its lots belong to. */
async function holdLocks(tx: Tx, holdId: string, personId: string): Promise<string[]> {
  const rows = await tx.creditAllocation.findMany({ where: { holdId }, select: { lot: { select: { subjectKey: true, programId: true } } } });
  return [lockOfPerson(personId), ...rows.filter((r) => r.lot.subjectKey.startsWith('pool:')).map((r) => lockOfPool(r.lot.programId ?? r.lot.subjectKey))];
}

/**
 * The step ran: it is charged `customerMicros` (up to what was held), in the order the room was taken, and the rest goes back. Safe to
 * say twice: once it ended it stays as it ended, and a second word, even a different one, changes nothing.
 */
export async function settleHold(input: { holdKey: string; customerMicros: number; provider?: ProviderCost }, now: Date = new Date()): Promise<HoldView | null> {
  if (!Number.isSafeInteger(input.customerMicros) || input.customerMicros < 0) throw new RangeError('customerMicros must be a whole number, 0 or more');
  const head = await prisma.creditHold.findUnique({ where: { holdKey: input.holdKey }, select: { id: true, personId: true } });
  if (!head) return null;
  return prisma.$transaction(async (tx) => {
    await lockAll(tx, await holdLocks(tx, head.id, head.personId));
    const row = await loadHold(tx, input.holdKey);
    if (!row) return null;
    if (row.state !== 'held') return holdView(row);
    if (input.customerMicros > asNumber(row.amountMicros)) throw new RangeError('A step cannot be charged more than was held for it');
    let left = input.customerMicros;
    for (const allocation of row.allocations) {
      const amount = asNumber(allocation.amountMicros);
      const charged = Math.min(amount, left);
      left -= charged;
      await tx.creditAllocation.update({ where: { id: allocation.id }, data: charged > 0 ? { state: 'settled', settledMicros: BigInt(charged) } : { state: 'released' } });
    }
    await tx.creditHold.update({
      where: { id: row.id },
      data: {
        state: 'settled',
        customerMicros: BigInt(input.customerMicros),
        closedAt: now,
        ...(input.provider ? { providerCostMicros: input.provider.costMicros === null ? null : BigInt(input.provider.costMicros), providerCostBasis: input.provider.basis } : {}),
      },
    });
    return holdView((await loadHold(tx, input.holdKey)) as FullHold);
  });
}

/** The step never ran (or a verified platform failure): everything held goes back. Safe to say twice; a settled hold stays settled. */
export async function releaseHold(input: { holdKey: string }, now: Date = new Date()): Promise<HoldView | null> {
  const head = await prisma.creditHold.findUnique({ where: { holdKey: input.holdKey }, select: { id: true, personId: true } });
  if (!head) return null;
  return prisma.$transaction(async (tx) => {
    await lockAll(tx, await holdLocks(tx, head.id, head.personId));
    const row = await loadHold(tx, input.holdKey);
    if (!row) return null;
    if (row.state !== 'held') return holdView(row);
    await tx.creditAllocation.updateMany({ where: { holdId: row.id }, data: { state: 'released' } });
    await tx.creditHold.update({ where: { id: row.id }, data: { state: 'released', closedAt: now } });
    return holdView((await loadHold(tx, input.holdKey)) as FullHold);
  });
}

/**
 * For a step whose reservation was never answered: the books CONFIRM that nothing is held under the key, and close the key, so a hold that
 * was still on its way is refused when it arrives (`closed`, holding nothing). `held` means a hold exists (the reservation did land), and the
 * caller releases it as any other. Safe to say twice. Meets a hold being made under the same key at the key's own lock: one of the two wins,
 * never both.
 */
export async function releaseKeyIfNothingHeld(input: { holdKey: string }, now: Date = new Date()): Promise<'closed' | 'held'> {
  if (!input.holdKey || input.holdKey.length > 255) throw new RangeError('holdKey is required (up to 255 characters)');
  return prisma.$transaction(async (tx) => {
    await lockAll(tx, [lockOfHoldKey(input.holdKey)]);
    if (await tx.creditHold.findUnique({ where: { holdKey: input.holdKey }, select: { id: true } })) return 'held';
    await tx.creditClosedKey.upsert({ where: { holdKey: input.holdKey }, create: { holdKey: input.holdKey, closedAt: now }, update: {} });
    return 'closed';
  });
}

/** Says what the provider billed us for a step, beside what the customer was charged. Never changes the customer's amount. */
export async function recordProviderCost(holdKey: string, cost: ProviderCost): Promise<boolean> {
  const { count } = await prisma.creditHold.updateMany({ where: { holdKey }, data: { providerCostMicros: cost.costMicros === null ? null : BigInt(cost.costMicros), providerCostBasis: cost.basis } });
  return count > 0;
}

export type Refunded =
  | { ok: true; created: boolean; refundedMicros: number; restoredMicros: number; replacementMicros: number }
  | { ok: false; reason: 'not_found' | 'not_settled' | 'too_much' | 'key_reused' | 'not_set' | 'refund_budget' };

/**
 * A refund keeps its source (spec 4): it goes back into the lot it came from while that lot still lasts, never turns into cash, and never
 * renews an expired gift. When the lot has ended, a small separate replacement credit is made instead, lasting until the end of the
 * month after it is made. Once per refund key.
 *
 * The bounds on giving back are Limits numbers that belong to whoever runs the work (the Instant executor keeps its own goodwill budget and
 * money per give-back), so they come in as `limits` and are enforced here when given: `giveBackMaxMicros` caps one replacement credit, and
 * `goodwillBudgetMicros` caps the month's goodwill and redelivery credit (an empty budget gives none). A verified platform failure is
 * always given back in full by default.
 */
export interface GiveBackLimits {
  /** The most one replacement credit may be. Empty: the amount that failed. */
  giveBackMaxMicros?: number | null;
  /** The most goodwill and redelivery credit may total in a UTC month, across everything. Undefined: not enforced here (the caller enforces its own). Null: none is given. */
  goodwillBudgetMicros?: number | null;
}

/**
 * What the books already gave back under a refund key, read only (nothing is created, locked or changed): the amount of the first answer, or
 * nothing when no give-back was ever made under it. Both kinds of rows are looked at, as `refundHold` does when asked again.
 */
export async function findRefund(input: { refundKey: string }): Promise<{ found: true; refundedMicros: number } | { found: false }> {
  const request = await prisma.creditRefundRequest.findUnique({ where: { requestKey: input.refundKey } });
  if (request) return { found: true, refundedMicros: asNumber(request.refundedMicros) };
  const earlier = (await prisma.creditRefund.findMany({ where: { refundKey: { startsWith: `${input.refundKey}#` } } })).filter((row) => /^\d+$/.test(row.refundKey.slice(input.refundKey.length + 1)));
  if (earlier.length === 0) return { found: false };
  return { found: true, refundedMicros: earlier.reduce((total, row) => total + asNumber(row.amountMicros), 0) };
}

export async function refundHold(input: { holdKey: string; refundKey: string; amountMicros: number; reason: 'platform_failure' | 'goodwill' | 'redelivery'; limits?: GiveBackLimits }, now: Date = new Date()): Promise<Refunded> {
  wholeMicros(input.amountMicros, 'amountMicros');
  if (!input.refundKey || input.refundKey.length > 240) throw new RangeError('refundKey is required (up to 240 characters)');
  const head = await prisma.creditHold.findUnique({ where: { holdKey: input.holdKey }, select: { id: true, personId: true } });
  if (!head) return { ok: false, reason: 'not_found' };
  const limits = input.limits ?? {};
  return prisma.$transaction(async (tx): Promise<Refunded> => {
    await lockAll(tx, [...(await holdLocks(tx, head.id, head.personId)), 'credit:refunds']);
    // The request's own row, by its exact key: asking again answers the same way (also when nothing was given back), and another request's
    // key that merely begins with this one is never a replay of it
    const prior = await tx.creditRefundRequest.findUnique({ where: { requestKey: input.refundKey } });
    if (prior) {
      if (prior.holdId !== head.id || asNumber(prior.requestedMicros) !== input.amountMicros || prior.reason !== input.reason) return { ok: false, reason: 'key_reused' };
      return { ok: true, created: false, refundedMicros: asNumber(prior.refundedMicros), restoredMicros: asNumber(prior.restoredMicros), replacementMicros: asNumber(prior.replacementMicros) };
    }
    // A refund made before request rows existed lives only in `credit_refunds`, as `<key>#0`, `<key>#1`, ...: asking again returns what it gave,
    // for the same step and the same reason (the amount asked for was not stored, so it cannot be compared)
    const earlier = (await tx.creditRefund.findMany({ where: { refundKey: { startsWith: `${input.refundKey}#` } } })).filter((row) => /^\d+$/.test(row.refundKey.slice(input.refundKey.length + 1)));
    if (earlier.length > 0) {
      if (earlier.some((row) => row.holdId !== head.id || row.reason !== input.reason)) return { ok: false, reason: 'key_reused' };
      const sum = (mode: string) => earlier.filter((row) => row.mode === mode).reduce((total, row) => total + asNumber(row.amountMicros), 0);
      return { ok: true, created: false, refundedMicros: sum('restored') + sum('replacement'), restoredMicros: sum('restored'), replacementMicros: sum('replacement') };
    }
    const hold = await loadHold(tx, input.holdKey);
    if (!hold) return { ok: false, reason: 'not_found' };
    if (hold.state !== 'settled' || hold.customerMicros === null) return { ok: false, reason: 'not_settled' };
    if (input.amountMicros > asNumber(hold.customerMicros) - asNumber(hold.refundedMicros)) return { ok: false, reason: 'too_much' };
    if (input.reason !== 'platform_failure' && limits.goodwillBudgetMicros !== undefined) {
      if (limits.goodwillBudgetMicros === null) return { ok: false, reason: 'not_set' };
      const given = await tx.creditRefund.aggregate({ where: { reason: { in: ['goodwill', 'redelivery'] }, createdAt: { gte: monthStart(now), lt: monthEnd(now) } }, _sum: { amountMicros: true } });
      if (asNumber(given._sum.amountMicros) + input.amountMicros > limits.goodwillBudgetMicros) return { ok: false, reason: 'refund_budget' };
    }
    const lots = await tx.creditLot.findMany({ where: { id: { in: hold.allocations.map((a) => a.lotId) } }, include: { account: { select: { status: true } } } });
    const refunded = await tx.creditRefund.groupBy({ by: ['allocationId'], where: { holdId: hold.id }, _sum: { amountMicros: true } });
    const back = new Map(refunded.map((r) => [r.allocationId, asNumber(r._sum.amountMicros)]));
    let left = input.amountMicros;
    let restored = 0;
    let replacement = 0;
    let n = 0;
    for (const allocation of hold.allocations) {
      if (left <= 0) break;
      if (allocation.state !== 'settled') continue;
      const room = asNumber(allocation.settledMicros) - (back.get(allocation.id) ?? 0);
      if (room <= 0) continue;
      const take = Math.min(room, left);
      const lot = lots.find((l) => l.id === allocation.lotId);
      if (!lot) continue;
      const lotLives = (!lot.expiresAt || lot.expiresAt > now) && lot.account.status !== 'closed';
      if (lotLives) {
        await tx.creditRefund.create({ data: { refundKey: `${input.refundKey}#${n++}`, holdId: hold.id, allocationId: allocation.id, lotId: lot.id, amountMicros: BigInt(take), mode: 'restored', reason: input.reason, createdAt: now } });
        restored += take;
        left -= take;
        continue;
      }
      // The lot ended: never renew it. A small separate credit, kept apart and ending soon, for the person whose credit it was
      // The give-back limit is for the whole refund, not for each ended lot: it is what we are willing to make whole after the credit ended.
      // What it does not cover is not given at all (it is not passed on to another lot), so `left` goes down by all of `take`.
      const given = limits.giveBackMaxMicros == null ? take : Math.min(take, Math.max(0, limits.giveBackMaxMicros - replacement));
      if (given <= 0) {
        left -= take;
        continue;
      }
      const replacementLot = await tx.creditLot.create({
        data: {
          slotKey: 'replacement',
          subjectKey: `person:${hold.personId}`,
          // One replacement per refund, never per allocation: a second partial refund of the same step makes its own (the refund key already
          // makes asking again the same as asking once, before this point). 'r:' + a uuid fits the 40 characters of a period key
          periodKey: `r:${randomUUID()}`,
          // A closed account funds nothing new, so a lot made under it could never be spent: when a failure on our side is found after
          // its sponsor's account closed, the platform makes the person whole (still bounded by the give-back limit the caller passes)
          fundingAccountId: lot.account.status === 'closed' ? PLATFORM_ACCOUNT_ID : lot.fundingAccountId,
          personId: hold.personId,
          source: 'replacement',
          amountMicros: BigInt(given),
          covers: lot.covers,
          issuedAt: now,
          startsAt: now,
          // Ends with the month after the one it is made in: it makes the person whole for a failure, it does not start a new gift
          expiresAt: monthEnd(new Date(monthEnd(now).getTime())),
          refundOfHoldId: hold.id,
          note: 'Replacement for a platform failure found after the credit it was taken from ended',
        },
      });
      await tx.creditRefund.create({ data: { refundKey: `${input.refundKey}#${n++}`, holdId: hold.id, allocationId: allocation.id, lotId: lot.id, amountMicros: BigInt(given), mode: 'replacement', replacementLotId: replacementLot.id, reason: input.reason, createdAt: now } });
      replacement += given;
      left -= take;
    }
    const total = restored + replacement;
    if (total > 0) await tx.creditHold.update({ where: { id: hold.id }, data: { refundedMicros: { increment: BigInt(total) } } });
    await tx.creditRefundRequest.create({
      data: { requestKey: input.refundKey, holdId: hold.id, requestedMicros: BigInt(input.amountMicros), reason: input.reason, refundedMicros: BigInt(total), restoredMicros: BigInt(restored), replacementMicros: BigInt(replacement), createdAt: now },
    });
    return { ok: true, created: true, refundedMicros: total, restoredMicros: restored, replacementMicros: replacement };
  });
}

/** Holds whose time ran out without being settled or released: what they spent is not known, so they keep counting until a reconciler closes them. */
export async function lapsedHolds(now: Date = new Date(), limit = 100): Promise<HoldView[]> {
  const rows = await prisma.creditHold.findMany({ where: { state: 'held', expiresAt: { lte: now } }, include: { allocations: { orderBy: { position: 'asc' } } }, orderBy: { expiresAt: 'asc' }, take: limit });
  return rows.map(holdView);
}

/** What a person has available for a category right now, issuing what is due first. Held room is already taken out. */
export async function availableCredit(personId: string, category: MoneyCategory, now: Date = new Date()): Promise<{ availableMicros: number; totalMicros: number; heldMicros: number }> {
  const standing = await creditStanding(personId, category, now);
  return { availableMicros: standing.availableMicros, totalMicros: standing.totalMicros, heldMicros: standing.heldMicros };
}

/**
 * `availableCredit` and why there may be none, in the words a hold would refuse with: `notGiven` when the person has nothing that pays for this
 * category because what they were due this period was not issued (the month's budget ran out, a cap, a clash, a paused account, or no budget
 * set), never "used up". `renewsAt` is when their monthly credit of this category comes again (the earliest end of a monthly lot they hold), or null.
 */
export async function creditStanding(personId: string, category: MoneyCategory, now: Date = new Date()): Promise<{ availableMicros: number; totalMicros: number; heldMicros: number; notGiven: boolean; renewsAt: Date | null }> {
  const issued = await ensureIssued(personId, now);
  const lots = await usableLots(prisma, personId, category, now);
  // Only a skip of a rule whose credit would have paid for this category counts, whatever the reason (no budget set, the month's budget ran
  // out, a cap, a clash)
  const skipped = issued.skipped.some((s) => skipCovers(s, category));
  const monthly = lots.filter((lot) => /^\d{4}-\d{2}$/.test(lot.lot.periodKey) && lot.expiresAt !== null).map((lot) => lot.expiresAt!.getTime());
  const renewsAt = monthly.length > 0 ? new Date(Math.min(...monthly)) : null;
  const balances = await lotBalances(prisma, lots.map((lot) => lot.id));
  let available = 0;
  let total = 0;
  let held = 0;
  for (const lot of lots) {
    const b = balances.get(lot.id);
    if (!b) continue;
    available += b.availableMicros;
    total += b.amountMicros - b.usedMicros;
    held += b.heldMicros;
  }
  // Nothing left (lots spent to nothing count as none) and what was due this period was not given; some credit left that is short stays "used up"
  const notGiven = available <= 0 && skipped;
  return { availableMicros: available, totalMicros: total, heldMicros: held, notGiven, renewsAt };
}
