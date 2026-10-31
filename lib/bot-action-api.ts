import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import type { z } from 'zod';
import { BotActionError } from '@/lib/bot-actions';
import { corsHeaders } from '@/lib/cors';
import { requireServiceToken } from '@/lib/service-tokens';

export const json = (request: NextRequest, body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: corsHeaders(request) });

export const preflight = (request: NextRequest) => NextResponse.json({}, { headers: corsHeaders(request) });

/**
 * Every route for saved bot actions (#739) is for the bot server and the game only: they authenticate the person
 * (the signed-in account, or the guest's server session) and pass who it was. The same BOT_SERVICE_TOKEN as the access
 * check. A guessed or forwarded action id is not authority on its own.
 */
export async function serviceRoute(
  request: NextRequest,
  what: string,
  run: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    requireServiceToken(request);
    return await run();
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return json(request, { error: 'Unauthorized' }, 401);
    }
    if (error instanceof BotActionError) return json(request, { error: error.message, code: error.code }, error.status);
    Sentry.captureException(error, { tags: { area: 'bot-actions' } });
    console.error(`Error ${what}:`, error);
    return json(request, { error: `Failed ${what}` }, 500);
  }
}

/** The body, or the 400 to send. An empty body counts as {} when `optional`. */
export async function readBody<T extends z.ZodTypeAny>(
  request: NextRequest,
  schema: T,
  optional = false,
): Promise<{ data: z.infer<T>; response?: undefined } | { data?: undefined; response: NextResponse }> {
  const raw = await request.json().catch(() => (optional ? {} : null));
  const parsed = schema.safeParse(raw ?? (optional ? {} : null));
  if (!parsed.success) return { response: json(request, { error: 'Invalid request data', details: parsed.error.issues }, 400) };
  return { data: parsed.data };
}
