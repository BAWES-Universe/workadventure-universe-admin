import { NextRequest, NextResponse } from 'next/server';
import { resolveExpectedLoginOrigin } from '@/lib/auth';
import { getPlayOrigin, requestOrigin } from '@/lib/origin-policy';

/**
 * For `/api/me/*` routes the game calls too: Orbit's own origin and the game's exact origin may call, never `*`.
 */
function allowedOrigins(request: NextRequest): string[] {
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
  return origin !== null && allowedOrigins(request).includes(origin);
}

/** A JSON answer, never cached, with CORS headers only for an allowed origin. */
export function meRespond(request: NextRequest, body: unknown, status: number, methods: string) {
  const result = status === 204 ? new NextResponse(null, { status }) : NextResponse.json(body, { status });
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('Vary', 'Origin');
  const origin = requestOrigin(request);
  if (origin && allowedOrigins(request).includes(origin)) {
    result.headers.set('Access-Control-Allow-Origin', origin);
    result.headers.set('Access-Control-Allow-Methods', methods);
    result.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  return result;
}
