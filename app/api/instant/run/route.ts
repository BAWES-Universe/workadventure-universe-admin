import { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { ownerAsker } from '@/lib/instant/asker';
import { runInstant, setInstantHooks } from '@/lib/instant/executor';
import { instantRulesAndReceipts } from '@/lib/instant/rules-and-receipts';
import { REASON_WORDS } from '@/lib/instant/values';

export const runtime = 'nodejs';

// Rules the person said in chat and task receipts attach to the executor here, where Instant runs are asked for
setInstantHooks(instantRulesAndReceipts);

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z
  .object({
    botId: z.string().min(1),
    requesterKey: z.string().trim().min(1).max(400).optional(),
    forOwner: z.boolean().optional(),
    tool: z.string().trim().min(1).max(200),
    arguments: z.record(z.string(), z.unknown()).default({}),
    /** The bot server's own id for this call (its attempt id): a retry is the same call and never runs or pays twice. */
    callId: z.string().trim().min(1).max(200),
    /** The task this call is part of (the key its receipt is opened under): rules about one task count all of its runs. While "Most research runs for one question" is set, a call without one is refused (`question_limit`): it could not be counted. */
    taskKey: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

/**
 * POST /api/instant/run - one Instant run for a Brick's owner, through the bounded executor. Every way it can end is a 200 with a
 * fixed `status` (done, failed, checking, refused, already_done) and, for the ones that did not run or did not work, a fixed `reason`
 * and plain `message`: never a provider message. 404 when the asker is not the Brick's owner. Asking again with the same callId gives
 * the same run back, looked up first if it was unclear. Auth: BOT_SERVICE_TOKEN.
 */
export async function POST(request: NextRequest) {
  return serviceRoute(request, 'running an Instant tool', async () => {
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const { botId, requesterKey, forOwner, tool, callId, taskKey } = body.data;
    const personId = await ownerAsker(botId, { requesterKey, forOwner });
    if (!personId) return json(request, { error: 'Not found' }, 404);
    const outcome = await runInstant({ botId, personId, tool, arguments: body.data.arguments, callId, taskKey });
    // A rule the person said in chat is final: `stop: true` means never retry it and never offer more credit for it; `message` is the rule's own words
    if (outcome.status === 'refused') {
      return json(request, { status: 'refused', reason: outcome.reason, message: outcome.words ?? REASON_WORDS[outcome.reason], runId: outcome.runId ?? null, ...(outcome.reason === 'rule' ? { stop: true } : {}) });
    }
    return json(request, outcome, outcome.status === 'checking' ? 202 : 200);
  });
}
