import { randomUUID } from 'crypto';
import { prisma } from '@/lib/db';
import { getMeterSettings } from '@/lib/meter';
import { envelopeIn } from '@/lib/meter-allowance';
import {
  CreditRefused,
  findClashes,
  isCategory,
  isMoneyCategory,
  readRecipient,
  recipientColumns,
  reaches,
  type CategoryId,
  type ClashFinding,
  type MoneyCategory,
  type PersonFacts,
  type ProgramKind,
  type Recipient,
  type RuleFacts,
  type Schedule,
  type Settlement,
  type Share,
} from '@/lib/credit-values';
import { currentRules, idsReached, lockAll, personFacts, ruleFacts, type Tx } from '@/lib/credit-store';
import { PLATFORM_ACCOUNT_ID, budgetOf, getFundingAccount, isFundingAdmin, issuedInMonth } from '@/lib/credit-funding';

/**
 * Grant programs and their rules (paying spec v3, sections 2, 2a, 7a and 11). What a super admin saves here is what issuing reads
 * (lib/credit-issue.ts). A program is one thing given; every change is a new version of its rule, never an edit in place, and the
 * lots already issued keep the version they were issued under. Nothing is taken back and nothing becomes debt.
 *
 * Kinds: a default (the category's amount, how often, and who gets it), an exception (a person or a group differs, or gets nothing),
 * and a gift (a one-time extra). Overlaps follow fixed rules (2a): a clash between exceptions of the same narrowness is refused on
 * save and names the people; separate gifts add; the same program reaching a person two ways issues once.
 */

export interface Issuer {
  userId: string;
  /** Whether the person is a platform super admin (from SUPER_ADMINS). Only they may fund anything from the platform's account. */
  superAdmin: boolean;
}

export interface GrantInput {
  categoryId: CategoryId;
  /** Millionths of a dollar for Instant Apps and computers; replies per window for Universe AI. Leave out (or 0) with schedule "none". */
  amount?: number;
  /** once, monthly (renews on the 1st in UTC, no roll-over) or none (an exception that gives nothing). For Universe AI: "once" means the allowance of each window, "none" means no replies. */
  schedule: Schedule;
  recipients: Recipient;
  /** each ("$5 each", the default) or shared ("$5 shared in total": one pool, one payer). Shared only for gifts. */
  share?: Share;
  /** Who pays. The platform's account when left out. */
  fundingAccountId?: string;
  /** What a gift may be spent on: one category, or Instant Apps and computers together as one dollar amount. */
  covers?: MoneyCategory[];
  claimStartsAt?: Date;
  claimEndsAt?: Date | null;
  lotExpiresAt?: Date | null;
  lotExpiresInDays?: number | null;
  /** A group that can change needs an end (claimEndsAt), a cap on how many can join, and a total funding cap. */
  joinerCap?: number | null;
  totalCapMicros?: number | null;
  /** free (a gift, never owed) or to_bill (agreed with the person outside the product: the note says what). */
  settlement?: Settlement;
  agreementNote?: string | null;
  agreementRef?: string | null;
  label?: string;
  /**
   * Makes the program once: a double tap, or a retry after a lost answer, sends the same key and finds the program the first call made
   * (`replayed: true`), so a gift is never given twice. The same key with other figures is refused (code `key_used`): the first stands.
   */
  requestKey?: string;
}

export interface RuleView {
  id: string;
  programId: string;
  version: number;
  state: string;
  categoryId: CategoryId;
  kind: ProgramKind;
  label: string;
  amount: number;
  schedule: Schedule;
  share: Share;
  fundingAccountId: string;
  covers: string[];
  recipients: Recipient;
  recipientCount: number | null;
  joinerCap: number | null;
  totalCapMicros: number | null;
  claimStartsAt: Date;
  claimEndsAt: Date | null;
  lotExpiresAt: Date | null;
  lotExpiresInDays: number | null;
  settlement: Settlement;
  agreementNote: string | null;
  agreementRef: string | null;
  createdById: string;
  createdAt: Date;
}

export interface ProgramView extends RuleView {
  status: 'active' | 'ended';
  endedAt: Date | null;
  versions: number;
  /** True when a request key found a program made earlier and nothing new was made. */
  replayed?: true;
}

export class ClashRefused extends CreditRefused {
  constructor(
    readonly clashes: { programId: string; label: string; people: { userId: string; name: string | null }[] }[],
  ) {
    super('Two rules disagree for the same people. Choose which one applies to them, then save again.', 'clash');
  }
}

export class OverBudget extends CreditRefused {
  constructor(
    readonly mostIssuedMicros: number,
    readonly roomMicros: number,
  ) {
    super('That would issue more than the funding account has left this month.', 'over_budget');
  }
}

