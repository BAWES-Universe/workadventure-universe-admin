import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { monthOf } from '@/lib/meter-values';
import { getAdapter, type ReadyMadeAdapter } from '@/lib/app-adapter';
import {
  COMPOSIO_RATES_READ_ON,
  COMPOSIO_RATES_SOURCE,
  FREE_MANAGED_CALLS_PER_MONTH,
  FREE_TOOL_CALLS_PER_MONTH,
  PRO_PLAN_CREDIT_MICROS,
  PRO_PLAN_FEE_MICROS,
  RATE_MICROS,
  SANDBOX_RUN_MICROS,
  ZDR_ADD_ON_MICROS,
  tierOf,
  type RateTier,
} from '@/lib/composio-rates';

/**
 * What Composio actually bills us for the ready-made apps, worked out from the meter's own events (shadow mode: it only reads
 * and reports, nothing is stopped or charged to anyone by it).
 *
 * Each app step is written to the meter at LIST price (lib/composio-rates.ts). The account's bill differs from the sum of those
 * lines, because Composio takes the month's free calls off first, then the plan's credit, and the plan costs its fee whatever
 * is used. This module works that out for a whole calendar month (UTC), so a margin can be read from what we pay and not from
 * list prices:
 *
 *   bill = plan fee + (list price of the calls past the free allowance, plus add-ons, minus the plan's credit, never below 0)
 *
 * Then it checks the count of calls against Composio's own usage numbers (its usage API answers with our project key), and the
 * bill against the invoice when somebody enters it, and says so when either is further apart than a set threshold.
 */

const SETTING_KEY = 'composio-billing';
const INVOICES_KEY = 'composio-invoices';

export type ComposioPlan = 'pro' | 'hobby';

export interface ComposioBillingSettings {
  /** The Composio plan the account is on. Pro unless a super admin says otherwise. */
  plan: ComposioPlan;
  /** Zero data retention switched on in Composio's project. It covers only apps on our own sign-in or an API key, never Composio's own sign-in and never the sandbox. */
  zdrOn: boolean;
}

export const COMPOSIO_BILLING_DEFAULTS: ComposioBillingSettings = { plan: 'pro', zdrOn: false };

/** Further apart than this and the check says so: a share of what Composio shows, and never less than a floor, so a handful of calls is not an alarm. */
export const GAP_CALLS_RATIO = 0.1;
export const GAP_CALLS_MIN = 25;
export const GAP_INVOICE_RATIO = 0.1;
export const GAP_INVOICE_MIN_MICROS = 2_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export async function readComposioBilling(): Promise<ComposioBillingSettings> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    const value = isRecord(row?.value) ? row.value : {};
    return { plan: value.plan === 'hobby' ? 'hobby' : 'pro', zdrOn: value.zdrOn === true };
  } catch (error) {
    // The books are never a reason a call fails: the defaults stand in
    console.error('[Composio billing] Could not read the settings:', error instanceof Error ? error.message : 'unknown');
    return COMPOSIO_BILLING_DEFAULTS;
  }
}

export async function saveComposioBilling(change: Partial<ComposioBillingSettings>, userId: string): Promise<ComposioBillingSettings> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('composio-billing'))`;
    const row = await tx.appSetting.findUnique({ where: { key: SETTING_KEY } });
    const saved = isRecord(row?.value) ? row.value : {};
    const next = { plan: change.plan ?? (saved.plan === 'hobby' ? 'hobby' : 'pro'), zdrOn: change.zdrOn ?? saved.zdrOn === true };
    const value = next as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
    return next;
  });
}

// ---------- Invoices (entered by a person: the invoice has no feed) ----------

export interface InvoiceEntry {
  micros: number;
  enteredAt: string;
  enteredById: string;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const readMonth = (value: unknown): { start: Date; end: Date; key: string } | null => {
  if (typeof value !== 'string' || !MONTH.test(value)) return null;
  const range = monthOf(new Date(`${value}-01T00:00:00.000Z`));
  return { ...range, key: value };
};

export async function readInvoices(): Promise<Record<string, InvoiceEntry>> {
  const row = await prisma.appSetting.findUnique({ where: { key: INVOICES_KEY } });
  const out: Record<string, InvoiceEntry> = {};
  if (!isRecord(row?.value)) return out;
  for (const [month, entry] of Object.entries(row.value)) {
    if (MONTH.test(month) && isRecord(entry) && typeof entry.micros === 'number' && Number.isSafeInteger(entry.micros) && entry.micros >= 0) {
      out[month] = { micros: entry.micros, enteredAt: typeof entry.enteredAt === 'string' ? entry.enteredAt : '', enteredById: typeof entry.enteredById === 'string' ? entry.enteredById : '' };
    }
  }
  return out;
}

/** What Composio's invoice for a month says, in millionths of a dollar. A later entry for the same month replaces the earlier one. */
export async function saveInvoice(month: string, micros: number, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('composio-invoices'))`;
    const row = await tx.appSetting.findUnique({ where: { key: INVOICES_KEY } });
    const saved = isRecord(row?.value) ? row.value : {};
    const value = { ...saved, [month]: { micros, enteredAt: new Date().toISOString(), enteredById: userId } } as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: INVOICES_KEY }, create: { key: INVOICES_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
  });
}

