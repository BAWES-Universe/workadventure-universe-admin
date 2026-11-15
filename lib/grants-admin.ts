import { prisma } from '@/lib/db';
import { getMeterSettings, saveMeterSettings, scheduleMemberAllowance } from '@/lib/meter';
import { getServerLimits } from '@/lib/bot-limits';
import { FAIR_USAGE_WINDOW_HOURS } from '@/lib/bot-limit-values';
import { wokaLayersForMany } from '@/lib/woka-avatar';
import {
  ClashRefused,
  endProgram,
  listPrograms,
  previewGrant,
  saveDefault,
  saveException,
  createGift,
  type GrantInput,
  type Issuer,
  type Preview,
  type ProgramView,
} from '@/lib/credit-rules';
import { markCreditBilled } from '@/lib/credit-billing';
import { CreditRefused, readRecipient, type MoneyCategory, type Recipient, type Schedule } from '@/lib/credit-values';
import { PLATFORM_ACCOUNT_ID, exposureOf } from '@/lib/credit-funding';
import { currentRules, idsReached } from '@/lib/credit-store';
import { MONEY_CATEGORIES, type AudienceView, type ClashView, type ExceptionSetting, type ExceptionView, type GiftScope, type GiftView, type GrantsOverview, type MoneyDefaultView, type PersonView, type PreviewNumbers, type PreviewRequest, type PreviewView, type Recipients } from '@/lib/grants-view';

/**
 * What the grants routes do (spec v3 O3): they turn what the Grants screens send into the funding books' own calls
 * (lib/credit-rules.ts) and turn what the books know back into the shapes the screens show (lib/grants-view.ts). Nothing in here
 * holds a rule of its own: the books refuse what is wrong, and this only maps. No amount is built in and no payment gateway is named.
 */

const DAY = 86_400_000;
const firstOfNextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/** A request that cannot be made as asked, in a line the screen shows as it is. */
export class GrantsRefused extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code?: string,
  ) {
    super(message);
  }
}

const asMoney = (id: string): id is MoneyCategory => (MONEY_CATEGORIES as readonly string[]).includes(id);
const recipientOf = (value: Recipients): Recipient => readRecipient(value);

// ---------- Reading: the overview ----------

interface Names {
  people: Map<string, { name: string; woka: string[] }>;
  universes: Map<string, string>;
  givers: Map<string, string>;
  accounts: Map<string, string>;
}

async function namesFor(programs: ProgramView[]): Promise<Names> {
  const personIds = new Set<string>();
  const universeIds = new Set<string>();
  for (const program of programs) {
    if (program.recipients.kind === 'people') program.recipients.userIds.forEach((id) => personIds.add(id));
    if (program.recipients.kind === 'universe') universeIds.add(program.recipients.universeId);
  }
  const giverIds = [...new Set(programs.map((program) => program.createdById))];
  const [users, wokas, universes, givers, accounts] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...personIds] } }, select: { id: true, name: true } }),
    personIds.size ? wokaLayersForMany([...personIds]).catch(() => new Map<string, string[]>()) : Promise.resolve(new Map<string, string[]>()),
    prisma.universe.findMany({ where: { id: { in: [...universeIds] } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: giverIds } }, select: { id: true, name: true, email: true } }),
    prisma.fundingAccount.findMany({ where: { id: { in: [...new Set(programs.map((program) => program.fundingAccountId))] } }, select: { id: true, name: true } }),
  ]);
  return {
    people: new Map(users.map((user) => [user.id, { name: user.name?.trim() || 'Someone', woka: wokas.get(user.id) ?? [] }])),
    universes: new Map(universes.map((universe) => [universe.id, universe.name])),
    givers: new Map(givers.map((user) => [user.id, user.name?.trim() || user.email || 'a super admin'])),
    accounts: new Map(accounts.map((account) => [account.id, account.name])),
  };
}