const KIND_RECIPIENTS: Record<ProgramKind, Recipient['kind'][]> = {
  default: ['all', 'new_from'],
  exception: ['people', 'universe'],
  gift: ['all', 'new_from', 'people', 'universe'],
};

interface Checked {
  categoryId: CategoryId;
  kind: ProgramKind;
  amount: number;
  schedule: Schedule;
  share: Share;
  covers: string[];
  recipient: Recipient;
  fundingAccountId: string;
  claimStartsAt: Date;
  claimEndsAt: Date | null;
  lotExpiresAt: Date | null;
  lotExpiresInDays: number | null;
  joinerCap: number | null;
  totalCapMicros: number | null;
  settlement: Settlement;
  agreementNote: string | null;
  agreementRef: string | null;
  label: string;
}

const LABELS: Record<ProgramKind, string> = { default: 'Default', exception: 'Exception', gift: 'Gift' };

/** The input as one rule, or what is wrong with it. Pure: nothing is read from the database here. */
export function checkGrant(kind: ProgramKind, input: GrantInput, now: Date): Checked {
  if (!isCategory(input.categoryId)) throw new CreditRefused('Pick Universe AI, Instant Apps or Computers', 'category');
  const recipient = readRecipient(input.recipients);
  if (!KIND_RECIPIENTS[kind].includes(recipient.kind)) {
    throw new CreditRefused(kind === 'default' ? 'A default reaches all signed-in members or new people from a date. Use an exception for a person or a group.' : 'An exception is for a person, people you pick, or a universe’s members. Use the default for everyone.', 'recipients');
  }
  const universeAi = input.categoryId === 'universe_ai';
  if (universeAi && kind === 'default') throw new CreditRefused('The Universe AI default is the replies-per-window number in Limits: change it there. Exceptions are saved here.', 'category');
  if (universeAi && kind === 'gift') throw new CreditRefused('Universe AI replies are not given as gifts here: use extra usage (2x, 5x, no limit)', 'category');
  const schedule = input.schedule;
  if (!['once', 'monthly', 'none'].includes(schedule)) throw new CreditRefused('How often must be once, monthly or none', 'schedule');
  if (kind === 'gift' && schedule !== 'once') throw new CreditRefused('A gift is a one-time extra', 'schedule');
  if (universeAi && schedule === 'monthly') throw new CreditRefused('Universe AI replies renew with their window, not monthly', 'schedule');
  const share = input.share ?? 'each';
  if (share === 'shared' && (kind !== 'gift' || !['people', 'universe'].includes(recipient.kind))) throw new CreditRefused('A shared amount is a gift to people you pick or a universe’s members', 'share');
  let amount = input.amount ?? 0;
  if (schedule === 'none') amount = 0;
  else if (!Number.isSafeInteger(amount) || amount <= 0) throw new CreditRefused('The amount must be a whole number above 0', 'amount');
  if (schedule === 'none' && kind === 'gift') throw new CreditRefused('A gift gives something. To give nothing, save an exception, or set the default to none.', 'schedule');
  const covers = universeAi ? ['universe_ai'] : kind === 'gift' ? [...new Set(input.covers ?? [input.categoryId])] : [input.categoryId];
  if (covers.length === 0 || !covers.every((id) => isMoneyCategory(id) || (universeAi && id === 'universe_ai'))) throw new CreditRefused('A gift covers Instant Apps, computers, or both', 'covers');
  if (kind !== 'gift' && covers[0] !== input.categoryId) throw new CreditRefused('A default or exception covers its own category', 'covers');
  const claimStartsAt = input.claimStartsAt ?? now;
  const claimEndsAt = input.claimEndsAt ?? null;
  if (claimEndsAt && !(claimEndsAt > claimStartsAt)) throw new CreditRefused('The end must come after the start', 'dates');
  const lotExpiresInDays = input.lotExpiresInDays ?? null;
  if (lotExpiresInDays !== null && (!Number.isSafeInteger(lotExpiresInDays) || lotExpiresInDays <= 0)) throw new CreditRefused('Days must be a whole number above 0', 'dates');
  const lotExpiresAt = input.lotExpiresAt ?? null;
  if (lotExpiresAt && lotExpiresInDays) throw new CreditRefused('Give a fixed end or a number of days, not both', 'dates');
  if (lotExpiresAt && !(lotExpiresAt > claimStartsAt)) throw new CreditRefused('Credit must end after it starts', 'dates');
  if (schedule === 'monthly' && (lotExpiresAt || lotExpiresInDays)) throw new CreditRefused('Monthly credit ends with its month (no roll-over)', 'dates');
  const settlement = input.settlement ?? 'free';
  if (!['free', 'to_bill'].includes(settlement)) throw new CreditRefused('settlement must be free or to_bill', 'settlement');
  if (settlement === 'to_bill' && kind !== 'gift') throw new CreditRefused('Only a gift can be billed', 'settlement');
  const agreementNote = input.agreementNote?.trim() ? input.agreementNote.trim().slice(0, 1000) : null;
  if (settlement === 'to_bill' && !agreementNote) throw new CreditRefused('Credit to be billed must say what was agreed', 'settlement');
  const joinerCap = input.joinerCap ?? null;
  const totalCapMicros = input.totalCapMicros ?? null;
  if (joinerCap !== null && (!Number.isSafeInteger(joinerCap) || joinerCap <= 0)) throw new CreditRefused('The cap on joiners must be a whole number above 0', 'caps');
  if (totalCapMicros !== null && (!Number.isSafeInteger(totalCapMicros) || totalCapMicros <= 0)) throw new CreditRefused('The total cap must be a whole number above 0', 'caps');
  if (recipient.kind === 'universe' && recipient.mode === 'changing') {
    if (kind === 'gift' && share === 'shared') throw new CreditRefused('A shared amount is for a fixed group: choose "who is in it now"', 'recipients');
    if (!claimEndsAt || joinerCap === null || totalCapMicros === null) throw new CreditRefused('A group that changes needs an end date, a cap on how many can join, and a total funding cap', 'caps');
  }
  return {
    categoryId: input.categoryId,
    kind,
    amount,
    schedule,
    share,
    covers,
    recipient,
    fundingAccountId: input.fundingAccountId ?? PLATFORM_ACCOUNT_ID,
    claimStartsAt,
    claimEndsAt,
    lotExpiresAt,
    lotExpiresInDays,
    joinerCap,
    totalCapMicros,
    settlement,
    agreementNote,
    agreementRef: input.agreementRef?.trim() ? input.agreementRef.trim().slice(0, 120) : null,
    label: (input.label?.trim() || LABELS[kind]).slice(0, 120),
  };
}