// ---------- The month's bill ----------

export interface ComposioMonth {
  month: string;
  plan: ComposioPlan;
  zdrOn: boolean;
  /** App steps written to the meter this month (free searches included). */
  events: number;
  /** Tool runs, and how many of them the month's free calls covered. */
  executions: number;
  freeExecutions: number;
  paidExecutions: number;
  /** Of the tool runs, those on Composio's own sign-in, and those on ours or an API key. */
  managedExecutions: number;
  ownExecutions: number;
  sandboxRuns: number;
  zdrCalls: number;
  /** Searches and lookups Composio does not charge for. */
  freeLookups: number;
  /** Tool runs priced at a figure the pricing page does not settle (the listed group of apps). */
  unsettledPriceExecutions: number;
  /** Events written before this meter learned to price a call by app: counted as one tool run each at their app's rate. */
  legacyEvents: number;
  /** What the meter wrote for the month, event by event, at list price. */
  recordedMicros: number;
  /** List price of the calls past the free ones, plus add-ons: what the plan's credit is taken off. */
  usageMicros: number;
  /** The plan's credit used, and what is billed on top of it. The credit does not roll over. */
  creditUsedMicros: number;
  extraMicros: number;
  planFeeMicros: number;
  /** What Composio bills us for the month: the fee, and the usage past the credit. The figure a margin is read from. */
  billedMicros: number;
  /** On Hobby, tool runs past the free ones are refused by Composio, not billed. */
  stoppedExecutions: number;
  ratesReadOn: string;
  ratesSource: string;
  /** Per tier: tool runs, paid ones and list price of those. */
  tiers: { tier: RateTier; executions: number; paidExecutions: number; micros: number }[];
}

export interface ScannedEvent {
  occurredAt: Date;
  costMicros: number | null;
  tool: string;
  toolkit: string;
  executions: number;
  sandboxRuns: number;
  zdrCalls: number;
  tier: RateTier;
  tierVerified: boolean;
  inner: Record<string, number>;
  legacy: boolean;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);

/** One meter event as a priced call. An event written before the meter priced by app is one tool run at its app's rate. */
function readEvent(row: { occurredAt: Date; costMicros: bigint | null; detail: unknown }): ScannedEvent {
  const detail = isRecord(row.detail) ? row.detail : {};
  const toolkit = typeof detail.toolkit === 'string' ? detail.toolkit : '';
  const tool = typeof detail.tool === 'string' ? detail.tool : '';
  const base = { occurredAt: row.occurredAt, costMicros: row.costMicros === null ? null : Number(row.costMicros), tool, toolkit };
  if (typeof detail.executions === 'number' && typeof detail.tier === 'string' && detail.tier in RATE_MICROS) {
    const inner: Record<string, number> = {};
    if (isRecord(detail.inner)) for (const [slug, count] of Object.entries(detail.inner)) inner[slug] = num(count);
    return { ...base, executions: num(detail.executions), sandboxRuns: num(detail.sandboxRuns), zdrCalls: num(detail.zdrCalls), tier: detail.tier as RateTier, tierVerified: detail.tierVerified !== false, inner, legacy: false };
  }
  const { tier, verified } = tierOf(toolkit, false);
  return { ...base, executions: 1, sandboxRuns: 0, zdrCalls: 0, tier, tierVerified: verified, inner: {}, legacy: true };
}

const BATCH = 5_000;

/** Every app step of a month, oldest first, read in batches so a big month never sits in memory at once. */
async function* scanAppSteps(from: Date, to: Date): AsyncGenerator<ScannedEvent> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.meterEvent.findMany({
      where: { kind: 'app_use', route: 'app', occurredAt: { gte: from, lt: to } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, occurredAt: true, costMicros: true, detail: true },
    });
    for (const row of rows) yield readEvent(row);
    if (rows.length < BATCH) return;
    cursor = rows[rows.length - 1].id;
  }
}

