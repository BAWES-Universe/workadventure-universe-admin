import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { asNumber, CreditRefused, monthEnd, monthStart } from '@/lib/credit-values';
import { lockAll, lockOfAccount, lotBalances, type Db } from '@/lib/credit-store';
import type { MeterSettings } from '@/lib/meter-values';

/**
 * Funding accounts (paying spec v3, sections 2b and 5): who pays. The platform itself ("BAWES Universe"), a person, or a universe, each
 * with named administrators, so the account survives a manager leaving. Self-service screens for people and universes come later; the books
 * are here now so personal, lent and universe-owned things keep working, and "Paid by BAWES Universe" is a real name.
 */

export const PLATFORM_ACCOUNT_ID = 'funding-platform';

export type AccountKind = 'platform' | 'person' | 'universe';
export type AccountStatus = 'active' | 'paused' | 'closed';

export interface FundingAccountView {
  id: string;
  kind: AccountKind;
  ownerKey: string;
  name: string;
  currency: string;
  budgetMicros: number | null;
  status: AccountStatus;
  adminIds: string[];
}

type Row = { id: string; kind: string; ownerKey: string; name: string; currency: string; budgetMicros: bigint | null; status: string; admins?: { userId: string }[] };

const view = (row: Row): FundingAccountView => ({
  id: row.id,
  kind: row.kind as AccountKind,
  ownerKey: row.ownerKey,
  name: row.name,
  currency: row.currency,
  budgetMicros: row.budgetMicros === null ? null : asNumber(row.budgetMicros),
  status: row.status as AccountStatus,
  adminIds: (row.admins ?? []).map((admin) => admin.userId).sort(),
});

/** The platform's own account. The migration makes it; this makes it again if a database lost it, so nothing else needs to check. */
export async function platformAccount(db: Pick<Db, 'fundingAccount'> = prisma): Promise<FundingAccountView> {
  const row = await db.fundingAccount.upsert({
    where: { kind_ownerKey: { kind: 'platform', ownerKey: 'platform' } },
    create: { id: PLATFORM_ACCOUNT_ID, kind: 'platform', ownerKey: 'platform', name: 'BAWES Universe' },
    update: {},
    include: { admins: { select: { userId: true } } },
  });
  return view(row);
}

export async function listFundingAccounts(): Promise<FundingAccountView[]> {
  await platformAccount();
  const rows = await prisma.fundingAccount.findMany({ include: { admins: { select: { userId: true } } }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] });
  return rows.map(view);
}

export async function getFundingAccount(id: string, db: Pick<Db, 'fundingAccount'> = prisma): Promise<FundingAccountView | null> {
  const row = await db.fundingAccount.findUnique({ where: { id }, include: { admins: { select: { userId: true } } } });
  return row ? view(row) : null;
}

/**
 * Makes the funding account of a person or a universe, once per owner: asking again finds it. A person's account has that person as an
 * administrator; a universe's has the people named. The platform's account is not made here, and nobody can become it.
 */
export async function ensureFundingAccount(input: { kind: 'person' | 'universe'; ownerKey: string; name: string; adminIds: string[]; budgetMicros?: number | null }): Promise<FundingAccountView> {
  if (!input.ownerKey || input.ownerKey === 'platform') throw new CreditRefused('That owner cannot have a funding account', 'owner');
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new CreditRefused('A funding account needs a name', 'name');
  const row = await prisma.fundingAccount.upsert({
    where: { kind_ownerKey: { kind: input.kind, ownerKey: input.ownerKey } },
    create: { kind: input.kind, ownerKey: input.ownerKey, name, budgetMicros: input.budgetMicros ?? null },
    update: {},
    include: { admins: { select: { userId: true } } },
  });
  const missing = input.adminIds.filter((id) => !row.admins.some((admin) => admin.userId === id));
  if (missing.length > 0) await prisma.fundingAccountAdmin.createMany({ data: missing.map((userId) => ({ accountId: row.id, userId })), skipDuplicates: true });
  return (await getFundingAccount(row.id)) as FundingAccountView;
}