/** Who may fund from an account. The platform's is for super admins only; any other account's administrators may, and never to everyone. */
async function checkIssuer(db: Tx, checked: Checked, issuer: Issuer): Promise<void> {
  const account = await getFundingAccount(checked.fundingAccountId, db);
  if (!account) throw new CreditRefused('That funding account does not exist', 'account');
  if (account.status !== 'active') throw new CreditRefused('That funding account is not active', 'account');
  if (account.kind === 'platform') {
    if (!issuer.superAdmin) throw new CreditRefused('Only a super admin can give credit from Universe’s own account', 'forbidden');
    return;
  }
  // A universe owner can never mint platform credit through a universe they control: a person's or universe's account funds only its own money
  if (!(await isFundingAdmin(account.id, issuer.userId, db))) throw new CreditRefused('Only an administrator of that funding account can give credit from it', 'forbidden');
  if (account.budgetMicros === null) throw new CreditRefused('That funding account has no budget set, so it cannot fund anything yet', 'account');
  if (checked.recipient.kind === 'all' || checked.recipient.kind === 'new_from') throw new CreditRefused('Only Universe’s own account can give credit to everyone', 'forbidden');
  if (account.kind === 'universe' && (checked.recipient.kind !== 'universe' || checked.recipient.universeId !== account.ownerKey) && checked.recipient.kind !== 'people') {
    throw new CreditRefused('A universe’s account funds that universe’s own people', 'forbidden');
  }
}

/** The ids a recipient reaches by id: people you pick (checked to be real signed-in accounts), or a universe's members now. */
async function snapshotIds(db: Tx, recipient: Recipient): Promise<string[]> {
  if (recipient.kind === 'people') {
    const found = await db.user.findMany({ where: { id: { in: recipient.userIds }, isGuest: false }, select: { id: true } });
    const known = new Set(found.map((user) => user.id));
    const unknown = recipient.userIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new CreditRefused(`Not signed-in accounts: ${unknown.join(', ')}`, 'recipients');
    return recipient.userIds;
  }
  if (recipient.kind === 'universe') {
    const universe = await db.universe.findUnique({ where: { id: recipient.universeId }, select: { id: true } });
    if (!universe) throw new CreditRefused('That universe does not exist', 'recipients');
    if (recipient.mode === 'changing') return [];
    const members = await db.universeMember.findMany({ where: { universeId: recipient.universeId, user: { isGuest: false } }, select: { userId: true } });
    if (members.length === 0) throw new CreditRefused('Nobody has joined that universe yet', 'recipients');
    return members.map((member) => member.userId).sort();
  }
  return [];
}

