import { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, preflight, readBody, serviceRoute } from '@/lib/bot-action-api';
import { HEADINGS } from '@/lib/mcp-tool-policy';
import { saveSorterPicks, unsortedActions } from '@/lib/app-actions/catalog';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return preflight(request);
}

/** A batch the bot server's small model reads at once, as it does for a bot's own tools. */
const BATCH = 60;

/**
 * GET /api/app-actions/unsorted?limit=60 - App actions that neither their name nor the App's own tags could sort, for the bot server's
 * small model (the same sorter and prompt as a bot's own tools). Answers { actions: [{ toolkit, slug, title, description }] }, oldest
 * first; empty when there are none. Until one is sorted it is under Deletes or sends out.
 * Auth: BOT_SERVICE_TOKEN.
 */
export async function GET(request: NextRequest) {
  return serviceRoute(request, 'reading the App actions to sort', async () => {
    const asked = Number(request.nextUrl.searchParams.get('limit'));
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, BATCH) : BATCH;
    return json(request, { actions: await unsortedActions(limit) });
  });
}

const bodySchema = z
  .object({
    actions: z
      .array(
        z
          .object({
            toolkit: z.string().trim().min(1).max(60),
            slug: z.string().trim().min(1).max(255),
            heading: z.enum(HEADINGS),
          })
          .strict(),
      )
      .min(1)
      .max(BATCH),
  })
  .strict();

/**
 * PUT /api/app-actions/unsorted - the small model's headings. Body: { actions: [{ toolkit, slug, heading }] }. Only an action still waiting
 * changes; Makes new things is taken only for an action Universe knows stays private (else Changes things), and a name that sends or
 * deletes always stays under Deletes or sends out. Each Brick's grant follows at its next read. Answers { sorted: n }.
 * Auth: BOT_SERVICE_TOKEN.
 */
export async function PUT(request: NextRequest) {
  return serviceRoute(request, 'saving the App actions sorted', async () => {
    const body = await readBody(request, bodySchema);
    if (body.response) return body.response;
    return json(request, { sorted: await saveSorterPicks(body.data.actions) });
  });
}
