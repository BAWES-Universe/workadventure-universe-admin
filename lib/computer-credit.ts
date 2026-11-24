import { prisma } from '@/lib/db';
import { ensureIssued } from '@/lib/credit-issue';
import { currentRules, personFacts, usableLots, type Db, type LotRow } from '@/lib/credit-store';
import { holdCredit, settleHold } from '@/lib/credit-spend';
import { settleRefundObligations } from '@/lib/computer-refunds';
import { stretchOfCharge } from '@/lib/computer-stretch';
import { pickBase, reaches } from '@/lib/credit-values';

/**
 * Credit for computers (gifts and exceptions, paying spec v3 section 4), read by the computer's own spending.
 *
 * A computer's month is the member's allowance (Limits, or what an exception says for them) and, beside it, credit given on purpose:
 *  - a gift for computers (or for Apps and computers together), credit to be billed, a replacement for a failure, and what an exception
 *    gives once, are lots of credit in the funding books, spent through holds like any credit, earliest-ending first;
 *  - the month's allowance is NOT a lot to draw from: it is the default's amount (or the exception that reaches the person: a different
 *    amount a month, or none), counted from what the person spent in the month. The default's own lots are issued for the budget's sake
 *    and are never drawn from, so the allowance is never counted twice.
 *
 * Credit is drawn first, as extra usage is (it is the part that ends), and what a step costs beyond it falls on the allowance. A step is drawn
 * once, under a key of its own event (asked twice it is the same draw); a job that fails on our side has what it drew put back (`giveBackComputerCredit`),
 * as it takes nothing from the allowance.
 */

/** The lots a computer may draw from: given on purpose. The default's own lots (and an exception's monthly ones) stand for the allowance and are left alone. */
export const drawableForComputers = (lot: Pick<LotRow, 'source' | 'periodKey'>): boolean => lot.source !== 'default' || lot.periodKey === 'once';

export const creditHoldKey = (eventId: string): string => `computer:credit:${eventId}`;

/** A person's month as the allowance counts it: the base for them, and the credit they can draw on now. */
export interface ComputerCredit {
  /** What they can draw now: held room already taken out. */
  availableMicros: number;
  /** What it was given: the "of" of a bar, so a bar full is all of it and empty is none. */
  totalMicros: number;
}

/** The monthly base for one person: an exception that reaches them replaces the default (a different amount a month, or none), otherwise the default allowance. */
export async function computerBase(db: Pick<Db, 'grantRule' | 'user' | 'universeMember'>, personId: string, now: Date, defaultMicros: number): Promise<number> {
  const rules = (await currentRules(db, { categoryId: 'computers', now })).filter((rule) => rule.programKind !== 'gift');
  if (rules.length === 0) return defaultMicros;
  const person = await personFacts(db, personId);
  if (!person) return defaultMicros;
  const { winner } = pickBase(rules.filter((rule) => reaches(rule, person)));
  // Nothing wins (no rule reaches them, or two rules disagree and nobody is issued until an admin chooses): the default allowance stands, as it did
  if (!winner || winner.programKind !== 'exception') return defaultMicros;
  // An exception that gives once (or nothing) leaves no monthly allowance: what it gives once is credit, drawn below
  return winner.schedule === 'monthly' ? winner.amount : 0;
}

/** The credit a person can draw on for computers now. Issues nothing: see `issueComputerCredit`. */
export async function computerCredit(db: Db, personId: string, now: Date): Promise<ComputerCredit> {
  const lots = (await usableLots(db, personId, 'computers', now)).filter((lot) => drawableForComputers(lot.lot));
  let availableMicros = 0;
  let totalMicros = 0;
  for (const lot of lots) {
    availableMicros += lot.balance.availableMicros;
    totalMicros += lot.balance.amountMicros;
  }
  return { availableMicros, totalMicros };
}

/** Whether any gift or exception that covers computers is running: a cheap question that keeps the common case (none) from issuing on every call. */
export async function computerCreditMayExist(db: Pick<Db, 'grantRule' | 'creditLot'>): Promise<boolean> {
  const rule = await db.grantRule.findFirst({
    where: { state: 'current', covers: { has: 'computers' }, program: { status: 'active', kind: { in: ['gift', 'exception'] } } },
    select: { id: true },
  });
  if (rule) return true;
  // Credit already issued stays spendable until it ends, whatever became of the program that gave it
  return (await db.creditLot.count({ where: { covers: { has: 'computers' }, OR: [{ source: { not: 'default' } }, { periodKey: 'once' }] } })) > 0;
}

