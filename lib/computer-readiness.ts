import { getComputerProvider, type Check } from '@/lib/computer-provider';
import { getMeterSettings } from '@/lib/meter';
import { missingSettings } from '@/lib/meter-values';
import { isWindingDown } from '@/lib/computer';
import { reconcileCheck } from '@/lib/computer-reconcile';
import { coldProvider, coldStatus } from '@/lib/computer-cold';
import { STORAGE_DELETION_ALERT_MS, storageDeletionsWaiting } from '@/lib/computer-archives';
import { computersArePaused } from '@/lib/capability-pause';
import { giveBackReadiness } from '@/lib/computer-fault-ops';

export interface Readiness {
  /** Every check passed: a person's job can run now. */
  ready: boolean;
  checks: Check[];
}

/**
 * Whether a computer job could run on this server now, in plain words, for the team before a qualification and at any time after. Reads
 * only: nothing is made, woken or paid for. What cannot be seen from here (the bot server answering at its public address) is proven
 * by a command run from a real computer, not guessed.
 */
export async function computerReadiness(): Promise<Readiness> {
  const checks: Check[] = [];
  const provider = getComputerProvider();
  if (!provider) {
    checks.push({ name: 'provider', ok: false, detail: 'No computer provider is set up on this server (the Agent37 key is missing)' });
  } else {
    checks.push({ name: 'provider', ok: true, detail: provider.kind === 'real' ? 'Real computers (Agent37)' : 'The pretend provider (development only)' });
    checks.push(...(await provider.checkup().catch(() => [{ name: 'provider check', ok: false, detail: 'The provider could not be checked' }])));
  }
  const missing = missingSettings(await getMeterSettings());
  checks.push({ name: 'usage controls', ok: missing.length === 0, detail: missing.length === 0 ? 'The usage controls are set' : `These usage controls are not set yet: ${missing.join(', ')}` });
  // The daily check of our books against the provider's bill: a mismatch is said here, so it is seen without looking in a log
  const books = await reconcileCheck().catch(() => ({ name: 'books and bill', ok: false, detail: 'The check of the books against the provider’s bill could not be read' }));
  if (books) checks.push(books);
  // Cold storage: how many computers are packed away, the last restore drill, and the slowest measured return (never promised). Only a failed drill is "not ready":
  // a copy that cannot be restored must be seen before anyone needs it. Computers that could not be packed away yet are said here too.
  if (coldProvider(provider)) {
    const cold = await coldStatus().catch(() => null);
    // A status that cannot be read is said, not left out: a missing line would let the page call itself ready without the cold storage check
    if (!cold) checks.push({ name: 'cold storage', ok: false, detail: 'The cold storage status could not be read' });
    else {
      const drill = cold.lastDrill ? `last restore drill ${cold.lastDrill.ok ? 'passed' : 'FAILED'} on ${cold.lastDrill.at.toISOString().slice(0, 10)}` : 'no restore drill has run yet';
      const slow = cold.slowestReturnMs === null ? 'no return measured yet' : `slowest measured return ${Math.round(cold.slowestReturnMs / 1000)} s over ${cold.returns} return${cold.returns === 1 ? '' : 's'}`;
      // The size is what the bucket really holds (not an estimate from one example); the awake seconds are measurements of the last 30 days
      const money = cold.storageMonthMicros === null ? 'storage price not set in the usage controls' : `about $${(cold.storageMonthMicros / 1_000_000).toFixed(2)} a month at the storage price`;
      const awake = cold.last30Days;
      const sized = `${Math.round(cold.storedBytes / 1_000_000)} MB of copies kept (${money}); last 30 days awake for cold storage: ${awake.packSeconds + awake.returnSeconds} s on Bricks’ computers, ${awake.scratchSeconds} s on throwaway ones, over ${awake.runs} run${awake.runs === 1 ? '' : 's'}`;
      checks.push({ name: 'cold storage', ok: cold.lastDrill ? cold.lastDrill.ok : true, detail: `${cold.cold} computer${cold.cold === 1 ? '' : 's'} packed away, ${cold.packing} being packed, ${cold.failing} could not be packed yet; ${drill}; ${slow}; ${sized}` });
    }
  }
  // The settings the bound on give-backs reads must exist: missing numbers hold unresolved give-backs, they never mean "no bound"
  const giveBack = await giveBackReadiness().catch(() => ({ ok: false, detail: 'The give-back settings could not be checked' }));
  checks.push({ name: 'give-backs', ...giveBack });
  // Deleted copies of a Brick's files that are still in the bucket: how many wait and for how long the oldest has. A day is far longer than a slow bucket takes,
  // so a deletion older than that means the bucket has stopped accepting deletes (and a deleted Brick's files are still stored): not ready until it is looked at.
  if (coldProvider(provider)) {
    const waiting = await storageDeletionsWaiting().catch(() => null);
    if (!waiting) checks.push({ name: 'storage deletions', ok: false, detail: 'The deletions waiting in storage could not be read' });
    else if (waiting.ageMs === null) checks.push({ name: 'storage deletions', ok: true, detail: 'No deletion is waiting in storage' });
    else {
      const hours = Math.floor(waiting.ageMs / 3_600_000);
      const age = hours >= 48 ? `${Math.floor(hours / 24)} days` : hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${Math.max(1, Math.round(waiting.ageMs / 60_000))} min`;
      const stalled = waiting.ageMs > STORAGE_DELETION_ALERT_MS;
      checks.push({
        name: 'storage deletions',
        ok: !stalled,
        detail: `${waiting.count} copy deletion${waiting.count === 1 ? '' : 's'} waiting${waiting.strayCopiesSince ? ' and the sweep for stray copies could not delete' : ''}; the oldest for ${age}${stalled ? ': the bucket may have stopped accepting deletes' : ''}`,
      });
    }
  }
  const winding = await isWindingDown();
  checks.push({ name: 'wind-down', ok: !winding, detail: winding ? 'A wind-down is on: no computer takes new work' : 'No wind-down is on' });
  const paused = await computersArePaused();
  checks.push({ name: 'pause', ok: !paused, detail: paused ? 'Computers are paused: no new job starts until the team resumes them' : 'Computers are not paused' });
  return { ready: checks.every((check) => check.ok), checks };
}
