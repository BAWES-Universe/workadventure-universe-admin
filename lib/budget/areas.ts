import { prisma } from '@/lib/db';
import { envelopeIn } from '@/lib/meter-allowance';
import { monthOf } from '@/lib/meter-values';
import { forecast, suggestions, type Forecast } from '@/lib/budget/forecast';
import { computerJobCosts, instantParts, instantRecentDays, keptByBrick, lapsedHeldMicros, monthSum, queueNow, recentDays, speechSeconds, type Filter, type KeptRow, type Queue } from '@/lib/budget/books';
import { available, numberById, type Values } from '@/lib/budget/numbers';
import type { AccountView, AreaState, AreaView, LineView } from '@/lib/budget/types';

/**
 * Builds each area's row from the books and the saved settings (billing consensus v2, section 3.1). A row says what was spent, what is set aside,
 * where the month ends at the recent pace, when the budget runs out, and for a pause what it prevents and what still costs money. It holds no
 * amount of its own: a budget is a saved number (or none: "not set"), a price is a saved price, a pace is read from the books.
 */

const dollars = (micros: number) => `$${(micros / 1_000_000).toLocaleString('en', { minimumFractionDigits: micros % 1_000_000 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
const hours = (seconds: number) => `${(seconds / 3600).toLocaleString('en', { maximumFractionDigits: 1 })} hours`;
const dayWords = (at: Date) => at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en')} ${count === 1 ? one : many}`;

export interface AreaContext {
  now: Date;
  values: Values;
  accounts: AccountView[];
}

