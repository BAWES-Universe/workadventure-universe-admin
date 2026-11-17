import { prisma } from '@/lib/db';
import { getAdapter } from '@/lib/app-adapter';
import type { ReadyMadeAdapter } from '@/lib/app-adapter/types';
import { evaluatePause, reconcileRun } from '@/lib/instant/executor';
import { getInstantFunds, type InstantFunds } from '@/lib/instant/funds';
import { denyInstantOnSessions, type SessionSweep } from '@/lib/instant/sessions';
import { pauseInstant } from '@/lib/instant/state';
import { freezeTool, getFrozenTools, unfreezeTools, type FreezeReason } from '@/lib/instant/freeze';
import { settleCheckingReceipts } from '@/lib/task-receipts';
import { instantListedPrices, usdToMicros } from '@/lib/instant/values';
import { reconcileSpeech, type ReconcileReport } from '@/lib/speech-status';

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
  /** Tools frozen by this check (S4): their price changed in a way nobody could read as "the same unit, no higher". Each takes no new runs, the others carry on. */
  frozen: string[];
  /** Tools that were frozen by an earlier check and whose live words match the table again: they carry on. */
  unfrozen: string[];
}

/** The first dollar figure in Composio's price words, in micros (exact), or null. "$0.007 per search" is 7,000. */
function firstDollars(words: string): number | null {
  const match = /\$(\d+(?:\.\d+)?)/.exec(words);
  return match ? usdToMicros(match[1]) : null;
}

/** The words of a price without its first dollar figure, so "per search" is compared with "per search" and not with "per 1,000 searches" or "from". */
const unitWords = (words: string): string => words.replace(/\$\d+(?:\.\d+)?/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * How a changed price reads (S4). `same`: the words are the same. `lower`: same unit and tier words, and a figure no higher: clear, nothing
 * to freeze. Anything else is unclear and freezes the tool: a higher figure, a figure that cannot be read, or unit or tier words that
 * differ (even when the figure looks lower: "$0.002 per 1,000" is not cheaper than "$0.007 per search").
 */
export function readPriceChange(listed: string, unitMicros: number, live: string | null): { kind: 'same' | 'lower' } | { kind: 'freeze'; reason: FreezeReason } {
  if (live === listed) return { kind: 'same' };
  const figure = live ? firstDollars(live) : null;
  if (live === null || figure === null) return { kind: 'freeze', reason: 'unreadable' };
  if (unitWords(live) !== unitWords(listed)) return { kind: 'freeze', reason: 'unit_or_tier' };
  return figure > unitMicros ? { kind: 'freeze', reason: 'higher' } : { kind: 'lower' };
}

export async function checkPriceDrift(adapter: ReadyMadeAdapter | null = getAdapter(), pause: (reason: string) => Promise<unknown> = pauseInstant): Promise<DriftReport> {
  const report: DriftReport = { checkedAt: new Date().toISOString(), up: [], changed: [], gone: [], unreachable: [], frozen: [], unfrozen: [] };
  const instant = adapter?.instant;
  if (!instant) return report;
  const frozenBefore = await getFrozenTools();
  const clear: string[] = [];
  for (const row of instantListedPrices()) {
    try {
      const live = await instant.tool(row.tool);
      if (!live || !live.instantSupported) {
        report.gone.push(row.tool);
        // No longer served as Instant: new runs of it would be refused by Composio, so it is held here, and carries on if it comes back
        await freezeTool(row.tool, { reason: 'gone', listed: row.listed, live: live?.priceWords ?? null });
        report.frozen.push(row.tool);
        continue;
      }
      const change = readPriceChange(row.listed, row.unitMicros, live.priceWords ?? null);
      if (change.kind !== 'freeze') {
        // Words that read as before (or a clearly lower price of the same unit) clear an earlier freeze of the tool
        if (change.kind === 'lower') report.changed.push(row.tool);
        if (frozenBefore && Object.prototype.hasOwnProperty.call(frozenBefore, row.tool)) clear.push(row.tool);
        continue;
      }
      // A price we cannot read, or a unit or tier we cannot compare, is not a price we can hold a run to: this tool is frozen
      await freezeTool(row.tool, { reason: change.reason, listed: row.listed, live: live.priceWords ?? null });
      report.frozen.push(row.tool);
      // A figure that is higher, or cannot be read, also stops all of Instant, as before; a changed unit or tier stops only that tool
      if (change.reason === 'higher' || change.reason === 'unreadable') report.up.push(row.tool);
      else report.changed.push(row.tool);
    } catch (error) {
      report.unreachable.push(row.tool);
      console.error('[Instant] Could not read a tool price:', error instanceof Error ? error.message : 'unknown');
    }
  }
  if (clear.length > 0) {
    await unfreezeTools(clear);
    report.unfrozen.push(...clear);
  }
  if (report.up.length > 0) await pause('price_drift');
  return report;
}

export interface SweepResult {
  looked: number;
  /** Receipts that left "checking" in this pass. */
  receipts: number;
  paused: boolean;
  sessions: SessionSweep;
  drift: DriftReport | null;
  /** The speech reconcile pass that runs with this sweep (docs/speech-admission-contract.md, section 6); null when it could not run. */
  speech: ReconcileReport | null;
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
  for (const row of open) {
    await reconcileRun(row.id, { funds, adapter, now }).catch((error) => console.error('[Instant] Could not look a run up:', error instanceof Error ? error.message : 'unknown'));
  }
  // A receipt still in checking whose runs have all ended is settled here too, so one the run's own pass could not move (a crash, a failed
  // write) never stays behind. Nothing here is asked of a person or a model.
  const receipts = await settleCheckingReceipts(BATCH, now).catch((error) => {
    console.error('[Instant] The receipt check failed:', error instanceof Error ? error.message : 'unknown');
    return 0;
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
  // Speech holds are reconciled by the same call the bot server already makes now and then: nothing new for it to schedule
  const speech = await reconcileSpeech(now).catch((error) => {
    console.error('[Speech] The reconcile pass failed:', error instanceof Error ? error.message : 'unknown');
    return null;
  });
  return { looked: open.length, receipts, paused, sessions, drift, speech };
}

/** For tests. */
export function forgetDriftClock(): void {
  lastDriftAt = 0;
}
