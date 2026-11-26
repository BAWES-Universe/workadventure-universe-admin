import { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { REPORT_AREAS, REPORT_EFFECTS, REPORT_KINDS, recordReportNote } from '@/lib/brick-reports';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

const short = z.string().trim().max(80);

const bodySchema = z
  .object({
    botId: z.string().trim().min(1).max(100),
    /** Who was in the chat (person:<id>, guest:<id>): kept only as a one-way hash, to count different people. */
    personKey: z.string().trim().regex(/^(person|guest):[A-Za-z0-9_.:-]{1,255}$/).optional(),
    kind: z.enum(REPORT_KINDS),
    area: z.enum(REPORT_AREAS),
    // Longer text is cut after cleaning; anything far longer is not a note
    title: z.string().max(400),
    tried: z.string().max(1200).optional(),
    stopped: z.string().max(1200).optional(),
    idea: z.string().max(1200).optional(),
    effect: z.enum(REPORT_EFFECTS),
    context: z
      .object({
        model: short.optional(),
        ownKey: z.boolean().optional(),
        gameVersion: z.string().trim().max(40).optional(),
        tools: z.array(short).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * POST /api/bricks/reports - a Brick's note to the Universe team (mock "Brick reports inbox"): it can't do something, got something
 * wrong, or has an idea. Orbit cleans it (no emails, phone numbers, links, @names or long numbers), counts it into a problem, and answers
 * `{ sent: true, id, takeBackKey, note }` with the note as kept, for the chat's "What was sent"; or `{ sent: false, reason }` (empty,
 * limit, unknown_brick). Never fails a chat on a refusal. Auth: BOT_SERVICE_TOKEN.
 */
export async function POST(request: NextRequest) {
  return serviceRoute(request, 'keeping a Brick report', async () => {
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    const { botId, personKey, kind, area, title, tried, stopped, idea, effect, context } = body.data;
    const outcome = await recordReportNote({ botId, personKey: personKey ?? null, kind, area, title, tried, stopped, idea, effect, context: context ?? null });
    return json(request, outcome);
  });
}
