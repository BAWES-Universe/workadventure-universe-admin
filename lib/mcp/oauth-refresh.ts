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
  normalizeExpiresIn,
  parseOAuthConfig,
  refreshBlockedReason,
  type McpOAuthConfig,
  type RefreshTokenResponse,
} from '@/lib/mcp/oauth-token';
import { checkOutboundUrl } from '@/lib/mcp/outbound-guard';

export type RefreshStatus = 'fresh' | 'refreshed' | 'reconnect_required' | 'unavailable';

export interface RefreshOutcome {
  status: RefreshStatus;
  /** Config as it should be used now (the refreshed one when status is 'refreshed'). */
  config: McpOAuthConfig | null;
  /**
   * Encrypted config to keep using. It is the config that was persisted whenever one was
   * written, and it always agrees with `config` and `status`: a terminal verdict never
   * hands back the pre-verdict blob, whose dead access token would contradict it.
   */
  authConfig: string | null;
  reason?: string;
}

export const REFRESH_TIMEOUT_MS = 10_000;

/**
 * How many times a refreshed pair is re-offered against the row as it changes under us.
 * Bounded so a connection being written by a loop of callers cannot spin here.
 */
const STORE_ATTEMPTS = 3;

/** Refresh-token errors that mean the token itself is dead, not our request. */
const TERMINAL_REFRESH_ERROR_CODES = new Set(['invalid_grant', 'invalid_token']);

/** Single-flight guard, keyed by what holds the token (a bot's server row, or a person's connection). */
const inFlight = new Map<string, Promise<RefreshOutcome>>();

/**
 * Where a token is kept: on a bot's own server row as before, or on a person's connection (#2001), which every Brick that was
 * let use it shares. A connection is refreshed once for all of them.
 */
export type TokenHolder = { kind: 'server' | 'connection'; id: string };
const holderKey = (holder: TokenHolder) => `${holder.kind}:${holder.id}`;

/** How long one request may hold a connection's refresh before another may take it over (the token endpoint times out sooner). */
export const LEASE_MS = REFRESH_TIMEOUT_MS * 2 + 5_000;
/** How long a request that did not get the lease waits for the one that has it, looking every `WAIT_STEP_MS`. */
const WAIT_STEP_MS = 250;

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
  holder: TokenHolder,
  expectedEncrypted: string,
  config: McpOAuthConfig
): Promise<{ won: boolean; authConfig: string }> {
  const authConfig = encryptApiKey(JSON.stringify(config));
  const where = { id: holder.id, authConfig: expectedEncrypted };
  const result =
    holder.kind === 'connection'
      ? await prisma.appConnection.updateMany({ where, data: { authConfig } })
      : await prisma.botMcpServer.updateMany({ where, data: { authConfig } });
  return { won: result.count === 1, authConfig };
}

/**
 * A refreshed pair carried onto the settings the row holds now. Only the token fields
 * come from the refresh; everything else (scopes, client secret, the advertised scope
 * snapshot, ...) belongs to whoever saved the connection last.
 */
function withRefreshedTokens(base: McpOAuthConfig, refreshed: McpOAuthConfig): McpOAuthConfig {
  const next: McpOAuthConfig = {
    ...base,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  };
  delete next.reconnectRequired;
  return next;
}

/**
 * Same authorization server and client, so a pair issued under one config is valid under
 * the other. Editing either endpoint URL clears the stored tokens on purpose, and a pair
 * issued to a different client is not the new client's.
 */
function sameIssuer(a: McpOAuthConfig, b: McpOAuthConfig): boolean {
  return (
    (a.tokenUrl ?? null) === (b.tokenUrl ?? null) &&
    (a.authorizeUrl ?? null) === (b.authorizeUrl ?? null) &&
    (a.clientId ?? null) === (b.clientId ?? null)
  );
}

