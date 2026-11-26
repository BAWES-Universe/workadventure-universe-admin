import type { Prisma } from '@prisma/client';
import { asNumber, claimOpen, isCategory, reaches, readRecipient, type CategoryId, type LotFacts, type LotSource, type PersonFacts, type ProgramKind, type Recipient, type RuleFacts, type Schedule, type Settlement, type Share } from '@/lib/credit-values';

/**
 * The funding books' database reads, shared by issuing, spending, the rules screens and the Usage view. Reads only (and the
 * advisory locks writers take): the rules of what to do are in lib/credit-values.ts, and the writers are lib/credit-issue.ts,
 * lib/credit-spend.ts and lib/credit-rules.ts.
 */

export type Tx = Prisma.TransactionClient;
export type Db = Pick<Tx, 'grantRule' | 'grantRecipient' | 'grantProgram' | 'creditLot' | 'creditAllocation' | 'creditRefund' | 'creditHold' | 'fundingAccount' | 'fundingAccountAdmin' | 'user' | 'universeMember' | '$queryRaw'>;

/**
 * One lock per name for the rest of the transaction: two writers on the same name go one after the other. Always taken in sorted
 * order (see `lockAll`) so two transactions that each need two names can never wait on each other.
 */
export async function lockName(tx: Pick<Tx, '$executeRaw'>, name: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`;
}

export async function lockAll(tx: Pick<Tx, '$executeRaw'>, names: Iterable<string>, shared: Iterable<string> = []): Promise<void> {
  // `shared` names are read-locked: many holders at once, but a writer of the name (which takes it as above) waits for all of them and
  // they wait for it. Both kinds are taken in one sorted order, so mixing them cannot make two transactions wait on each other
  const readers = new Set(shared);
  for (const name of [...new Set([...names, ...readers])].sort()) {
    if (readers.has(name) && ![...names].includes(name)) await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${name}))`;
    else await lockName(tx, name);
  }
}

export const lockOfPerson = (personId: string): string => `credit:person:${personId}`;
export const lockOfPool = (programId: string): string => `credit:pool:${programId}`;
export const lockOfEffect = (effectKey: string): string => `credit:effect:${effectKey}`;
/** One hold key: a hold being made under it and the closing of that key (see `releaseKeyIfNothingHeld`) meet here, one after the other. */
export const lockOfHoldKey = (holdKey: string): string => `credit:holdkey:${holdKey}`;
export const lockOfAccount = (accountId: string): string => `credit:account:${accountId}`;
/** What a save of a category's rules holds while it checks and writes them: issuing holds it shared, so it reads rules that are not half-saved. */
export const lockOfRules = (categoryId: string): string => `credit:rules:${categoryId}`;
/** The meter's settings (Limits): a save holds it exclusive, issuing holds it shared while it reads the rollout budget. */
export const LOCK_METER_SETTINGS = 'meter:settings';

type RuleRow = Prisma.GrantRuleGetPayload<{ include: { program: true; recipients: { select: { userId: true } } } }>;

/** A saved rule as the pure rules read it. */
export function ruleFacts(row: RuleRow): RuleFacts {
  const recipient: Recipient = readRecipient({
    kind: row.recipientType,
    from: row.recipientFrom ?? undefined,
    to: row.recipientTo ?? undefined,
    universeId: row.recipientUniverseId ?? undefined,
    mode: row.recipientMode ?? undefined,
    // The ids a rule reaches by id, in the shape readRecipient expects; a universe snapshot keeps its ids in the recipient rows
    userIds: row.recipientType === 'people' ? row.recipients.map((r) => r.userId) : undefined,
  });
  return {
    id: row.id,
    programId: row.programId,
    programKind: row.program.kind as ProgramKind,
    categoryId: (isCategory(row.program.categoryId) ? row.program.categoryId : 'instant_apps') as CategoryId,
    version: row.version,
    fundingAccountId: row.fundingAccountId,
    covers: row.covers,
    benefitKind: row.benefitKind as RuleFacts['benefitKind'],
    amount: asNumber(row.amount),
    schedule: row.schedule as Schedule,
    share: row.share as Share,
    recipient,
    recipientIds: new Set(row.recipients.map((r) => r.userId)),
    joinerCap: row.joinerCap,
    totalCapMicros: row.totalCapMicros === null ? null : asNumber(row.totalCapMicros),
    claimStartsAt: row.claimStartsAt,
    claimEndsAt: row.claimEndsAt,
    lotExpiresAt: row.lotExpiresAt,
    lotExpiresInDays: row.lotExpiresInDays,
    settlement: row.settlement as Settlement,
  };
}

