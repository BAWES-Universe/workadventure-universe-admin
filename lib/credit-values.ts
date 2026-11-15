/**
 * The funding books' words and pure rules (paying spec v3, section 16, O1). Nothing here reads the database, so every rule is
 * tested on its own: who a grant reaches, which of several rules wins, what a charge is, and the order credit is spent in.
 * Every amount is a whole number of millionths of a dollar ("micros"), except replies, which are whole replies. A dollar of credit
 * is never a reply, and replies never pay for dollars: each category has one fixed unit.
 */

export const CATEGORY_IDS = ['universe_ai', 'instant_apps', 'computers'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

/** The categories that hold money. Universe AI is a reply entitlement with its window (lib/reply-limits.ts) and has no lots. */
export const MONEY_CATEGORIES = ['instant_apps', 'computers'] as const;
export type MoneyCategory = (typeof MONEY_CATEGORIES)[number];

export const isCategory = (value: unknown): value is CategoryId => typeof value === 'string' && (CATEGORY_IDS as readonly string[]).includes(value);
export const isMoneyCategory = (value: unknown): value is MoneyCategory => typeof value === 'string' && (MONEY_CATEGORIES as readonly string[]).includes(value);

export const SCHEDULES = ['once', 'monthly', 'none'] as const;
export type Schedule = (typeof SCHEDULES)[number];

export const SHARES = ['each', 'shared'] as const;
export type Share = (typeof SHARES)[number];

export const PROGRAM_KINDS = ['default', 'exception', 'gift'] as const;
export type ProgramKind = (typeof PROGRAM_KINDS)[number];

export const SETTLEMENTS = ['free', 'to_bill'] as const;
export type Settlement = (typeof SETTLEMENTS)[number];

/**
 * What a lot of credit came from. The four kinds are never mixed: a default (or an exception to it), a gift, agreed manual billing, and
 * purchased credit (later, only after a verified payment). A replacement is a small credit made apart for a platform failure.
 */
export const LOT_SOURCES = ['default', 'gift', 'manual_billing', 'purchase', 'replacement'] as const;
export type LotSource = (typeof LOT_SOURCES)[number];

/**
 * What a charge can be. A charge class decides which category pays, so nested work is charged once: an App used inside a computer job is
 * a computer_tool, not also an instant_run. Ordinary connected-app use (app_overhead), kept storage and Universe AI chat are not paid
 * from credit at all: they are counted as platform cost, and charging for them would be a deliberate, announced change.
 */
export const CHARGE_CLASSES = ['instant_run', 'computer_job', 'computer_model', 'computer_tool', 'app_overhead', 'storage', 'model_reply'] as const;
export type ChargeClass = (typeof CHARGE_CLASSES)[number];

/** Which category pays for each charge class, as the categories table lists it (data). A class no category lists is never paid from credit. */
export function categoryFor(chargeClass: string, categories: readonly { id: string; pays: readonly string[]; status?: string }[]): MoneyCategory | null {
  const hit = categories.filter((category) => category.status !== 'retired' && isMoneyCategory(category.id) && category.pays.includes(chargeClass));
  // Two categories claiming one class would make a charge payable twice: nobody pays rather than guessing
  return hit.length === 1 ? (hit[0].id as MoneyCategory) : null;
}

export interface ChargeFacts {
  /** What the step is: an Instant run, a computer's own time, the model inside a job, a paid tool inside a job. */
  work: 'instant' | 'computer_time' | 'computer_model' | 'tool';
  /** The job it runs inside, if any. A computer job is one with a computer. */
  inComputerJob: boolean;
}

/** The charge class of a step: an App or tool used inside a computer job belongs to that job (charged once), anywhere else an Instant run is its own. */
export function classifyCharge(facts: ChargeFacts): ChargeClass {
  switch (facts.work) {
    case 'computer_time':
      return 'computer_job';
    case 'computer_model':
      return 'computer_model';
    case 'tool':
      return facts.inComputerJob ? 'computer_tool' : 'instant_run';
    case 'instant':
      return facts.inComputerJob ? 'computer_tool' : 'instant_run';
  }
}

// ---------- Recipients ----------

/**
 * Who a grant is for. Stored by account id, never by role: roles belong to each universe, so they are not a platform-wide way to pick
 * people ("people you pick" covers staff and anyone special). Being a recipient gives no room, app or admin rights.
 */
export type Recipient =
  /** Signed-in accounts only. Guests keep their own separate rules. */
  | { kind: 'all' }
  /** Accounts created from `from` (included) until `to` (not included), by the account's real creation time. Signing in again or joining a universe is not signing up. */
  | { kind: 'new_from'; from: Date; to?: Date | null }
  /** One person, or people you pick: a snapshot of ids. */
  | { kind: 'people'; userIds: string[] }
  /** A universe's members: people who joined it, not people who visited a public room. A snapshot of who is in it now unless it says `changing`. */
  | { kind: 'universe'; universeId: string; mode?: 'snapshot' | 'changing' };

export const RECIPIENT_KINDS = ['all', 'new_from', 'people', 'universe'] as const;

export class CreditRefused extends Error {
  constructor(
    message: string,
    readonly code: string = 'refused',
  ) {
    super(message);
    this.name = 'CreditRefused';
  }
}

/** A refusal from these rules, by what it says it is: two copies of this module (a test runner loads one per path) still agree. */
export const isCreditRefused = (error: unknown): error is CreditRefused => error instanceof CreditRefused || (error instanceof Error && error.name === 'CreditRefused' && typeof (error as { code?: unknown }).code === 'string');

const isDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

/** A recipient as an admin API sends it (dates may be ISO strings); the checked one, or what is wrong with it. */
export function readRecipient(input: unknown): Recipient {
  if (typeof input !== 'object' || input === null) throw new CreditRefused('recipients is required', 'recipients');
  const raw = input as Record<string, unknown>;
  const date = (value: unknown): Date | null => {
    const parsed = typeof value === 'string' || typeof value === 'number' ? new Date(value) : value;
    return isDate(parsed) ? parsed : null;
  };
  switch (raw.kind) {
    case 'all':
      return { kind: 'all' };
    case 'new_from': {
      const from = date(raw.from);
      if (!from) throw new CreditRefused('"New people from" needs a date', 'recipients');
      const to = raw.to === undefined || raw.to === null ? null : date(raw.to);
      if (raw.to !== undefined && raw.to !== null && !to) throw new CreditRefused('The end date is not a date', 'recipients');
      if (to && to <= from) throw new CreditRefused('The end date must come after the start', 'recipients');
      return { kind: 'new_from', from, to };
    }
    case 'people': {
      if (!Array.isArray(raw.userIds) || raw.userIds.length === 0) throw new CreditRefused('Pick at least one person', 'recipients');
      const ids = raw.userIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 255);
      if (ids.length !== raw.userIds.length) throw new CreditRefused('Every person must be an account id', 'recipients');
      return { kind: 'people', userIds: [...new Set(ids)].sort() };
    }
    case 'universe': {
      if (typeof raw.universeId !== 'string' || !raw.universeId) throw new CreditRefused('Pick a universe', 'recipients');
      if (raw.mode !== undefined && raw.mode !== 'snapshot' && raw.mode !== 'changing') throw new CreditRefused('mode must be snapshot or changing', 'recipients');
      return { kind: 'universe', universeId: raw.universeId, mode: raw.mode === 'changing' ? 'changing' : 'snapshot' };
    }
    default:
      // "role" and every other word land here: roles are never recipients
      throw new CreditRefused('Recipients are all signed-in members, new people from a date, people you pick, or a universe’s members', 'recipients');
  }
}

