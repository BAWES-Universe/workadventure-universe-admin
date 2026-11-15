import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { asNumber, isMoneyCategory, pickBase, planLot, reaches, subjectKeyFor, type RuleFacts } from '@/lib/credit-values';
import { currentRules, lockAll, lockOfAccount, lockOfPerson, lockOfPool, personFacts, type Tx } from '@/lib/credit-store';
import { budgetOf, issuedInMonth, platformAccount, getFundingAccount } from '@/lib/credit-funding';
import type { MeterSettings } from '@/lib/meter-values';

/**
 * Issuing (paying spec v3, section 2, "Exactly once"). A grant is keyed by program + person (or shared pool) + period, and the database
 * holds that key unique, so however a person is reached (a sign-up, a migration, a reconnect, another device or bot, a room change, a rule
 * edit, joining and leaving a universe and joining again) their credit for the period is one lot. Issuing is lazy and idempotent: it
 * runs when a person's credit is read or spent, and again for the same person it does nothing.
 *
 * What this never does: issue past the account's funded budget for the month, issue from a paused or closed account, give the bigger of
 * two clashing rules, take anything back when a rule is lowered, or issue anything for Universe AI replies (those are an entitlement
 * with a window, not credit: lib/reply-limits.ts).
 */

export type SkipReason =
  /** The account has no budget set (for the platform, Limits' rollout budget): nothing is assumed, so nothing is issued. */
  | 'not_set'
  /** This month's budget would be passed. */
  | 'over_budget'
  /** The rule's total cap, or its cap on how many can join, is reached. */
  | 'cap'
  /** Two rules that disagree both reach this person: nothing is issued until an admin chooses. */
  | 'clash'
  /** The funding account is paused or closed. */
  | 'account_inactive';

export interface IssuedLot {
  lotId: string;
  programId: string;
  periodKey: string;
  subjectKey: string;
  amountMicros: number;
}

export interface IssueResult {
  issued: IssuedLot[];
  skipped: { programId: string; reason: SkipReason }[];
}

interface Plan {
  rule: RuleFacts;
  base: boolean;
}

/** What each rule would issue to this person now, before any budget is looked at. */
function plansFor(rules: readonly RuleFacts[], person: Parameters<typeof reaches>[1], skipped: IssueResult['skipped']): Plan[] {
  const reachingBase = new Map<string, RuleFacts[]>();
  const plans: Plan[] = [];
  for (const rule of rules) {
    if (!isMoneyCategory(rule.categoryId) || !reaches(rule, person)) continue;
    if (rule.programKind === 'gift') plans.push({ rule, base: false });
    else reachingBase.set(rule.categoryId, [...(reachingBase.get(rule.categoryId) ?? []), rule]);
  }
  for (const candidates of reachingBase.values()) {
    const picked = pickBase(candidates);
    if (picked.winner) plans.push({ rule: picked.winner, base: true });
    else if (picked.clash) for (const rule of picked.clash) skipped.push({ programId: rule.programId, reason: 'clash' });
  }
  return plans;
}

/**
 * Gives a person the credit they are due now, once per program and period. Safe to call any number of times, from anywhere, at once.
 * Returns what this call issued and what it could not. A guest, or someone who does not exist, is due nothing.
 */
export async function ensureIssued(personId: string, now: Date = new Date(), settingsIn?: MeterSettings): Promise<IssueResult> {
  const empty: IssueResult = { issued: [], skipped: [] };
  const person = await personFacts(prisma, personId);
  if (!person) return empty;
  const rules = await currentRules(prisma, { now });
  const skipped: IssueResult['skipped'] = [];
  const plans = plansFor(rules, person, skipped);
  if (plans.length === 0) return { issued: [], skipped };
  const settings = settingsIn ?? (await getMeterSettings());
  await platformAccount();
  const issued = await prisma.$transaction(async (tx) => {
    // Every name this person's issuing touches, locked in one order: two calls at the same moment go one after the other
    await lockAll(tx, [lockOfPerson(personId), ...plans.map((plan) => lockOfAccount(plan.rule.fundingAccountId)), ...plans.filter((plan) => plan.rule.share === 'shared').map((plan) => lockOfPool(plan.rule.programId))]);
    const out: IssuedLot[] = [];
    for (const { rule } of plans) {
      const result = await issueOne(tx, rule, personId, now, settings);
      if (result.lot) out.push(result.lot);
      else if (result.skipped) skipped.push({ programId: rule.programId, reason: result.skipped });
    }
    return out;
  });
  return { issued, skipped };
}

