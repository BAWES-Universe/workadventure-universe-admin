import { NextRequest, NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { getSessionUser, type SessionUser } from '@/lib/auth-session';
import { mePreflight, meOriginAllowed, meRespond } from '@/lib/me-api';
import { isQuestEngineError, type QuestEngineErrorCode } from './errors';

/** The `/api/me/quests/*` routes share one shape: origin check, session, a validated body, and the engine's errors as statuses. */

const STATUS_BY_CODE: Record<QuestEngineErrorCode, number> = {
  'not-found': 404,
  'not-published': 409,
  paused: 409,
  'out-of-scope': 403,
  'version-immutable': 409,
  'invalid-spec': 400,
  'invalid-observation': 400,
  'stale-revision': 409,
  'not-accepted': 409,
  'too-many-quests': 429,
};

export function questErrorResponse(request: NextRequest, error: unknown, methods: string, label: string): NextResponse {
  if (isQuestEngineError(error)) {
    return meRespond(request, { error: error.message, code: error.code, ...(error.details ?? {}) }, STATUS_BY_CODE[error.code], methods);
  }
  console.error(`[Quests] ${label} failed:`, error);
  return meRespond(request, { error: 'Internal server error' }, 500, methods);
}

export interface MeQuestContext<Body> {
  request: NextRequest;
  user: SessionUser;
  body: Body;
}

/**
 * Runs a handler for the session user. `schema` parses the JSON body (or, for a GET, the query as an object); a body
 * that does not fit answers 400 with the first problem.
 */
export async function withMeQuests<Body>(
  request: NextRequest,
  methods: string,
  label: string,
  schema: ZodType<Body> | null,
  handler: (context: MeQuestContext<Body>) => Promise<unknown | NextResponse>,
): Promise<NextResponse> {
  if (!meOriginAllowed(request)) return meRespond(request, { error: 'Origin not allowed' }, 403, methods);
  const user = await getSessionUser(request);
  if (!user) return meRespond(request, { error: 'Unauthorized' }, 401, methods);

  let body: Body = undefined as Body;
  if (schema) {
    let raw: unknown;
    if (request.method === 'GET' || request.method === 'DELETE') {
      raw = Object.fromEntries(request.nextUrl.searchParams.entries());
    } else {
      try {
        raw = await request.json();
      } catch {
        return meRespond(request, { error: 'Invalid JSON body' }, 400, methods);
      }
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return meRespond(request, { error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` }, 400, methods);
    }
    body = parsed.data;
  }
  try {
    const result = await handler({ request, user, body });
    return result instanceof NextResponse ? result : meRespond(request, result, 200, methods);
  } catch (error) {
    return questErrorResponse(request, error, methods, label);
  }
}

export function questPreflight(request: NextRequest, methods: string): NextResponse {
  return mePreflight(request, methods);
}