type ProgramRow = NonNullable<Awaited<ReturnType<typeof loadProgramRow>>>;

async function loadProgramByKey(db: Pick<Tx, 'grantProgram'>, requestKey: string) {
  return db.grantProgram.findUnique({
    where: { requestKey },
    include: { rules: { orderBy: { version: 'desc' }, include: { program: true, recipients: { select: { userId: true } } } } },
  });
}

/** Whether a saved program says what a new request says: the same figures, who it is for, and how it is paid. Times are not compared: a retry starts a moment later. */
function sameFigures(made: ProgramRow, checked: Checked): boolean {
  const rule = ruleFacts(made.rules[0]);
  const a = rule.recipient;
  const b = checked.recipient;
  const sameRecipients =
    a.kind === b.kind &&
    (a.kind === 'people' && b.kind === 'people'
      ? a.userIds.length === b.userIds.length && a.userIds.every((id, i) => id === b.userIds[i])
      : a.kind === 'universe' && b.kind === 'universe'
        ? a.universeId === b.universeId && (a.mode ?? 'snapshot') === (b.mode ?? 'snapshot')
        : a.kind === 'new_from' && b.kind === 'new_from'
          ? a.from.getTime() === b.from.getTime() && (a.to?.getTime() ?? null) === (b.to?.getTime() ?? null)
          : true);
  return (
    made.kind === checked.kind &&
    made.categoryId === checked.categoryId &&
    rule.amount === checked.amount &&
    rule.schedule === checked.schedule &&
    rule.share === checked.share &&
    rule.settlement === checked.settlement &&
    rule.fundingAccountId === checked.fundingAccountId &&
    [...rule.covers].sort().join() === [...checked.covers].sort().join() &&
    sameRecipients
  );
}

async function loadProgramRow(db: Pick<Tx, 'grantProgram'>, programId: string) {
  return db.grantProgram.findUnique({
    where: { id: programId },
    include: { rules: { orderBy: { version: 'desc' }, include: { program: true, recipients: { select: { userId: true } } } } },
  });
}

function viewOf(program: { id: string; categoryId: string; kind: string; label: string; status: string; endedAt: Date | null }, rule: ProgramRow['rules'][number], versions: number): ProgramView {
  const facts = ruleFacts(rule);
  return {
    id: rule.id,
    programId: program.id,
    version: rule.version,
    state: rule.state,
    categoryId: facts.categoryId,
    kind: program.kind as ProgramKind,
    label: program.label,
    amount: facts.amount,
    schedule: facts.schedule,
    share: facts.share,
    fundingAccountId: facts.fundingAccountId,
    covers: [...facts.covers],
    recipients: facts.recipient,
    recipientCount: facts.recipient.kind === 'all' || facts.recipient.kind === 'new_from' || (facts.recipient.kind === 'universe' && facts.recipient.mode === 'changing') ? null : facts.recipientIds.size,
    joinerCap: facts.joinerCap,
    totalCapMicros: facts.totalCapMicros,
    claimStartsAt: facts.claimStartsAt,
    claimEndsAt: facts.claimEndsAt,
    lotExpiresAt: facts.lotExpiresAt,
    lotExpiresInDays: facts.lotExpiresInDays,
    settlement: facts.settlement,
    agreementNote: rule.agreementNote,
    agreementRef: rule.agreementRef,
    createdById: rule.createdById,
    createdAt: rule.createdAt,
    status: program.status as 'active' | 'ended',
    endedAt: program.endedAt,
    versions,
  };
}

/** The programs of a category (all of them when none is named), each with its current rule. Ended ones come last. */
export async function listPrograms(categoryId?: CategoryId, opts: { kind?: ProgramKind; includeEnded?: boolean } = {}): Promise<ProgramView[]> {
  const programs = await prisma.grantProgram.findMany({
    where: { ...(categoryId ? { categoryId } : {}), ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.includeEnded ? {} : { status: 'active' }) },
    include: { rules: { orderBy: { version: 'desc' }, include: { program: true, recipients: { select: { userId: true } } } } },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
  });
  return programs.filter((program) => program.rules.length > 0).map((program) => viewOf(program, program.rules[0], program.rules.length));
}

/** One program: its current rule, and every earlier version as it was. */
export async function getProgram(programId: string): Promise<{ program: ProgramView; versions: RuleView[] } | null> {
  const row = await loadProgramRow(prisma, programId);
  if (!row || row.rules.length === 0) return null;
  const program = viewOf(row, row.rules[0], row.rules.length);
  return { program, versions: row.rules.map((rule) => viewOf(row, rule, row.rules.length)) };
}

