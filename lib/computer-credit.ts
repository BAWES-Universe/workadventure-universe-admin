import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureIssued, type IssueResult } from '@/lib/credit-issue';
import { holdCredit, refundHold, releaseHold, settleHold } from '@/lib/credit-spend';
import { lockAll, lockOfPerson, usableLots, type Tx } from '@/lib/credit-store';
import { PLATFORM_ACCOUNT_ID } from '@/lib/credit-funding';
import { asNumber } from '@/lib/credit-values';
import { givenBackJob } from '@/lib/computer-values';
import { checkSpend } from '@/lib/spend-rules';
import { pickRunning } from '@/lib/meter-grants';
import type { NoRoom } from '@/lib/meter-allowance';

/**
 * What a computer job costs the person, paid from their credit (paying spec v3, section 4; audit finding F01).
 *
 * Computer jobs used to be held to one monthly allowance of their own, a different book from the credit lots that Usage shows, that gifts
 * and exceptions write to, and that Apps spend from. Now a computer job takes its room from the same lots, in the same order (earliest
 * ending first, a shared pool once for everyone it reaches), and the old allowance is no longer asked at all, so nothing is ever charged
 * to both. What stays apart is our own side: the pool's ceiling, jobs at once and the envelope are the meter's (lib/meter-allowance.ts)
 * and are checked the same way as before; a person's credit never raises them and they never lower a person's credit.
 *
 *  - A job holds credit for its first stretch when it starts and for each stretch it renews: one hold each, keyed by the job's own room key,
 *    so asking again for the same stretch takes nothing more. A model call inside the job holds its own (a computer_model charge).
 *  - When the job ends the holds settle for what the machine really ran, in the order they were taken, and the rest goes back; a job that
 *    never ran releases them. What the provider really billed us stays in the hold's provider cost, apart from what the person was charged.
 *  - A failure that is ours (the machine would not start) gives the person's charge back, once, into the lot it came from. A successful job
 *    the person did not like, and a failure that is not proven to be ours, never does.
 *  - Usage before this book took over is carried, not erased: computer spend recorded before the first job asked the lots is taken off the
 *    month's lot once (a settled hold of its own), so the month's credit is neither lost nor given twice. The old extra usage (2x, 5x, no
 *    limit) still means what it said for computers: see `syncExtraUsage`.
 */

/** The hold of a stretch a job renews: the first stretch is the job's own room key. */
export const renewHoldKey = (roomKey: string, renewal: number): string => `${roomKey}:r${renewal}`;

const CUTOVER_KEY = 'computer-credit-books';

async function readCutover(): Promise<Date | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: CUTOVER_KEY } });
  const value = row?.value as { from?: unknown } | null;
  const from = typeof value?.from === 'string' ? new Date(value.from) : null;
  return from && !Number.isNaN(from.getTime()) ? from : null;
}

/**
 * The moment computer jobs began taking their room from credit lots: written once, by the first job that asks (never by a page that only
 * looks), and never moved. Null before any job has asked.
 */
async function cutoverOf(now: Date, writeIt: boolean): Promise<Date | null> {
  const known = await readCutover();
  if (known || !writeIt) return known;
  await prisma.appSetting.createMany({ data: [{ key: CUTOVER_KEY, value: { from: now.toISOString() } as Prisma.InputJsonValue }], skipDuplicates: true });
  return (await readCutover()) ?? now;
}

/**
 * Takes this month's computer spend that was booked before the lots took over off the month's lot, once per lot. Their credit for the
 * month then reads as what they really have left, never a fresh full amount on top of what they already used. Never more than the lot holds.
 */