function audienceOf(program: ProgramView, names: Names): AudienceView {
  if (program.recipients.kind === 'universe') {
    return { kind: 'universe', people: [], universe: { id: program.recipients.universeId, name: names.universes.get(program.recipients.universeId) ?? 'A universe' }, count: program.recipientCount ?? 0 };
  }
  const people: PersonView[] = program.recipients.kind === 'people' ? program.recipients.userIds.map((id) => ({ id, name: names.people.get(id)?.name ?? 'Someone', woka: names.people.get(id)?.woka ?? [] })) : [];
  return { kind: 'people', people, universe: null, count: people.length };
}

/** The recipients as the screen holds them (dates as ISO strings). */
export function recipientsView(recipient: Recipient): Recipients {
  if (recipient.kind === 'new_from') return { kind: 'new_from', from: recipient.from.toISOString(), ...(recipient.to ? { to: recipient.to.toISOString() } : {}) };
  if (recipient.kind === 'universe') return { kind: 'universe', universeId: recipient.universeId, mode: recipient.mode === 'changing' ? 'changing' : 'snapshot' };
  return recipient;
}

const settingOf = (program: ProgramView | undefined): ExceptionSetting => {
  if (!program) return { mode: 'same' };
  if (program.schedule === 'none') return { mode: 'none' };
  return { mode: 'own', amountMicros: program.amount, interval: program.schedule === 'monthly' ? 'monthly' : 'once' };
};

/** One exception on the screen holds one rule for each money category over the same people: its id names both programs. */
export const exceptionId = (apps?: string, computers?: string) => `${apps ?? 'none'}~${computers ?? 'none'}`;
export function readExceptionId(id: string): { instant_apps: string | null; computers: string | null } | null {
  const [apps, computers, ...rest] = id.split('~');
  if (rest.length > 0 || apps === undefined || computers === undefined) return null;
  return { instant_apps: apps === 'none' ? null : apps, computers: computers === 'none' ? null : computers };
}

const recipientKey = (recipient: Recipient): string => {
  if (recipient.kind === 'people') return `people:${[...recipient.userIds].sort().join(',')}`;
  if (recipient.kind === 'universe') return `universe:${recipient.universeId}`;
  return recipient.kind;
};

/** Gift programs' lots: what was used of them and whether the ones to bill were billed. */
async function giftFigures(programIds: string[]): Promise<Map<string, { used: number; unbilled: number; billed: Date | null; lots: number }>> {
  const out = new Map<string, { used: number; unbilled: number; billed: Date | null; lots: number }>();
  if (programIds.length === 0) return out;
  const lots = await prisma.creditLot.findMany({ where: { programId: { in: programIds } }, select: { id: true, programId: true, settlement: true, billedAt: true } });
  const allocations = await prisma.creditAllocation.groupBy({ by: ['lotId'], where: { lotId: { in: lots.map((lot) => lot.id) }, state: 'settled' }, _sum: { settledMicros: true } });
  const used = new Map(allocations.map((row) => [row.lotId, Number(row._sum.settledMicros ?? 0)]));
  for (const lot of lots) {
    const entry = out.get(lot.programId as string) ?? { used: 0, unbilled: 0, billed: null, lots: 0 };
    entry.used += used.get(lot.id) ?? 0;
    entry.lots += 1;
    if (lot.settlement === 'to_bill' && !lot.billedAt) entry.unbilled += 1;
    if (lot.billedAt && (!entry.billed || lot.billedAt > entry.billed)) entry.billed = lot.billedAt;
    out.set(lot.programId as string, entry);
  }
  return out;
}

/** How many ended gifts stay listed under the running ones. */
const RECENTLY_ENDED_GIFTS = 30;

