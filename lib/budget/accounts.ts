import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';
import { Agent37Client, Agent37Error } from '@/lib/agent37/client';
import { recentDays } from '@/lib/budget/books';
import { sonioxOrgKey } from '@/lib/budget/provider-keys';
import { getAdapter } from '@/lib/app-adapter';
import { readComposioBilling } from '@/lib/composio-billing';
import { monthOf } from '@/lib/meter-values';
import type { AccountState, AccountView } from '@/lib/budget/types';

/**
 * The company accounts that pay for what Universe funds (billing consensus v2, 3.2 and P7). Each company is read where its own account API says what
 * it holds, and shown in the status that fits what it is: a prepaid balance, a monthly plan with what is left of its included amount, or billed
 * after use (no balance made up). "Unknown" and "zero" are different states: a company that does not tell us is never shown as empty, and a read
 * that failed keeps the last good reading with its time and says it could not be refreshed. Credit at one company never pays another.
 *
 * Reading a balance is free at every company that gives one; nothing paid is called from here.
 */

const DAY = 24 * 60 * 60 * 1000;
const READ_TIMEOUT_MS = 8_000;

export type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

interface Company {
  key: string;
  name: string;
  paysFor: string;
  /** The company's billing page: where a top up or a plan change happens. */
  url: string;
}

/** Where each company's billing is. Links, not amounts. */
export const COMPANIES: Company[] = [
  { key: 'deepseek', name: 'DeepSeek', paysFor: 'Chat replies and computer steps', url: 'https://platform.deepseek.com/top_up' },
  { key: 'elevenlabs', name: 'ElevenLabs', paysFor: 'Speaking', url: 'https://elevenlabs.io/app/subscription' },
  { key: 'soniox', name: 'Soniox', paysFor: 'Listening', url: 'https://console.soniox.com' },
  { key: 'composio', name: 'Composio', paysFor: 'Connected Apps and Instant Apps', url: 'https://platform.composio.dev' },
  { key: 'agent37', name: 'Agent37', paysFor: 'Computers: machine time and resting disks', url: 'https://agent37.com' },
  { key: 'r2', name: 'Cloudflare R2', paysFor: 'Files and packed away copies', url: 'https://dash.cloudflare.com' },
];

/** What a reading holds before the page words it. */
export interface Reading {
  kind: AccountView['kind'];
  balanceMicros?: number | null;
  planLeftPercent?: number | null;
  planRenewsAt?: string | null;
  /** The company said the account is overdrawn or unusable. */
  empty?: boolean;
  /** The company's own words for the account when it is not simply a number (past due). */
  note?: string | null;
  /** A pace to work days left from, in millionths of a dollar a day. */
  dailyMicros?: number | null;
  /** For a plan, the days left at this pace, worked from the plan's own use. */
  planDaysLeft?: number | null;
  /** The reading is ours (a count from our books) and not the company's own. */
  ours?: boolean;
  /** What else the company tells us, a line each. */
  facts?: string[];
  /** The company says the account is overdrawn or a payment failed. */
  overdue?: boolean;
  /** For a company read with its own key: whether that key is saved here. */
  connected?: boolean;
}

const dollarsOf = (value: number) => dollars(Math.round(value * 1_000_000));

const asRecord = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  if (!response.ok) return { status: response.status, body: null };
  return { status: response.status, body: asRecord(await response.json().catch(() => null)) };
}