async function readStoredConfig(
  holder: TokenHolder
): Promise<{ encrypted: string; config: McpOAuthConfig } | null> {
  const row =
    holder.kind === 'connection'
      ? await prisma.appConnection.findUnique({ where: { id: holder.id }, select: { authConfig: true } })
      : await prisma.botMcpServer.findUnique({ where: { id: holder.id }, select: { authConfig: true } });
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
  /** Set when the token is kept on a person's connection (#2001): it is then read, renewed and stored there, once for all of its Bricks. */
  connectionId?: string | null;
  authConfig: string | null;
  serverUrl?: string | null;
  nowMs?: number;
}): Promise<RefreshOutcome> {
  const { serverId, connectionId = null, authConfig, serverUrl = null, nowMs = Date.now() } = params;
  const holder: TokenHolder = connectionId ? { kind: 'connection', id: connectionId } : { kind: 'server', id: serverId };

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

  // A person's GitHub (game #2041) is renewed by lib/github/connection.ts with the GitHub App's own secret, never here: this
  // path would send it to an endpoint it does not have and could mark a working sign-in as lost
  if ((config as { provider?: unknown }).provider === 'github') {
    return { status: 'fresh', config, authConfig };
  }

  // Terminal states are reported without a network call. The verdict itself is
  // recorded once (a guarded write), so the panel can say why instead of showing a
  // green badge on a dead token; after that the marker alone short-circuits every
  // later poll.
  if (isReconnectRequired(config, nowMs)) {
    const reason = refreshBlockedReason(config, nowMs) ?? 'Reconnect required.';

    if (!config.reconnectRequired && config.accessToken) {
      // Authorized at some point and no longer renewable — record it.
      return markTerminal(holder, authConfig, config, reason, nowMs);
    }

    // Either already recorded, or never authorized: nothing to write. A connection
    // that was never authorized is simply not connected yet, and the panel already
    // offers "Connect with OAuth" for it.
    return { status: 'reconnect_required', config, authConfig, reason };
  }

  if (!needsRefresh(config, nowMs)) {
    return { status: 'fresh', config, authConfig };
  }

  const existing = inFlight.get(holderKey(holder));
  if (existing) return existing;

  const pending = (holder.kind === 'connection'
    ? refreshUnderLease(holder, authConfig, config, serverUrl, nowMs)
    : performRefresh(holder, authConfig, config, serverUrl, nowMs))
    .catch((error: unknown): RefreshOutcome => ({
      // Unexpected failure: transient by default. Never condemn a connection
      // permanently because of a bug in this code path.
      status: 'unavailable',
      config,
      authConfig,
      reason: `The connection could not be refreshed: ${messageOf(error)}`,
    }))
    .finally(() => {
      inFlight.delete(holderKey(holder));
    });

  inFlight.set(holderKey(holder), pending);
  return pending;
}

/**
 * Holds a connection's refresh lease for something that must not run while a renewal is in flight (taking its sign-in back at the
 * app: a provider that rotates the refresh token would otherwise be handed the one a renewal just replaced). Waits for the renewal
 * that has it, up to the lease length; if it is still not free by then it carries on without, since it is best effort. The returned
 * function lets go (a row that is already gone is not an error).
 */
export async function holdRefreshLease(connectionId: string): Promise<() => Promise<void>> {
  return (await takeRefreshLease(connectionId)) ?? (async () => undefined);
}

/**
 * The same lease, strictly: null when it could not be had within the lease length (or the row is gone), so a caller that must
 * never run beside a renewal (one that rotates a refresh token, game #2041) stops instead of carrying on.
 */
