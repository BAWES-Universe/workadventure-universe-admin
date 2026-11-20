import { prisma } from '@/lib/db';
import { getAdapter } from '@/lib/app-adapter';
import type { ReadyMadeAdapter } from '@/lib/app-adapter/types';
import { evaluatePause, reconcileRun, sweepGoodwill, type GoodwillSweep } from '@/lib/instant/executor';
import { getInstantFunds, type InstantFunds } from '@/lib/instant/funds';
import { denyInstantOnSessions, type SessionSweep } from '@/lib/instant/sessions';
import { pauseInstant } from '@/lib/instant/state';
import { repairInstantReporting, type ReportingRepair } from '@/lib/instant/report';
import { settleCheckingReceipts } from '@/lib/task-receipts';
import { sweepPageOrders, type OrderSweep } from '@/lib/app-direct/pay';
import { instantListedPrices, usdToMicros } from '@/lib/instant/values';

/**
 * The bot server asks for this now and then (like the computer sweep). It looks unfinished runs up by their own id and settles what
 * can be settled (pending reconciliation), reads existing sessions back so none allows Instant, checks the trusted prices against
 * Composio's own listing (a price that moved up stops Instant), and runs the failure-rate pause check. Safe to run twice at once.
 */

const BATCH = 50;
const DRIFT_EVERY_MS = 6 * 60 * 60 * 1000;
let lastDriftAt = 0;

export interface DriftReport {
  checkedAt: string;
  /** The live price words differ from the words the table was read against, and the live figure is higher: Instant was paused. */
  up: string[];
  /** The words differ, but the figure does not read higher (or cannot be read): for a person to look at. */
  changed: string[];
  /** Composio no longer lists the tool or no longer serves it as Instant: runs of it will be refused by Composio. */
  gone: string[];
  /** Composio could not be asked about these this time. */
  unreachable: string[];
}

/** The first dollar figure in Composio's price words, in micros (exact), or null. "$0.007 per search" is 7,000. */
function firstDollars(words: string): number | null {
  const match = /\$(\d+(?:\.\d+)?)/.exec(words);
  return match ? usdToMicros(match[1]) : null;
}

export async function checkPriceDrift(adapter: ReadyMadeAdapter | null = getAdapter(), pause: (reason: string) => Promise<unknown> = pauseInstant): Promise<DriftReport> {
  const report: DriftReport = { checkedAt: new Date().toISOString(), up: [], changed: [], gone: [], unreachable: [] };
  const instant = adapter?.instant;
  if (!instant) return report;
  for (const row of instantListedPrices()) {
    try {
      const live = await instant.tool(row.tool);
      if (!live || !live.instantSupported) {
        report.gone.push(row.tool);
        continue;
      }
      if (live.priceWords === row.listed) continue;
      // Words we cannot read a figure from count as higher: a price we cannot read is not a price we can hold a run to
      const figure = live.priceWords ? firstDollars(live.priceWords) : null;
      if (figure === null || figure > row.unitMicros) report.up.push(row.tool);
      else report.changed.push(row.tool);
    } catch (error) {
      report.unreachable.push(row.tool);
      console.error('[Instant] Could not read a tool price:', error instanceof Error ? error.message : 'unknown');
    }
  }
  if (report.up.length > 0) await pause('price_drift');
  return report;
}

export interface SweepResult {
  looked: number;
  /** Receipts that left "checking" in this pass. */
  receipts: number;
  /** Goodwill give-backs the books never confirmed: tried again, or let go after the wait. */
  goodwill: GoodwillSweep;
  paused: boolean;
  /** The usage events mended in this pass (missing ones written, wrong amounts corrected) and the gaps still there, with the age of the oldest; null when the pass could not run. */
  reporting: ReportingRepair | null;
  sessions: SessionSweep;
  drift: DriftReport | null;
  /** Page payments nobody is watching, asked about at the payment service (see `sweepPageOrders`). */
  pageOrders: OrderSweep | null;
}