/** DeepSeek's prepaid balance (`GET /user/balance`), in dollars. A balance in another currency is not turned into dollars: it is unknown. */
export async function readDeepSeek(key: string, fetchImpl: FetchLike): Promise<Reading> {
  const { status, body } = await getJson(fetchImpl, 'https://api.deepseek.com/user/balance', { Authorization: `Bearer ${key}`, Accept: 'application/json' });
  if (status === 401 || status === 403) throw new Unreadable('DeepSeek refused the key');
  const infos = Array.isArray(body?.balance_infos) ? (body!.balance_infos as unknown[]) : null;
  if (!body || !infos) throw new Unreadable('DeepSeek did not give a balance');
  const usd = infos.map(asRecord).find((info) => info?.currency === 'USD');
  const total = usd ? Number(usd.total_balance) : NaN;
  if (!Number.isFinite(total)) throw new Unreadable('DeepSeek did not give a balance in dollars');
  const facts: string[] = [];
  const granted = Number(usd?.granted_balance);
  const toppedUp = Number(usd?.topped_up_balance);
  if (Number.isFinite(granted) && granted > 0) facts.push(`${dollars(Math.round(granted * 1_000_000))} of it was granted`);
  if (Number.isFinite(toppedUp) && toppedUp > 0) facts.push(`${dollars(Math.round(toppedUp * 1_000_000))} of it was topped up`);
  facts.push('Pay as you go: no plan and no automatic top up. The run-out date is the warning.');
  return { kind: 'balance', balanceMicros: Math.round(total * 1_000_000), empty: body.is_available === false || total <= 0, facts };
}

const cents = (value: unknown): string | null => (typeof value === 'number' && Number.isFinite(value) ? dollars(Math.round(value * 10_000)) : null);

/** ElevenLabs' plan (`GET /v1/user/subscription`): characters used of those included, and when the count starts again. */
export async function readElevenLabs(key: string, fetchImpl: FetchLike, now: Date): Promise<Reading> {
  const { status, body } = await getJson(fetchImpl, 'https://api.elevenlabs.io/v1/user/subscription', { 'xi-api-key': key, Accept: 'application/json' });
  if (status === 401 || status === 403) throw new Unreadable('ElevenLabs refused the key');
  if (!body) throw new Unreadable('ElevenLabs did not give its plan');
  const used = Number(body.character_count);
  const limit = Number(body.character_limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) throw new Unreadable('ElevenLabs did not give what its plan includes');
  const reset = Number(body.next_character_count_reset_unix);
  const renews = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null;
  const left = Math.max(0, Math.min(100, ((limit - used) / limit) * 100));
  // Days left at the plan's own pace: used so far over the days since the count started (a month before it starts again)
  let planDaysLeft: number | null = null;
  if (renews) {
    const startedAt = new Date(renews);
    startedAt.setUTCMonth(startedAt.getUTCMonth() - 1);
    const elapsed = (now.getTime() - startedAt.getTime()) / DAY;
    if (elapsed > 0 && used > 0) planDaysLeft = (limit - used) / (used / elapsed);
  }
  const facts = [`${used.toLocaleString('en')} of ${limit.toLocaleString('en')} credits used this period`];
  const tier = typeof body.tier === 'string' && body.tier ? body.tier : null;
  if (tier) facts.push(`Plan: ${tier}`);
  const planStatus = typeof body.status === 'string' ? body.status : null;
  const overdue = planStatus === 'past_due' || planStatus === 'unpaid';
  if (planStatus && planStatus !== 'active' && planStatus !== 'free' && planStatus !== 'trialing') facts.push(`Status: ${planStatus.replace(/_/g, ' ')}`);
  if (body.allowed_to_extend_character_limit === true) facts.push('Goes past the plan’s credits and bills the extra (overage is on)');
  else if (body.allowed_to_extend_character_limit === false) facts.push('Stops at the plan’s credits (overage is off)');
  const next = asRecord(body.next_invoice);
  const nextDue = cents(next?.amount_due_cents);
  if (nextDue) facts.push(`Next invoice ${nextDue}`);
  const open = Array.isArray(body.open_invoices) ? body.open_invoices.length : 0;
  if (open > 0) facts.push(`${open} open invoice${open === 1 ? '' : 's'} to pay`);
  facts.push('ElevenLabs does not give the prepaid dollar balance or Auto Top Up through its API: see its billing page.');
  return { kind: 'plan', planLeftPercent: left, planRenewsAt: renews ? renews.toISOString() : null, empty: used >= limit, planDaysLeft, facts, overdue: overdue || open > 0 };
}

/**
 * Soniox's prepaid balance (`GET /v1/organization/balance`). It needs a separate organization key (starts snx_org_) that an organization admin makes in
 * the Soniox console; the usual project key cannot read it. Under invoice billing there is no balance: it is billed after use.
 */
