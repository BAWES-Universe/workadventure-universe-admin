import { getComputerProvider, type Check } from '@/lib/computer-provider';
import { getMeterSettings } from '@/lib/meter';
import { missingSettings } from '@/lib/meter-values';
import { isWindingDown } from '@/lib/computer';
import { reconcileCheck } from '@/lib/computer-reconcile';
import { computersArePaused } from '@/lib/capability-pause';

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
  const winding = await isWindingDown();
  checks.push({ name: 'wind-down', ok: !winding, detail: winding ? 'A wind-down is on: no computer takes new work' : 'No wind-down is on' });
  const paused = await computersArePaused();
  checks.push({ name: 'pause', ok: !paused, detail: paused ? 'Computers are paused: no new job starts until the team resumes them' : 'Computers are not paused' });
  return { ready: checks.every((check) => check.ok), checks };
}