/** What the rule saves about a recipient, as columns. */
export function recipientColumns(recipient: Recipient): {
  recipientType: Recipient['kind'];
  recipientFrom: Date | null;
  recipientTo: Date | null;
  recipientUniverseId: string | null;
  recipientMode: 'snapshot' | 'changing' | null;
} {
  return {
    recipientType: recipient.kind,
    recipientFrom: recipient.kind === 'new_from' ? recipient.from : null,
    recipientTo: recipient.kind === 'new_from' ? (recipient.to ?? null) : null,
    recipientUniverseId: recipient.kind === 'universe' ? recipient.universeId : null,
    recipientMode: recipient.kind === 'universe' ? (recipient.mode ?? 'snapshot') : null,
  };
}

/** A person as the rules need to know them. */
export interface PersonFacts {
  id: string;
  createdAt: Date;
  /** The universes they have joined. */
  universeIds: ReadonlySet<string>;
}

/** A saved rule as the rules here read it. */
export interface RuleFacts {
  id: string;
  programId: string;
  programKind: ProgramKind;
  categoryId: CategoryId;
  version: number;
  fundingAccountId: string;
  covers: readonly string[];
  benefitKind: 'replace' | 'add_credit';
  amount: number;
  schedule: Schedule;
  share: Share;
  recipient: Recipient;
  /** For people and for a universe snapshot: the ids saved with the rule. */
  recipientIds: ReadonlySet<string>;
  joinerCap: number | null;
  totalCapMicros: number | null;
  claimStartsAt: Date;
  claimEndsAt: Date | null;
  lotExpiresAt: Date | null;
  lotExpiresInDays: number | null;
  settlement: Settlement;
}

