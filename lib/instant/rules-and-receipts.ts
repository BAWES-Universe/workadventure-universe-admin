import { checkSpend } from '@/lib/spend-rules';
import { closeReceipt } from '@/lib/task-receipts';
import type { InstantHooks, RunInput } from '@/lib/instant/executor';
import type { InstantOutcome } from '@/lib/instant/values';

/**
 * Rules people say in chat and task receipts, attached to the Instant executor's seams (paying spec 3, part O4). The executor does not know
 * how either works.
 *
 *  - `beforeRun`: a cheap early look at the rules, so a run a rule forbids is refused in the rule's own words before a run is made. It
 *    asks about the provider's top price, which is never more than what would be held, so it can only let through what the credit door's
 *    own check (made under the person's lock, with the whole hold) then refuses. That one is the one that decides; this one saves a run row.
 *  - `afterRun`: a run whose answer did not come back puts the task's receipt (when one is open) in "checking", so Activity says so and
 *    offers no "Didn't work?" until it is known. Done and refused runs need nothing here: what a task used is read from the books by its
 *    key, and the bot server closes the receipt when the task ends.
 */
export const instantRulesAndReceipts: InstantHooks = {
  async beforeRun(input: RunInput, topMicros: number) {
    const ruled = await checkSpend({ payerPersonId: input.personId, botId: input.botId, taskKey: input.taskKey ?? null, chargeClass: 'apps', amountMicros: Math.max(1, topMicros) });
    return ruled.ok ? null : { refuse: true, words: ruled.words };
  },
  async afterRun(input: RunInput, outcome: InstantOutcome) {
    if (outcome.status !== 'checking' || !input.taskKey) return;
    await closeReceipt({ botId: input.botId, taskKey: input.taskKey, personId: input.personId, state: 'checking' });
  },
};