async function carryEarlierUsage(personId: string, now: Date, admission: boolean): Promise<void> {
  const cutover = await cutoverOf(now, admission);
  if (!cutover) return;
  const lots = (await usableLots(prisma, personId, 'computers', now)).filter((entry) => entry.lot.slotKey === 'base:computers' && entry.lot.startsAt < cutover);
  for (const entry of lots) {
    const holdKey = `carry:${entry.lot.id}`;
    if (await prisma.creditHold.findUnique({ where: { holdKey }, select: { id: true } })) continue;
    const until = entry.lot.expiresAt && entry.lot.expiresAt < cutover ? entry.lot.expiresAt : cutover;
    const spent = await prisma.meterEvent.aggregate({
      where: { pool: 'computer', payerKind: 'universe', personKey: `person:${personId}`, costMicros: { not: null }, occurredAt: { gte: entry.lot.startsAt, lt: until } },
      _sum: { costMicros: true },
    });
    const amount = Math.min(asNumber(spent._sum.costMicros), asNumber(entry.lot.amountMicros));
    if (amount <= 0) continue;
    await prisma.$transaction(async (tx) => {
      await lockAll(tx, [lockOfPerson(personId)]);
      if (await tx.creditHold.findUnique({ where: { holdKey }, select: { id: true } })) return;
      const hold = await tx.creditHold.create({
        data: {
          holdKey,
          personId,
          category: 'computers',
          chargeClass: 'computer_job',
          route: 'carry',
          state: 'settled',
          amountMicros: BigInt(amount),
          customerMicros: BigInt(amount),
          expiresAt: now,
          createdAt: now,
          closedAt: now,
          detail: { carriedFrom: 'meter_events', until: until.toISOString() },
        },
      });
      await tx.creditAllocation.create({ data: { holdId: hold.id, lotId: entry.lot.id, amountMicros: BigInt(amount), settledMicros: BigInt(amount), state: 'settled', position: 0 } });
    });
  }
}

/**
 * The old extra usage ("Extra usage" on a person's page: 2x, 5x, no limit, for chat, voice and computer time) still means what it said for
 * computers. A multiple becomes credit in the same lots: the extra the largest running one is worth above the month's usual (4x usual
 * extra for 5x, never 10x for 2x and 5x), once per grant and multiple, ending when the grant ends. No limit lifts the person's own credit
 * limit while it lasts: nothing is held against their credit, and the pool, jobs at once and every rule they said still hold. Returns
 * whether no limit is running.
 */
async function syncExtraUsage(personId: string, now: Date): Promise<boolean> {
  const running = await prisma.meterGrant.findMany({ where: { personId, startsAt: { lte: now }, endsAt: { gt: now } }, select: { grantKey: true, multiplier: true, noLimit: true, startsAt: true, endsAt: true, settlement: true } });
  const lots = await prisma.creditLot.findMany({ where: { subjectKey: `person:${personId}`, slotKey: { startsWith: 'extra:' } } });
  // The end of a grant that was ended or changed is the end of its credit; what is already spent stays spent
  if (lots.length > 0) {
    const grants = await prisma.meterGrant.findMany({ where: { grantKey: { in: lots.map((lot) => lot.slotKey.slice('extra:'.length)) } }, select: { grantKey: true, endsAt: true } });
    for (const lot of lots) {
      const grant = grants.find((g) => `extra:${g.grantKey}` === lot.slotKey);
      if (grant && grant.endsAt > lot.startsAt && lot.expiresAt?.getTime() !== grant.endsAt.getTime()) await prisma.creditLot.update({ where: { id: lot.id }, data: { expiresAt: grant.endsAt } });
    }
  }
  if (running.some((grant) => grant.noLimit)) return true;
  const best = pickRunning(running.map((grant) => ({ ...grant, multiplier: grant.multiplier })));
  if (!best || !best.multiplier || best.multiplier < 2) return false;
  const base = (await usableLots(prisma, personId, 'computers', now)).find((entry) => entry.lot.slotKey === 'base:computers');
  if (!base) return false;
  const wanted = asNumber(base.lot.amountMicros) * (best.multiplier - 1);
  const have = lots.filter((lot) => !lot.expiresAt || lot.expiresAt > now).reduce((sum, lot) => sum + asNumber(lot.amountMicros), 0);
  if (wanted <= have) return false;
  const grant = running.find((entry) => entry.grantKey === best.grantKey);
  if (!grant) return false;
  await prisma.creditLot.createMany({
    data: [
      {
        slotKey: `extra:${grant.grantKey}`,
        subjectKey: `person:${personId}`,
        periodKey: `x${best.multiplier}`,
        fundingAccountId: PLATFORM_ACCOUNT_ID,
        personId,
        // A mirror of extra usage for computers: what was agreed and billed stays on the extra usage's own record, so this is never a second bill
        source: 'gift',
        amountMicros: BigInt(wanted - have),
        covers: ['computers'],
        issuedAt: now,
        startsAt: grant.startsAt,
        expiresAt: grant.endsAt,
        settlement: 'free',
        note: `Extra usage ${grant.grantKey}`,
      },
    ],
    skipDuplicates: true,
  });
  return false;
}

