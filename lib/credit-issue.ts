import { prisma } from '@/lib/db';
import { getMeterSettings, getMeterSettingsStrict } from '@/lib/meter';
import { asNumber, isMoneyCategory, pickBase, planLot, reaches, subjectKeyFor, type PersonFacts, type RuleFacts } from '@/lib/credit-values';
import { currentRules, usableLots, lockAll, lockOfAccount, lockOfPerson, lockOfPool, lockOfRules, LOCK_METER_SETTINGS, personFacts, type Tx } from '@/lib/credit-store';
import { budgetOf, issuedInMonth, platformAccount, getFundingAccount, monthKeyOf, PLATFORM_ACCOUNT_ID } from '@/lib/credit-funding';
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
  /** `categoryId` is the category the skipped rule gives credit for, so spending can tell "never given this period" from "used up". */
  skipped: { programId: string; categoryId?: string; reason: SkipReason }[];
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
    else if (picked.clash) for (const rule of picked.clash) skipped.push({ programId: rule.programId, categoryId: rule.categoryId, reason: 'clash' });
  }
  return plans;
}

/** The names a set of plans must lock: the person's own, each account they draw on, and each shared pool. */
function locksFor(personId: string, plans: readonly Plan[]): string[] {
  return [lockOfPerson(personId), ...plans.map((plan) => lockOfAccount(plan.rule.fundingAccountId)), ...plans.filter((plan) => plan.rule.share === 'shared').map((plan) => lockOfPool(plan.rule.programId))];
}

/** The rules locks of the categories a set of plans comes from. */
const rulesLocksFor = (plans: readonly Plan[]): string[] => [...new Set(plans.map((plan) => lockOfRules(plan.rule.categoryId)))];

/** Waiting for a save of rules or of Limits (a moment) counts against the transaction's time, so it gets more than the default five seconds. */
const TRANSACTION = { maxWait: 10_000, timeout: 20_000 };

/**
 * Gives a person the credit they are due now, once per program and period. Safe to call any number of times, from anywhere, at once.
 * Returns what this call issued and what it could not. A guest, or someone who does not exist, is due nothing.
 *
 * What is due is worked out twice: once to know which locks to take, and again under them. Under the locks the rules, the person's
 * groups and the rollout budget are read fresh, so a program that ended, a rule that was edited or a budget that was lowered while this
 * call waited is what counts, never what was read before. If the fresh read needs a lock that was not taken (a rule now reaches this
 * person through another account or pool), nothing is issued and the whole thing starts again with the full set.
 */
export async function ensureIssued(personId: string, now: Date = new Date()): Promise<IssueResult> {
  await platformAccount();
  for (let attempt = 0; attempt < 4; attempt++) {
    // Read again on every attempt: a start over is because the person's facts or the rules moved, so the locks are worked out from what is true now
    const first = await personFacts(prisma, personId);
    if (!first) return { issued: [], skipped: [] };
    // Nothing reaches this person: say why when two rules clash for them, so a caller can tell "nothing due" from "waiting for a choice"
    const early: IssueResult['skipped'] = [];
    const planned = plansFor(await currentRules(prisma, { now }), first, early);
    if (planned.length === 0) return { issued: [], skipped: early };
    // Everything due this period is issued already (the answer on every look after the first one of a period, such as each chat turn's list
    // of research Apps), or what is missing was already left out by this month's rollout budget and still does not fit: nothing to lock and
    // nothing to write, so no transaction takes the funding account's lock. A shared pool always takes the full way, which also answers this
    // person's asks from a pool someone else's look made
    const settled = await settledWithoutLocks(personId, planned, now);
    if (settled) return { issued: [], skipped: [...early, ...settled] };
    const result = await prisma.$transaction(async (tx): Promise<IssueResult | 'again'> => {
      // The rollout budget is read under a shared lock that a super admin's save of Limits waits for, so a lowered budget is never missed; and
      // the rules of each category this person is due something from under a shared lock that a save of that category's rules waits for, so a
      // rule is never read half-saved. Only those categories, so a save in one never holds up issuing in another. Shared, so people being
      // issued to at the same moment do not wait for each other
      const names = locksFor(personId, planned);
      const categories = rulesLocksFor(planned);
      await lockAll(tx, names, [LOCK_METER_SETTINGS, ...categories]);
      const person = await personFacts(tx, personId);
      if (!person) return { issued: [], skipped: [] };
      const skipped: IssueResult['skipped'] = [];
      const plans = plansFor(await currentRules(tx, { now }), person, skipped);
      const held = new Set(names);
      const heldRules = new Set(categories);
      if (locksFor(personId, plans).some((name) => !held.has(name)) || rulesLocksFor(plans).some((name) => !heldRules.has(name))) return 'again';
      if (plans.length === 0) return { issued: [], skipped };
      const settings = await getMeterSettings(tx);
      const out: IssuedLot[] = [];
      for (const { rule } of plans) {
        const done = await issueOne(tx, rule, personId, now, settings);
        if (done.lot) out.push(done.lot);
        else if (done.skipped) skipped.push({ programId: rule.programId, categoryId: rule.categoryId, reason: done.skipped });
        // Left out by the rollout budget: said on the Limits screen as people not given credit this month (once per person, program and month)
        if (done.skipped === 'over_budget' && rule.fundingAccountId === PLATFORM_ACCOUNT_ID) {
          await tx.$executeRaw`INSERT INTO "credit_issue_skips" ("person_id", "program_id", "month_key", "reason", "first_at") VALUES (${personId}, ${rule.programId}, ${monthKeyOf(now)}, 'over_budget', (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')) ON CONFLICT DO NOTHING`;
        }
      }
      await answerAsksFromPools(tx, person, now);
      return { issued: out, skipped };
    }, TRANSACTION);
    if (result !== 'again') return result;
  }
  throw new Error('Could not issue credit: the rules kept changing');
}