/** Whether the rule's claim period is open at a moment. */
export const claimOpen = (rule: Pick<RuleFacts, 'claimStartsAt' | 'claimEndsAt'>, now: Date): boolean =>
  rule.claimStartsAt <= now && (rule.claimEndsAt === null || now < rule.claimEndsAt);

/** Whether a person is one of the rule's recipients (not whether the rule is open, or has money left: see `claimOpen` and the issuing). */
export function reaches(rule: Pick<RuleFacts, 'recipient' | 'recipientIds'>, person: PersonFacts): boolean {
  const recipient = rule.recipient;
  switch (recipient.kind) {
    case 'all':
      return true;
    case 'new_from':
      return person.createdAt >= recipient.from && (!recipient.to || person.createdAt < recipient.to);
    case 'people':
      return rule.recipientIds.has(person.id);
    case 'universe':
      return recipient.mode === 'changing' ? person.universeIds.has(recipient.universeId) : rule.recipientIds.has(person.id);
  }
}

// ---------- Which rule wins (spec 2a) ----------

/**
 * How narrow a base rule (a default or an exception) is: a person's own exception comes first, then a group's, then the default.
 * One person is "people you pick" with a single id; two or more, or a universe's members, are a group.
 */
export function baseRank(rule: Pick<RuleFacts, 'programKind' | 'recipient' | 'recipientIds'>): 1 | 2 | 3 {
  if (rule.programKind === 'default') return 3;
  if (rule.recipient.kind === 'people' && rule.recipient.userIds.length === 1) return 1;
  return 2;
}

export type BaseWinner = { winner: RuleFacts } | { winner: null; clash: RuleFacts[] } | { winner: null; clash?: undefined };

/** Two rules say the same thing when they would give a person the same. */
const sameGiving = (a: RuleFacts, b: RuleFacts): boolean => a.amount === b.amount && a.schedule === b.schedule && a.share === b.share;

/**
 * Of the base rules that reach one person in one category, the one that applies: the narrowest. Two of the same narrowness that say
 * different things are a clash, which the save refuses, so it should not exist: if it does (rules saved by another path) nobody is given
 * the bigger one by quiet default, nothing is issued, and the caller says so.
 */
export function pickBase(rules: readonly RuleFacts[]): BaseWinner {
  if (rules.length === 0) return { winner: null };
  const best = Math.min(...rules.map(baseRank));
  const top = rules.filter((rule) => baseRank(rule) === best);
  if (top.every((rule) => sameGiving(rule, top[0]))) {
    // The same thing said twice: the oldest program, so it is never a matter of the order the rows came in
    const sorted = [...top].sort((a, b) => a.programId.localeCompare(b.programId));
    return { winner: sorted[0] };
  }
  return { winner: null, clash: top };
}

export interface ClashFinding {
  /** The program already saved that disagrees. */
  programId: string;
  /** The people it would reach both ways. */
  userIds: string[];
}

/**
 * Whether a base rule about to be saved clashes with those already saved for the same category. `idsOf` gives the people a rule
 * reaches by id. Only same-narrowness exceptions can clash (a person's own exception beats a group's, and any exception beats the
 * default), and only when they say different things. The people it affects are named so the admin can choose.
 */
export function findClashes(candidate: RuleFacts, saved: readonly RuleFacts[], idsOf: (rule: RuleFacts) => ReadonlySet<string>): ClashFinding[] {
  if (candidate.programKind === 'gift') return [];
  const rank = baseRank(candidate);
  const mine = idsOf(candidate);
  const findings: ClashFinding[] = [];
  for (const other of saved) {
    if (other.programKind === 'gift' || other.programId === candidate.programId) continue;
    if (baseRank(other) !== rank) continue;
    // Two defaults for one category are one too many; they reach everyone, so the clash is "everyone"
    if (rank === 3) {
      findings.push({ programId: other.programId, userIds: [] });
      continue;
    }
    if (sameGiving(candidate, other)) continue;
    const shared = [...idsOf(other)].filter((id) => mine.has(id)).sort();
    if (shared.length > 0) findings.push({ programId: other.programId, userIds: shared });
  }
  return findings;
}

// ---------- Periods and lots ----------

