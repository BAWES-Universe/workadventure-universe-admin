import { ensureFreshOAuthConfig } from '@/lib/mcp/oauth-refresh';
import { markReconnectRequired } from '@/lib/mcp/oauth-token';
import { prisma } from '@/lib/db';

/**
 * Server-side token refresh (#187), including the two failure modes that turn a
 * working connection into an unrecoverable one:
 *
 * 1. a rejected refresh (revoked / expired / invalidated by rotation) must land in
 *    a terminal "reconnect required" state and stop being re-attempted on every
 *    poll, and
 * 2. a concurrent refresh against a rotating provider must not leave the losing
 *    (already invalidated) token pair persisted.
 */

jest.mock('@/lib/db', () => ({
  prisma: {
    botMcpServer: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

jest.mock('@/lib/encryption', () => ({
  encryptApiKey: (value: string) => `enc:${value}`,
  decryptApiKey: (value: string) => value.replace(/^enc:/, ''),
}));

const NOW = new Date('2026-09-22T12:00:00Z').getTime();
const nowSeconds = Math.floor(NOW / 1000);
const SERVER_ID = 'server-789';
const TOKEN_URL = 'https://auth.example.com/oauth2/token';
const SERVER_URL = 'https://mcp.example.com/mcp';

const enc = (config: Record<string, unknown>) => `enc:${JSON.stringify(config)}`;
const dec = (encrypted: string) => JSON.parse(encrypted.replace(/^enc:/, ''));

const expiredConfig = {
  clientId: 'client-abc',
  tokenUrl: TOKEN_URL,
  authorizeUrl: 'https://auth.example.com/oauth2/authorize',
  accessToken: 'expired-access',
  refreshToken: 'refresh-1',
  expiresAt: nowSeconds - 60,
};

const updateMany = prisma.botMcpServer.updateMany as jest.Mock;
const update = prisma.botMcpServer.update as jest.Mock;
const findUnique = prisma.botMcpServer.findUnique as jest.Mock;
const originalFetch = global.fetch;

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ensureFreshOAuthConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('serves a usable token without touching the network', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const authConfig = enc({ ...expiredConfig, expiresAt: nowSeconds + 3600 });

    const outcome = await ensureFreshOAuthConfig({ serverId: SERVER_ID, authConfig, nowMs: NOW });

    expect(outcome.status).toBe('fresh');
    expect(outcome.config?.accessToken).toBe('expired-access');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and persists the rotated pair', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 })
      );
    global.fetch = fetchMock as unknown as typeof fetch;
    const authConfig = enc(expiredConfig);

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig,
      serverUrl: SERVER_URL,
      nowMs: NOW,
    });

    expect(outcome.status).toBe('refreshed');

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(TOKEN_URL);
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
    expect(body.get('client_id')).toBe('client-abc');
    // RFC 8707 on the token request too, so a refreshed token stays addressed to
    // the same MCP server.
    expect(body.get('resource')).toBe(SERVER_URL);

    // Compare-and-set against the exact config this refresh was derived from.
    const update = updateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: SERVER_ID, authConfig });
    const persisted = dec(update.data.authConfig);
    expect(persisted.accessToken).toBe('access-2');
    expect(persisted.refreshToken).toBe('refresh-2');
    expect(persisted.expiresAt).toBe(nowSeconds + 3600);
    expect(outcome.config?.refreshToken).toBe('refresh-2');
  });

  it('lands a rejected refresh in reconnect-required, clears the dead tokens, and stops re-attempting', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(tokenResponse({ error: 'invalid_grant', error_description: 'revoked' }, 400));
    global.fetch = fetchMock as unknown as typeof fetch;

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('reconnect_required');
    expect(outcome.reason).toContain('revoked');

    const persisted = dec(updateMany.mock.calls[0][0].data.authConfig);
    expect(persisted.accessToken).toBeUndefined();
    expect(persisted.refreshToken).toBeUndefined();
    expect(persisted.reconnectRequired.at).toBe('2026-09-22T12:00:00.000Z');
    expect(persisted.reconnectRequired.reason).toContain('revoked');

    // The whole point: the next poll must not try again, and must not touch the network.
    const markedConfig = updateMany.mock.calls[0][0].data.authConfig as string;
    const second = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: markedConfig,
      nowMs: NOW,
    });

    expect(second.status).toBe('reconnect_required');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('marks a 401 from the token endpoint as terminal', async () => {
    global.fetch = jest.fn().mockResolvedValue(tokenResponse({}, 401)) as unknown as typeof fetch;

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('reconnect_required');
  });

  it('leaves the connection retryable when the failure is ours or transient', async () => {
    const fetchMock = jest.fn().mockResolvedValue(tokenResponse({ error: 'invalid_request' }, 400));
    global.fetch = fetchMock as unknown as typeof fetch;
    const authConfig = enc(expiredConfig);

    const outcome = await ensureFreshOAuthConfig({ serverId: SERVER_ID, authConfig, nowMs: NOW });

    expect(outcome.status).toBe('unavailable');
    expect(outcome.reason).toContain('invalid_request');
    // Not condemned: no write, so the next attempt still tries.
    expect(updateMany).not.toHaveBeenCalled();

    await ensureFreshOAuthConfig({ serverId: SERVER_ID, authConfig, nowMs: NOW });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a 5xx as transient', async () => {
    global.fetch = jest.fn().mockResolvedValue(tokenResponse({}, 503)) as unknown as typeof fetch;

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('unavailable');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('treats a network failure as transient', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('unavailable');
    expect(outcome.reason).toContain('could not be reached');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('shares one refresh exchange between concurrent callers', async () => {
    const gate = deferred<Response>();
    const fetchMock = jest.fn(() => gate.promise);
    global.fetch = fetchMock as unknown as typeof fetch;
    const authConfig = enc(expiredConfig);

    const first = ensureFreshOAuthConfig({ serverId: SERVER_ID, authConfig, serverUrl: SERVER_URL, nowMs: NOW });
    const second = ensureFreshOAuthConfig({ serverId: SERVER_ID, authConfig, serverUrl: SERVER_URL, nowMs: NOW });

    gate.resolve(tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }));
    const [a, b] = await Promise.all([first, second]);

    // Two requests arriving while the token is expired must not each present the
    // same refresh token to a rotating provider.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(a.status).toBe('refreshed');
    expect(b.status).toBe('refreshed');
    expect(b.config?.accessToken).toBe('access-2');
  });

  it('adopts the winner when another writer persisted first', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 })) as unknown as typeof fetch;
    updateMany.mockResolvedValue({ count: 0 }); // compare-and-set lost
    findUnique.mockResolvedValue({
      authConfig: enc({
        ...expiredConfig,
        accessToken: 'access-winner',
        refreshToken: 'refresh-winner',
        expiresAt: nowSeconds + 3600,
      }),
    });

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    // The losing pair may already be invalidated at the provider, so a live stored
    // pair wins and is not overwritten.
    expect(outcome.status).toBe('refreshed');
    expect(outcome.config?.accessToken).toBe('access-winner');
    expect(update).not.toHaveBeenCalled();
  });

  it('reports a connection whose provider issued no refresh token as needing a human', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const noRefresh = { ...expiredConfig, refreshToken: undefined };

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(noRefresh),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('reconnect_required');
    expect(outcome.reason).toContain('no refresh token');
    expect(fetchMock).not.toHaveBeenCalled();
    const persisted = dec(updateMany.mock.calls[0][0].data.authConfig);
    expect(persisted.reconnectRequired.reason).toContain('no refresh token');
  });

  it('does not flag a connection that was never authorized', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const neverAuthorized = {
      clientId: 'client-abc',
      tokenUrl: TOKEN_URL,
      authorizeUrl: 'https://auth.example.com/oauth2/authorize',
      scopes: 'openid mcp',
    };

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(neverAuthorized),
      nowMs: NOW,
    });

    // Nothing has been authorized yet: the panel offers "Connect with OAuth", and
    // writing a reconnect verdict here would just be noise.
    expect(outcome.status).toBe('reconnect_required');
    expect(updateMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records the verdict once, then short-circuits on the marker alone', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const stale = { ...expiredConfig, refreshToken: undefined };

    const first = await ensureFreshOAuthConfig({ serverId: SERVER_ID, authConfig: enc(stale), nowMs: NOW });
    expect(first.status).toBe('reconnect_required');
    const marked = updateMany.mock.calls[0][0].data.authConfig as string;

    updateMany.mockClear();
    const second = await ensureFreshOAuthConfig({ serverId: SERVER_ID, authConfig: marked, nowMs: NOW });
    expect(second.status).toBe('reconnect_required');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('reports a missing or unreadable configuration without throwing', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    const missing = await ensureFreshOAuthConfig({ serverId: SERVER_ID, authConfig: null, nowMs: NOW });
    expect(missing.status).toBe('unavailable');

    const corrupt = await ensureFreshOAuthConfig({ serverId: SERVER_ID, authConfig: 'not-json', nowMs: NOW });
    expect(corrupt.status).toBe('unavailable');
    expect(corrupt.reason).toContain('could not be read');
  });
});