/**
 * A shared amount for Instant Apps is credit this person can now draw on, whether this call made the pool or it was made when the first of the
 * others arrived: what they asked for before the pool began is answered. An ask made after the pool began is a new one, and an ask for
 * computer time is left alone. What counts as credit they can draw on is decided where spending decides it (`usableLots`): the pool's account
 * must be active, the person must be reached by the version the pool was issued under, and there must be room left.
 */
async function answerAsksFromPools(tx: Tx, person: PersonFacts, now: Date): Promise<void> {
  const usable = await usableLots(tx, person.id, 'instant_apps', now, { person });
  for (const { lot, availableMicros } of usable) {
    if (!lot.subjectKey.startsWith('pool:') || availableMicros <= 0) continue;
    await tx.meterRequest.updateMany({ where: { personId: person.id, what: 'apps', answeredAt: null, createdAt: { lte: lot.issuedAt } }, data: { answeredAt: now, grantKey: `lot:${lot.id}` } });
  }
}

type Issued = { lot: IssuedLot; skipped?: undefined } | { lot?: undefined; skipped: SkipReason | null };

/**
 * Whether this look has nothing to do, read without locks: null when it must take the full way under the locks. Otherwise the skips to give
 * back (empty when every per-person lot of this period is there). A missing lot counts as settled only when this person was already left out
 * by the platform's rollout budget this month (the Limits screen's row) and it still does not fit: the platform account is active, has a
 * budget, and what it issued this month plus this lot is past it. Lots are never taken away, so the month's issued total only goes up: a read
 * without locks can only find it lower than it is, which sends the person the full way (never a wrong "no"), and a budget raised a moment
 * ago is seen on the next look. A shared pool, any other skip reason, or anything that cannot be read takes the full way.
 */
async function settledWithoutLocks(personId: string, plans: readonly Plan[], now: Date): Promise<IssueResult['skipped'] | null> {
  const skipped: IssueResult['skipped'] = [];
  let room: { budget: number; issued: number } | null | undefined;
  for (const { rule } of plans) {
    if (rule.share !== 'each') return null;
    const plan = planLot(rule, now);
    if (!plan) continue;
    const lot = await prisma.creditLot.findUnique({ where: { slotKey_subjectKey_periodKey: { slotKey: plan.slotKey, subjectKey: subjectKeyFor(rule, personId), periodKey: plan.periodKey } }, select: { id: true } });
    if (lot) continue;
    if (rule.fundingAccountId !== PLATFORM_ACCOUNT_ID) return null;
    const left = await prisma.creditIssueSkip.findUnique({ where: { personId_programId_monthKey: { personId, programId: rule.programId, monthKey: monthKeyOf(now) } }, select: { reason: true } });
    if (left?.reason !== 'over_budget') return null;
    if (room === undefined) room = await platformRoom(now);
    if (!room || room.issued + plan.amountMicros <= room.budget) return null;
    skipped.push({ programId: rule.programId, categoryId: rule.categoryId, reason: 'over_budget' });
  }
  return skipped;
}