export async function readSoniox(key: string, fetchImpl: FetchLike): Promise<Reading> {
  const { status, body } = await getJson(fetchImpl, 'https://api.soniox.com/v1/organization/balance', { Authorization: `Bearer ${key}`, Accept: 'application/json' });
  if (status === 401 || status === 403) throw new Unreadable('Soniox refused the organization key');
  if (status === 429) throw new Unreadable('Soniox asked Orbit to wait before reading again');
  if (!body) throw new Unreadable('Soniox did not give its balance');
  const usd = (value: unknown): number | null => {
    const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
    return Number.isFinite(number) ? Math.round(number * 1_000_000) : null;
  };
  const facts: string[] = [];
  const free = usd(body.free_balance_usd);
  if (free !== null && free > 0) facts.push(`${dollars(free)} of it was granted`);
  if (body.autopay_enabled === true) {
    const threshold = usd(body.autopay_threshold_usd);
    const amount = usd(body.autopay_amount_usd);
    facts.push(`Autopay is on${threshold !== null ? `: ${amount !== null ? `adds ${dollars(amount)} ` : ''}when under ${dollars(threshold)}` : ''}`);
  } else if (body.autopay_enabled === false) facts.push('Autopay is off');
  const failed = body.has_payment_error === true;
  if (failed) facts.push('The last payment failed');
  if (body.has_payment_method === false) facts.push('No payment method on file');
  if (body.invoice_billing_enabled === true) return { kind: 'after', facts: ['Invoiced by Soniox after use', ...facts.filter((fact) => !fact.startsWith('Autopay'))], overdue: failed, connected: true };
  const balance = usd(body.available_balance_usd);
  if (balance === null) throw new Unreadable('Soniox did not give a balance in dollars');
  return { kind: 'balance', balanceMicros: balance, empty: body.balance_exhausted === true || balance <= 0, facts, overdue: failed, connected: true };
}

/** Agent37's wallet (`GET /v1/billing`). */
export async function readAgent37(client: Pick<Agent37Client, 'billing'>): Promise<Reading> {
  try {
    const wallet = await client.billing();
    const dollars = Number(wallet.balance_usd);
    if (!Number.isFinite(dollars)) throw new Unreadable('Agent37 did not give a balance');
    const facts: string[] = [];
    if (typeof wallet.tier === 'number') facts.push(`Tier ${wallet.tier}${typeof wallet.instance_limit === 'number' ? `, up to ${wallet.instance_limit} computers` : ''}`);
    const rule = wallet.auto_top_up as { enabled?: boolean; threshold_usd?: number; amount_usd?: number } | null | undefined;
    if (rule?.enabled === true) {
      const threshold = Number(rule.threshold_usd);
      const amount = Number(rule.amount_usd);
      facts.push(`Auto top up is on${Number.isFinite(threshold) ? `: ${Number.isFinite(amount) ? `adds ${dollarsOf(amount)} ` : ''}when under ${dollarsOf(threshold)}` : ''}`);
    } else facts.push('Auto top up is off (it is set on Agent37’s own page)');
    const overdue = wallet.past_due === true;
    if (overdue) facts.push('Agent37 puts computers to sleep while the wallet is negative, and deletes one left suspended for 30 days');
    return { kind: 'balance', balanceMicros: Math.round(dollars * 1_000_000), empty: dollars <= 0 || overdue, note: overdue ? 'The wallet is overdrawn.' : null, facts, overdue };
  } catch (error) {
    if (error instanceof Unreadable) throw error;
    if (error instanceof Agent37Error && (error.status === 401 || error.status === 403)) throw new Unreadable('Agent37 refused the key');
    throw new Unreadable('Agent37 could not be reached');
  }
}

export class Unreadable extends Error {}

// ---------- Which key to read each company with ----------