export async function addAdmin(accountId: string, userId: string, addedById: string | null): Promise<void> {
  await prisma.fundingAccountAdmin.createMany({ data: [{ accountId, userId, addedById }], skipDuplicates: true });
}

/** Takes an administrator off. The last one stays: an account nobody can administer is never left behind (paused is the way to stop one). */
export async function removeAdmin(accountId: string, userId: string): Promise<'removed' | 'last_admin' | 'not_found'> {
  // One removal per account at a time, and the check and the delete in one transaction: two removals at once cannot both see "one is left"
  return prisma.$transaction(async (tx) => {
    await lockAll(tx, [lockOfAccount(accountId)]);
    // The account's own row too, locked for the rest of the transaction: whatever else writes to the account waits here as well, not only
    // the code that takes the named lock
    await tx.$queryRaw`SELECT id FROM funding_accounts WHERE id = ${accountId} FOR UPDATE`;
    const admins = await tx.fundingAccountAdmin.findMany({ where: { accountId }, select: { userId: true } });
    if (!admins.some((admin) => admin.userId === userId)) return 'not_found';
    const account = await tx.fundingAccount.findUnique({ where: { id: accountId }, select: { kind: true } });
    if (account?.kind !== 'platform' && admins.length <= 1) return 'last_admin';
    await tx.fundingAccountAdmin.deleteMany({ where: { accountId, userId } });
    return 'removed';
  });
}

export async function isFundingAdmin(accountId: string, userId: string, db: Pick<Db, 'fundingAccountAdmin'> = prisma): Promise<boolean> {
  const row = await db.fundingAccountAdmin.findUnique({ where: { accountId_userId: { accountId, userId } }, select: { id: true } });
  return !!row;
}

/** Paused or closed funds nothing new, and a hold never draws from its lots. What was issued is not taken back. */
export async function setAccountStatus(accountId: string, status: AccountStatus): Promise<FundingAccountView> {
  if (accountId === PLATFORM_ACCOUNT_ID && status === 'closed') throw new CreditRefused('The platform’s account cannot be closed', 'status');
  const row = await prisma.fundingAccount.update({ where: { id: accountId }, data: { status }, include: { admins: { select: { userId: true } } } });
  return view(row);
}

/** The monthly funded budget: the account's own, or for the platform the rollout budget in Limits. Null means nothing is set, so nothing issues. */
export function budgetOf(account: Pick<FundingAccountView, 'kind' | 'budgetMicros'>, settings: Pick<MeterSettings, 'rolloutBudgetMicros'>): number | null {
  if (account.budgetMicros !== null) return account.budgetMicros;
  return account.kind === 'platform' ? settings.rolloutBudgetMicros : null;
}

/** What an account issued in the calendar month (UTC) of `now`. */
export async function issuedInMonth(db: Pick<Db, 'creditLot'>, accountId: string, now: Date): Promise<number> {
  const sum = await db.creditLot.aggregate({ where: { fundingAccountId: accountId, issuedAt: { gte: monthStart(now), lt: monthEnd(now) } }, _sum: { amountMicros: true } });
  return asNumber(sum._sum.amountMicros);
}

export interface Exposure {
  accountId: string;
  /** The month's funded budget; null when none is set. */
  budgetMicros: number | null;
  /** Credit issued this UTC month. */
  issuedThisMonthMicros: number;
  /** Credit promised and not yet spent: what is left in lots that have not ended. */
  outstandingMicros: number;
  /** Room held for steps that have not finished. */
  heldMicros: number;
  /** Held room whose time ran out without being settled or released: not known yet, so still counted. */
  unresolvedMicros: number;
  /** Charged this month to customers' credit from this account's lots. */
  chargedThisMonthMicros: number;
}

/**
 * What an account has promised and what is at risk, counted from the lots and holds. Customer credit only: what a provider bills us is
 * the meter's books (lib/meter-allowance.ts envelope), kept apart on purpose, and a dollar of credit is not a dollar of provider cost.
 */