/**
 * The month's bill from the meter's events. Composio takes the free calls off in the order calls happen (100,000 tool runs in
 * all, of which 20,000 on its own sign-in apps), the rest are paid at their app's rate, add-ons are paid on every call they
 * cover, and the Pro plan's credit is taken off the usage. Pure given the events, so a test can hand it any month.
 */
export function billFrom(events: Iterable<ScannedEvent>, settings: ComposioBillingSettings, month: string): ComposioMonth {
  const pro = settings.plan === 'pro';
  let totalFree = FREE_TOOL_CALLS_PER_MONTH;
  let managedFree = FREE_MANAGED_CALLS_PER_MONTH;
  const tiers = new Map<RateTier, { executions: number; paidExecutions: number; micros: number }>();
  const out = {
    events: 0, executions: 0, freeExecutions: 0, paidExecutions: 0, managedExecutions: 0, ownExecutions: 0, sandboxRuns: 0, zdrCalls: 0, freeLookups: 0,
    unsettledPriceExecutions: 0, legacyEvents: 0, recordedMicros: 0, usageMicros: 0, stoppedExecutions: 0,
  };
  for (const event of events) {
    out.events += 1;
    if (event.legacy) out.legacyEvents += 1;
    out.recordedMicros += event.costMicros ?? 0;
    if (event.executions === 0 && event.sandboxRuns === 0) out.freeLookups += 1;
    const managed = event.tier !== 'own';
    const free = Math.min(event.executions, totalFree, managed ? managedFree : Number.POSITIVE_INFINITY);
    totalFree -= free;
    if (managed) managedFree -= free;
    const paid = event.executions - free;
    const entry = tiers.get(event.tier) ?? { executions: 0, paidExecutions: 0, micros: 0 };
    entry.executions += event.executions;
    entry.paidExecutions += paid;
    entry.micros += paid * RATE_MICROS[event.tier];
    tiers.set(event.tier, entry);
    out.executions += event.executions;
    out.freeExecutions += free;
    out.paidExecutions += paid;
    if (managed) out.managedExecutions += event.executions;
    else out.ownExecutions += event.executions;
    if (!event.tierVerified) out.unsettledPriceExecutions += event.executions;
    out.sandboxRuns += event.sandboxRuns;
    out.zdrCalls += event.zdrCalls;
    // The add-ons are paid on every run they cover, free calls or not; paid runs at their app's rate
    out.usageMicros += paid * RATE_MICROS[event.tier] + event.sandboxRuns * SANDBOX_RUN_MICROS + event.zdrCalls * ZDR_ADD_ON_MICROS;
    // Hobby: the free calls run out and Composio refuses the rest
    if (!pro) out.stoppedExecutions += paid;
  }
  const creditUsed = pro ? Math.min(out.usageMicros, PRO_PLAN_CREDIT_MICROS) : 0;
  const extra = pro ? out.usageMicros - creditUsed : 0;
  const planFee = pro ? PRO_PLAN_FEE_MICROS : 0;
  return {
    month,
    plan: settings.plan,
    zdrOn: settings.zdrOn,
    ...out,
    creditUsedMicros: creditUsed,
    extraMicros: extra,
    planFeeMicros: planFee,
    billedMicros: planFee + extra,
    ratesReadOn: COMPOSIO_RATES_READ_ON,
    ratesSource: COMPOSIO_RATES_SOURCE,
    tiers: [...tiers.entries()].map(([tier, value]) => ({ tier, ...value })),
  };
}

export async function composioMonth(month: { start: Date; end: Date; key: string }, settings?: ComposioBillingSettings): Promise<ComposioMonth> {
  const events: ScannedEvent[] = [];
  for await (const event of scanAppSteps(month.start, month.end)) events.push(event);
  return billFrom(events, settings ?? (await readComposioBilling()), month.key);
}

// ---------- The check against Composio's own numbers ----------

export interface UsageNumbers {
  toolCalls: number;
  groups: { key: string; count: number }[];
}

export interface Reconciliation {
  month: string;
  /** Composio's own count of tool calls for the project and month; null when it could not be asked (no key, or it answered with an error). */
  composio: UsageNumbers | null;
  /** Our count: one per app step written, and the same with the tools run inside batches. Composio's count may or may not include the inside ones, so a gap counts only when both fall outside the threshold. */
  oursTopLevel: number;
  oursWithInner: number;
  callGap: number | null;
  callsFlagged: boolean;
  /** The five tool names whose counts differ most, ours (top level and inside batches) against Composio's. */
  biggestDifferences: { tool: string; ours: number; composio: number }[];
  invoice: { micros: number; enteredAt: string } | null;
  invoiceGapMicros: number | null;
  invoiceFlagged: boolean;
  /** What a person should look at, in words. Empty when nothing is out of line. */
  flags: string[];
  thresholds: { callsRatio: number; callsMin: number; invoiceRatio: number; invoiceMinMicros: number };
}