const meterNumber = (values: Values, key: string): number | null => {
  const value = (values.meter as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
};

/** Whether the store that holds a budget has it at all (a budget another change adds is not there until it is). */
const numberAvailable = (id: string): boolean => {
  const def = numberById(id);
  return !!def && available(def);
};

export interface StateInput {
  /** The budget; null when there is none to hold the area to. */
  budgetMicros: number | null;
  /** Spent plus set aside plus anything kept back that the admission counts. */
  usedMicros: number;
  forecast: Forecast;
  /** A company's money is missing, so this area is paused whatever the budget says. */
  providerEmpty: string | null;
  /** Capacity is full while money is fine. */
  capacityFull: { running: number; limit: number } | null;
  notSetLine?: string;
}

/** The state of an area and its one line, in the order of what matters: a company's money, a reached budget, full capacity, a forecast past the budget. */
export function stateOf(input: StateInput): { state: AreaState; line: string } {
  if (input.providerEmpty) return { state: 'provider', line: `Paused: ${input.providerEmpty} is empty` };
  if (input.budgetMicros === null) return { state: 'not_set', line: input.notSetLine ?? 'No budget set' };
  if (input.usedMicros >= input.budgetMicros) return { state: 'reached', line: 'Budget reached' };
  if (input.capacityFull) return { state: 'capacity', line: `Full: ${input.capacityFull.running} of ${input.capacityFull.limit} jobs at once` };
  if (input.forecast.runsOutAt) return { state: 'low', line: `Runs out about ${dayWords(input.forecast.runsOutAt)}` };
  return { state: 'ok', line: 'Lasts the month' };
}

function readingOf(f: Forecast): AreaView['reading'] {
  return { sampleDays: f.sampleDays, daysWithUse: f.daysWithUse, readAt: f.readAt.toISOString(), sparse: f.sparse, burst: f.burst };
}

interface Shared {
  now: Date;
  month: { start: Date; end: Date };
  sampleDays: number;
  sparseDays: number;
  burstPercent: number;
  roomPercent: number | null;
  headroomPercent: number | null;
  /** Null until the page's own settings are read: the forecast is not worked without them and the page says so. */
  ready: boolean;
}

function shared(ctx: AreaContext): Shared {
  const budget = ctx.values.budget;
  const ready = budget.sampleDays !== null && budget.sparseDays !== null && budget.burstPercent !== null;
  return {
    now: ctx.now,
    month: monthOf(ctx.now),
    sampleDays: budget.sampleDays ?? 1,
    sparseDays: budget.sparseDays ?? 1,
    burstPercent: budget.burstPercent ?? 100,
    roomPercent: budget.raiseRoomPercent,
    headroomPercent: budget.raiseHeadroomPercent,
    ready,
  };
}

function forecastFor(s: Shared, days: number[], spent: number, held: number, budget: number | null): Forecast {
  return forecast({ spentMicros: spent, heldMicros: held, budgetMicros: budget, recentDays: days, now: s.now, monthStart: s.month.start, monthEnd: s.month.end, sparseDays: s.sparseDays, burstPercent: s.burstPercent });
}

const accountOf = (accounts: AccountView[], key: string) => accounts.find((account) => account.key === key);

// ---------- The areas ----------

async function chatArea(ctx: AreaContext, s: Shared): Promise<AreaView> {
  const filter: Filter = { pool: 'chat', kind: 'model_call' };
  const [sum, days] = await Promise.all([monthSum(filter, ctx.now), recentDays(filter, ctx.now, s.sampleDays)]);
  const f = forecastFor(s, days, sum.costMicros, 0, null);
  const priced = sum.events - sum.unpriced;
  const deepseek = accountOf(ctx.accounts, 'deepseek');
  const facts = [`${plural(sum.events, 'reply', 'replies')} this month${priced > 0 ? `, about ${dollars(Math.round(sum.costMicros / priced))} each` : ''}`, 'Chat keeps its fair usage per person, as before. It has no money stop'];
  if (sum.unpriced > 0) facts.push(`${plural(sum.unpriced, 'reply', 'replies')} had no price yet. They are unknown, not zero`);
  return {
    key: 'chat',
    title: 'Chat replies',
    covers: 'Universe AI text replies in chat, direct messages and calls. Not in the budget: fair usage per person, as before.',
    budgetMicros: null,
    spentMicros: sum.costMicros,
    heldMicros: 0,
    forecastMicros: f.monthEndMicros,
    runsOutAt: null,
    usedPercent: null,
    state: deepseek?.state === 'zero' ? 'provider' : 'ok',
    stateLine: deepseek?.state === 'zero' ? 'DeepSeek is empty' : 'Alert only',
    facts,
    offers: [],
    numberId: null,
    ...(deepseek?.state === 'zero' ? { topUp: { name: 'DeepSeek', url: deepseek.url } } : {}),
    reading: s.ready ? readingOf(f) : null,
    unpricedEvents: sum.unpriced,
  };
}

async function speechArea(ctx: AreaContext, s: Shared): Promise<AreaView> {
  const filter: Filter = { kind: 'speech' };
  const [sum, days, seconds] = await Promise.all([monthSum(filter, ctx.now), recentDays(filter, ctx.now, s.sampleDays), speechSeconds(ctx.now)]);
  const id = 'meter:speechBudgetMicros';
  const budget = numberAvailable(id) ? meterNumber(ctx.values, 'speechBudgetMicros') : null;
  const f = forecastFor(s, days, sum.costMicros, 0, budget);
  const st = stateOf({ budgetMicros: budget, usedMicros: sum.costMicros, forecast: f, providerEmpty: null, capacityFull: null, notSetLine: numberAvailable(id) ? 'No budget set' : 'No money budget yet' });
  const memberSeconds = meterNumber(ctx.values, 'speechMemberCeilingSeconds');
  const facts = [`Heard ${hours(seconds.heard)}, spoke ${hours(seconds.spoken)} this month`];
  if (memberSeconds !== null) facts.push(`One person may use ${hours(memberSeconds)} a month on Universe AI`);
  if (sum.unpriced > 0) facts.push(`${plural(sum.unpriced, 'use')} had no price yet. They are unknown, not zero, and are not in the money shown`);
  const eleven = accountOf(ctx.accounts, 'elevenlabs');
  const flag = eleven && (eleven.state === 'low' || eleven.state === 'zero') ? 'A raise doesn’t add voice at ElevenLabs. Its plan is running low.' : undefined;
  return {
    key: 'speech',
    title: 'Speech',
    covers: 'Universe AI listening and speaking, in calls and voice notes.',
    budgetMicros: budget,
    spentMicros: sum.costMicros,
    heldMicros: 0,
    forecastMicros: f.monthEndMicros,
    runsOutAt: f.runsOutAt ? f.runsOutAt.toISOString() : null,
    usedPercent: f.usedPercent,
    state: st.state,
    stateLine: st.line,
    facts,
    ...(flag ? { flag } : {}),
    ifPaused: { stops: 'Universe AI stops listening and speaking. Bricks answer in text. Calls between people and own voice keys carry on.', stillCosts: 'Still costs: nothing new.' },
    offers: budget !== null ? suggestions(f.monthEndMicros, budget, s.roomPercent, s.headroomPercent).map((offer) => ({ micros: offer.micros, words: offer.words })) : [],
    numberId: numberAvailable(id) ? id : null,
    reading: s.ready ? readingOf(f) : null,
    unpricedEvents: sum.unpriced,
  };
}

async function appsArea(ctx: AreaContext, s: Shared): Promise<AreaView> {
  const connectedFilter: Filter = { pool: 'chat', kind: 'app_use', route: 'app' };
  const [connected, connectedDays, instant, instantDays] = await Promise.all([monthSum(connectedFilter, ctx.now), recentDays(connectedFilter, ctx.now, s.sampleDays), instantParts(ctx.now), instantRecentDays(ctx.now, s.sampleDays)]);
  const connectedId = 'meter:appUseCeilingMicros';
  const instantId = 'instant:exposureCeilingMicros';
  const connectedBudget = numberAvailable(connectedId) ? meterNumber(ctx.values, 'appUseCeilingMicros') : null;
  const instantBudget = typeof ctx.values.instant.exposureCeilingMicros === 'number' ? ctx.values.instant.exposureCeilingMicros : null;
  const instantSpent = instant.settledMicros;
  const connectedF = forecastFor(s, connectedDays, connected.costMicros, 0, connectedBudget);
  const instantF = forecastFor(s, instantDays, instantSpent, instant.openMicros, instantBudget);
  const lines: LineView[] = [
    { key: 'connected', title: 'Connected Apps', budgetMicros: connectedBudget, spentMicros: connected.costMicros, heldMicros: 0, facts: [plural(connected.events, 'step')], numberId: connectedId },
    { key: 'instant', title: 'Instant Apps', budgetMicros: instantBudget, spentMicros: instantSpent, heldMicros: instant.openMicros, facts: [plural(instant.runs, 'run')], numberId: instantId },
  ];
  // Code jobs (#997) is a third line when that change has merged: its budget is then a number the page knows
  const codeId = 'meter:codeJobsBudgetMicros';
  if (numberAvailable(codeId)) {
    const codeFilter: Filter = { pool: 'chat', kind: 'app_use', route: 'code' };
    const code = await monthSum(codeFilter, ctx.now);
    lines.push({ key: 'code', title: 'Code jobs', budgetMicros: meterNumber(ctx.values, 'codeJobsBudgetMicros'), spentMicros: code.costMicros, heldMicros: 0, facts: [plural(code.events, 'job')], numberId: codeId });
  }
  const set = lines.filter((line) => line.budgetMicros !== null);
  const budget = set.length > 0 ? set.reduce((sum, line) => sum + (line.budgetMicros ?? 0), 0) : null;
  const spent = lines.reduce((sum, line) => sum + line.spentMicros, 0);
  const held = lines.reduce((sum, line) => sum + line.heldMicros, 0);
  const f = forecastFor(s, connectedDays.map((value, index) => value + (instantDays[index] ?? 0)), spent, held, budget);
  const worst = [connectedF, instantF];
  const anyReached = lines.some((line) => line.budgetMicros !== null && line.spentMicros + line.heldMicros >= line.budgetMicros);
  const anyLow = worst.some((entry) => entry.runsOutAt !== null);
  const composio = accountOf(ctx.accounts, 'composio');
  const providerEmpty = composio?.state === 'zero' ? 'Composio' : null;
  let state: AreaState = anyReached ? 'reached' : anyLow ? 'low' : 'ok';
  let stateLine = anyReached ? 'A budget is reached' : anyLow ? `Runs out about ${dayWords((worst.find((entry) => entry.runsOutAt)!.runsOutAt as Date))}` : 'Lasts the month';
  if (budget === null) {
    state = 'not_set';
    stateLine = 'No budget set';
  }
  if (providerEmpty) {
    state = 'provider';
    stateLine = 'Paused: Composio is empty';
  }
  const facts: string[] = [];
  if (connected.unpriced > 0) facts.push(`${plural(connected.unpriced, 'step')} had no price yet. They are unknown, not zero`);
  return {
    key: 'apps',
    title: 'Apps',
    covers: 'Connected Apps, Instant Apps and code jobs on Universe’s bill. Each has its own budget; Apps is their sum.',
    budgetMicros: budget,
    spentMicros: spent,
    heldMicros: held,
    forecastMicros: f.monthEndMicros,
    runsOutAt: f.runsOutAt ? f.runsOutAt.toISOString() : null,
    usedPercent: f.usedPercent,
    state,
    stateLine,
    lines,
    facts,
    ifPaused: { stops: 'App steps on Universe’s bill wait.', stillCosts: 'Free steps and Apps on a person’s own account carry on. Still costs: nothing new.' },
    offers: [],
    numberId: null,
    ...(providerEmpty && composio ? { topUp: { name: 'Composio', url: composio.url } } : {}),
    reading: s.ready ? readingOf(f) : null,
    unpricedEvents: connected.unpriced,
  };
}

async function computersArea(ctx: AreaContext, s: Shared, kept: KeptRow[], queue: Queue): Promise<AreaView> {
  const filter: Filter = { pool: 'computer' };
  const [sum, days, envelope, lapsed, jobs] = await Promise.all([
    monthSum(filter, ctx.now),
    recentDays(filter, ctx.now, s.sampleDays),
    envelopeIn(prisma, ctx.now, ctx.values.meter),
    lapsedHeldMicros(ctx.now),
    computerJobCosts(ctx.now),
  ]);
  const id = 'meter:poolCeilingMicros';
  const budget = ctx.values.meter.poolCeilingMicros;
  // What admission counts against the budget: the pool's whole envelope (spent, set aside, kept storage and the part kept back)
  const used = envelope.totalMicros;
  const held = envelope.reservedMicros + lapsed;
  const keptBack = envelope.keptStorageMicros + envelope.reserveMicros;
  // The disks kept and the part kept back count against the budget already (they are in the envelope), so they are part of what is used
  const f = forecastFor(s, days, sum.costMicros + keptBack, held, budget);
  const atOnceAll = ctx.values.meter.atOnceAll;
  const waitingBusy = queue.waiting.busy ?? 0;
  const full = atOnceAll !== null && queue.running >= atOnceAll && waitingBusy > 0 ? { running: queue.running, limit: atOnceAll } : null;
  const agent37 = accountOf(ctx.accounts, 'agent37');
  const st = stateOf({ budgetMicros: budget, usedMicros: used, forecast: f, providerEmpty: agent37?.state === 'zero' ? 'Agent37' : null, capacityFull: full });
  const waitingAll = Object.values(queue.waiting).reduce((sum, count) => sum + count, 0);
  const facts: string[] = [];
  if (jobs.medianMicros !== null) facts.push(`A usual job costs about ${dollars(jobs.medianMicros)}${jobs.highMicros !== null ? `, a big one about ${dollars(jobs.highMicros)}` : ''}`);
  facts.push(`${plural(queue.running, 'job')} running, ${waitingAll} waiting${waitingAll > 0 && queue.oldestWaitMinutes !== null ? ` (the longest ${plural(queue.oldestWaitMinutes, 'minute')})` : ''}`);
  if (keptBack > 0) facts.push(`${dollars(keptBack)} of the budget is kept back: the disks kept and the part kept for late bills`);
  if (sum.unpriced > 0) facts.push(`${plural(sum.unpriced, 'use')} had no price yet. They are unknown, not zero`);
  if (st.state === 'provider') facts.push(`${plural(waitingAll, 'job')} saved and waiting. Raising this budget won’t help: the money is missing at Agent37`);
  if (st.state === 'capacity') facts.push('Money is fine. Raising the budget won’t help: wait, or let more run at once');
  const stillCostsDisks = kept.length > 0 ? `Still costs: ${plural(kept.length, 'resting disk')}, about ${dollars(envelope.keptStorageMicros)} a month (in Storage).` : 'Still costs: nothing new.';
  return {
    key: 'computers',
    title: 'Computers',
    covers: `Model steps on computers and machine time${envelope.reserveMicros > 0 ? `, with ${dollars(envelope.reserveMicros)} kept back for late bills` : ''}.`,
    budgetMicros: budget,
    spentMicros: sum.costMicros,
    heldMicros: held,
    forecastMicros: f.monthEndMicros,
    runsOutAt: f.runsOutAt ? f.runsOutAt.toISOString() : null,
    usedPercent: budget !== null && budget > 0 ? (used / budget) * 100 : budget === 0 ? 100 : null,
    state: st.state,
    stateLine: st.line,
    facts,
    ifPaused: st.state === 'capacity'
      ? { stops: `New computer jobs wait in line. The ${plural(queue.running, 'running job')} carry on.`, stillCosts: 'Still costs: the running jobs, as usual. Nothing extra.' }
      : { stops: 'New computer jobs wait. Running jobs are saved and paused.', stillCosts: stillCostsDisks },
    offers: budget !== null ? suggestions(f.monthEndMicros, budget, s.roomPercent, s.headroomPercent) : [],
    numberId: id,
    ...(st.state === 'provider' && agent37 ? { topUp: { name: 'Agent37', url: agent37.url } } : {}),
    capacity: true,
    reading: s.ready ? readingOf(f) : null,
    unpricedEvents: sum.unpriced,
  };
}

function storageArea(ctx: AreaContext, s: Shared, kept: KeptRow[], keptMicros: number, packedBytes: number): AreaView {
  const id = 'meter:storageBudgetMicros';
  const budget = numberAvailable(id) ? meterNumber(ctx.values, 'storageBudgetMicros') : null;
  const idle = kept.filter((row) => row.idle);
  const bytes = kept.reduce((sum, row) => sum + row.bytes, 0);
  const gb = (value: number) => `${(value / 1e9).toLocaleString('en', { maximumFractionDigits: 1 })} GB`;
  const price = ctx.values.meter.storageMicrosPerGbMonth;
  const idleMicros = price === null ? null : Math.round(idle.reduce((sum, row) => sum + (row.bytes * price) / 1e9, 0));
  const f = forecastFor(s, new Array<number>(s.sampleDays).fill(0), keptMicros, 0, budget);
  const st = stateOf({ budgetMicros: budget, usedMicros: keptMicros, forecast: f, providerEmpty: null, capacityFull: null, notSetLine: numberAvailable(id) ? 'No budget set' : 'No separate budget yet' });
  const facts = [`Kept: ${plural(kept.length, 'resting computer')}${packedBytes > 0 ? `, ${gb(packedBytes)} packed away` : ''}, ${gb(bytes)} in all`];
  if (idle.length > 0) facts.push(`${plural(idle.length, 'of those computers belongs', 'of those computers belong')} to people who haven’t used one for ${ctx.values.budget.idleDays} days${idleMicros !== null ? `, about ${dollars(idleMicros)} a month` : ''}`);
  facts.push(price === null ? 'The disk price is not set, so what is kept cannot be priced' : `Next month already owes about ${dollars(keptMicros)} for what is kept`);
  return {
    key: 'storage',
    title: 'Storage',
    covers: 'New resting disks, packed away copies and files. What is already kept is shown, and goes on costing.',
    budgetMicros: budget,
    spentMicros: keptMicros,
    heldMicros: 0,
    forecastMicros: keptMicros,
    runsOutAt: null,
    usedPercent: f.usedPercent,
    state: price === null ? 'not_set' : st.state,
    stateLine: price === null ? 'Disk price not set' : st.line,
    facts,
    ifPaused: { stops: 'No new disks, copies or files are kept.', stillCosts: `Still costs: what is already kept, about ${dollars(keptMicros)} a month.` },
    offers: budget !== null ? suggestions(keptMicros, budget, s.roomPercent, s.headroomPercent) : [],
    numberId: numberAvailable(id) ? id : null,
    tidy: true,
    reading: null,
    unpricedEvents: 0,
  };
}

export interface AreasResult {
  areas: AreaView[];
  kept: KeptRow[];
  queue: Queue;
  /** Gross cost this month, and what members fund themselves, for the funding line. */
  keptMicros: number;
}

export async function buildAreas(ctx: AreaContext): Promise<AreasResult> {
  const s = shared(ctx);
  const [kept, queue, archive] = await Promise.all([
    keptByBrick(ctx.now, ctx.values.budget.idleDays),
    queueNow(ctx.now),
    prisma.computerArchive.aggregate({ where: { state: { in: ['stored', 'verified', 'superseded'] } }, _sum: { bytes: true } }),
  ]);
  const price = ctx.values.meter.storageMicrosPerGbMonth ?? 0;
  const keptMicros = Math.round(kept.reduce((sum, row) => sum + (row.bytes * price) / 1e9, 0));
  const packedBytes = Number(archive._sum.bytes ?? 0);
  const [chat, speech, apps, computers] = await Promise.all([chatArea(ctx, s), speechArea(ctx, s), appsArea(ctx, s), computersArea(ctx, s, kept, queue)]);
  const storage = storageArea(ctx, s, kept, keptMicros, packedBytes);
  return { areas: [chat, speech, apps, computers, storage], kept, queue, keptMicros };
}

