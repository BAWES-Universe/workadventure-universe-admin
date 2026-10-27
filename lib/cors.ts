import { resolveExpectedLoginOrigin } from '@/lib/auth';
import { getPlayOrigin, requestOrigin } from '@/lib/origin-policy';

/**
 * The one CORS rule for API routes a browser calls from another origin (#171): an origin on the list gets its own
 * origin back, any other gets no grant, and every answer says `Vary: Origin`. Never `*`, and never
 * `Access-Control-Allow-Credentials`: these routes read the `Authorization` header, which a browser never adds by
 * itself, so a grant cannot ride on a cookie.
 */

const DEFAULT_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

/**
 * Who may call: Orbit's own origin, the game's origin (the same one the session exchange uses), and any extra origin
 * in CORS_ALLOWED_ORIGINS.
 */
export function allowedOrigins(request: Request & { nextUrl?: { origin: string } }): string[] {
  const origins: string[] = [];
  const own = resolveExpectedLoginOrigin(process.env.NEXT_PUBLIC_API_URL || process.env.ADMIN_API_URL, '');
  if (own) origins.push(own);
  else if (process.env.NODE_ENV !== 'production' && request.nextUrl) origins.push(request.nextUrl.origin);
  try {
    origins.push(getPlayOrigin());
  } catch {
    // Missing play origin in production: the game is not on the list.
  }
  for (const entry of (process.env.CORS_ALLOWED_ORIGINS || '').split(',')) {
    const origin = entry.trim();
    if (origin) origins.push(origin);
  }
  return origins;
}

/** CORS headers for this request: its origin echoed only when it is on the list. */
export function corsHeaders(
  request: Request & { nextUrl?: { origin: string } },
  methods: string = DEFAULT_METHODS
): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
  const origin = requestOrigin(request);
  if (origin && allowedOrigins(request).includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}