export async function sweepInstant(deps: { funds?: InstantFunds; adapter?: ReadyMadeAdapter | null; now?: Date; forceDrift?: boolean } = {}): Promise<SweepResult> {
  const funds = deps.funds ?? getInstantFunds();
  const adapter = deps.adapter === undefined ? getAdapter() : deps.adapter;
  const now = deps.now ?? new Date();
  const open = await prisma.instantRun.findMany({
    where: {
      OR: [
        { state: { in: ['reserving', 'held', 'sent', 'ambiguous'] } },
        { providerState: 'pending' },
        { state: { in: ['succeeded', 'failed', 'refused'] }, customerState: 'held' },
      ],
    },
    // The oldest attempt first (never tried first): runs that cannot be settled yet never keep the later ones from being tried
    orderBy: [{ checkedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: BATCH,
    select: { id: true },
  });
  // Runs let go unconfirmed (released after Composio could not be asked, or after the wait with no log or no readable one) are looked for in Composio's log a little longer
  // (bounded days, a few a sweep): what turns up corrects the vendor cost and what the receipt says, and never what the person pays
  const lateRuns = await prisma.instantRun.findMany({
    where: { state: 'failed', providerBasis: 'estimated', finishedAt: { gte: new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000) }, OR: [{ detail: { path: ['releasedUnconfirmed'], equals: true } }, { detail: { path: ['noLog'], equals: true } }, { detail: { path: ['unreadableLog'], equals: true } }] },
    orderBy: [{ checkedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: 25,
    select: { id: true },
  });
  for (const row of [...open, ...lateRuns.filter((late) => !open.some((one) => one.id === late.id))]) {
    await reconcileRun(row.id, { funds, adapter, now }).catch((error) => console.error('[Instant] Could not look a run up:', error instanceof Error ? error.message : 'unknown'));
  }
  // A receipt still in checking whose runs have all ended is settled here too, so one the run's own pass could not move (a crash, a failed
  // write) never stays behind. Nothing here is asked of a person or a model.
  const receipts = await settleCheckingReceipts(BATCH, now).catch((error) => {
    console.error('[Instant] The receipt check failed:', error instanceof Error ? error.message : 'unknown');
    return 0;
  });
  const goodwill = await sweepGoodwill({ funds, adapter, now }).catch((error): GoodwillSweep => {
    console.error('[Instant] The give-back check failed:', error instanceof Error ? error.message : 'unknown');
    return { looked: 0, settled: 0, released: 0 };
  });
  // Usage events a settled run lacks (the write was refused) or has with other amounts than the run: mended from the run's own rows, a bounded batch a pass.
  // Nothing here asks an App, the credit books or a wallet for anything
  const reporting = await repairInstantReporting({ now }).catch((error): ReportingRepair | null => {
    console.error('[Instant] The usage event repair failed:', error instanceof Error ? error.message : 'unknown');
    return null;
  });
  const paused = await evaluatePause(now).catch(() => false);
  const sessions = await denyInstantOnSessions(BATCH, adapter).catch((error): SessionSweep => {
    console.error('[Instant] The session check failed:', error instanceof Error ? error.message : 'unknown');
    return { checked: 0, alreadyDenied: 0, denied: 0, gone: 0, failed: 0, remaining: 0 };
  });
  let drift: DriftReport | null = null;
  if (deps.forceDrift || Date.now() - lastDriftAt >= DRIFT_EVERY_MS) {
    drift = await checkPriceDrift(adapter).catch((error) => {
      console.error('[Instant] The price check failed:', error instanceof Error ? error.message : 'unknown');
      return null;
    });
    // The clock starts only when the check finished and Composio answered for every tool (and any pause it needed was made): a failed or partial check is tried again by the next sweep
    if (drift && drift.unreachable.length === 0) lastDriftAt = Date.now();
  }
  // Orders of paid pages that nobody is watching any more are asked about here too, so the same call that settles what is owed settles what
  // was paid. A failure of this never stops the rest of the sweep.
  const pageOrders = await sweepPageOrders(now).catch((error): OrderSweep | null => {
    console.error('[Instant] The page order check failed:', error instanceof Error ? error.message : 'unknown');
    return null;
  });
  return { looked: open.length, receipts, goodwill, paused, reporting, sessions, drift, pageOrders };
}

/** For tests. */
export function forgetDriftClock(): void {
  lastDriftAt = 0;
}