async function deepSeekKey(): Promise<string | null> {
  const providers = await prisma.botsAiProvider.findMany({ where: { ownerId: null, enabled: true, apiKeyEncrypted: { not: null } }, select: { endpoint: true, apiKeyEncrypted: true, isDefault: true }, orderBy: { isDefault: 'desc' } });
  const found = providers.find((provider) => {
    try {
      return !!provider.endpoint && new URL(provider.endpoint).hostname.endsWith('deepseek.com');
    } catch {
      return false;
    }
  });
  return found?.apiKeyEncrypted ? decryptApiKey(found.apiKeyEncrypted) : null;
}

async function voiceKey(adapter: string): Promise<string | null> {
  const provider = await prisma.voiceProvider.findFirst({ where: { adapter, ownerId: null, enabled: true, apiKeyEncrypted: { not: null } }, select: { apiKeyEncrypted: true } });
  return provider?.apiKeyEncrypted ? decryptApiKey(provider.apiKeyEncrypted) : null;
}

// ---------- Reading and wording ----------

export interface ReadContext {
  now: Date;
  fetchImpl?: FetchLike;
  /** The Agent37 client; absent when no key is set. */
  agent37?: Pick<Agent37Client, 'billing'> | null;
  /** Dollars a day Universe is spending at each company on the recent pace, in millionths of a dollar; null when it cannot be told. */
  pace?: Partial<Record<string, number | null>>;
  /** Instant paused itself because Composio ran out. */
  composioEmpty?: boolean;
  /** Our own count for a company that gives no balance, in millionths of a dollar this month. */
  ours?: Partial<Record<string, number | null>>;
}

const dollars = (micros: number) => `$${(micros / 1_000_000).toLocaleString('en', { minimumFractionDigits: micros % 1_000_000 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

/** Days left and what would last thirty days at a pace, for a balance. Null when there is no pace to go by. */
export function runway(balanceMicros: number, dailyMicros: number | null | undefined): { daysLeft: number; thirtyDayMicros: number } | null {
  if (!dailyMicros || dailyMicros <= 0) return null;
  return { daysLeft: balanceMicros / dailyMicros, thirtyDayMicros: Math.max(0, Math.ceil(dailyMicros * 30 - balanceMicros)) };
}

/** The words and state for one reading. A pure function of the reading, the pace and the days left in the month. */
export function describe(company: Company, reading: Reading, now: Date, monthEnd: Date): Pick<AccountView, 'kind' | 'balanceMicros' | 'planLeftPercent' | 'planRenewsAt' | 'state' | 'line' | 'daysLeft' | 'thirtyDayMicros' | 'checkedBy'> {
  const worded = describeReading(company, reading, now, monthEnd);
  // A failed payment or an overdrawn account is never "fine": it is at least a warning, whatever the amount says
  return reading.overdue && worded.state === 'ok' ? { ...worded, state: 'low', line: `${reading.note ?? 'A payment needs attention.'} ${worded.line}`.trim() } : worded;
}

function describeReading(company: Company, reading: Reading, now: Date, monthEnd: Date): Pick<AccountView, 'kind' | 'balanceMicros' | 'planLeftPercent' | 'planRenewsAt' | 'state' | 'line' | 'daysLeft' | 'thirtyDayMicros' | 'checkedBy'> {
  const daysToMonthEnd = Math.max(0, (monthEnd.getTime() - now.getTime()) / DAY);
  const base = { kind: reading.kind, balanceMicros: reading.balanceMicros ?? null, planLeftPercent: reading.planLeftPercent ?? null, planRenewsAt: reading.planRenewsAt ?? null, daysLeft: null as number | null, thirtyDayMicros: null as number | null, checkedBy: (reading.ours ? 'ours' : 'company') as 'company' | 'ours' };
  if (reading.kind === 'balance' && reading.balanceMicros !== null && reading.balanceMicros !== undefined) {
    const lasting = runway(reading.balanceMicros, reading.dailyMicros);
    if (reading.empty) {
      return { ...base, state: 'zero', line: `${reading.note ?? 'Empty.'} ${lasting ? `About ${dollars(Math.max(lasting.thirtyDayMicros, 0))} lasts 30 days.` : ''}`.trim(), daysLeft: 0, thirtyDayMicros: lasting?.thirtyDayMicros ?? null };
    }
    if (!lasting) return { ...base, state: 'ok', line: 'No recent use to work a pace from.' };
    const days = Math.floor(lasting.daysLeft);
    const low = lasting.daysLeft < daysToMonthEnd;
    return {
      ...base,
      state: low ? 'low' : 'ok',
      daysLeft: lasting.daysLeft,
      thirtyDayMicros: lasting.thirtyDayMicros,
      line: `About ${days} day${days === 1 ? '' : 's'} left at this pace.${lasting.thirtyDayMicros > 0 ? ` About ${dollars(lasting.thirtyDayMicros)} more lasts 30 days.` : ''}`,
    };
  }
  if (reading.kind === 'plan') {
    const left = reading.planLeftPercent ?? null;
    const renews = reading.planRenewsAt ? new Date(reading.planRenewsAt) : null;
    const renewsWords = renews ? `renews ${renews.toLocaleDateString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : 'renewal date not given';
    const daysLeft = reading.planDaysLeft ?? null;
    const untilRenewal = renews ? Math.max(0, (renews.getTime() - now.getTime()) / DAY) : null;
    const runsOutFirst = daysLeft !== null && untilRenewal !== null && daysLeft < untilRenewal;
    const state: AccountState = reading.empty ? 'zero' : runsOutFirst || (left !== null && daysLeft === null && left < 20) ? 'low' : 'ok';
    const pace = daysLeft === null ? '' : runsOutFirst ? ` At this pace it runs out in about ${Math.max(0, Math.floor(daysLeft))} day${Math.floor(daysLeft) === 1 ? '' : 's'}.` : ' Lasts past the renewal at this pace.';
    return { ...base, state, daysLeft, line: `Monthly plan, ${renewsWords}.${pace}`.trim() };
  }
  if (reading.kind === 'after') return { ...base, state: 'ok', line: `Billed after use, so there is no balance.${reading.balanceMicros ? ` About ${dollars(reading.balanceMicros)} this month so far.` : ''}`, balanceMicros: null };
  // Unknown: the company does not tell us. Never shown as zero
  const ourCount = reading.balanceMicros ? ` By our count about ${dollars(reading.balanceMicros)} this month.` : '';
  return { ...base, state: reading.empty ? 'zero' : 'unknown', line: reading.empty ? `${reading.note ?? `${company.name} said it has no money.`}${ourCount}` : `${reading.note ?? `${company.name} doesn’t tell us its balance.`}${ourCount}`, balanceMicros: null };
}

