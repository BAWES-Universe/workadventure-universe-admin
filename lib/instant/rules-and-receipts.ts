import { prisma } from '@/lib/db';
import { checkSpend } from '@/lib/spend-rules';
import { settleReceipt, touchLeaseForRun } from '@/lib/task-receipts';
import type { InstantHooks, RunInput } from '@/lib/instant/executor';
import type { InstantOutcome } from '@/lib/instant/values';

/**
 * Rules people say in chat and task receipts, attached to the Instant executor's seams (paying spec 3, part O4). The executor does not know
 * how either works.
 *
 *  - `beforeRun`: a cheap early look at the rules, so a run a rule forbids is refused in the rule's own words before a run is made. It
 *    asks about the provider's top price, which is never more than what would be held, so it can only let through what the credit door's
 *    own check (made under the person's lock, with the whole hold) then refuses. That one is the one that decides; this one saves a run row.
 *  - `beforeRun`: also a sign of life: a run is about to go out, so the task's receipt lease (when it is running) is extended, whether or not
 *    the bot server renews it.
 *  - `afterRun`: the task's receipt (when one is open) is looked at again from its runs: a run whose answer did not come back puts it in
 *    "checking", so Activity says so, and a run that landed under a receipt that had ended puts that right. What a task used is read from the
 *    books by its key.
 *  - `afterSettle`: a run was looked up (by a retry or by the sweep). When it ended, and no other run of its task is still open, the
 *    receipt leaves "checking" by itself: done when a run worked, refunded when none did. No person and no model is ever asked.
 */
export const instantRulesAndReceipts: InstantHooks = {
  async beforeRun(input: RunInput, topMicros: number) {
    if (input.taskKey) await touchLeaseForRun({ botId: input.botId, personId: input.personId, taskKey: input.taskKey }).catch((error) => console.error('[Instant] A receipt lease was not renewed:', error instanceof Error ? error.message : 'unknown'));
    const ruled = await checkSpend({ payerPersonId: input.personId, botId: input.botId, taskKey: input.taskKey ?? null, chargeClass: 'apps', amountMicros: Math.max(1, topMicros) });
    return ruled.ok ? null : { refuse: true, words: ruled.words };
  },
  async afterRun(_input: RunInput, outcome: InstantOutcome) {
    // A refusal before any run was made leaves nothing to look at
    if (!outcome.runId) return;
    // The task is the one saved on the run, never the one a retry of the same call says: a retry with another task must not move that task's receipt
    const run = await prisma.instantRun.findUnique({ where: { id: outcome.runId }, select: { botId: true, personId: true, taskKey: true } });
    if (!run?.taskKey) return;
    await settleReceipt({ botId: run.botId, personId: run.personId, taskKey: run.taskKey });
  },
  async afterSettle(runId: string) {
    const run = await prisma.instantRun.findUnique({ where: { id: runId }, select: { botId: true, personId: true, taskKey: true } });
    if (!run?.taskKey) return;
    await settleReceipt({ botId: run.botId, personId: run.personId, taskKey: run.taskKey });
  },
};
