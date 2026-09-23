/**
 * OAuth token lifecycle for MCP connections (#187).
 *
 * Pure functions only — no database, no network — so the decisions that decide
 * whether a connection lives or dies (when to refresh, whether a refresh token is
 * even usable, what scope list to ask for, what to persist after a rotation) are
 * unit-testable rather than only observable in production.
 *
 * The gap this closes: nothing redeemed a refresh token. `grant_type=refresh_token`
 * appeared zero times in the codebase. Every OAuth connection therefore died when
 * its access token expired and stayed dead until a human re-ran the sign-in popup,
 * however many valid refresh tokens sat unused in `authConfig`.
 */

export interface McpOAuthConfig {
  clientId?: string | null;
  clientSecret?: string | null;
  scopes?: string | null;
  authorizeUrl?: string | null;
  tokenUrl?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  /** Epoch seconds. Absent when the provider returned no `expires_in`. */
  expiresAt?: number | null;
  /** Snapshot of the authorization server's advertised `scopes_supported`. */
  scopesSupported?: string[] | null;
  /**
   * Set when the connection cannot be renewed automatically and needs a human to
   * re-authorize. Its presence is what stops us re-attempting on every poll.
   */
  reconnectRequired?: { at: string; reason: string } | null;
  [key: string]: unknown;
}

/** Refresh this long before the access token actually expires. */
export const REFRESH_SKEW_SECONDS = 300;

export const OFFLINE_ACCESS_SCOPE = 'offline_access';

export interface RefreshTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** Parse a decrypted `authConfig`. Returns null for anything that is not a JSON object. */
export function parseOAuthConfig(decrypted: string): McpOAuthConfig | null {
  try {
    const parsed: unknown = JSON.parse(decrypted);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as McpOAuthConfig;
  } catch {
    return null;
  }
}

/**
 * True when the access token is missing, expired, or inside the refresh skew.
 * A token with no recorded expiry is treated as usable: we know nothing about when
 * it dies, and refusing to use it would break providers that omit `expires_in`.
 */
export function isAccessTokenStale(
  config: McpOAuthConfig,
  nowMs: number = Date.now(),
  skewSeconds: number = REFRESH_SKEW_SECONDS
): boolean {
  if (!config.accessToken) return true;
  if (typeof config.expiresAt !== 'number' || !Number.isFinite(config.expiresAt)) return false;
  return config.expiresAt - skewSeconds <= Math.floor(nowMs / 1000);
}

/** True when a refresh should be attempted now. */
export function needsRefresh(config: McpOAuthConfig, nowMs: number = Date.now()): boolean {
  if (config.reconnectRequired) return false; // terminal until a human acts
  if (!config.refreshToken) return false; // nothing to redeem; see refreshBlockedReason
  return isAccessTokenStale(config, nowMs);
}

/**
 * Why this connection cannot be renewed automatically, or null when it can be (or
 * does not need to be). Used to turn a bare 401 into an actionable message.
 */
export function refreshBlockedReason(config: McpOAuthConfig, nowMs: number = Date.now()): string | null {
  if (config.reconnectRequired) return config.reconnectRequired.reason;
  if (!config.accessToken) return 'No access token is stored for this connection.';
  if (isAccessTokenStale(config, nowMs, 0) && !config.refreshToken) {
    return 'The provider issued no refresh token, so this connection cannot be renewed automatically.';
  }
  return null;
}

/**
 * True when the connection is in a state only a human can fix.
 *
 * Deliberately tests *real* expiry (skew 0), not the refresh threshold: the two
 * questions differ. `REFRESH_SKEW_SECONDS` answers "should we refresh soon", which is
 * right for `needsRefresh`; this answers "is it beyond automatic recovery". Judging a
 * connection terminal at the refresh threshold would destroy a still-valid access
 * token with minutes of life left — it is routed into markReconnectRequired, which
 * clears the tokens, so the bot would lose its tools early and the panel would demand
 * a human while a working token sat in the row.
 */
export function isReconnectRequired(config: McpOAuthConfig, nowMs: number = Date.now()): boolean {
  if (config.reconnectRequired) return true;
  return isAccessTokenStale(config, nowMs, 0) && !config.refreshToken;
}

/**
 * Fold a successful refresh into the stored config.
 *
 * The rotated refresh token MUST be persisted: providers that rotate invalidate the
 * presented token on use, so keeping the old one means the next refresh fails and the
 * connection becomes unrecoverable — the exact failure this code exists to prevent.
 */
export function applyRefreshResult(
  config: McpOAuthConfig,
  token: RefreshTokenResponse,
  nowMs: number = Date.now()
): McpOAuthConfig {
  if (!token.access_token) {
    throw new Error('Refresh response carried no access_token');
  }
  const next: McpOAuthConfig = {
    ...config,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || config.refreshToken,
    expiresAt:
      typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)
        ? Math.floor(nowMs / 1000) + token.expires_in
        : (config.expiresAt ?? null),
  };
  delete next.reconnectRequired;
  return next;
}

/**
 * Record that this connection needs a human.
 *
 * The stored credentials are dead or unusable, so they are cleared: that makes the
 * panel report the connection as not connected (with a Reconnect action) instead of
 * showing a token that can never work.
 */
export function markReconnectRequired(
  config: McpOAuthConfig,
  reason: string,
  nowMs: number = Date.now()
): McpOAuthConfig {
  const next: McpOAuthConfig = {
    ...config,
    reconnectRequired: { at: new Date(nowMs).toISOString(), reason },
  };
  delete next.accessToken;
  delete next.refreshToken;
  delete next.expiresAt;
  return next;
}

/**
 * Work out the scope string to send on the authorization request.
 *
 * `offline_access` is the scope that asks a provider for a refresh token, and it must
 * only ever be requested from a server that advertises it — asking for an
 * unpublished scope is a request the provider is entitled to reject. When we know
 * nothing about the server's published scopes, what is configured is sent unchanged:
 * guessing either way is worse than passing through what a human configured.
 *
 * When nothing is configured but the server does advertise its scopes, those are what
 * get requested. Falling back to `offline_access` alone would ask for the refresh scope
 * and drop every functional scope, so the token comes back unable to call anything —
 * and that is the state every connection created through the panel starts in, because
 * the Scopes field is optional and is not pre-filled from discovery (#190 review).
 */
export function resolveRequestedScopes(
  storedScopes: string | null | undefined,
  advertised: string[] | null | undefined
): string | null {
  const stored = (storedScopes ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!advertised || advertised.length === 0) {
    return stored.length > 0 ? stored.join(' ') : null;
  }

  const advertisedSet = new Set(advertised.map((s) => s.trim()).filter(Boolean));
  const base = stored.length > 0 ? stored : Array.from(advertisedSet);
  const requested = base.filter((s) => s !== OFFLINE_ACCESS_SCOPE);
  if (advertisedSet.has(OFFLINE_ACCESS_SCOPE)) {
    requested.push(OFFLINE_ACCESS_SCOPE);
  }

  const deduped = Array.from(new Set(requested));
  return deduped.length > 0 ? deduped.join(' ') : null;
}