export interface Stored {
  [key: string]: { reading: Reading; at: string };
}

/**
 * Reads every company, at once, each with its own timeout. A read that fails does not fail the page: the company keeps the last good reading it
 * had (with its time) and says it could not be refreshed. Returns the readings that worked, to be saved.
 */
export async function readAccounts(ctx: ReadContext, previous: Stored, only?: string): Promise<{ accounts: AccountView[]; fresh: Stored }> {
  const fetchImpl: FetchLike = ctx.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  const monthEnd = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth() + 1, 1));
  const results = await Promise.all(
    COMPANIES.map(async (company) => {
      const skip = only !== undefined && only !== company.key;
      let reading: Reading | null = null;
      let failure: string | null = null;
      if (!skip) {
        try {
          reading = await readCompany(company.key, ctx, fetchImpl);
        } catch (error) {
          failure = error instanceof Unreadable ? error.message : `${company.name} could not be reached`;
          if (!(error instanceof Unreadable)) console.error(`[Budget] Could not read ${company.name}:`, error instanceof Error ? error.message : 'unknown');
        }
      }
      return { company, reading, failure, skip };
    }),
  );
  const fresh: Stored = {};
  const accounts: AccountView[] = results.map(({ company, reading, failure }) => {
    const last = previous[company.key];
    const used = reading ?? last?.reading ?? null;
    const at = reading ? ctx.now.toISOString() : (last?.at ?? null);
    if (reading) fresh[company.key] = { reading, at: at! };
    const pace = ctx.pace?.[company.key] ?? null;
    const view: AccountView = {
      key: company.key,
      name: company.name,
      paysFor: company.paysFor,
      kind: 'unknown',
      balanceMicros: null,
      planLeftPercent: null,
      planRenewsAt: null,
      state: 'unknown',
      line: '',
      checkedAt: at,
      checkedBy: null,
      url: company.url,
      daysLeft: null,
      thirtyDayMicros: null,
      canVerify: true,
      facts: [],
      overdue: false,
      addFunds: company.key === 'agent37',
      ...(company.key === 'soniox' ? { connection: { connected: false, what: 'Soniox organization key' } } : {}),
    };
    if (used) {
      const worded = describe(company, { ...used, dailyMicros: pace }, ctx.now, monthEnd);
      Object.assign(view, worded);
      view.facts = used.facts ?? [];
      view.overdue = used.overdue === true || worded.state === 'zero';
      if (view.connection) view.connection.connected = used.connected === true;
    } else {
      view.line = failure ?? `${company.name} is not set up here, so it cannot be read.`;
      if (view.connection) view.connection.connected = !!failure;
      view.state = failure ? 'error' : 'unknown';
    }
    // A read that failed now is said, never read as zero: the last good reading stays, with its time
    if (failure) {
      view.state = used && view.state !== 'zero' ? view.state : 'error';
      view.line = `${failure}. ${used ? 'Showing the last reading.' : ''}`.trim();
    }
    return view;
  });
  return { accounts, fresh };
}