async function chooseNames(userIds: string[]): Promise<{ userId: string; name: string | null }[]> {
  if (userIds.length === 0) return [];
  const users = await prisma.user.findMany({ where: { id: { in: userIds.slice(0, 50) } }, select: { id: true, name: true } });
  return users.map((user) => ({ userId: user.id, name: user.name }));
}

/** Whether a rule about to be saved clashes with those already saved for its category; names the people when it does. */
async function clashesOf(db: Tx, candidate: RuleFacts, programIds?: { exclude: string }): Promise<ClashFinding[]> {
  if (candidate.programKind === 'gift') return [];
  const saved = (await currentRules(db, { categoryId: candidate.categoryId })).filter((rule) => rule.programKind !== 'gift' && rule.programId !== programIds?.exclude);
  const ids = new Map<string, Set<string>>();
  for (const rule of [candidate, ...saved]) ids.set(rule.id, await idsReached(db, rule));
  return findClashes(candidate, saved, (rule) => ids.get(rule.id) ?? new Set());
}

/** Saves a new program, or a new version of one (`programId`). A clash between rules is refused. */
async function save(kind: ProgramKind, input: GrantInput & { programId?: string }, issuer: Issuer, now: Date): Promise<ProgramView> {
  const checked = checkGrant(kind, input, now);
  const programId = input.programId ?? randomUUID();
  if (input.requestKey !== undefined && (!input.requestKey || input.requestKey.length > 255)) throw new CreditRefused('requestKey must be 1 to 255 characters', 'request_key');
  const view = await prisma.$transaction(async (tx) => {
    // One save of a category's rules at a time, so two admins at the same moment cannot both save a clashing rule
    await lockAll(tx, [`credit:rules:${checked.categoryId}`, ...(input.requestKey ? [`credit:request:${input.requestKey}`] : [])]);
    await checkIssuer(tx, checked, issuer);
    if (input.requestKey && !input.programId) {
      const made = await loadProgramByKey(tx, input.requestKey);
      if (made) {
        if (!sameFigures(made, checked)) throw new CreditRefused('That key was used for a different gift. The first one stands.', 'key_used');
        return { ...viewOf(made, made.rules[0], made.rules.length), replayed: true as const };
      }
    }
    const ids = await snapshotIds(tx, checked.recipient);
    const existing = input.programId ? await loadProgramRow(tx, programId) : null;
    if (input.programId && !existing) throw new CreditRefused('That program does not exist', 'not_found');
    if (existing) {
      if (existing.status !== 'active') throw new CreditRefused('That program has ended. Make a new one instead.', 'ended');
      if (existing.kind !== kind || existing.categoryId !== checked.categoryId) throw new CreditRefused('A program keeps its kind and category', 'kind');
    }
    const candidate: RuleFacts = {
      id: 'candidate',
      programId,
      programKind: kind,
      categoryId: checked.categoryId,
      version: (existing?.rules[0]?.version ?? 0) + 1,
      fundingAccountId: checked.fundingAccountId,
      covers: checked.covers,
      benefitKind: kind === 'gift' ? 'add_credit' : 'replace',
      amount: checked.amount,
      schedule: checked.schedule,
      share: checked.share,
      recipient: checked.recipient,
      recipientIds: new Set(ids),
      joinerCap: checked.joinerCap,
      totalCapMicros: checked.totalCapMicros,
      claimStartsAt: checked.claimStartsAt,
      claimEndsAt: checked.claimEndsAt,
      lotExpiresAt: checked.lotExpiresAt,
      lotExpiresInDays: checked.lotExpiresInDays,
      settlement: checked.settlement,
    };
    const clashes = await clashesOf(tx, candidate, { exclude: programId });
    if (clashes.length > 0) {
      const labels = await tx.grantProgram.findMany({ where: { id: { in: clashes.map((c) => c.programId) } }, select: { id: true, label: true } });
      throw new ClashRefused(await Promise.all(clashes.map(async (c) => ({ programId: c.programId, label: labels.find((l) => l.id === c.programId)?.label ?? c.programId, people: await chooseNames(c.userIds) }))));
    }
    const preview = await previewIn(tx, checked, ids, now, { forProgramId: programId });
    const budget = preview.budget;
    // A rule that reaches a fixed set of people must fit in what the account has left this month: it is refused now, not half-issued later
    if (budget.budgetMicros !== null && preview.mostIssued.firstPeriodMicros !== null && !preview.mostIssued.unbounded && preview.mostIssued.firstPeriodMicros > budget.roomMicros) {
      throw new OverBudget(preview.mostIssued.firstPeriodMicros, budget.roomMicros);
    }
    if (existing) {
      await tx.grantRule.updateMany({ where: { programId, state: 'current' }, data: { state: 'superseded', supersededAt: now } });
    } else {
      await tx.grantProgram.create({ data: { id: programId, categoryId: checked.categoryId, kind, label: checked.label, createdById: issuer.userId, requestKey: input.requestKey ?? null } });
    }
    const cols = recipientColumns(checked.recipient);
    await tx.grantRule.create({
      data: {
        programId,
        version: candidate.version,
        state: 'current',
        fundingAccountId: checked.fundingAccountId,
        covers: checked.covers,
        benefitKind: candidate.benefitKind,
        amount: BigInt(checked.amount),
        schedule: checked.schedule,
        share: checked.share,
        ...cols,
        joinerCap: checked.joinerCap,
        totalCapMicros: checked.totalCapMicros === null ? null : BigInt(checked.totalCapMicros),
        claimStartsAt: checked.claimStartsAt,
        claimEndsAt: checked.claimEndsAt,
        lotExpiresAt: checked.lotExpiresAt,
        lotExpiresInDays: checked.lotExpiresInDays,
        settlement: checked.settlement,
        agreementNote: checked.agreementNote,
        agreementRef: checked.agreementRef,
        createdById: issuer.userId,
        createdAt: now,
        recipients: ids.length > 0 && checked.recipient.kind !== 'all' ? { create: ids.map((userId) => ({ userId })) } : undefined,
      },
    });
    if (existing && input.label?.trim()) await tx.grantProgram.update({ where: { id: programId }, data: { label: checked.label } });
    const saved = await loadProgramRow(tx, programId);
    return viewOf(saved as ProgramRow, (saved as ProgramRow).rules[0], (saved as ProgramRow).rules.length);
  });
  return view;
}