export async function exposureOf(accountId: string, now: Date = new Date(), settings?: MeterSettings): Promise<Exposure> {
  const [account, resolved] = await Promise.all([getFundingAccount(accountId), settings ? Promise.resolve(settings) : getMeterSettings()]);
  if (!account) throw new CreditRefused('That funding account does not exist', 'account');
  const live = await prisma.creditLot.findMany({ where: { fundingAccountId: accountId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, select: { id: true } });
  const balances = await lotBalances(prisma, live.map((lot) => lot.id));
  let outstanding = 0;
  for (const balance of balances.values()) outstanding += balance.availableMicros;
  // Room held for steps in progress counts even when the lot it came from has ended since: the step may still settle against it
  const heldNow = await prisma.$queryRaw<{ micros: bigint | null }[]>`
    SELECT COALESCE(SUM(a.amount_micros), 0)::bigint AS micros
    FROM credit_allocations a JOIN credit_holds h ON h.id = a.hold_id JOIN credit_lots l ON l.id = a.lot_id
    WHERE a.state = 'held' AND h.expires_at > ${now} AND l.funding_account_id = ${accountId}`;
  const held = asNumber(heldNow[0]?.micros);
  const lapsed = await prisma.$queryRaw<{ micros: bigint | null }[]>`
    SELECT COALESCE(SUM(a.amount_micros), 0)::bigint AS micros
    FROM credit_allocations a JOIN credit_holds h ON h.id = a.hold_id JOIN credit_lots l ON l.id = a.lot_id
    WHERE a.state = 'held' AND h.expires_at <= ${now} AND l.funding_account_id = ${accountId}`;
  const charged = await prisma.$queryRaw<{ micros: bigint | null }[]>`
    SELECT COALESCE(SUM(a.settled_micros), 0)::bigint AS micros
    FROM credit_allocations a JOIN credit_holds h ON h.id = a.hold_id JOIN credit_lots l ON l.id = a.lot_id
    WHERE a.state = 'settled' AND h.closed_at >= ${monthStart(now)} AND h.closed_at < ${monthEnd(now)} AND l.funding_account_id = ${accountId}`;
  return {
    accountId,
    budgetMicros: budgetOf(account, resolved),
    issuedThisMonthMicros: await issuedInMonth(prisma, accountId, now),
    outstandingMicros: outstanding,
    heldMicros: held,
    unresolvedMicros: asNumber(lapsed[0]?.micros),
    chargedThisMonthMicros: asNumber(charged[0]?.micros),
  };
}

/** The UTC month of a moment, "2026-12". */
export const monthKeyOf = (now: Date): string => now.toISOString().slice(0, 7);

/**
 * The rollout budget this UTC month, for the Limits screen: what the platform issued from defaults and gifts, and how many people were due a
 * default and were not given it because it would have passed the budget. Never silent when it runs out.
 */
export async function rolloutThisMonth(now: Date = new Date()): Promise<{ issuedMicros: number; notGivenPeople: number; perPersonMicros: number; accountBudgetMicros: number | null }> {
  const issuedMicros = await issuedInMonth(prisma, PLATFORM_ACCOUNT_ID, now);
  // The platform funding account's own budget, when one is set, is the one issuing goes by (`budgetOf`), not the Limits number
  const accountBudgetMicros = (await getFundingAccount(PLATFORM_ACCOUNT_ID))?.budgetMicros ?? null;
  const rows = await prisma.creditIssueSkip.findMany({ where: { monthKey: monthKeyOf(now), reason: 'over_budget' }, distinct: ['personId'], select: { personId: true } });
  // What one more person is given from the budget this month: the current defaults Universe pays for, each person's own share of each
  const defaults = await prisma.grantRule.findMany({
    where: {
      state: 'current',
      fundingAccountId: PLATFORM_ACCOUNT_ID,
      share: 'each',
      claimStartsAt: { lte: now },
      OR: [{ claimEndsAt: null }, { claimEndsAt: { gt: now } }],
      program: { kind: 'default', status: 'active' },
    },
    select: { amount: true },
  });
  const perPersonMicros = defaults.reduce((sum, rule) => sum + Number(rule.amount), 0);
  return { issuedMicros, notGivenPeople: rows.length, perPersonMicros, accountBudgetMicros };
}