export async function overview(now: Date = new Date()): Promise<GrantsOverview> {
  const [programs, limits, settings, people, exposure] = await Promise.all([
    listPrograms(undefined, { includeEnded: true }),
    getServerLimits(),
    getMeterSettings(),
    prisma.user.count({ where: { isGuest: false } }),
    exposureOf(PLATFORM_ACCOUNT_ID, now),
  ]);
  const money = programs.filter((program) => asMoney(program.categoryId));
  const names = await namesFor(money);

  const defaults = {} as Record<MoneyCategory, MoneyDefaultView>;
  for (const category of MONEY_CATEGORIES) {
    const active = money.find((program) => program.kind === 'default' && program.categoryId === category && program.status === 'active');
    const ended = money.find((program) => program.kind === 'default' && program.categoryId === category && program.status === 'ended');
    if (active && active.schedule === 'none') defaults[category] = { set: true, amountMicros: null, interval: 'none', recipients: null };
    else if (active) defaults[category] = { set: true, amountMicros: active.amount, interval: active.schedule, recipients: recipientsView(active.recipients) };
    // Computers have followed one monthly allowance for each member since the meter began; until a default is saved here, that is the default
    else if (category === 'computers' && settings.memberAllowanceMicros !== null && !ended) defaults[category] = { set: true, amountMicros: settings.memberAllowanceMicros, interval: 'monthly', recipients: { kind: 'all' } };
    else if (ended) defaults[category] = { set: true, amountMicros: null, interval: 'none', recipients: null };
    else defaults[category] = { set: false, amountMicros: null, interval: 'none', recipients: null };
  }

  // Exceptions: the active ones, one line for each group of people
  const groups = new Map<string, { audience: AudienceView; apps?: ProgramView; computers?: ProgramView }>();
  for (const program of money.filter((entry) => entry.kind === 'exception' && entry.status === 'active')) {
    const key = recipientKey(program.recipients);
    const group = groups.get(key) ?? { audience: audienceOf(program, names) };
    if (program.categoryId === 'instant_apps') group.apps = program;
    else group.computers = program;
    groups.set(key, group);
  }
  const exceptions: ExceptionView[] = [...groups.values()].map((group) => ({ id: exceptionId(group.apps?.programId, group.computers?.programId), audience: group.audience, instant_apps: settingOf(group.apps), computers: settingOf(group.computers) }));

  // Gifts: every one still running, and the ones that ended most recently (so a long history never hides a running gift)
  const endedAt = (program: ProgramView) => (program.lotExpiresAt ?? program.claimEndsAt ?? now).getTime();
  const isEnded = (program: ProgramView) => program.status === 'ended' || endedAt(program) <= now.getTime();
  const allGifts = money.filter((program) => program.kind === 'gift');
  const gifts = [...allGifts.filter((program) => !isEnded(program)), ...allGifts.filter(isEnded).sort((a, b) => endedAt(b) - endedAt(a)).slice(0, RECENTLY_ENDED_GIFTS)];
  const figures = await giftFigures(gifts.map((gift) => gift.programId));
  const giftViews: GiftView[] = gifts
    .map((gift): GiftView => {
      const audience = audienceOf(gift, names);
      const endsAt = gift.lotExpiresAt ?? gift.claimEndsAt ?? now;
      const f = figures.get(gift.programId);
      const reach = gift.recipientCount ?? audience.count;
      return {
        id: gift.programId,
        audience,
        amountMicros: gift.amount,
        shared: gift.share === 'shared',
        totalMicros: gift.share === 'shared' ? gift.amount : gift.amount * Math.max(1, reach),
        scope: gift.covers.length > 1 ? 'both' : gift.covers[0] === 'computers' ? 'computers' : 'apps',
        endsAt: endsAt.toISOString(),
        ended: gift.status === 'ended' || endsAt <= now,
        usedMicros: f?.used ?? 0,
        givenByName: names.givers.get(gift.createdById) ?? 'a super admin',
        settlement: gift.settlement === 'to_bill' ? 'to_bill' : 'gift',
        billedAt: gift.settlement === 'to_bill' && f && f.lots > 0 && f.unbilled === 0 ? (f.billed?.toISOString() ?? null) : null,
        payer: `Paid by ${names.accounts.get(gift.fundingAccountId) ?? 'Universe'}`,
      };
    })
    .sort((a, b) => Number(a.ended) - Number(b.ended) || b.endsAt.localeCompare(a.endsAt));

  return {
    ai: { signedIn: limits.fairUsage.signedIn, guest: limits.fairUsage.guest, windowHours: FAIR_USAGE_WINDOW_HOURS },
    money: defaults,
    exceptions,
    gifts: giftViews,
    totals: { people, issuedMonthMicros: exposure.issuedThisMonthMicros, usedMonthMicros: exposure.chargedThisMonthMicros, budgetMicros: exposure.budgetMicros },
  };
}