/** The category's default: how much, how often, and who gets it. Saving again makes a new version of the same program. */
export async function saveDefault(input: GrantInput, issuer: Issuer, now: Date = new Date()): Promise<ProgramView> {
  const current = await prisma.grantProgram.findFirst({ where: { categoryId: input.categoryId, kind: 'default', status: 'active' }, select: { id: true } });
  return save('default', { ...input, programId: current?.id }, issuer, now);
}

/** An exception for a person, people you pick, or a universe's members: a different amount or how often, or no grant at all. */
export async function saveException(input: GrantInput & { programId?: string }, issuer: Issuer, now: Date = new Date()): Promise<ProgramView> {
  return save('exception', input, issuer, now);
}

/** A gift: a one-time extra, to people you pick or a universe's members (or everyone), each or shared, one dollar amount for what it covers. */
export async function createGift(input: GrantInput, issuer: Issuer, now: Date = new Date()): Promise<ProgramView> {
  return save('gift', input, issuer, now);
}

/** Ends a program: nothing new is issued under it, the credit already given stays until it ends, and its history stays. */
export async function endProgram(programId: string, issuer: Issuer, now: Date = new Date()): Promise<'ended' | 'already_ended' | 'not_found'> {
  return prisma.$transaction(async (tx) => {
    const program = await tx.grantProgram.findUnique({ where: { id: programId }, include: { rules: { where: { state: 'current' }, take: 1 } } });
    if (!program) return 'not_found';
    if (program.status === 'ended') return 'already_ended';
    const rule = program.rules[0];
    if (rule) {
      const account = await getFundingAccount(rule.fundingAccountId, tx);
      if (account?.kind === 'platform' ? !issuer.superAdmin : !(await isFundingAdmin(rule.fundingAccountId, issuer.userId, tx))) throw new CreditRefused('You cannot end this one', 'forbidden');
    }
    await tx.grantProgram.update({ where: { id: programId }, data: { status: 'ended', endedAt: now } });
    await tx.grantRule.updateMany({ where: { programId, state: 'current' }, data: { state: 'ended', supersededAt: now } });
    return 'ended';
  });
}

// ---------- The preview, before any save (spec 7a) ----------

