/**
 * Shared CORS headers helper for API routes
 */
export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

/**
 * CORS headers for routes people call from the game with their login: the origin is echoed with credentials only when
 * it is in CORS_ALLOWED_ORIGINS, and any other origin gets no access (fail-closed).
 */
export function trustedCorsHeaders(request?: { headers: { get(name: string): string | null } }): Record<string, string> {
  const base = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  const origin = request?.headers.get('origin');
  if (!origin) return base;
  const trusted = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  if (!trusted.includes(origin)) return { ...base, Vary: 'Origin' };
  return { ...base, 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' };
}
