/**
 * Server-side refresh of a connection's OAuth access token (#187).
 *
 * Called before a token is handed out or used, so a connection survives its token's
 * expiry without a human re-running the sign-in popup.
 *
 * Two failure modes are handled explicitly, because both are easy to get wrong and
 * both end with a connection that was alive becoming unusable:
 *
 * 1. **A rejected refresh.** Revoked, expired through inactivity, or invalidated by a
 *    rotation. The connection is marked `reconnectRequired`, its dead tokens are
 *    cleared, and the reason is stored — so it is reported as needing a human instead
 *    of being re-attempted on every poll forever.
 * 2. **Concurrent refresh against a rotating provider.** The bots' config endpoint is
 *    polled while two different UIs can also trigger a test. Two requests arriving
 *    while the token is expired would each present the same stored refresh token; a
 *    rotating provider invalidates the first on use, the second fails, and whichever
 *    pair is persisted may be the loser. Two guards: an in-process single-flight per
 *    connection, and a compare-and-set write so a token refresh only lands if the
 *    config it was computed from is still the one in the row.
 */

import { prisma } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';
import {
  applyRefreshResult,
  isAccessTokenStale,
  isReconnectRequired,
  markReconnectRequired,
  needsRefresh,
  parseOAuthConfig,
  refreshBlockedReason,
  type McpOAuthConfig,
  type RefreshTokenResponse,
} from '@/lib/mcp/oauth-token';

export type RefreshStatus = 'fresh' | 'refreshed' | 'reconnect_required' | 'unavailable';

export interface RefreshOutcome {
  status: RefreshStatus;
  /** Config as it should be used now (the refreshed one when status is 'refreshed'). */
  config: McpOAuthConfig | null;
  /** Encrypted config to keep using. Already persisted whenever it changed. */
  authConfig: string | null;
  reason?: string;
}

export const REFRESH_TIMEOUT_MS = 10_000;

/** Single-flight guard, keyed by connection id. */
const inFlight = new Map<string, Promise<RefreshOutcome>>();