export async function takeRefreshLease(connectionId: string): Promise<(() => Promise<void>) | null> {
  const claim = () =>
    prisma.appConnection.updateMany({
      where: { id: connectionId, OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: new Date() } }] },
      data: { refreshLeaseUntil: new Date(Date.now() + LEASE_MS) },
    });
  const deadline = Date.now() + LEASE_MS;
  for (;;) {
    if ((await claim()).count === 1) {
      return async () => {
        await prisma.appConnection.updateMany({ where: { id: connectionId }, data: { refreshLeaseUntil: null } }).catch(() => undefined);
      };
    }
    // A row that is gone (disconnected at the same moment) has no lease to wait for: stop looking at once
    if (!(await prisma.appConnection.findUnique({ where: { id: connectionId }, select: { id: true } }))) return null;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
}

/**
 * A connection's refresh, one at a time across every server that runs Orbit (#2001): the request that wins the lease renews the
 * token; the others wait for it and use what it stored. Two Bricks (or two requests) never present the same refresh token, so a
 * provider that rotates it never signs the person out. The lease ends by itself after `LEASE_MS`, so a crash never blocks a
 * connection for long, and the compare-and-set write below still guards the row either way.
 */
async function refreshUnderLease(
  holder: TokenHolder,
  encryptedConfig: string,
  config: McpOAuthConfig,
  serverUrl: string | null,
  nowMs: number
): Promise<RefreshOutcome> {
  const claim = () =>
    prisma.appConnection.updateMany({
      where: { id: holder.id, OR: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { lt: new Date() } }] },
      data: { refreshLeaseUntil: new Date(Date.now() + LEASE_MS) },
    });
  const deadline = Date.now() + LEASE_MS;
  let claimed = (await claim()).count === 1;
  while (!claimed) {
    // Someone else is renewing it: look at what they stored instead of renewing a second time
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    const stored = await readStoredConfig(holder).catch(() => null);
    if (stored && !needsRefresh(stored.config, Date.now()) && !!stored.config.accessToken) {
      return { status: 'fresh', config: stored.config, authConfig: stored.encrypted };
    }
    if (stored && isReconnectRequired(stored.config, Date.now())) {
      return {
        status: 'reconnect_required',
        config: stored.config,
        authConfig: stored.encrypted,
        reason: refreshBlockedReason(stored.config, Date.now()) ?? 'Reconnect required.',
      };
    }
    claimed = (await claim()).count === 1;
    if (!claimed && Date.now() > deadline) {
      return {
        status: 'unavailable',
        config,
        authConfig: encryptedConfig,
        reason: 'Another request is renewing this connection. Try again in a moment.',
      };
    }
  }
  try {
    // Read again now that the lease is ours: the one that held it may have renewed it just before
    const stored = await readStoredConfig(holder).catch(() => null);
    if (stored && stored.encrypted !== encryptedConfig) {
      if (isReconnectRequired(stored.config, Date.now())) {
        return {
          status: 'reconnect_required',
          config: stored.config,
          authConfig: stored.encrypted,
          reason: refreshBlockedReason(stored.config, Date.now()) ?? 'Reconnect required.',
        };
      }
      if (!needsRefresh(stored.config, Date.now()) && !!stored.config.accessToken) {
        return { status: 'fresh', config: stored.config, authConfig: stored.encrypted };
      }
      return performRefresh(holder, stored.encrypted, stored.config, serverUrl, nowMs);
    }
    return await performRefresh(holder, encryptedConfig, config, serverUrl, nowMs);
  } finally {
    await prisma.appConnection.updateMany({ where: { id: holder.id }, data: { refreshLeaseUntil: null } }).catch(() => undefined);
  }
}