async function readCompany(key: string, ctx: ReadContext, fetchImpl: FetchLike): Promise<Reading | null> {
  switch (key) {
    case 'deepseek': {
      const secret = await deepSeekKey();
      if (!secret) return null;
      return readDeepSeek(secret, fetchImpl);
    }
    case 'elevenlabs': {
      const secret = await voiceKey('elevenlabs');
      if (!secret) return null;
      return readElevenLabs(secret, fetchImpl, ctx.now);
    }
    case 'agent37':
      return ctx.agent37 ? readAgent37(ctx.agent37) : null;
    case 'soniox': {
      const secret = await sonioxOrgKey();
      // Without the organization key nothing else stops: the row says it is not connected and where to connect
      if (!secret) return { kind: 'unknown', connected: false, note: 'Not connected. Soniox gives its balance only to an organization key: add one here and this row shows it.', facts: ['Made by an organization admin in the Soniox console (it starts snx_org_)'] };
      return readSoniox(secret, fetchImpl);
    }
    case 'composio': {
      // Composio gives no prepaid balance or plan through its API. Said plainly: the plan saved here, Composio's own count of calls, and our count
      const facts: string[] = [];
      const billing = await readComposioBilling();
      facts.push(`Plan saved in Orbit: ${billing.plan === 'pro' ? 'Pro' : 'Hobby'} (Composio does not tell us its plan or balance)`);
      const adapter = getAdapter();
      if (adapter?.usage) {
        const month = monthOf(ctx.now);
        const usage = await adapter.usage({ fromMs: month.start.getTime(), toMs: month.end.getTime() }).catch(() => null);
        if (usage) facts.push(`Composio counts ${usage.toolCalls.toLocaleString('en')} tool call${usage.toolCalls === 1 ? '' : 's'} this month`);
      }
      return { kind: 'unknown', balanceMicros: ctx.ours?.composio ?? null, ours: true, empty: ctx.composioEmpty === true, note: ctx.composioEmpty === true ? 'Composio said its balance is used up, so Instant Apps paused.' : 'Composio doesn’t tell us its balance. Instant Apps pause by themselves if it runs out.', facts };
    }
    case 'r2':
      return { kind: 'after', balanceMicros: ctx.ours?.r2 ?? null, ours: true };
    default:
      return null;
  }
}

/** The recent pace of what Universe spends at a company, from the books: millionths of a dollar a day over `days`. */
export async function paceFor(filters: Parameters<typeof recentDays>[0][], now: Date, days: number): Promise<number> {
  const series = await Promise.all(filters.map((filter) => recentDays(filter, now, days)));
  const total = series.flat().reduce((sum, value) => sum + value, 0);
  return days > 0 ? total / days : 0;
}