// ---------- Turning a request into the books' own calls ----------

const scopeCovers = (scope: GiftScope): MoneyCategory[] => (scope === 'both' ? ['instant_apps', 'computers'] : scope === 'apps' ? ['instant_apps'] : ['computers']);

function settingInput(category: MoneyCategory, setting: ExceptionSetting, recipients: Recipient, now: Date): GrantInput | null {
  if (setting.mode === 'same') return null;
  if (setting.mode === 'none') return { categoryId: category, schedule: 'none', recipients, claimStartsAt: now };
  return { categoryId: category, amount: setting.amountMicros, schedule: setting.interval, recipients, claimStartsAt: now };
}

export function defaultInput(request: Extract<PreviewRequest, { what: 'default' }>, now: Date): GrantInput {
  // Until computer jobs draw from credit lots they follow one monthly allowance for every member, so a computers default can only say that
  if (request.category === 'computers' && request.interval !== 'none' && (request.interval !== 'monthly' || request.recipients.kind !== 'all')) {
    throw new GrantsRefused('For now computer credit is given every month to everyone, or not at all. Use an exception or a gift for anything else.');
  }
  if (request.interval === 'none') return { categoryId: request.category, amount: 0, schedule: 'none', recipients: recipientOf(request.recipients), claimStartsAt: now };
  const monthlyNext = request.interval === 'monthly' && request.startsOn !== 'now';
  return { categoryId: request.category, amount: request.amountMicros ?? 0, schedule: request.interval as Schedule, recipients: recipientOf(request.recipients), claimStartsAt: monthlyNext ? firstOfNextMonth(now) : now };
}

export async function giftInput(request: Extract<PreviewRequest, { what: 'gift' }> & { settlement?: 'gift' | 'to_bill'; note?: string | null; grantKey?: string }, now: Date): Promise<GrantInput> {
  const endsAt = new Date(request.endsAt);
  if (Number.isNaN(endsAt.getTime()) || endsAt <= now) throw new GrantsRefused('A gift ends on a day in the future');
  if (endsAt.getTime() - now.getTime() > 366 * DAY) throw new GrantsRefused('A gift can end up to a year from now');
  const recipients = recipientOf(request.audience);
  const covers = scopeCovers(request.scope);
  const input: GrantInput = {
    categoryId: covers[0],
    covers,
    amount: request.amountMicros,
    schedule: 'once',
    share: request.shared ? 'shared' : 'each',
    recipients,
    claimStartsAt: now,
    claimEndsAt: endsAt,
    lotExpiresAt: endsAt,
    settlement: request.settlement === 'to_bill' ? 'to_bill' : 'free',
    agreementNote: request.settlement === 'to_bill' ? (request.note ?? null) : null,
    ...(request.grantKey ? { requestKey: request.grantKey } : {}),
  };
  if (recipients.kind === 'universe' && recipients.mode === 'changing') {
    const cap = request.joinerCap;
    if (!cap || !Number.isInteger(cap) || cap < 1) throw new GrantsRefused('Say the most people who can join');
    const members = await prisma.universeMember.count({ where: { universeId: recipients.universeId, user: { isGuest: false } } });
    // The books cap how many people can ever hold the gift (members now included): the people there now and those who may join.
    // What the admin types is how many MORE may join, so the members now are added here. The money is capped by the same people
    input.joinerCap = members + cap;
    input.totalCapMicros = request.shared ? request.amountMicros : request.amountMicros * (members + cap);
  }
  return input;
}

// ---------- Preview ----------

const namesOfUsers = async (ids: string[]): Promise<Map<string, string>> => new Map((await prisma.user.findMany({ where: { id: { in: ids.slice(0, 50) } }, select: { id: true, name: true } })).map((user) => [user.id, user.name?.trim() || 'Someone']));

/** The signed-in members of a universe now: who a rule for its members reaches, whether it is fixed at saving or changing (a saved rule that is not yet saved has no ids of its own to read). */
async function membersOf(universeId: string): Promise<Set<string>> {
  const members = await prisma.universeMember.findMany({ where: { universeId, user: { isGuest: false } }, select: { userId: true } });
  return new Set(members.map((member) => member.userId));
}