/** What each of a person's computer steps drew from credit in a month, by the step's event id: what was drawn less what was given back. */
export async function computerDraws(db: Pick<Db, 'creditHold'>, personId: string, from: Date, to: Date): Promise<Map<string, number>> {
  const holds = await db.creditHold.findMany({
    where: { personId, category: 'computers', state: 'settled', effectKey: { startsWith: 'computer:' }, closedAt: { gte: from, lt: to } },
    select: { effectKey: true, customerMicros: true, refundedMicros: true },
  });
  const draws = new Map<string, number>();
  for (const hold of holds) {
    if (!hold.effectKey) continue;
    draws.set(hold.effectKey, Math.max(0, Number(hold.customerMicros ?? 0) - Number(hold.refundedMicros)));
  }
  return draws;
}

/** Gives a person what is due them now, when anything that covers computers is running or was issued. Never throws: a person's credit that could not be read is not a reason to stop a step. */
export async function issueComputerCredit(personId: string, now: Date): Promise<number> {
  try {
    if (!(await computerCreditMayExist(prisma))) return 0;
    return (await ensureIssued(personId, now)).issued.length;
  } catch (error) {
    console.error('[Computer] Could not issue credit for computers:', error instanceof Error ? error.message : 'unknown');
    return 0;
  }
}

/**
 * A computer step with a known cost draws from the person's credit first (once, under its event's own key), and the rest of its cost falls on
 * the allowance. Returns what it drew. Asked again for the same step it finds the same draw. Never throws: when the credit cannot be taken
 * (none, or used by something else a moment ago) the whole cost falls on the allowance, as it did before there was credit for computers.
 */
export async function drawComputerCredit(
  input: { eventId: string; personId: string; botId: string | null; jobId: string | null; costMicros: number; chargeClass: 'computer_job' | 'computer_model' },
  now: Date,
): Promise<number> {
  const holdKey = creditHoldKey(input.eventId);
  try {
    const before = await prisma.creditHold.findUnique({ where: { holdKey }, select: { state: true, amountMicros: true, customerMicros: true } });
    if (before) {
      // A draw that was held and never settled (it stopped between the two) is settled now at what it held
      if (before.state === 'held') await settleHold({ holdKey, customerMicros: Number(before.amountMicros) }, now);
      return before.state === 'released' ? 0 : Number(before.customerMicros ?? before.amountMicros);
    }
    if (!Number.isSafeInteger(input.costMicros) || input.costMicros <= 0) return 0;
    if (!(await computerCreditMayExist(prisma))) return 0;
    await issueComputerCredit(input.personId, now);
    // The draw carries the stretch of the charge it pays for (a model call the one it was admitted in, a pause its own, the job's time the one it is in now), so a give-back for a fault of ours
    // touches that stretch's credit and no earlier stretch's (lib/computer-stretch)
    const jobStretch = input.jobId ? await stretchOfCharge(input.jobId, input.eventId) : null;
    let want = input.costMicros;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { availableMicros } = await computerCredit(prisma, input.personId, now);
      want = Math.min(want, availableMicros);
      if (want <= 0) return 0;
      const held = await holdCredit(
        {
          holdKey,
          personId: input.personId,
          category: 'computers',
          amountMicros: want,
          chargeClass: input.chargeClass,
          botId: input.botId,
          jobKey: input.jobId,
          jobStretch,
          effectKey: input.eventId,
          provider: 'universe',
          route: 'computer',
          lotFilter: drawableForComputers,
        },
        now,
      );
      if (held.ok) {
        await settleHold({ holdKey, customerMicros: want }, now);
        return want;
      }
      // Used by something else in the meantime (the same dollar for Apps): ask again for what is left
      if (held.reason !== 'credit_used_up') return 0;
      want = Math.min(want, held.availableMicros);
    }
    return 0;
  } catch (error) {
    console.error('[Computer] Could not draw credit for a computer step:', error instanceof Error ? error.message : 'unknown');
    return 0;
  }
}

/**
 * A job that failed on our side takes nothing from the person's month, and that includes the credit it drew: each draw is given back into the
 * lot it came from while that lot lasts (a small replacement credit when it ended), by the funding books' own give-back. What is owed is an obligation
 * until the books acknowledge it (lib/computer-refunds): asked again it is the same refund (the same amount under the same key), never a second one. Never throws.
 */
export async function giveBackComputerCredit(jobId: string, now: Date = new Date()): Promise<void> {
  // What is owed is written first (once per hold, with its amount fixed), then asked of the books; one that cannot be acknowledged is kept, tried again with a
  // growing wait, and told to Sentry when it is old (lib/computer-refunds)
  await settleRefundObligations(jobId, now);
}