function safeDecrypt(encrypted: string): string {
  try {
    return decryptApiKey(encrypted);
  } catch {
    return '';
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function describeTransportError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `The token endpoint did not respond within ${Math.round(REFRESH_TIMEOUT_MS / 1000)} seconds.`;
  }
  return `The token endpoint could not be reached: ${messageOf(error)}`;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The provider's error code, e.g. `invalid_grant`. */
function extractTokenErrorCode(parsed: Record<string, unknown> | null): string | null {
  if (!parsed) return null;
  const error = parsed.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const nested = (error as Record<string, unknown>).code;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return null;
}

function extractTokenErrorDescription(parsed: Record<string, unknown> | null): string | null {
  if (!parsed) return null;
  for (const key of ['error_description', 'message', 'error'] as const) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Write the config only if the row still holds the exact config it was derived from.
 * Losing this compare-and-set means another writer got there first, and its token pair
 * is the one the provider considers current.
 */
async function persistIfUnchanged(
  serverId: string,
  expectedEncrypted: string,
  config: McpOAuthConfig
): Promise<{ won: boolean; authConfig: string }> {
  const authConfig = encryptApiKey(JSON.stringify(config));
  const result = await prisma.botMcpServer.updateMany({
    where: { id: serverId, authConfig: expectedEncrypted },
    data: { authConfig },
  });
  return { won: result.count === 1, authConfig };
}

async function readStoredConfig(
  serverId: string
): Promise<{ encrypted: string; config: McpOAuthConfig } | null> {
  const row = await prisma.botMcpServer.findUnique({
    where: { id: serverId },
    select: { authConfig: true },
  });
  if (!row?.authConfig) return null;
  const config = parseOAuthConfig(safeDecrypt(row.authConfig));
  if (!config) return null;
  return { encrypted: row.authConfig, config };
}

/**
 * Return a usable config for a connection, refreshing it first when required.
 * Never throws: every failure mode is reported as an outcome the caller can surface.
 */
export async function ensureFreshOAuthConfig(params: {
  serverId: string;
  authConfig: string | null;
  serverUrl?: string | null;
  nowMs?: number;
}): Promise<RefreshOutcome> {
  const { serverId, authConfig, serverUrl = null, nowMs = Date.now() } = params;

  if (!authConfig) {
    return {
      status: 'unavailable',
      config: null,
      authConfig: null,
      reason: 'No OAuth configuration is stored for this connection.',
    };
  }

  const config = parseOAuthConfig(safeDecrypt(authConfig));
  if (!config) {
    return {
      status: 'unavailable',
      config: null,
      authConfig,
      reason: 'The stored OAuth configuration could not be read.',
    };
  }

  // Terminal states are reported without a network call. The verdict itself is
  // recorded once (a guarded write), so the panel can say why instead of showing a
  // green badge on a dead token; after that the marker alone short-circuits every
  // later poll.
  if (isReconnectRequired(config, nowMs)) {
    const reason = refreshBlockedReason(config, nowMs) ?? 'Reconnect required.';

    if (!config.reconnectRequired && config.accessToken) {
      // Authorized at some point and no longer renewable — record it.
      return markTerminal(serverId, authConfig, config, reason, nowMs);
    }

    // Either already recorded, or never authorized: nothing to write. A connection
    // that was never authorized is simply not connected yet, and the panel already
    // offers "Connect with OAuth" for it.
    return { status: 'reconnect_required', config, authConfig, reason };
  }

  if (!needsRefresh(config, nowMs)) {
    return { status: 'fresh', config, authConfig };
  }

  const existing = inFlight.get(serverId);
  if (existing) return existing;

  const pending = performRefresh(serverId, authConfig, config, serverUrl, nowMs)
    .catch((error: unknown): RefreshOutcome => ({
      // Unexpected failure: transient by default. Never condemn a connection
      // permanently because of a bug in this code path.
      status: 'unavailable',
      config,
      authConfig,
      reason: `The connection could not be refreshed: ${messageOf(error)}`,
    }))
    .finally(() => {
      inFlight.delete(serverId);
    });

  inFlight.set(serverId, pending);
  return pending;
}

async function performRefresh(
  serverId: string,
  encryptedConfig: string,
  config: McpOAuthConfig,
  serverUrl: string | null,
  nowMs: number
): Promise<RefreshOutcome> {
  if (!config.tokenUrl) {
    return markTerminal(
      serverId,
      encryptedConfig,
      config,
      'No token endpoint is stored for this connection.',
      nowMs
    );
  }

  const refreshToken = config.refreshToken;
  if (!refreshToken) {
    return markTerminal(
      serverId,
      encryptedConfig,
      config,
      'The provider issued no refresh token, so this connection cannot be renewed automatically.',
      nowMs
    );
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  if (config.clientId) body.set('client_id', config.clientId);
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  // RFC 8707 applies to token requests as well as authorization requests, and a
  // refreshed token must stay addressed to the same MCP server — otherwise a
  // connection that works when authorized stops working an hour later.
  if (serverUrl) body.set('resource', serverUrl);

  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (error) {
    // Network failure or timeout: transient. The next poll may succeed.
    return {
      status: 'unavailable',
      config,
      authConfig: encryptedConfig,
      reason: describeTransportError(error),
    };
  }

  const rawBody = await response.text().catch(() => '');
  const parsedBody = parseJsonObject(rawBody);
  const errorCode = extractTokenErrorCode(parsedBody);

  if (!response.ok) {
    // `invalid_grant` is the specified code for a refresh token that is invalid,
    // expired or revoked — the terminal case. A 401 from a token endpoint means the
    // same in practice. Anything else (invalid_request, invalid_client, a 5xx) says
    // our request or the client credentials are the problem, which a human
    // re-authorizing would not fix, so it stays retryable and reports its reason.
    const isTerminal = errorCode === 'invalid_grant' || response.status === 401;
    if (!isTerminal) {
      return {
        status: 'unavailable',
        config,
        authConfig: encryptedConfig,
        reason: `The token endpoint rejected the refresh (HTTP ${response.status}${
          errorCode ? ` ${errorCode}` : ''
        }).`,
      };
    }

    const detail = extractTokenErrorDescription(parsedBody) ?? errorCode ?? `HTTP ${response.status}`;
    return markTerminal(
      serverId,
      encryptedConfig,
      config,
      `The provider rejected the stored refresh token (${detail}). Reconnect to authorize this connection again.`,
      nowMs
    );
  }

  const tokenResponse: RefreshTokenResponse = {
    access_token: typeof parsedBody?.access_token === 'string' ? parsedBody.access_token : undefined,
    refresh_token: typeof parsedBody?.refresh_token === 'string' ? parsedBody.refresh_token : undefined,
    expires_in: typeof parsedBody?.expires_in === 'number' ? parsedBody.expires_in : undefined,
  };

  if (!tokenResponse.access_token) {
    return markTerminal(
      serverId,
      encryptedConfig,
      config,
      'The token endpoint returned no access token.',
      nowMs
    );
  }

  const updated = applyRefreshResult(config, tokenResponse, nowMs);

  let persisted: { won: boolean; authConfig: string };
  try {
    persisted = await persistIfUnchanged(serverId, encryptedConfig, updated);
  } catch (error) {
    // Refusing to hand out a token that is not stored: the next request would
    // present the old one and fail in a far more confusing way.
    return {
      status: 'unavailable',
      config,
      authConfig: encryptedConfig,
      reason: `The refreshed token could not be stored: ${messageOf(error)}`,
    };
  }

  if (!persisted.won) {
    const current = await readStoredConfig(serverId).catch(() => null);
    if (current) {
      return { status: 'refreshed', config: current.config, authConfig: current.encrypted };
    }
  }

  return { status: 'refreshed', config: updated, authConfig: persisted.authConfig };
}

async function markTerminal(
  serverId: string,
  encryptedConfig: string,
  config: McpOAuthConfig,
  reason: string,
  nowMs: number
): Promise<RefreshOutcome> {
  const marked = markReconnectRequired(config, reason, nowMs);
  try {
    const persisted = await persistIfUnchanged(serverId, encryptedConfig, marked);
    if (!persisted.won) {
      // Someone else wrote while we were in flight. If they stored a usable token
      // (a human just reconnected), adopt it instead of persisting our verdict.
      const current = await readStoredConfig(serverId).catch(() => null);
      if (current && !isReconnectRequired(current.config, nowMs) && !isAccessTokenStale(current.config, nowMs)) {
        return { status: 'refreshed', config: current.config, authConfig: current.encrypted };
      }
    }
  } catch (error) {
    console.error('[OAuthRefresh] Failed to persist reconnect-required state:', error);
  }

  return { status: 'reconnect_required', config: marked, authConfig: encryptedConfig, reason };
}