/** The people two rules would both reach, named, from the saved rules and the ones asked about. */
async function clashOf(category: MoneyCategory, recipients: Recipient, programId: string | undefined, setting: { amountMicros: number; interval: string }): Promise<ClashView | null> {
  const others = (await currentRules(prisma, { categoryId: category })).filter((rule) => rule.programKind === 'exception' && rule.programId !== programId);
  const mine = recipients.kind === 'people' ? new Set(recipients.userIds) : recipients.kind === 'universe' ? await membersOf(recipients.universeId) : new Set<string>();
  const myRank = recipients.kind === 'people' && recipients.userIds.length === 1 ? 1 : 2;
  for (const other of others) {
    const theirRank = other.recipient.kind === 'people' && other.recipient.userIds.length === 1 ? 1 : 2;
    if (theirRank !== myRank) continue;
    if (other.amount === setting.amountMicros && other.schedule === setting.interval && other.share === 'each') continue;
    const theirs = await idsReached(prisma, other);
    const shared = [...theirs].filter((id) => mine.has(id));
    if (shared.length === 0) continue;
    const names = await namesOfUsers(shared);
    const universe = other.recipient.kind === 'universe' ? await prisma.universe.findUnique({ where: { id: other.recipient.universeId }, select: { name: true } }) : null;
    const label = universe?.name ?? (other.recipient.kind === 'people' ? 'another rule for people you picked' : 'another rule');
    const words = other.schedule === 'none' ? `${category === 'computers' ? 'Computers' : 'Instant Apps'}: no grant` : `${category === 'computers' ? 'Computers' : 'Instant Apps'} ${usdWords(other.amount)} ${other.schedule === 'monthly' ? 'a month' : 'once'}`;
    return { people: shared.map((id) => names.get(id) ?? 'Someone'), other: { name: label, text: words }, thisText: setting.interval === 'none' ? 'no grant' : `${usdWords(setting.amountMicros)} ${setting.interval === 'monthly' ? 'a month' : 'once'}` };
  }
  return null;
}

const usdWords = (micros: number) => `$${(micros / 1_000_000).toLocaleString('en', { maximumFractionDigits: 2 })}`;

async function ownRulePeople(category: MoneyCategory, recipient: Recipient): Promise<number> {
  const exceptions = (await currentRules(prisma, { categoryId: category })).filter((rule) => rule.programKind === 'exception');
  const ids = new Set<string>();
  for (const rule of exceptions) (await idsReached(prisma, rule)).forEach((id) => ids.add(id));
  if (ids.size === 0) return 0;
  return prisma.user.count({ where: { id: { in: [...ids] }, isGuest: false, ...(recipient.kind === 'new_from' ? { createdAt: { gte: recipient.from, ...(recipient.to ? { lt: recipient.to } : {}) } } : {}) } });
}

function numbersOf(preview: Preview, request: PreviewRequest, extra: { interval: PreviewNumbers['interval']; startsOn?: 'next' | 'now'; ownRules: number; audienceName?: string; endsOn?: string }): PreviewNumbers {
  const countNow = preview.recipients.countNow ?? 0;
  const shared = preview.recipients.share === 'shared';
  const each = preview.recipients.eachMicros;
  return {
    people: countNow,
    ownRules: extra.ownRules,
    laterToo: preview.recipients.growing,
    amountMicros: each,
    interval: extra.interval,
    shared,
    startsOn: extra.startsOn,
    // A changing universe gift can reach the people there now and the joiners the admin allowed: that is the most it can issue
    mostNowMicros: shared ? each : each * (countNow + (request.what === 'gift' && request.joinerCap && preview.recipients.growing ? request.joinerCap : 0)),
    // The funding check is about who is there now: joiners are funded as they join
    issuedNowMicros: shared ? each : each * countNow,
    noLifetimeMax: preview.mostIssued.unbounded,
    endsOn: extra.endsOn,
    audienceName: extra.audienceName,
    already: request.what === 'gift' ? preview.overlaps.filter((overlap) => overlap.how === 'adds' && overlap.people > 0).map((overlap) => `${overlap.people.toLocaleString('en')} of these ${overlap.people === 1 ? 'person' : 'people'} already ${overlap.people === 1 ? 'has' : 'have'} credit from ${overlap.label.toLowerCase() === 'gift' ? 'another gift' : overlap.label}. This is a separate gift, so it adds.`) : [],
    budget: preview.budget.budgetMicros === null ? { budgetMicros: null, roomMicros: 0 } : { budgetMicros: preview.budget.budgetMicros, roomMicros: preview.budget.roomMicros },
  };
}

