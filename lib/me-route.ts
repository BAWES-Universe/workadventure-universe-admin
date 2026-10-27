import { NextRequest, NextResponse } from 'next/server';
import { allowedOrigins } from '@/lib/cors';
import { requestOrigin } from '@/lib/origin-policy';

// `/api/me/*` routes the game calls too use the same list as every other cross-origin route (lib/cors.ts).

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