export interface Prepared {
  /** Extra usage with no limit is running: the person's own credit is not held back. */
  unlimited: boolean;
  /** The funded budget is not set, so no credit was ever issued: the controls are not set up (the same answer as an empty Limit). */
  notSet: boolean;
}

/**
 * What is due is issued, usage from before the lots took over is carried, and extra usage is brought in: asked before computer credit is
 * read. `admission` is true when a job is about to take room (the first such ask fixes the moment the lots took over); a page that only looks
 * passes false.
 */
export async function prepareComputerCredit(personId: string, now: Date, admission = true): Promise<Prepared> {
  const issued: IssueResult = await ensureIssued(personId, now);
  await carryEarlierUsage(personId, now, admission);
  const unlimited = await syncExtraUsage(personId, now);
  return { unlimited, notSet: issued.skipped.some((skip) => skip.reason === 'not_set') };
}

export interface CreditLeft {
  unlimited: boolean;
  /** What new work can take: every lot that may pay for computers, held room already taken out. */
  availableMicros: number;
  /** What the lots in force hold in all, used or not (a lot that is used up and still in force counts: it is part of what they have this month). */
  totalMicros: number;
  /** Held for work that has not finished. */
  inProgressMicros: number;
  /** Whether anything at all is in force for computers (a default, an exception, a gift). */
  any: boolean;
  /** The funded budget is not set, so no credit was ever issued: the controls are not set up (a page shows nothing rather than "out"). */
  notSet: boolean;
}

/** A person's computer credit as the Usage page, the owner's view and the admission check all read it. Reads only (see `prepareComputerCredit`). */
export async function computerCreditLeft(db: Parameters<typeof usableLots>[0], personId: string, now: Date, unlimited = false, notSet = false): Promise<CreditLeft> {
  const lots = await usableLots(db, personId, 'computers', now);
  return {
    unlimited,
    availableMicros: lots.reduce((sum, lot) => sum + lot.availableMicros, 0),
    totalMicros: lots.reduce((sum, lot) => sum + lot.balance.amountMicros, 0),
    inProgressMicros: lots.reduce((sum, lot) => sum + lot.balance.heldMicros, 0),
    any: lots.length > 0,
    notSet: notSet && lots.length === 0,
  };
}

/** The same figures with the extra usage that has no limit read in: for a page, never for admission. */
export async function computerCreditFor(personId: string, now: Date): Promise<CreditLeft> {
  const prepared = await prepareComputerCredit(personId, now, false).catch((error) => {
    console.error('[Computer] Could not bring credit up to date:', error instanceof Error ? error.message : 'unknown');
    return { unlimited: false, notSet: false } as Prepared;
  });
  return computerCreditLeft(prisma, personId, now, prepared.unlimited, prepared.notSet);
}

/**
 * The personal check of the meter's admission, asked inside the pool's lock after what the person said in chat and before jobs at once and
 * the pool: whether this person's credit has room for `extra`. The hold that follows is the real take (and meets a race); this is what
 * keeps the order of the answers: a person whose credit is used up is told so whatever the pool holds.
 */
