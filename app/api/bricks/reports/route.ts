import { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { OPERATION_PATTERN, REPORT_AREAS, REPORT_EFFECTS, REPORT_FAILURES, REPORT_KINDS, recordReportNote } from '@/lib/brick-reports';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const bodySchema = z
  .object({
    botId: z.string().trim().min(1).max(100),
    /** Who was in the chat (person:<id>, guest:<id>): kept only as a one-way hash, to count different people. */
    personKey: z.string().trim().regex(/^(person|guest):[A-Za-z0-9_.:-]{1,255}$/).optional(),
    /** The bot server's reference for this note (sha256 of the chat's message and what the note is about): sent again, same note. */
    ref: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(REPORT_KINDS),
    area: z.enum(REPORT_AREAS),
    /** What was running, filled by the bot server from what ran: one of the Brick's own tools, `app:<key>`, `app` or `none`. */
    operation: z.string().regex(OPERATION_PATTERN),
    /** For an App: the connection it ran on, only to name the catalog App it came from. Never kept. */
    appConnectionId: z.string().uuid().optional(),
    failure: z.enum(REPORT_FAILURES),
    retried: z.boolean(),
    /** Words the Brick drafted with the person, only when they asked: cleaned and answered back as `wordsPreview`, never kept. */
    draftWords: z.string().max(1200).optional(),
    effect: z.enum(REPORT_EFFECTS),
    /** What the bot server already knew, with no words in it: only these two, so no caller can put words here. */
    context: z
      .object({
        ownKey: z.boolean().optional(),
        gameVersion: z.string().trim().regex(/^[A-Za-z0-9._+-]{1,40}$/).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * POST /api/bricks/reports - a Brick's note to the Universe team (mock "Brick reports inbox"): a step failed, it can't do something, it got
 * corrected, or it has an idea. The note is product-only (kind, area, what ran, how it failed, tried again), filled by the bot server from
 * what ran, with no words from the chat. Orbit counts it into a problem and answers `{ sent: true, id, takeBackKey, note }` with the note
 * as kept, for the chat's "What was sent", plus `wordsPreview` (the person's draft words, cleaned, not kept until they press Send). The
 * same `ref` sent again answers the same receipt with `again: true` and keeps nothing new, so a lost answer can be asked again safely.
 * `{ sent: false, reason }` (limit, unknown_brick) on a refusal; never fails a chat. Auth: BOT_SERVICE_TOKEN.
 */
export async function POST(request: NextRequest) {
  return serviceRoute(request, 'keeping a Brick report', async () => {
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const { botId, personKey, ref, kind, area, operation, appConnectionId, failure, retried, draftWords, effect, context } = body.data;
    const outcome = await recordReportNote({ botId, personKey: personKey ?? null, ref, kind, area, operation, appConnectionId: appConnectionId ?? null, failure, retried, draftWords, effect, context: context ?? null });
    return json(request, outcome);
  });
}