/** A UTC month, "2026-12". Monthly credit renews on the 1st in UTC, shown in local time, with no roll-over. */
export function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
export const monthEnd = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/** The slot a base rule's lots live in: a default and an exception take turns in it, never both. A gift has its own. */
export const slotKeyFor = (rule: Pick<RuleFacts, 'programKind' | 'categoryId' | 'programId'>): string =>
  rule.programKind === 'gift' ? `gift:${rule.programId}` : `base:${rule.categoryId}`;

export const subjectKeyFor = (rule: Pick<RuleFacts, 'share' | 'programId'>, personId: string): string => (rule.share === 'shared' ? `pool:${rule.programId}` : `person:${personId}`);

export interface LotPlan {
  slotKey: string;
  subjectKey: string;
  periodKey: string;
  amountMicros: number;
  startsAt: Date;
  expiresAt: Date | null;
  source: LotSource;
}

/**
 * The lot a rule issues to a person (or to its shared pool) at a moment, or null when it issues none (no grant, or a one-off that is not
 * due). The period is part of the key: the same program reaching the same person in the same period is one lot, whatever the path.
 *  - once: one lot for good. It lasts until the fixed end, or the days after issuing, or never ends.
 *  - monthly: one lot a UTC month, ending with the month. Nothing rolls over.
 */
export function planLot(rule: RuleFacts, now: Date): LotPlan | null {
  if (rule.schedule === 'none' || rule.amount <= 0) return null;
  const source: LotSource = rule.settlement === 'to_bill' ? 'manual_billing' : rule.programKind === 'gift' ? 'gift' : 'default';
  const slotKey = slotKeyFor(rule);
  if (rule.schedule === 'monthly') {
    return { slotKey, subjectKey: '', periodKey: monthKey(now), amountMicros: rule.amount, startsAt: monthStart(now), expiresAt: monthEnd(now), source };
  }
  const days = rule.lotExpiresInDays;
  const expiresAt = rule.lotExpiresAt ?? (days ? new Date(now.getTime() + days * 86_400_000) : null);
  // A fixed end that has already passed: the credit ended before this person could claim it, so there is nothing to issue (and a lot that
  // ends before it starts is refused by the database, which would lose the person's other lots too)
  if (expiresAt && expiresAt.getTime() <= now.getTime()) return null;
  return { slotKey, subjectKey: '', periodKey: rule.programKind === 'gift' ? 'gift' : 'once', amountMicros: rule.amount, startsAt: now, expiresAt, source };
}

// ---------- Spending order (spec 4) ----------

export interface LotFacts {
  id: string;
  source: LotSource;
  covers: readonly string[];
  issuedAt: Date;
  expiresAt: Date | null;
  /** What is left, held work already taken out. */
  availableMicros: number;
}

/**
 * The order credit is spent in: credit that ends soonest first (default grants and free credit together), then free credit that never
 * ends, then purchased credit. Two ending together: the more restricted one first, then the oldest, then by id so the order never
 * depends on how the rows came in.
 */
export function spendOrder<T extends LotFacts>(lots: readonly T[]): T[] {
  const group = (lot: T): number => (lot.source === 'purchase' ? 2 : lot.expiresAt ? 0 : 1);
  return [...lots].sort((a, b) => {
    const g = group(a) - group(b);
    if (g !== 0) return g;
    if (a.expiresAt && b.expiresAt && a.expiresAt.getTime() !== b.expiresAt.getTime()) return a.expiresAt.getTime() - b.expiresAt.getTime();
    if (a.covers.length !== b.covers.length) return a.covers.length - b.covers.length;
    if (a.issuedAt.getTime() !== b.issuedAt.getTime()) return a.issuedAt.getTime() - b.issuedAt.getTime();
    return a.id.localeCompare(b.id);
  });
}

export interface Take {
  lotId: string;
  amountMicros: number;
}

/** What to take from which lots, in order, for `amountMicros`; null when the lots cannot cover it (nothing is taken in part). */
export function allocate(lots: readonly LotFacts[], amountMicros: number): Take[] | null {
  let left = amountMicros;
  const takes: Take[] = [];
  for (const lot of spendOrder(lots)) {
    if (left <= 0) break;
    if (lot.availableMicros <= 0) continue;
    const amount = Math.min(left, lot.availableMicros);
    takes.push({ lotId: lot.id, amountMicros: amount });
    left -= amount;
  }
  return left > 0 ? null : takes;
}

// ---------- Settings that are Khalid's ----------

/** Whole micros, above zero. */
export const wholeMicros = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new CreditRefused(`${what} must be a whole number above 0`, 'amount');
  return value;
};

export const asNumber = (value: bigint | number | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));
