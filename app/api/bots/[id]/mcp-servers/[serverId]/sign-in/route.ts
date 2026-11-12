import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';
import { corsHeaders } from '@/lib/cors';
import { reportToolSignIn } from '@/lib/tool-signin';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

const json = (request: NextRequest, body: unknown, status = 200) => NextResponse.json(body, { status, headers: corsHeaders(request) });

const reportSchema = z.object({
  state: z.enum(['expired', 'no-answer', 'ok']),
  at: z.string().datetime({ offset: true }).optional(),
  status: z.union([z.literal(401), z.literal(403)]).nullish(),
});

/**
 * PUT /api/bots/:id/mcp-servers/:serverId/sign-in
 * The bot server tells Orbit what it saw when a bot really used this tool server (game #1819). Body:
 * { state: "expired" | "no-answer" | "ok", at?: ISO time it saw it, status?: 401 | 403 (expired only) }.
 * "expired" is a refused sign-in: Orbit keeps the first time as "since" and tells the person who connected it, once. "no-answer"
 * is a timeout or server error, shown as "Didn't answer" with no notice. "ok" clears both. A repeat changes nothing.
 * Answers { changed } (true only when what is stored moved), 404 when the bot has no such server, 400 for a bad body.
 *
 * Auth: the bot server's ADMIN_API_TOKEN only. No person can report this.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; serverId: string }> }) {
  try {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
    const expected = process.env.ADMIN_API_TOKEN;
    if (!token || !expected || token !== expected) return json(request, { error: 'Unauthorized' }, 401);

    const { id, serverId } = await params;
    const parsed = reportSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400);

    const outcome = await reportToolSignIn(id, serverId, {
      state: parsed.data.state,
      at: parsed.data.at ? new Date(parsed.data.at) : undefined,
      status: parsed.data.status ?? null,
    });
    if (!outcome) return json(request, { error: 'App not found' }, 404);
    return json(request, outcome);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'tool-signin' } });
    console.error('Error saving a tool sign-in report:', error);
    return json(request, { error: 'Failed saving the report' }, 500);
  }
}