export function creditCheck(personId: string, now: Date, prepared: Prepared): (tx: Tx, extraMicros: number) => Promise<NoRoom | null> {
  return async (tx, extraMicros) => {
    if (prepared.unlimited) return null;
    const left = await computerCreditLeft(tx, personId, now);
    if (!left.any && prepared.notSet) return { ok: false, reason: 'not_set', missing: ['rolloutBudgetMicros'] };
    return left.availableMicros >= extraMicros ? null : { ok: false, reason: 'allowance', leftMicros: left.availableMicros };
  };
}

export type HeldForJob = { ok: true; held: boolean } | { ok: false; reason: 'allowance' | 'not_set' | 'closed' };

interface HoldAsk {
  key: string;
  personId: string;
  amountMicros: number;
  botId: string | null;
  jobId: string;
  chargeClass: 'computer_job' | 'computer_model';
  parentKey?: string | null;
}

/**
 * Holds credit for a stretch of a job, or for one model call inside it. What the person said in chat was already checked by the room
 * taken just before (the meter reads the rules under its pool lock, ahead of the credit), so it is not asked again here: the room is
 * already in the books by now and would be counted twice.
 * `held` is false when none was taken because no limit is running. */
export async function holdForJob(ask: HoldAsk, now: Date, prepared: Prepared): Promise<HeldForJob> {
  if (prepared.unlimited) return { ok: true, held: false };
  const held = await holdCredit(
    {
      holdKey: ask.key,
      personId: ask.personId,
      category: 'computers',
      amountMicros: ask.amountMicros,
      chargeClass: ask.chargeClass,
      botId: ask.botId,
      jobKey: ask.jobId,
      parentHoldKey: ask.parentKey ?? null,
      route: 'computer',
      provider: 'agent37',
    },
    now,
  );
  if (held.ok) return { ok: true, held: true };
  if (held.reason === 'credit_used_up') return { ok: false, reason: 'allowance' };
  if (held.reason === 'not_set') return { ok: false, reason: 'not_set' };
  // closed, key reused, wrong class, effect charged: this stretch is not one to start from
  return { ok: false, reason: 'closed' };
}

const costBasisOf = (cost: number | null, real: boolean): 'measured' | 'estimated' | 'unknown' => (cost === null ? 'unknown' : real ? 'measured' : 'estimated');

/**
 * The job ended having run: its holds settle, in the order they were taken, to the cost of what ran (a stretch that was never reached goes
 * back whole). More than every stretch held, which cannot happen while the room is renewed ahead, is not charged to the person: it is ours
 * and it stays in the provider cost. Safe to say twice: a settled hold stays as it settled.
 */
export async function settleJobCredit(jobId: string, costMicros: number, real: boolean, now: Date): Promise<void> {
  const found = await prisma.creditHold.findMany({ where: { jobKey: jobId, category: 'computers', chargeClass: 'computer_job', state: 'held' }, select: { holdKey: true, amountMicros: true, createdAt: true } });
  // In the order they were taken: the stretch a hold is for is in its key (the job's own room key is the first)
  const stretch = (key: string) => Number(/:r(\d+)$/.exec(key)?.[1] ?? 0);
  const holds = [...found].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || stretch(a.holdKey) - stretch(b.holdKey));
  let left = costMicros;
  for (let index = 0; index < holds.length; index++) {
    const amount = asNumber(holds[index].amountMicros);
    const charged = Math.min(amount, left);
    left -= charged;
    // What the provider billed, in full: whatever the holds could not cover is on the last one, never lost
    const provider = index === holds.length - 1 ? charged + left : charged;
    await settleHold({ holdKey: holds[index].holdKey, customerMicros: charged, provider: { costMicros: provider, basis: costBasisOf(provider, real) } }, now);
  }
}

/**
 * A job that was already running when the lots took over has room in the meter's books but no credit held for the stretches it already
 * began: nothing it used before its first renewal would ever be charged to the person. Before it renews or ends, the stretches it holds
 * room for are held in the lots too, as far as the person's credit reaches (work that began under the old rule is never refused after
 * the fact, only charged for what the credit covers). Once only: the hold is under the job's own room key. A job that began after the
 * lots took over already holds its first stretch, so nothing happens for it.
 */