const ruleInclude = { program: true, recipients: { select: { userId: true } } } as const;

/**
 * The rules in force: the current version of every active program. `now` keeps only those whose claim period is open, and also keeps a
 * version that a later one will replace only when that one starts (a default replaced by one that begins next month): until then it is
 * the rule people are issued under, so nobody is left with nothing in between.
 */
export async function currentRules(db: Pick<Db, 'grantRule'>, filter: { categoryId?: CategoryId; programId?: string; now?: Date; waitingAfter?: Date } = {}): Promise<RuleFacts[]> {
  const rows = await db.grantRule.findMany({
    where: {
      ...(filter.now || filter.waitingAfter ? { OR: [{ state: 'current' }, { state: 'superseded', supersededAt: { gt: (filter.now ?? filter.waitingAfter) as Date } }] } : { state: 'current' }),
      program: { status: 'active', ...(filter.categoryId ? { categoryId: filter.categoryId } : {}) },
      ...(filter.programId ? { programId: filter.programId } : {}),
    },
    include: ruleInclude,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  // `waitingAfter` is for checks between rules (a clash, an overlap): a version that a later one will replace counts until then, so its claim
  // period ends where the replacement starts
  const facts = rows.map((row) => {
    const rule = ruleFacts(row);
    return filter.waitingAfter && row.state === 'superseded' && row.supersededAt && (!rule.claimEndsAt || row.supersededAt < rule.claimEndsAt) ? { ...rule, claimEndsAt: row.supersededAt } : rule;
  });
  return filter.now ? facts.filter((rule) => claimOpen(rule, filter.now as Date)) : facts;
}

/** A person as the rules need them; null when they do not exist or are a guest (guests keep their own separate rules and have no credit). */
export async function personFacts(db: Pick<Db, 'user' | 'universeMember'>, personId: string): Promise<PersonFacts | null> {
  const user = await db.user.findUnique({ where: { id: personId }, select: { id: true, createdAt: true, isGuest: true } });
  if (!user || user.isGuest) return null;
  const memberships = await db.universeMember.findMany({ where: { userId: personId }, select: { universeId: true } });
  return { id: user.id, createdAt: user.createdAt, universeIds: new Set(memberships.map((m) => m.universeId)) };
}

/** `personFacts` for many people in two reads (not two per person), keyed by id; guests and people who do not exist are left out. */
export async function peopleFacts(db: Pick<Db, 'user' | 'universeMember'>, personIds: readonly string[]): Promise<Map<string, PersonFacts>> {
  const out = new Map<string, PersonFacts>();
  if (personIds.length === 0) return out;
  const users = await db.user.findMany({ where: { id: { in: [...personIds] }, isGuest: false }, select: { id: true, createdAt: true } });
  if (users.length === 0) return out;
  const memberships = await db.universeMember.findMany({ where: { userId: { in: users.map((user) => user.id) } }, select: { userId: true, universeId: true } });
  const universes = new Map<string, Set<string>>();
  for (const m of memberships) universes.set(m.userId, (universes.get(m.userId) ?? new Set<string>()).add(m.universeId));
  for (const user of users) out.set(user.id, { id: user.id, createdAt: user.createdAt, universeIds: universes.get(user.id) ?? new Set<string>() });
  return out;
}

/** The people a rule reaches by id, for a clash check or a preview: the saved ids, or a changing universe's members now. */
export async function idsReached(db: Pick<Db, 'universeMember'>, rule: Pick<RuleFacts, 'recipient' | 'recipientIds'>): Promise<Set<string>> {
  const recipient = rule.recipient;
  if (recipient.kind === 'universe' && recipient.mode === 'changing') {
    const members = await db.universeMember.findMany({ where: { universeId: recipient.universeId }, select: { userId: true } });
    return new Set(members.map((member) => member.userId));
  }
  if (recipient.kind === 'people') return new Set(recipient.userIds);
  return new Set(rule.recipientIds);
}

export interface LotBalance {
  amountMicros: number;
  /** Taken for steps that have not finished. */
  heldMicros: number;
  /** Taken for steps that finished, less what was given back into the lot. */
  usedMicros: number;
  availableMicros: number;
}

/** What each lot holds and has spent, counted from the allocations and refunds (a lot has no balance of its own). */
export async function lotBalances(db: Pick<Db, '$queryRaw'>, lotIds: readonly string[]): Promise<Map<string, LotBalance>> {
  const out = new Map<string, LotBalance>();
  if (lotIds.length === 0) return out;
  const rows = await db.$queryRaw<{ id: string; amount: bigint; held: bigint; settled: bigint; restored: bigint }[]>`
    SELECT l.id,
           l.amount_micros AS amount,
           COALESCE((SELECT SUM(a.amount_micros) FROM credit_allocations a WHERE a.lot_id = l.id AND a.state = 'held'), 0)::bigint AS held,
           COALESCE((SELECT SUM(a.settled_micros) FROM credit_allocations a WHERE a.lot_id = l.id AND a.state = 'settled'), 0)::bigint AS settled,
           COALESCE((SELECT SUM(r.amount_micros) FROM credit_refunds r WHERE r.lot_id = l.id AND r.mode = 'restored'), 0)::bigint AS restored
    FROM credit_lots l WHERE l.id = ANY(${lotIds as string[]})`;
  for (const row of rows) {
    const amount = asNumber(row.amount);
    const held = asNumber(row.held);
    const used = asNumber(row.settled) - asNumber(row.restored);
    out.set(row.id, { amountMicros: amount, heldMicros: held, usedMicros: used, availableMicros: Math.max(0, amount - held - used) });
  }
  return out;
}

export type LotRow = Prisma.CreditLotGetPayload<Record<string, never>>;

/**
 * The lots that may pay for something in a category for a person at a moment: theirs, and the shared pools they are recipients of;
 * not ended, not yet started, from an account that funds. `onlyAccountId` is for work a named payer funds (a universe-paid service):
 * then only that account's lots count, and nothing falls back to anyone else's.
 */
export async function usableLots(
  db: Db,
  personId: string,
  category: CategoryId,
  now: Date,
  opts: { onlyAccountId?: string | null; person?: PersonFacts | null } = {},
): Promise<(LotFacts & { lot: LotRow; balance: LotBalance })[]> {
  const own = await db.creditLot.findMany({
    where: { subjectKey: `person:${personId}`, covers: { has: category }, startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], account: { status: 'active' }, ...(opts.onlyAccountId ? { fundingAccountId: opts.onlyAccountId } : {}) },
  });
  const poolLots = await db.creditLot.findMany({
    where: { subjectKey: { startsWith: 'pool:' }, covers: { has: category }, startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], account: { status: 'active' }, ...(opts.onlyAccountId ? { fundingAccountId: opts.onlyAccountId } : {}) },
  });
  let pools: LotRow[] = [];
  if (poolLots.length > 0) {
    const person = opts.person === undefined ? await personFacts(db, personId) : opts.person;
    const rules = person ? await db.grantRule.findMany({ where: { programId: { in: poolLots.map((lot) => lot.programId ?? '') } }, include: ruleInclude, orderBy: { version: 'desc' } }) : [];
    // A pool is open to the people its rule reaches: the version it was issued under, never a later edit
    const reached = new Map<string, boolean>();
    for (const lot of poolLots) {
      const row = issuingVersion(rules.filter((rule) => rule.programId === lot.programId), lot.ruleVersion);
      reached.set(lot.id, !!row && !!person && reachesRow(row, person));
    }
    pools = poolLots.filter((lot) => reached.get(lot.id));
  }
  const lots = [...own, ...pools];
  const balances = await lotBalances(db, lots.map((lot) => lot.id));
  return lots.map((lot) => {
    const balance = balances.get(lot.id) ?? { amountMicros: asNumber(lot.amountMicros), heldMicros: 0, usedMicros: 0, availableMicros: asNumber(lot.amountMicros) };
    return { id: lot.id, source: lot.source as LotSource, covers: lot.covers, issuedAt: lot.issuedAt, expiresAt: lot.expiresAt, availableMicros: balance.availableMicros, lot, balance };
  });
}

const reachesRow = (row: RuleRow, person: PersonFacts): boolean => reaches(ruleFacts(row), person);

/** The version a pool was issued under, from one program's versions newest first: the newest when that one is gone (or was never said). */
const issuingVersion = (versions: readonly RuleRow[], ruleVersion: number | null): RuleRow | undefined => versions.find((rule) => rule.version === ruleVersion) ?? versions[0];

/**
 * Whether a shared pool is open to a person, the way `usableLots` decides it: by the rule version the pool was issued under (the latest
 * version when that one is gone), never a later edit.
 */
export async function poolOpenTo(db: Db, lot: { programId: string; ruleVersion: number | null }, personId: string): Promise<boolean> {
  const person = await personFacts(db, personId);
  if (!person) return false;
  const rules = await db.grantRule.findMany({ where: { programId: lot.programId }, include: ruleInclude, orderBy: { version: 'desc' } });
  const row = issuingVersion(rules, lot.ruleVersion);
  return !!row && reachesRow(row, person);
}