/** The platform account's budget in force this month and what it issued, read without locks; null when it is not active, has no budget, or cannot be read. */
async function platformRoom(now: Date): Promise<{ budget: number; issued: number } | null> {
  try {
    const account = await getFundingAccount(PLATFORM_ACCOUNT_ID);
    if (!account || account.status !== 'active') return null;
    const budget = budgetOf(account, await getMeterSettingsStrict(prisma));
    if (budget === null) return null;
    return { budget, issued: await issuedInMonth(prisma, account.id, now) };
  } catch {
    return null;
  }
}

/** One rule's lot for one person, inside the locks. `skipped: null` means it was already issued (the quiet, normal answer). */
async function issueOne(tx: Tx, rule: RuleFacts, personId: string, now: Date, settings: MeterSettings): Promise<Issued> {
  const plan = planLot(rule, now);
  if (!plan) return { skipped: null };
  const subjectKey = subjectKeyFor(rule, personId);
  const already = await tx.creditLot.findUnique({ where: { slotKey_subjectKey_periodKey: { slotKey: plan.slotKey, subjectKey, periodKey: plan.periodKey } }, select: { id: true } });
  // Already there (for a shared pool, made when someone else arrived first): this person has it, so they are not among the people left out
  if (already) {
    await tx.creditIssueSkip.deleteMany({ where: { personId, programId: rule.programId, monthKey: monthKeyOf(now) } });
    return { skipped: null };
  }
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
  // Given after all (the rollout budget was raised this month): no longer among the people it left out. A shared pool is credit for everyone
  // the rule reaches, so each of them left out earlier this month is cleared too; anyone it does not reach stays counted
  await clearSkipsFor(tx, rule, personId, now);
  const lot = await tx.creditLot.findUniqueOrThrow({ where: { slotKey_subjectKey_periodKey: { slotKey: plan.slotKey, subjectKey, periodKey: plan.periodKey } }, select: { id: true } });
  // Credit for Instant Apps arrived (a gift or a renewal): what the person asked for before now is answered, so a later ask is a new one
  if (rule.covers.includes('instant_apps') && rule.share === 'each') {
    await tx.meterRequest.updateMany({ where: { personId, what: 'apps', answeredAt: null, createdAt: { lte: now } }, data: { answeredAt: now, grantKey: `lot:${lot.id}` } });
  }
  return { lot: { lotId: lot.id, programId: rule.programId, periodKey: plan.periodKey, subjectKey, amountMicros: plan.amountMicros } };
}

/** Clears this month's "left out" records that a new lot answers: the person's own, and for a shared pool everyone the rule reaches. */
async function clearSkipsFor(tx: Tx, rule: RuleFacts, personId: string, now: Date): Promise<void> {
  const monthKey = monthKeyOf(now);
  await tx.creditIssueSkip.deleteMany({ where: { personId, programId: rule.programId, monthKey } });
  if (rule.share !== 'shared') return;
  const others = await tx.creditIssueSkip.findMany({ where: { programId: rule.programId, monthKey }, select: { personId: true } });
  const reached: string[] = [];
  for (const { personId: other } of others) {
    const facts = await personFacts(tx, other);
    if (facts && reaches(rule, facts)) reached.push(other);
  }
  if (reached.length > 0) await tx.creditIssueSkip.deleteMany({ where: { personId: { in: reached }, programId: rule.programId, monthKey } });
}

/** Issues for several people (a rollout, a migration run, a gift to people you pick): each one the same exactly-once way. */
export async function ensureIssuedFor(personIds: readonly string[], now: Date = new Date()): Promise<{ issued: number; skipped: number }> {
  let issued = 0;
  let skipped = 0;
  for (const id of personIds) {
    // Each person reads the settings fresh: a rollout budget changed during a long run applies to the people after it
    const result = await ensureIssued(id, now);
    issued += result.issued.length;
    skipped += result.skipped.length;
  }
  return { issued, skipped };
}
