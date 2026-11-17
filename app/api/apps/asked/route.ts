import { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { recordAppAsk } from '@/lib/app-demand';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z
  .object({
    /** The App name a Brick looked for and did not find. Only this is kept, and only when it is short and reads like a name. */
    name: z.string().max(200),
    /** Who asked, in the words reply windows use: person:<id> or guest:<id>. Kept only as a one-way hash, to count different people. */
    requesterKey: z.string().trim().regex(/^(person|guest):[A-Za-z0-9_-]{1,255}$/),
  })
  .strict();

/**
 * POST /api/apps/asked { name, requesterKey } - the bot server tells us a Brick looked for an App and found none (spec section
 * 22, "Asked for, not available yet"). Counts the App's NAME, never what the person wrote: a name that is long, a link, an email or
 * a sentence is not counted. Answers `{ counted }` and never fails a chat. Auth: BOT_SERVICE_TOKEN.
 */
export async function POST(request: NextRequest) {
  return serviceRoute(request, 'counting an App that was asked for', async () => {
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const outcome = await recordAppAsk({ name: body.data.name, personKey: body.data.requesterKey });
    return json(request, outcome.counted ? { counted: true } : { counted: false, reason: outcome.reason });
  });
}
