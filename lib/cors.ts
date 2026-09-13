import { isAllowedOrigin, requestOrigin, getPlayOrigin } from './origin-policy';

export { isAllowedOrigin, requestOrigin, getPlayOrigin } from './origin-policy';

/**
 * Shared CORS headers helper for API routes.
 *
 * Implements SHU-0024 origin policy:
 * - Only grants CORS to the configured play origin (from lib/origin-policy.ts)
 * - Emits 'Vary: Origin' on all responses (success, error, preflight)
 * - Never emits wildcard (*) origin
 * - Never emits Access-Control-Allow-Credentials
 */
export function corsHeaders(request?: Request | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };

  if (request) {
    const origin = requestOrigin(request);
    if (origin && isAllowedOrigin(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
    }
  }

  return headers;
}
