import { NextRequest, NextResponse } from 'next/server';
import { resolveExpectedLoginOrigin } from '@/lib/auth';
import { getPlayOrigin, requestOrigin } from '@/lib/origin-policy';

/**
 * The origin policy of the session-authenticated `/api/me/*` routes, which the game calls from its own origin with
 * the person's Orbit session: Orbit's own origin and the game's exact origin; never `*`.
 */
export function allowedMeOrigins(request: NextRequest): string[] {
  const origins: string[] = [];
  const own = resolveExpectedLoginOrigin(process.env.NEXT_PUBLIC_API_URL || process.env.ADMIN_API_URL, '');
  if (own) origins.push(own);
  else if (process.env.NODE_ENV !== 'production') origins.push(request.nextUrl.origin);
  try {
    origins.push(getPlayOrigin());
  } catch {
    // Missing play origin in production: only Orbit itself may call.
  }
  return origins;
}

/** No Origin header (same-origin GET) is allowed; a present Origin must be on the list. */
export function meOriginAllowed(request: NextRequest): boolean {
  if (!request.headers.get('origin')) return true;
  const origin = requestOrigin(request);
  return origin !== null && allowedMeOrigins(request).includes(origin);
}

export function meRespond(request: NextRequest, body: unknown, status = 200, methods = 'GET, PUT, OPTIONS'): NextResponse {
  const result = status === 204 ? new NextResponse(null, { status }) : NextResponse.json(body, { status });
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('Vary', 'Origin');
  const origin = requestOrigin(request);
  if (origin && allowedMeOrigins(request).includes(origin)) {
    result.headers.set('Access-Control-Allow-Origin', origin);
    result.headers.set('Access-Control-Allow-Methods', methods);
    result.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  return result;
}

export function mePreflight(request: NextRequest, methods: string): NextResponse {
  return meRespond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403, methods);
}