async function performRefresh(
  holder: TokenHolder,
  encryptedConfig: string,
  config: McpOAuthConfig,
  serverUrl: string | null,
  nowMs: number
): Promise<RefreshOutcome> {
  if (!config.tokenUrl) {
    return markTerminal(
      holder,
      encryptedConfig,
      config,
      'No token endpoint is stored for this connection.',
      nowMs
    );
  }

  const refreshToken = config.refreshToken;
  if (!refreshToken) {
    return markTerminal(
      holder,
      encryptedConfig,
      config,
      'The provider issued no refresh token, so this connection cannot be renewed automatically.',
      nowMs
    );
  }

  // The token endpoint receives the refresh token and the client secret, so it gets the
  // same destination check as the connection test, including DNS resolution: the
  // save-time check only looks at the hostname. A blocked destination is not the refresh
  // token's fault, so the tokens are kept and nothing is marked for a human.
  const destination = await checkOutboundUrl(config.tokenUrl);
  if (!destination.allowed) {
    return {
      status: 'unavailable',
      config,
      authConfig: encryptedConfig,
      reason: `The token endpoint is not an allowed destination (${destination.error ?? 'blocked'}).`,
    };
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
      // A redirect would carry the refresh token and client secret to a destination the
      // check above never saw (a 307/308 re-sends the body), so it fails the request
      // instead. It surfaces as a transport error: retryable, tokens kept (#193 review).
      redirect: 'error',
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
    // Terminal means the refresh token itself is dead, and only a parsed error code can
    // say that: `invalid_grant` is the specified code for invalid/expired/revoked, and
    // `invalid_token` says the same. Everything else stays retryable, because a terminal
    // verdict deletes the stored tokens and only a human can bring them back. That
    // includes a bare 401 with no code: RFC 6749 §5.2 uses 401 for client-authentication
    // failure (`invalid_client`), and a proxy or firewall in front of the provider can
    // answer 401 with an HTML page. Neither proves the refresh token is dead.
    const isTerminal = errorCode !== null && TERMINAL_REFRESH_ERROR_CODES.has(errorCode);
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
      holder,
      encryptedConfig,
      config,
      `The provider rejected the stored refresh token (${detail}). Reconnect to authorize this connection again.`,
      nowMs
    );
  }

  const tokenResponse: RefreshTokenResponse = {
    access_token: typeof parsedBody?.access_token === 'string' ? parsedBody.access_token : undefined,
    refresh_token: typeof parsedBody?.refresh_token === 'string' ? parsedBody.refresh_token : undefined,
    // Numeric strings are common in the wild; dropping the duration would record no expiry
    // and leave the new token never proactively refreshed (#190 review).
    expires_in: normalizeExpiresIn(parsedBody?.expires_in),
  };

  if (!tokenResponse.access_token) {
    return markTerminal(
      holder,
      encryptedConfig,
      config,
      'The token endpoint returned no access token.',
      nowMs
    );
  }

  const updated = applyRefreshResult(config, tokenResponse, nowMs);

  let persisted: { won: boolean; authConfig: string };
  try {
    persisted = await persistIfUnchanged(holder, encryptedConfig, updated);
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
    let current = await readStoredConfig(holder).catch(() => null);

    // Only a pair another writer stored counts. A row that still holds the pair this
    // refresh started from lost the race to something else (a settings save, say), and
    // that pair's refresh token may be the one we just spent: adopting it would drop
    // the pair we were issued and leave the connection unable to refresh (#193 review).
    const holdsUsablePair = (
      stored: { encrypted: string; config: McpOAuthConfig } | null
    ): boolean =>
      !!stored &&
      !!stored.config.accessToken &&
      !isAccessTokenStale(stored.config, nowMs, 0) &&
      (stored.config.accessToken !== config.accessToken || stored.config.refreshToken !== config.refreshToken);

    // Another writer stored a live pair while we were in flight: theirs is the token
    // the provider considers current, so adopt it.
    if (holdsUsablePair(current)) {
      return { status: 'refreshed', config: current!.config, authConfig: current!.encrypted };
    }

    // The row holds a terminal verdict while our exchange just succeeded, and a
    // terminal verdict must not outrank a successful exchange: success is proof the
    // connection is alive, while a rejection only proves that one refresh token was
    // spent — exactly what happens when a concurrent caller rotates it first. Writing
    // the pair we hold over the marker is what keeps the connection alive.
    //
    // Every attempt is guarded against the value read immediately before it. A blind
    // write would clobber whatever another process stored in the window since that read,
    // and against a rotating provider the loser's pair is the spent one: overwriting the
    // winner's live pair with it would leave the connection unable to refresh at all
    // (#190 review).
    //
    // What is written is our pair carried onto the settings the row holds now, not the
    // settings this refresh started from: otherwise a concurrent save of the connection
    // (its scopes, say) would be reverted. If that save changed the authorization server
    // or the client, our pair is not theirs, so nothing is written and the saved settings
    // stand (#193 review).
    for (let attempt = 0; attempt < STORE_ATTEMPTS; attempt += 1) {
      if (current && !sameIssuer(current.config, config)) {
        return {
          status: 'unavailable',
          config: current.config,
          authConfig: current.encrypted,
          reason:
            "This connection's OAuth settings were changed while it was being refreshed, so the new settings were kept. Reconnect to authorize them.",
        };
      }
      const toStore = current ? withRefreshedTokens(current.config, updated) : updated;
      const stored = await persistIfUnchanged(holder, current?.encrypted ?? encryptedConfig, toStore).catch(
        () => null
      );
      if (stored?.won) {
        return { status: 'refreshed', config: toStore, authConfig: stored.authConfig };
      }

      current = await readStoredConfig(holder).catch(() => null);
      if (holdsUsablePair(current)) {
        return { status: 'refreshed', config: current!.config, authConfig: current!.encrypted };
      }
    }

    // The row kept changing under us and holds nothing usable. Hand back what it holds
    // rather than overwriting a value we cannot see, and let the next request try again.
    return {
      status: 'unavailable',
      config: current?.config ?? config,
      authConfig: current?.encrypted ?? encryptedConfig,
      reason:
        'The refreshed token could not be stored because this connection was being written concurrently. Retry, or reconnect to authorize it again.',
    };
  }

  return { status: 'refreshed', config: updated, authConfig: persisted.authConfig };
}