export const callGapIsFlagged = (gap: number, composioCalls: number): boolean => gap > Math.max(GAP_CALLS_MIN, Math.ceil(composioCalls * GAP_CALLS_RATIO));
export const invoiceGapIsFlagged = (gapMicros: number, invoiceMicros: number): boolean => gapMicros > Math.max(GAP_INVOICE_MIN_MICROS, Math.ceil(invoiceMicros * GAP_INVOICE_RATIO));

/** Composio's usage for the month through the adapter; null when it is off or Composio does not answer (never thrown: a check that cannot run says so). */
async function composioUsage(adapter: ReadyMadeAdapter | null, month: { start: Date; end: Date }): Promise<UsageNumbers | null> {
  if (!adapter?.usage) return null;
  try {
    return await adapter.usage({ fromMs: month.start.getTime(), toMs: month.end.getTime() });
  } catch (error) {
    console.error('[Composio billing] Could not read Composio’s usage:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

/** The month's calls and bill against what Composio itself reports, and against the invoice when someone has entered it. */
export async function reconcileMonth(month: { start: Date; end: Date; key: string }, billed: ComposioMonth, adapter: ReadyMadeAdapter | null = getAdapter()): Promise<Reconciliation> {
  const [composio, invoices] = await Promise.all([composioUsage(adapter, month), readInvoices()]);
  const ours = new Map<string, number>();
  const withInner = new Map<string, number>();
  let top = 0;
  let inner = 0;
  for await (const event of scanAppSteps(month.start, month.end)) {
    const tool = event.tool || 'unknown';
    top += 1;
    ours.set(tool, (ours.get(tool) ?? 0) + 1);
    withInner.set(tool, (withInner.get(tool) ?? 0) + 1);
    for (const [slug, count] of Object.entries(event.inner)) {
      inner += count;
      withInner.set(slug, (withInner.get(slug) ?? 0) + count);
    }
  }
  const flags: string[] = [];
  let callGap: number | null = null;
  let callsFlagged = false;
  let biggest: Reconciliation['biggestDifferences'] = [];
  if (composio) {
    const gapTop = Math.abs(top - composio.toolCalls);
    const gapInner = Math.abs(top + inner - composio.toolCalls);
    callGap = Math.min(gapTop, gapInner);
    callsFlagged = callGapIsFlagged(gapTop, composio.toolCalls) && callGapIsFlagged(gapInner, composio.toolCalls);
    if (callsFlagged) flags.push(`Composio counts ${composio.toolCalls} tool calls for ${month.key}; our books have ${top} (${top + inner} with the tools run inside batches).`);
    const theirs = new Map(composio.groups.map((group) => [group.key, group.count]));
    const keys = new Set([...withInner.keys(), ...theirs.keys()]);
    biggest = [...keys]
      .map((tool) => ({ tool, ours: withInner.get(tool) ?? 0, composio: theirs.get(tool) ?? 0 }))
      .sort((a, b) => Math.abs(b.ours - b.composio) - Math.abs(a.ours - a.composio) || a.tool.localeCompare(b.tool))
      .slice(0, 5);
  } else {
    flags.push('Composio’s own usage could not be read, so the call count was not checked.');
  }
  const entered = invoices[month.key];
  const invoice = entered ? { micros: entered.micros, enteredAt: entered.enteredAt } : null;
  const invoiceGapMicros = invoice ? Math.abs(billed.billedMicros - invoice.micros) : null;
  const invoiceFlagged = invoice !== null && invoiceGapMicros !== null && invoiceGapIsFlagged(invoiceGapMicros, invoice.micros);
  if (invoice === null) flags.push(`No Composio invoice is entered for ${month.key}, so the bill was not checked against it.`);
  else if (invoiceFlagged) flags.push(`Composio's invoice for ${month.key} is ${(invoice.micros / 1e6).toFixed(2)} dollars; our books work out ${(billed.billedMicros / 1e6).toFixed(2)}. Check the rates in lib/composio-rates.ts.`);
  return {
    month: month.key,
    composio,
    oursTopLevel: top,
    oursWithInner: top + inner,
    callGap,
    callsFlagged,
    biggestDifferences: biggest,
    invoice,
    invoiceGapMicros,
    invoiceFlagged,
    flags,
    thresholds: { callsRatio: GAP_CALLS_RATIO, callsMin: GAP_CALLS_MIN, invoiceRatio: GAP_INVOICE_RATIO, invoiceMinMicros: GAP_INVOICE_MIN_MICROS },
  };
}