const dayWords = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** The three-part preview of what a screen is about to save. Reads only. */
export async function previewFor(request: PreviewRequest, now: Date = new Date()): Promise<PreviewView> {
  try {
    if (request.what === 'default') {
      if (request.interval === 'none' || request.amountMicros === null) return { numbers: null, clash: null };
      const input = defaultInput(request, now);
      const preview = await previewGrant('default', input, now);
      const own = await ownRulePeople(request.category, input.recipients);
      return { numbers: numbersOf(preview, request, { interval: request.interval, startsOn: request.startsOn, ownRules: own }), clash: null };
    }
    if (request.what === 'gift') {
      const input = await giftInput(request, now);
      const preview = await previewGrant('gift', input, now);
      return { numbers: numbersOf(preview, request, { interval: 'once', ownRules: 0, endsOn: dayWords(request.endsAt) }), clash: null };
    }
    // An exception: each money category it sets, over the same people
    const recipients = recipientOf(request.audience);
    let numbers: PreviewNumbers | null = null;
    let clash: ClashView | null = null;
    let most = 0;
    let issuedNow = 0;
    for (const category of MONEY_CATEGORIES) {
      const setting = request[category];
      const input = settingInput(category, setting, recipients, now);
      if (!input) continue;
      const preview = await previewGrant('exception', input, now);
      const first = numbersOf(preview, request, { interval: setting.mode === 'own' ? setting.interval : 'none', ownRules: 0 });
      if (setting.mode === 'own') {
        most += first.mostNowMicros ?? 0;
        issuedNow += first.issuedNowMicros ?? 0;
      }
      numbers = numbers ?? first;
      // "No grant" is a figure like any other: the books refuse it too when another rule of the same rank says something else for the same people
      if (!clash) clash = await clashOf(category, recipients, request.replaceId ? (readExceptionId(request.replaceId)?.[category] ?? undefined) : undefined, setting.mode === 'own' ? { amountMicros: setting.amountMicros, interval: setting.interval } : { amountMicros: 0, interval: 'none' });
    }
    return { numbers: numbers ? { ...numbers, mostNowMicros: most > 0 ? most : null, issuedNowMicros: issuedNow > 0 ? issuedNow : null } : null, clash };
  } catch (error) {
    if (error instanceof CreditRefused || error instanceof GrantsRefused) return { numbers: null, clash: null, problem: error.message };
    throw error;
  }
}

// ---------- Saving ----------

export async function saveDefaultFor(request: Extract<PreviewRequest, { what: 'default' }>, issuer: Issuer, now: Date = new Date()): Promise<void> {
  const category = request.category;
  await saveDefault(defaultInput(request, now), issuer, now);
  // Until computer jobs draw from credit lots, they follow one monthly allowance for each member: it follows the default saved here
  if (category === 'computers') {
    const everyone = request.recipients.kind === 'all';
    if (request.interval === 'none') await saveMeterSettings({ memberAllowanceMicros: null }, issuer.userId);
    else if (request.interval === 'monthly' && everyone && request.amountMicros) {
      // "On the 1st" waits for the 1st, as the default itself does; "Now" changes the allowance now
      if (request.startsOn === 'now') await saveMeterSettings({ memberAllowanceMicros: request.amountMicros }, issuer.userId);
      else await scheduleMemberAllowance(request.amountMicros, firstOfNextMonth(now), issuer.userId);
    }
  }
}