export async function adoptEarlierStretches(job: { id: string; personId: string; botId: string; reservationKey: string | null; startedAt: Date | null }, now: Date, prepared: Prepared): Promise<void> {
  if (prepared.unlimited || !job.reservationKey || !job.startedAt) return;
  const cutover = await readCutover();
  if (!cutover || job.startedAt >= cutover) return;
  if (await prisma.creditHold.findUnique({ where: { holdKey: job.reservationKey }, select: { id: true } })) return;
  const room = await prisma.meterReservation.findUnique({ where: { reservationKey: job.reservationKey }, select: { amountMicros: true } });
  // Whatever state the room is in (a job that is ending has just settled it), the amount it held is what the job's stretches were
  if (!room) return;
  const left = await computerCreditLeft(prisma, job.personId, now, false, prepared.notSet);
  const amount = Math.min(asNumber(room.amountMicros), Math.floor(left.availableMicros));
  if (amount <= 0) return;
  await holdForJob({ key: job.reservationKey, personId: job.personId, amountMicros: amount, botId: job.botId, jobId: job.id, chargeClass: 'computer_job' }, now, prepared);
}

/** The job never ran, or ended before it began: everything it held goes back. Safe to say twice. */
export async function releaseJobCredit(jobId: string, now: Date): Promise<void> {
  const holds = await prisma.creditHold.findMany({ where: { jobKey: jobId, category: 'computers', chargeClass: 'computer_job', state: 'held' }, select: { holdKey: true } });
  for (const hold of holds) await releaseHold({ holdKey: hold.holdKey }, now);
}

/**
 * A failure that is ours (the machine would not start): what the person was charged for the job goes back into the lot it came from, once
 * per hold, while what the provider billed us stays in the books. A lot that has ended is never renewed: the books make a small replacement.
 */
export async function giveBackJobCredit(jobId: string, now: Date): Promise<number> {
  const holds = await prisma.creditHold.findMany({ where: { jobKey: jobId, category: 'computers', chargeClass: { in: ['computer_job', 'computer_model'] }, state: 'settled' }, select: { holdKey: true, customerMicros: true, refundedMicros: true } });
  let given = 0;
  for (const hold of holds) {
    const amount = asNumber(hold.customerMicros) - asNumber(hold.refundedMicros);
    if (amount <= 0) continue;
    const done = await refundHold({ holdKey: hold.holdKey, refundKey: `giveback:${hold.holdKey}`, amountMicros: amount, reason: 'platform_failure' }, now);
    if (done.ok) given += done.refundedMicros;
  }
  return given;
}

/**
 * One model call inside a job was made: its hold settles to what it cost, never more than was held (the rest is ours and stays in the
 * provider cost). A price that is not known settles at what was held, as the meter's room does.
 * Version 1 settles at least 1 (a call that cost "0" still took its room). Version 2 passes `exact`: a measured zero stays zero, and
 * `providerCostMicros` (what the provider billed, which may be more than what the person is charged) is kept beside the charge, never merged.
 */
export async function settleCallCredit(
  callKey: string,
  costMicros: number | null,
  real: boolean,
  now: Date,
  opts: { exact?: boolean; providerCostMicros?: number | null; providerReal?: boolean } = {},
): Promise<void> {
  const hold = await prisma.creditHold.findUnique({ where: { holdKey: callKey }, select: { amountMicros: true, state: true } });
  if (!hold || hold.state !== 'held') return;
  const held = asNumber(hold.amountMicros);
  const charged = opts.exact ? Math.min(held, Math.max(0, costMicros ?? held)) : Math.min(held, Math.max(1, costMicros ?? held));
  const provider = opts.providerCostMicros === undefined ? costMicros : opts.providerCostMicros;
  await settleHold({ holdKey: callKey, customerMicros: charged, provider: { costMicros: provider, basis: costBasisOf(provider, opts.providerReal ?? real) } }, now);
}

