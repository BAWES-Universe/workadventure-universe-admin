import { sweepComputers } from '@/lib/computer';
import { getInstantPause, resumeInstant } from '@/lib/instant/state';
import type { AccountView } from '@/lib/budget/types';

/**
 * After a top up: what the backend is asked to look at again, once Orbit has read the company's account and found money in it. The backend's own
 * sweeps and resume paths do the work (they check the current permissions, the payer, that the job was not cancelled and that an outside action was
 * not already done, and they resume each piece once); this only asks, and only when the account is not empty or unreadable.
 */
export interface LookedAgain {
  /** Whether the backend was asked to look again. */
  looked: boolean;
  /** What it said, in a line the page shows. */
  line: string;
  computersStarted?: number;
  instantResumed?: boolean;
}

export async function lookAgain(company: string, account: Pick<AccountView, 'state' | 'name'>, userId: string): Promise<LookedAgain> {
  if (account.state === 'zero') return { looked: false, line: `${account.name} still shows no money. Nothing was resumed; the waiting work stays saved.` };
  if (account.state === 'error' || account.state === 'unknown') {
    // A company that does not tell us its balance cannot be proven to have money, except by the work itself
    if (company !== 'composio') return { looked: false, line: `Orbit could not read ${account.name}, so it did not resume anything.` };
  }
  if (company === 'agent37') {
    const swept = await sweepComputers();
    return { looked: true, computersStarted: swept.started, line: swept.started > 0 ? `Orbit carried on with ${swept.started} waiting job${swept.started === 1 ? '' : 's'}, once each.` : 'Orbit looked again. No job was waiting for a place.' };
  }
  if (company === 'composio') {
    const pause = await getInstantPause();
    if (pause.paused && pause.reason === 'provider_empty') {
      // Composio does not show a balance, so this is the super admin saying they topped up. If it is still empty Instant pauses itself again on the first run
      await resumeInstant(userId);
      return { looked: true, instantResumed: true, line: 'Instant Apps are back on. If Composio is still empty, they pause again by themselves.' };
    }
    return { looked: true, instantResumed: false, line: 'Instant Apps were not paused for money, so there was nothing to resume.' };
  }
  return { looked: true, line: `${account.name} was read again.` };
}