type Issued = { lot: IssuedLot; skipped?: undefined } | { lot?: undefined; skipped: SkipReason | null };

/** One rule's lot for one person, inside the locks. `skipped: null` means it was already issued (the quiet, normal answer). */
async function issueOne(tx: Tx, rule: RuleFacts, personId: string, now: Date, settings: MeterSettings): Promise<Issued> {
  const plan = planLot(rule, now);
  if (!plan) return { skipped: null };
  const subjectKey = subjectKeyFor(rule, personId);
  const already = await tx.creditLot.findUnique({ where: { slotKey_subjectKey_periodKey: { slotKey: plan.slotKey, subjectKey, periodKey: plan.periodKey } }, select: { id: true } });
  if (already) return { skipped: null };
  const account = await getFundingAccount(rule.fundingAccountId, tx);
  if (!account || account.status !== 'active') return { skipped: 'account_inactive' };
  const budget = budgetOf(account, settings);
  if (budget === null) return { skipped: 'not_set' };
  if ((await issuedInMonth(tx, account.id, now)) + plan.amountMicros > budget) return { skipped: 'over_budget' };
  if (rule.totalCapMicros !== null) {
    const given = await tx.creditLot.aggregate({ where: { programId: rule.programId }, _sum: { amountMicros: true } });
    if (asNumber(given._sum.amountMicros) + plan.amountMicros > rule.totalCapMicros) return { skipped: 'cap' };
  }
  // A group that can change has a cap on how many can join: joining, leaving and joining again is still the one lot a period
  if (rule.joinerCap !== null && rule.share === 'each') {
    const people = await tx.creditLot.findMany({ where: { programId: rule.programId }, select: { personId: true }, distinct: ['personId'] });
    if (!people.some((p) => p.personId === personId) && people.length >= rule.joinerCap) return { skipped: 'cap' };
  }
  const { count } = await tx.creditLot.createMany({
    data: [
      {
        slotKey: plan.slotKey,
        subjectKey,
        periodKey: plan.periodKey,
        programId: rule.programId,
        ruleId: rule.id,
        ruleVersion: rule.version,
        fundingAccountId: account.id,
        personId: rule.share === 'shared' ? null : personId,
        source: plan.source,
        amountMicros: BigInt(plan.amountMicros),
        covers: [...rule.covers],
        issuedAt: now,
        startsAt: plan.startsAt,
        expiresAt: plan.expiresAt,
        settlement: rule.settlement,
      },
    ],
    skipDuplicates: true,
  });
  if (count === 0) return { skipped: null };
  const lot = await tx.creditLot.findUniqueOrThrow({ where: { slotKey_subjectKey_periodKey: { slotKey: plan.slotKey, subjectKey, periodKey: plan.periodKey } }, select: { id: true } });
  return { lot: { lotId: lot.id, programId: rule.programId, periodKey: plan.periodKey, subjectKey, amountMicros: plan.amountMicros } };
}

/** Issues for several people (a rollout, a migration run, a gift to people you pick): each one the same exactly-once way. */
export async function ensureIssuedFor(personIds: readonly string[], now: Date = new Date()): Promise<{ issued: number; skipped: number }> {
  const settings = await getMeterSettings();
  let issued = 0;
  let skipped = 0;
  for (const id of personIds) {
    const result = await ensureIssued(id, now, settings);
    issued += result.issued.length;
    skipped += result.skipped.length;
  }
  return { issued, skipped };
}