/** What the rules the person said leave for a step's extra, clamped: a rule that counts in a cap that is nearly used leaves less, one that allows only some accounts leaves none. */
async function ruleLeft(personId: string, botId: string | null, jobId: string, extraMicros: number, now: Date): Promise<number> {
  const ruled = await checkSpend({ payerPersonId: personId, botId, taskKey: jobId, chargeClass: 'computer', amountMicros: extraMicros }, now);
  if (ruled.ok) return extraMicros;
  return Math.max(0, Math.min(extraMicros, ruled.leftMicros ?? 0));
}

/**
 * R7: a step that cost more than what was set aside for the member takes the rest only from funds that are eligible, still free and inside
 * what was authorised: the person's own credit lots (never past what is available), and inside the rules they said (a cap, "only my own
 * accounts"). The extra reservation is made explicit FIRST, as its own hold under the step's key with `:x`, and then settled to what it took;
 * whatever it could not take is not charged to the person and stays Universe's, in the provider cost. Never more than `wantedMicros`.
 * Returns what was captured. A person whose extra usage has no limit is not held back, and nothing is held for them at all.
 */
export async function captureExtraCredit(
  step: { callKey: string; personId: string; botId: string | null; jobId: string },
  wantedMicros: number,
  now: Date,
  prepared: Prepared,
): Promise<number> {
  if (wantedMicros <= 0 || prepared.unlimited) return 0;
  const key = `${step.callKey}:x`;
  const existing = await prisma.creditHold.findUnique({ where: { holdKey: key }, select: { state: true, amountMicros: true, customerMicros: true } });
  if (existing) return existing.state === 'settled' ? asNumber(existing.customerMicros) : 0;
  const left = await computerCreditLeft(prisma, step.personId, now, false, prepared.notSet);
  const allowed = await ruleLeft(step.personId, step.botId, step.jobId, Math.min(wantedMicros, Math.floor(left.availableMicros)), now);
  if (allowed <= 0) return 0;
  const held = await holdForJob({ key, personId: step.personId, amountMicros: allowed, botId: step.botId, jobId: step.jobId, chargeClass: 'computer_model', parentKey: step.callKey }, now, prepared);
  // The credit was there at the check and not at the hold (another step took it): nothing is captured
  if (!held.ok || !held.held) return 0;
  await settleHold({ holdKey: key, customerMicros: allowed }, now);
  return allowed;
}

/** When a lot ends: its own end, or the end of the UTC month it was issued for (a month's lot ends with the month); null for one that never ends. */
function periodEndOf(expiresAt: Date | null, periodKey: string): string | null {
  if (expiresAt) return expiresAt.toISOString();
  const month = /^(\d{4})-(\d{2})$/.exec(periodKey);
  return month ? new Date(Date.UTC(Number(month[1]), Number(month[2]), 1)).toISOString() : null;
}

export type PayerKind = 'owner' | 'visitor' | 'schedule' | 'teammate';

export interface Funding {
  payerKind: PayerKind;
  /** The account whose lot pays first (earliest ending first, as the hold takes them); null when no lot is in force (extra usage with no limit, or none left). */
  fundingAccountId: string | null;
  /** The limits recorded for the step. A limit that does not apply is null. */
  limits: { taskMicros: number | null; botMicros: number | null; grantId: string | null; periodEnds: string | null; fixedPriceMicros: number | null };
}

/**
 * D2: who pays for a step and what bounds it, resolved before the step is sent and recorded with it. A job is its owner's: it rides on the
 * standing rule the owner disclosed (their computers credit, their rules). A run of a schedule is recorded as a schedule's. What bounds it is
 * read from what exists, never made up: the cap of a rule the owner said for this task or this Brick (the strictest), the gift or shared pool
 * the first lot comes from, and the day that lot ends (the month's end for a monthly one).
 */