/** A program as the input that would save it again, so it can be saved with some people taken out. */
function inputOfProgram(program: ProgramView): GrantInput {
  return { categoryId: program.categoryId, amount: program.amount, schedule: program.schedule, recipients: program.recipients, share: program.share, claimStartsAt: program.claimStartsAt, claimEndsAt: program.claimEndsAt, lotExpiresAt: program.lotExpiresAt, label: program.label };
}

/** What taking people out of another rule changed, so a refused save can put the other rule back. */
interface TakenOut {
  before: ProgramView;
  ended: boolean;
}

async function takeOut(programId: string, people: string[], issuer: Issuer, now: Date, taken: TakenOut[]): Promise<void> {
  const other = (await listPrograms(undefined, { kind: 'exception' })).find((program) => program.programId === programId);
  if (!other) return;
  if (other.recipients.kind !== 'people') {
    throw new GrantsRefused('That other rule is for a universe’s members, so these people can’t be taken out of it. End that rule, or give each of them a rule of their own (a person’s own rule comes first).', 400, 'clash');
  }
  const left = other.recipients.userIds.filter((id) => !people.includes(id));
  if (left.length === 0) {
    await endProgram(programId, issuer, now);
    taken.push({ before: other, ended: true });
  } else {
    await saveException({ ...inputOfProgram(other), recipients: { kind: 'people', userIds: left }, programId }, issuer, now);
    taken.push({ before: other, ended: false });
  }
}

/**
 * Gives other rules back the people a refused save had taken out of them. A shortened rule is saved as it was. A rule that had to
 * end can't be reopened, so it is made again with the same figures and people (its old id is gone, its people have it again).
 */
async function putBack(taken: TakenOut[], issuer: Issuer, now: Date): Promise<void> {
  let failed = 0;
  for (const { before, ended } of [...taken].reverse()) {
    try {
      await saveException({ ...inputOfProgram(before), programId: ended ? undefined : before.programId }, issuer, now);
    } catch (error) {
      failed += 1;
      console.error('[Grants] Could not give a rule back its people after a refused save:', error instanceof Error ? error.message : 'unknown');
    }
  }
  // Never let the screen say "nothing changed" when another rule could not be put back
  if (failed > 0) throw new GrantsRefused('That didn’t save, and another rule could not be fully put back. Check the exceptions list before trying again.', 500);
}

/** Puts back what a refused save had already changed: a new rule ends, a changed one goes back to what it was. */
async function undo(done: { before: ProgramView | undefined; after: ProgramView }[], issuer: Issuer, now: Date): Promise<void> {
  for (const { before, after } of done.reverse()) {
    try {
      if (before) await saveException({ ...inputOfProgram(before), programId: before.programId }, issuer, now);
      else await endProgram(after.programId, issuer, now);
    } catch (error) {
      console.error('[Grants] Could not put back a rule after a refused save:', error instanceof Error ? error.message : 'unknown');
    }
  }
}

/**
 * Saves an exception: one rule for each money category it sets, over the same people. A category set to "As everyone" has no rule (an
 * existing one ends). A clash is refused with the people named; with `clashChoice` the admin says which rule applies to them: "this"
 * takes them out of the other rule, "other" takes them out of this one.
 */