export interface Preview {
  /** Part 1: who qualifies now and what each receives. */
  recipients: {
    /** People who qualify now. Null for a group that has no list yet (everyone, or new people from a date). */
    countNow: number | null;
    /** True when later sign-ups or joiners also qualify, so the count is only today's. */
    growing: boolean;
    share: Share;
    /** What each person receives (each), or the shared total (shared). Micros, or replies for Universe AI. */
    eachMicros: number;
    schedule: Schedule;
    unit: 'usd_micros' | 'reply';
  };
  /** Part 2: the most credit it issues. Never one number for "most it can cost". */
  mostIssued: {
    /** What the first period issues to the people who qualify now; null when that is not a fixed number. */
    firstPeriodMicros: number | null;
    /** Renewals still to come until the end date; null with no end date. */
    renewals: number | null;
    /** The most it ever issues to the people who qualify now. Null means there is no lifetime maximum, and says so plainly. */
    lifetimeMicros: number | null;
    /** No maximum: later joiners or sign-ups qualify with no cap, or it renews every month with no end. */
    unbounded: boolean;
    cappedBy: { totalCapMicros: number | null; joinerCap: number | null };
    sentence: string;
  };
  /** Part 3: what it can cost us, at provider prices, kept apart from part 2. */
  cost: {
    /** Credit the first period issues, which is at most this much at provider prices: a dollar of credit is never more than a dollar of provider cost. Null for replies, whose provider cost varies. */
    atMostAtProviderPricesMicros: number | null;
    variableProviderCost: boolean;
    reservedMicros: number;
    unresolvedMicros: number;
    keptStorageMicros: number;
    sentence: string;
  };
  budget: { budgetMicros: number | null; issuedThisMonthMicros: number; roomMicros: number };
  /** Other programs for the same category that reach some of the same people. */
  overlaps: { programId: string; label: string; kind: ProgramKind; how: 'adds' | 'replaces' | 'issues_once' | 'clash'; people: number }[];
}

const monthsBetween = (from: Date, to: Date): number => (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) + 1;