async function markTerminal(
  holder: TokenHolder,
  encryptedConfig: string,
  config: McpOAuthConfig,
  reason: string,
  nowMs: number
): Promise<RefreshOutcome> {
  const marked = markReconnectRequired(config, reason, nowMs);
  try {
    const persisted = await persistIfUnchanged(holder, encryptedConfig, marked);
    if (persisted.won) {
      // Hand back the blob that was actually written, never the one this call started
      // from. A caller serves `authConfig` to the bot as its credentials while deriving
      // "connected" from `config`, so returning the pre-verdict blob made one payload
      // declare that a reconnect was required and carry the dead access token the bot
      // would then present and get a 401 for (#190 review finding).
      return { status: 'reconnect_required', config: marked, authConfig: persisted.authConfig, reason };
    }

    // Someone else wrote while we were in flight. If they stored a usable token
    // (a human just reconnected), adopt it instead of recording our verdict.
    const current = await readStoredConfig(holder).catch(() => null);
    if (current && !!current.config.accessToken && !isAccessTokenStale(current.config, nowMs, 0)) {
      return { status: 'refreshed', config: current.config, authConfig: current.encrypted };
    }
    // Their row holds no usable token either, so our verdict stays the honest answer and
    // is what `config` reports below. Their token-bearing blob is deliberately not
    // served: a caller would read it as a connected connection whose token just failed,
    // which is the illusion this verdict exists to remove.
  } catch (error) {
    console.error('[OAuthRefresh] Failed to persist reconnect-required state:', error);
  }

  // Reached when the guarded write lost to a row holding nothing usable, or when it could
  // not be made at all. Either way the verdict is served with a config that agrees with
  // it, so no dead access token goes out beside "reconnect required". markTerminal is only
  // reached once the stored token itself is unusable, so nothing that could still
  // authenticate is discarded here.
  return {
    status: 'reconnect_required',
    config: marked,
    authConfig: encryptApiKey(JSON.stringify(marked)),
    reason,
  };
}
