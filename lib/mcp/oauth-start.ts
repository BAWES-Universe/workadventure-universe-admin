import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { resolveRequestedScopes } from '@/lib/mcp/oauth-token';
import { encryptApiKey } from '@/lib/encryption';
import { getOAuthCallbackUrl, getOAuthCallbackBase, validateOAuthCallbackUrl } from '@/lib/oauth-callback';

/**
 * Starts a sign-in on an app's own page: the address to send the person to, with a one-time state that carries what the
 * return needs. One place for a bot's own server (`/api/bots/:id/mcp-servers/:serverId/oauth/start`) and for a person's
 * connection (`/api/me/apps/:id/sign-in`), so the two cannot drift apart (RFC 8707 resource, PKCE, a state that expires).
 */
export interface OAuthStartInput {
  request: NextRequest;
  oauthConfig: { clientId?: string; scopes?: string; authorizeUrl?: string; scopesSupported?: string[] | null };
  /** The resource the authorization is addressed to (the app's link). */
  serverUrl: string | null;
  /** Where to send the person back to when no allowed `redirectUrl` came with the request. */
  fallbackPath: string;
  /** What the return needs to find the connection again: carried inside the encrypted state, never in a query. */
  state: Record<string, unknown>;
}

export type OAuthStartResult = { ok: true; authorizeUrl: string } | { ok: false; status: number; error: string };

export function startOAuth(input: OAuthStartInput): OAuthStartResult {
  const { request, oauthConfig, serverUrl, fallbackPath, state } = input;
  if (!oauthConfig.clientId) {
    return {
      ok: false,
      status: 400,
      error:
        'OAuth clientId not configured. Update authConfig with {"clientId":"...","clientSecret":"...","authorizeUrl":"...","tokenUrl":"...","scopes":"..."}',
    };
  }
  if (!oauthConfig.authorizeUrl) {
    return { ok: false, status: 400, error: "OAuth authorizeUrl not configured. Provide the OAuth provider's authorization endpoint URL." };
  }

  // Must always be absolute: it is stored in the state token and later passed to new URL() in the callback endpoint
  const { searchParams } = new URL(request.url);
  const requestOrigin = new URL(request.url).origin;
  let redirectUrl = searchParams.get('redirectUrl');
  if (redirectUrl) {
    // Validate redirectUrl against allowed origins to prevent open redirect
    const allowedOrigins = [requestOrigin, ...(process.env.CORS_ALLOWED_ORIGINS || '').split(',').filter(Boolean)];
    const isAllowed = allowedOrigins.some((origin) => {
      try {
        return new URL(redirectUrl!).origin === origin;
      } catch {
        return false;
      }
    });
    if (!isAllowed) redirectUrl = `${requestOrigin}${fallbackPath}`;
  } else {
    const origin = process.env.CORS_ALLOWED_ORIGINS?.split(',')[0] || requestOrigin;
    redirectUrl = `${origin}${fallbackPath}`;
  }

  // Callback URL is always the admin API's OAuth callback endpoint (ADMIN_API_URL must be browser-accessible)
  const callbackUrl = getOAuthCallbackUrl();
  if (!callbackUrl) return { ok: false, status: 500, error: 'ADMIN_API_URL environment variable is not configured' };
  const callbackValidation = validateOAuthCallbackUrl(callbackUrl);
  if (callbackValidation) return { ok: false, status: 500, error: callbackValidation };
  const callbackBase = getOAuthCallbackBase()!;

  // PKCE code verifier and challenge (S256)
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  // The state is encrypted JSON with the full callback URI, so the token exchange uses the same redirect_uri as the
  // authorization request, and an exp claim (10 minutes) so a state is only good while fresh
  const stateToken = encryptApiKey(
    JSON.stringify({
      ...state,
      redirectUrl,
      // The resource this authorization request is addressed to, carried through to the token request. RFC 8707 requires both
      // to name the same resource, and the link can be edited while the state is in flight (#188 review).
      ...(serverUrl ? { resource: serverUrl } : {}),
      codeVerifier,
      redirectUri: callbackUrl,
      ts: Date.now(),
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  );

  try {
    const parsedAuthUrl = new URL(oauthConfig.authorizeUrl);
    if (parsedAuthUrl.protocol !== 'http:' && parsedAuthUrl.protocol !== 'https:') {
      return { ok: false, status: 400, error: 'Invalid authorizeUrl in authConfig — must use http or https protocol' };
    }
  } catch {
    return { ok: false, status: 400, error: 'Invalid authorizeUrl in authConfig — must be a valid, absolute URL' };
  }

  const authorizeUrl = new URL(oauthConfig.authorizeUrl);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', oauthConfig.clientId);
  authorizeUrl.searchParams.set('redirect_uri', `${callbackBase}/api/oauth/mcp-callback`);
  // `offline_access` asks for a refresh token and is only ever requested from a server that advertises it (#187)
  authorizeUrl.searchParams.set('scope', resolveRequestedScopes(oauthConfig.scopes, oauthConfig.scopesSupported) || '');
  authorizeUrl.searchParams.set('state', stateToken);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  // RFC 8707 resource indicator, addressed to the app; guarded so an empty value never emits `resource=` (#185)
  if (serverUrl) authorizeUrl.searchParams.set('resource', serverUrl);

  return { ok: true, authorizeUrl: authorizeUrl.toString() };
}