describe('skew must not be conflated with expiry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
  });

  it('serves a still-valid token and clears nothing when the connection cannot be refreshed', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const aliveButNotRefreshable = {
      ...expiredConfig,
      refreshToken: undefined,
      expiresAt: nowSeconds + 120,
    };

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(aliveButNotRefreshable),
      nowMs: NOW,
    });

    // Two minutes of life left is not "beyond automatic recovery".
    expect(outcome.status).toBe('fresh');
    expect(outcome.config?.accessToken).toBe('expired-access');
    expect(updateMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks the same connection terminal only once the token has actually expired', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const deadAndNotRefreshable = {
      ...expiredConfig,
      refreshToken: undefined,
      expiresAt: nowSeconds - 1,
    };

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(deadAndNotRefreshable),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('reconnect_required');
    const persisted = dec(updateMany.mock.calls[0][0].data.authConfig);
    expect(persisted.accessToken).toBeUndefined();
    expect(persisted.reconnectRequired).toBeDefined();
  });
});

describe('a successful exchange outranks a concurrent terminal verdict', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the pair it holds when the losing writer finds a reconnect-required marker', async () => {
    // A refreshes successfully; B, a concurrent caller whose token A just spent, is
    // rejected and writes its terminal verdict first. A's guarded write therefore
    // loses. A's pair is proof the connection is alive and must survive — adopting
    // B's marker would discard a working connection and report success for it.
    const fetchMock = jest
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: 'access-A', refresh_token: 'refresh-A', expires_in: 3600 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const deadMarker = enc(
      markReconnectRequired(expiredConfig, 'the provider rejected the stored refresh token', NOW)
    );
    updateMany
      .mockResolvedValueOnce({ count: 0 }) // our own guarded write loses to B
      .mockResolvedValueOnce({ count: 1 }); // re-assert against B's marker wins
    findUnique.mockResolvedValue({ authConfig: deadMarker });

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('refreshed');
    expect(outcome.config?.accessToken).toBe('access-A');
    expect(outcome.config?.reconnectRequired).toBeUndefined();
    // The re-assert was guarded against what the row actually held at that moment.
    expect(updateMany.mock.calls[1][0].where).toEqual({ id: SERVER_ID, authConfig: deadMarker });
    expect(dec(updateMany.mock.calls[1][0].data.authConfig).accessToken).toBe('access-A');
  });

  it('never reports refreshed when the pair it holds could not be stored', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: 'access-A', refresh_token: 'refresh-A' })) as unknown as typeof fetch;
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({
      authConfig: enc(markReconnectRequired(expiredConfig, 'rejected', NOW)),
    });
    update.mockRejectedValue(new Error('database unavailable'));

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    // Handing back tokens that are not in the row is the silent failure this guards.
    expect(outcome.status).toBe('unavailable');
    expect(outcome.reason).toContain('could not be stored');
  });

  it('keeps invalid_client retryable even when it arrives with a 401', async () => {
    const fetchMock = jest.fn().mockResolvedValue(tokenResponse({ error: 'invalid_client' }, 401));
    global.fetch = fetchMock as unknown as typeof fetch;

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    // A wrong client registration is not fixed by a human re-authorizing.
    expect(outcome.status).toBe('unavailable');
    expect(outcome.reason).toContain('invalid_client');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('still treats invalid_token as terminal', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(tokenResponse({ error: 'invalid_token' }, 400)) as unknown as typeof fetch;

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('reconnect_required');
  });
});