export async function resolveFunding(job: { id: string; botId: string; personId: string; runId: string | null }, now: Date): Promise<Funding> {
  let payerKind: PayerKind = 'owner';
  if (job.runId) {
    const run = await prisma.brickItemRun.findUnique({ where: { id: job.runId }, select: { item: { select: { kind: true } } } });
    if (run?.item.kind === 'schedule') payerKind = 'schedule';
  }
  const lots = (await usableLots(prisma, job.personId, 'computers', now)).filter((lot) => lot.availableMicros > 0);
  // The order the hold takes them: earliest ending first, a lot that never ends last
  lots.sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity));
  const first = lots[0];
  const rules = await prisma.spendRule.findMany({
    where: { ownerPersonId: job.personId, state: 'active', capMicros: { not: null }, OR: [{ scope: 'bot', botId: job.botId }, { scope: 'task', taskKey: job.id }] },
    select: { scope: true, capMicros: true },
  });
  const strictest = (scope: string): number | null => {
    const caps = rules.filter((rule) => rule.scope === scope && rule.capMicros !== null).map((rule) => Number(rule.capMicros));
    return caps.length === 0 ? null : Math.min(...caps);
  };
  return {
    payerKind,
    fundingAccountId: first ? first.lot.fundingAccountId : null,
    limits: {
      taskMicros: strictest('task'),
      botMicros: strictest('bot'),
      grantId: first && (first.lot.subjectKey.startsWith('pool:') || first.source === 'gift') ? first.lot.programId : null,
      periodEnds: first ? periodEndOf(first.expiresAt, first.lot.periodKey) : null,
      fixedPriceMicros: null,
    },
  };
}

/** A hold that was never used (a call that was never sent, a start that did not happen) goes back whole. Safe to say twice; a hold that does not exist is nothing. */
export async function releaseCreditHold(holdKey: string, now: Date): Promise<void> {
  await releaseHold({ holdKey }, now);
}

/**
 * Settles what a crash left behind: a hold whose job is over (or gone) and whose call room is closed. The sweep runs it, so credit is
 * never held for work that ended. Returns how many holds it closed.
 */
export async function reconcileComputerHolds(now: Date, take = 200): Promise<number> {
  let closed = 0;
  const jobHolds = await prisma.creditHold.findMany({ where: { category: 'computers', chargeClass: 'computer_job', state: 'held', jobKey: { not: null }, expiresAt: { lte: now } }, select: { jobKey: true }, distinct: ['jobKey'], take });
  for (const { jobKey } of jobHolds) {
    if (!jobKey) continue;
    const job = await prisma.computerJob.findUnique({ where: { id: jobKey }, select: { status: true, secondsRun: true, botId: true, startedAt: true, endedBy: true } });
    if (job && !['done', 'stopped', 'failed'].includes(job.status)) continue;
    if (!job || !job.startedAt) {
      await releaseJobCredit(jobKey, now);
    } else {
      // What was written to the books for the job, or what its seconds cost at the machine's price
      const event = await prisma.meterEvent.findUnique({ where: { eventId: `computer:${jobKey}:time` }, select: { costMicros: true, basis: true } });
      if (!event) continue;
      await settleJobCredit(jobKey, Math.max(1, asNumber(event.costMicros)), event.basis === 'measured', now);
      // A job that failed on our side is not the person's: what it was charged goes back (once per hold)
      if (givenBackJob(job.status, job.endedBy)) await giveBackJobCredit(jobKey, now);
    }
    closed++;
  }
  const callHolds = await prisma.creditHold.findMany({ where: { category: 'computers', chargeClass: 'computer_model', state: 'held', expiresAt: { lte: now } }, select: { holdKey: true, amountMicros: true }, take });
  for (const hold of callHolds) {
    const room = await prisma.meterReservation.findUnique({ where: { reservationKey: hold.holdKey }, select: { state: true, settledMicros: true } });
    // Its room is still held: the sweep's own handling of lapsed calls settles both together
    if (room?.state === 'held') continue;
    if (room?.state === 'settled') await settleCallCredit(hold.holdKey, room.settledMicros === null ? null : asNumber(room.settledMicros), true, now);
    else await releaseCreditHold(hold.holdKey, now);
    closed++;
  }
  return closed;
}