export async function saveExceptionFor(request: Extract<PreviewRequest, { what: 'exception' }> & { clashChoice?: 'this' | 'other' }, issuer: Issuer, now: Date = new Date()): Promise<void> {
  let recipients = recipientOf(request.audience);
  const existing = request.replaceId ? readExceptionId(request.replaceId) : null;
  if (request.replaceId && !existing) throw new GrantsRefused('That exception was not found', 404);
  // The same people already have a rule for this category: this is a change to it, never a second one
  let active = await listPrograms(undefined, { kind: 'exception' });
  const findExisting = (category: MoneyCategory): ProgramView | undefined => {
    const named = existing?.[category] ? active.find((program) => program.programId === existing[category]) : undefined;
    return named ?? active.find((program) => program.categoryId === category && recipientKey(program.recipients) === recipientKey(recipients));
  };

  // Changes to other rules made to settle a clash: put back if the save is refused after all
  const taken: TakenOut[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    // What this attempt changed, so a refusal part-way puts it back: one rule for each category is saved on its own, never half-saved
    const done: { before: ProgramView | undefined; after: ProgramView }[] = [];
    try {
      const toEnd: ProgramView[] = [];
      for (const category of MONEY_CATEGORIES) {
        const current = findExisting(category);
        const input = settingInput(category, request[category], recipients, now);
        if (!input) {
          if (current) toEnd.push(current);
          continue;
        }
        done.push({ before: current, after: await saveException({ ...input, programId: current?.programId }, issuer, now) });
      }
      // Ending comes last: it is the one step that cannot be put back
      for (const program of toEnd) await endProgram(program.programId, issuer, now);
      return;
    } catch (error) {
      await undo(done, issuer, now);
      if (!(error instanceof ClashRefused) || !request.clashChoice || attempt > 0) {
        await putBack(taken, issuer, now);
        throw error;
      }
      // The admin chose which rule applies to the people the two disagree about
      try {
        const clashing = new Set(error.clashes.flatMap((clash) => clash.userIds));
        if (request.clashChoice === 'this') {
          for (const clash of error.clashes) await takeOut(clash.programId, clash.userIds, issuer, now, taken);
        } else {
          if (recipients.kind !== 'people') throw new GrantsRefused('This rule is for a universe’s members, so those people can’t be taken out of it. Pick “This one”, or give each of them a rule of their own.', 400, 'clash');
          const left = recipients.userIds.filter((id) => !clashing.has(id));
          if (left.length === 0) throw new GrantsRefused('Nobody would be left in this rule. Pick “This one”, or change the people.', 400, 'clash');
          recipients = { kind: 'people', userIds: left };
        }
        active = await listPrograms(undefined, { kind: 'exception' });
      } catch (settling) {
        await putBack(taken, issuer, now);
        throw settling;
      }
    }
  }
}

export async function endException(id: string, issuer: Issuer, now: Date = new Date()): Promise<'ended' | 'not_found'> {
  const parts = readExceptionId(id);
  if (!parts) return 'not_found';
  let found = false;
  // Only exception rules are ended here, never a default or a gift that an id happens to name
  const exceptionIds = new Set((await listPrograms(undefined, { kind: 'exception' })).map((program) => program.programId));
  for (const category of MONEY_CATEGORIES) {
    const programId = parts[category];
    if (!programId || !exceptionIds.has(programId)) continue;
    const result = await endProgram(programId, issuer, now);
    if (result !== 'not_found') found = true;
  }
  return found ? 'ended' : 'not_found';
}

export async function createGiftFor(request: Extract<PreviewRequest, { what: 'gift' }> & { settlement?: 'gift' | 'to_bill'; note?: string | null; grantKey?: string }, issuer: Issuer, now: Date = new Date()): Promise<ProgramView> {
  return createGift(await giftInput(request, now), issuer, now);
}

/** "End it now" for a gift: stops it reaching anyone new. Only a gift can be ended here, never a default or an exception. */
export async function endGift(programId: string, issuer: Issuer, now: Date = new Date()): Promise<'ended' | 'already_ended' | 'not_found'> {
  const program = await prisma.grantProgram.findUnique({ where: { id: programId }, select: { kind: true } });
  if (!program || program.kind !== 'gift') return 'not_found';
  return endProgram(programId, issuer, now);
}

/** "Mark as billed": says a gift that was to be billed was, and when. Said once; a gift is never owed, so it cannot be marked. */
export async function markGiftBilled(programId: string, now: Date = new Date()): Promise<'billed' | 'already_billed' | 'not_billable' | 'not_found' | 'nothing_yet'> {
  const program = await prisma.grantProgram.findUnique({ where: { id: programId }, select: { kind: true, rules: { orderBy: { version: 'desc' }, take: 1, select: { settlement: true } } } });
  if (!program || program.kind !== 'gift') return 'not_found';
  if (program.rules[0]?.settlement !== 'to_bill') return 'not_billable';
  const { result } = await markCreditBilled({ programId }, now);
  return result === 'not_found' ? 'nothing_yet' : result;
}

export const issuerFor = (user: { id: string }, superAdmin: boolean): Issuer => ({ userId: user.id, superAdmin });