async function previewIn(db: Tx, checked: Checked, ids: readonly string[], now: Date, opts: { forProgramId?: string } = {}): Promise<Preview> {
  // Everything inside the caller's transaction: nothing here asks for a second connection while it is held
  const settings = await getMeterSettings(db);
  const universeAi = checked.categoryId === 'universe_ai';
  const recipient = checked.recipient;
  let countNow: number | null = null;
  let growing = false;
  if (recipient.kind === 'all') {
    countNow = await db.user.count({ where: { isGuest: false } });
    growing = true;
  } else if (recipient.kind === 'new_from') {
    countNow = await db.user.count({ where: { isGuest: false, createdAt: { gte: recipient.from, ...(recipient.to ? { lt: recipient.to } : {}) } } });
    growing = !recipient.to || recipient.to > now;
  } else if (recipient.kind === 'universe' && recipient.mode === 'changing') {
    countNow = await db.universeMember.count({ where: { universeId: recipient.universeId, user: { isGuest: false } } });
    growing = true;
  } else {
    countNow = ids.length;
  }
  const eachMicros = checked.amount;
  const people = countNow ?? 0;
  const first = checked.share === 'shared' ? eachMicros : eachMicros * people;
  const months = checked.schedule === 'monthly' ? (checked.claimEndsAt ? Math.max(0, monthsBetween(checked.claimStartsAt > now ? checked.claimStartsAt : now, new Date(checked.claimEndsAt.getTime() - 1))) : null) : checked.schedule === 'once' ? 1 : 0;
  const renewals = checked.schedule === 'monthly' ? (months === null ? null : Math.max(0, months - 1)) : 0;
  // A cap on how many can join and a total cap bound a group that grows; with neither, a growing group has no lifetime maximum
  const capped = checked.totalCapMicros !== null || (checked.joinerCap !== null && checked.share === 'each');
  const unbounded = checked.schedule !== 'none' && ((growing && !capped) || (checked.schedule === 'monthly' && months === null));
  let lifetime: number | null = null;
  if (!unbounded && checked.schedule !== 'none') {
    const periods = checked.schedule === 'monthly' ? (months ?? 1) : 1;
    const joiners = growing && checked.joinerCap !== null && checked.share === 'each' ? Math.max(people, checked.joinerCap) : people;
    const whole = (checked.share === 'shared' ? eachMicros : eachMicros * joiners) * periods;
    lifetime = checked.totalCapMicros !== null ? Math.min(whole, checked.totalCapMicros) : whole;
  }
  const dollars = (micros: number) => `$${(micros / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
  const unit = universeAi ? 'replies' : '';
  const amountWords = universeAi ? `${eachMicros} replies` : dollars(eachMicros);
  let sentence: string;
  if (checked.schedule === 'none') sentence = 'Gives nothing: those people get no grant.';
  else if (unbounded) sentence = growing && !capped ? `Issues ${amountWords} to each person who qualifies, including people who join or sign up later. It has no lifetime maximum.` : `Renews every month with no end date, so it has no lifetime maximum.`;
  else sentence = `Issues at most ${universeAi ? `${lifetime} ${unit}` : dollars(lifetime ?? 0)} in all${checked.schedule === 'monthly' ? ` over ${months} month${months === 1 ? '' : 's'}` : ''}.`;
  const envelope = await envelopeIn(db, now, settings).catch(() => null);
  const account = await getFundingAccount(checked.fundingAccountId, db);
  const budget = account ? budgetOf(account, settings) : null;
  const issued = account ? await issuedInMonth(db, account.id, now) : 0;
  const overlaps = await overlapsOf(db, checked, ids, opts.forProgramId);
  return {
    recipients: { countNow, growing, share: checked.share, eachMicros, schedule: checked.schedule, unit: universeAi ? 'reply' : 'usd_micros' },
    mostIssued: {
      firstPeriodMicros: universeAi ? null : growing && countNow !== null && !capped ? null : first,
      renewals,
      lifetimeMicros: universeAi ? null : lifetime,
      unbounded: universeAi ? false : unbounded,
      cappedBy: { totalCapMicros: checked.totalCapMicros, joinerCap: checked.joinerCap },
      sentence,
    },
    cost: {
      atMostAtProviderPricesMicros: universeAi ? null : first,
      variableProviderCost: universeAi,
      reservedMicros: envelope?.reservedMicros ?? 0,
      unresolvedMicros: envelope?.unsettledMicros ?? 0,
      keptStorageMicros: envelope?.keptStorageMicros ?? 0,
      sentence: universeAi
        ? 'Replies have a variable provider cost, so no dollar figure is given.'
        : 'At most this much at provider prices (a dollar of credit is not a dollar of provider cost; it is never more). Reserved, unresolved and kept-storage figures are what we already carry.',
    },
    budget: { budgetMicros: budget, issuedThisMonthMicros: issued, roomMicros: budget === null ? 0 : Math.max(0, budget - issued) },
    overlaps,
  };
}

async function overlapsOf(db: Tx, checked: Checked, ids: readonly string[], forProgramId: string | undefined): Promise<Preview['overlaps']> {
  const others = (await currentRules(db, {})).filter((rule) => rule.programId !== forProgramId && (rule.categoryId === checked.categoryId || rule.covers.some((c) => checked.covers.includes(c))));
  const mine = new Set(ids);
  const out: Preview['overlaps'] = [];
  const labels = await db.grantProgram.findMany({ where: { id: { in: others.map((rule) => rule.programId) } }, select: { id: true, label: true } });
  for (const other of others) {
    const theirs = await idsReached(db, other);
    const wide = other.recipient.kind === 'all' || other.recipient.kind === 'new_from';
    const shared = wide ? mine.size : [...theirs].filter((id) => mine.has(id)).length;
    // A rule that reaches by date or everyone overlaps with any group; a changing group counts only members now
    if (shared === 0 && !(checked.recipient.kind === 'all' || checked.recipient.kind === 'new_from')) continue;
    let how: Preview['overlaps'][number]['how'];
    if (checked.kind === 'gift' && other.programKind === 'gift') how = 'adds';
    else if (checked.kind === 'gift') how = 'adds';
    else if (other.programKind === 'gift') how = 'adds';
    else if (other.programKind === 'default') how = 'replaces';
    else how = checked.kind === 'default' ? 'replaces' : 'clash';
    out.push({ programId: other.programId, label: labels.find((l) => l.id === other.programId)?.label ?? other.programId, kind: other.programKind, how, people: wide || checked.recipient.kind === 'all' ? shared || theirs.size : shared });
  }
  return out;
}

/**
 * The three-part preview before anything is saved (spec 7a): who gets what, the most credit it issues, and what it can cost us at provider
 * prices. Shown separately because they are different numbers. Reads only; saves nothing.
 */
export async function previewGrant(kind: ProgramKind, input: GrantInput, now: Date = new Date()): Promise<Preview> {
  const checked = checkGrant(kind, input, now);
  return prisma.$transaction(async (tx) => {
    let ids: string[] = [];
    try {
      ids = await snapshotIds(tx, checked.recipient);
    } catch (error) {
      // A preview of an empty universe says so rather than failing: the screen shows "nobody yet"
      if (!(error instanceof CreditRefused && error.message.startsWith('Nobody has joined'))) throw error;
    }
    return previewIn(tx, checked, ids, now);
  });
}

/** The rules that reach a person now, for their page: the exceptions they are under, and the default. */
export async function rulesFor(personId: string, now: Date = new Date()): Promise<{ rules: RuleFacts[]; person: PersonFacts | null }> {
  const person = await personFacts(prisma, personId);
  if (!person) return { rules: [], person: null };
  const rules = (await currentRules(prisma, { now })).filter((rule) => reaches(rule, person));
  return { rules, person };
}
