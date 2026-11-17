import { getComputerProvider, type Check } from '@/lib/computer-provider';
import { getMeterSettings } from '@/lib/meter';
import { missingSettings } from '@/lib/meter-values';
import { isWindingDown } from '@/lib/computer';
import { reconcileCheck } from '@/lib/computer-reconcile';
import { coldProvider, coldStatus } from '@/lib/computer-cold';

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
    if (cold) {
      const drill = cold.lastDrill ? `last restore drill ${cold.lastDrill.ok ? 'passed' : 'FAILED'} on ${cold.lastDrill.at.toISOString().slice(0, 10)}` : 'no restore drill has run yet';
      const slow = cold.slowestReturnMs === null ? 'no return measured yet' : `slowest measured return ${Math.round(cold.slowestReturnMs / 1000)} s over ${cold.returns} return${cold.returns === 1 ? '' : 's'}`;
      checks.push({ name: 'cold storage', ok: cold.lastDrill ? cold.lastDrill.ok : true, detail: `${cold.cold} computer${cold.cold === 1 ? '' : 's'} packed away, ${cold.packing} being packed, ${cold.failing} could not be packed yet; ${drill}; ${slow}` });
    }
  }
  const winding = await isWindingDown();
  checks.push({ name: 'wind-down', ok: !winding, detail: winding ? 'A wind-down is on: no computer takes new work' : 'No wind-down is on' });
  return { ready: checks.every((check) => check.ok), checks };
}
