import { ensureFreshOAuthConfig } from '@/lib/mcp/oauth-refresh';
import { markReconnectRequired } from '@/lib/mcp/oauth-token';
import { checkOutboundUrl } from '@/lib/mcp/outbound-guard';
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

// The destination check resolves DNS; tests decide its verdict instead.
jest.mock('@/lib/mcp/outbound-guard', () => ({
  checkOutboundUrl: jest.fn(),
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
const outboundCheck = checkOutboundUrl as jest.Mock;
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
    outboundCheck.mockResolvedValue({ allowed: true });
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

  it('keeps a 401 with no error code retryable, and keeps the tokens', async () => {
    // RFC 6749 §5.2 uses 401 for client-authentication failure, and a proxy in front of
    // the provider can answer 401 too. Neither proves the refresh token is dead, and a
    // terminal verdict would delete it for good (#193 review).
    global.fetch = jest.fn().mockResolvedValue(tokenResponse({}, 401)) as unknown as typeof fetch;

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('unavailable');
    expect(outcome.reason).toContain('HTTP 401');
    expect(updateMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps an HTML 401 from a proxy retryable', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('<html><body>401 Authorization Required</body></html>', {
        status: 401,
        headers: { 'content-type': 'text/html' },
      })
    ) as unknown as typeof fetch;

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('unavailable');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not send the refresh token to a destination that fails the outbound check', async () => {
    outboundCheck.mockResolvedValue({ allowed: false, error: 'Server resolves to private IP range (10.x.x.x)' });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    expect(outboundCheck).toHaveBeenCalledWith(TOKEN_URL);
    expect(fetchMock).not.toHaveBeenCalled();
    // Not the refresh token's fault: nothing is deleted or marked for a human.
    expect(outcome.status).toBe('unavailable');
    expect(outcome.reason).toContain('not an allowed destination');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('checks the token endpoint before every refresh request', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('refreshed');
    expect(outboundCheck).toHaveBeenCalledWith(TOKEN_URL);
    expect(outboundCheck.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
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

describe('a terminal verdict and the credentials it hands back agree', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue(null);
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('serves the config it wrote, not the pre-verdict blob with the dead token', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const noRefresh = { ...expiredConfig, refreshToken: undefined };

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(noRefresh),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('reconnect_required');
    // The caller serves `authConfig` to the bot as its credentials while deriving
    // "connected" from `config`: returning the pre-verdict blob made one payload declare
    // a reconnect was required and carry the dead access token the bot would present.
    const served = dec(outcome.authConfig as string);
    expect(served.accessToken).toBeUndefined();
    expect(served.refreshToken).toBeUndefined();
    expect(served.reconnectRequired.reason).toContain('no refresh token');
    // Exactly what the guarded write persisted, and the same config the outcome reports.
    expect(outcome.authConfig).toBe(updateMany.mock.calls[0][0].data.authConfig);
    expect(served).toEqual(outcome.config);
  });

  it('adopts a live pair another writer stored instead of recording the verdict', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const noRefresh = { ...expiredConfig, refreshToken: undefined };
    updateMany.mockResolvedValue({ count: 0 }); // the verdict loses the compare-and-set
    findUnique.mockResolvedValue({
      authConfig: enc({
        ...expiredConfig,
        accessToken: 'access-just-authorized',
        refreshToken: 'refresh-just-authorized',
        expiresAt: nowSeconds + 3600,
      }),
    });

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(noRefresh),
      nowMs: NOW,
    });

    // A human re-authorized while this call was in flight: their pair is the live one.
    expect(outcome.status).toBe('refreshed');
    expect(outcome.config?.accessToken).toBe('access-just-authorized');
    expect(dec(outcome.authConfig as string).accessToken).toBe('access-just-authorized');
  });

  it("never serves another writer's dead token when the verdict cannot be persisted", async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const noRefresh = { ...expiredConfig, refreshToken: undefined };
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({
      authConfig: enc({ ...expiredConfig, accessToken: 'dead-elsewhere' }),
    });

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(noRefresh),
      nowMs: NOW,
    });

    // `config` is what a caller reads to decide whether the connection is connected, so a
    // token-bearing blob here would be reported as a live connection whose token just failed.
    expect(outcome.status).toBe('reconnect_required');
    const served = dec(outcome.authConfig as string);
    expect(served.accessToken).toBeUndefined();
    expect(served.reconnectRequired.reason).toContain('no refresh token');
    expect(served).toEqual(outcome.config);
  });

  it('still serves a verdict consistent with itself when nothing could be written', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const noRefresh = { ...expiredConfig, refreshToken: undefined };
    updateMany.mockRejectedValue(new Error('database unavailable'));

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(noRefresh),
      nowMs: NOW,
    });

    expect(outcome.status).toBe('reconnect_required');
    const served = dec(outcome.authConfig as string);
    expect(served.accessToken).toBeUndefined();
    expect(served).toEqual(outcome.config);
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

  it('re-offers its pair through a guarded write, never a blind one', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: 'access-A', refresh_token: 'refresh-A' })) as unknown as typeof fetch;
    // Our guarded write keeps losing: the row holds a terminal verdict and our CAS
    // against it never lands.
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ authConfig: enc(markReconnectRequired(expiredConfig, 'rejected', NOW)) });

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    // A blind write here would clobber a pair another process stored in the window
    // between the read and the write — and against a rotating provider that pair is the
    // only one still valid, so the connection would never refresh again.
    expect(update).not.toHaveBeenCalled();
    expect(updateMany.mock.calls.length).toBeGreaterThan(1);
    for (const [args] of updateMany.mock.calls) {
      expect(args.where).toEqual({ id: SERVER_ID, authConfig: expect.any(String) });
    }
    expect(outcome.status).toBe('unavailable');
    expect(outcome.reason).toContain('could not be stored');
  });

  it('adopts a pair that lands while it is retrying, instead of storing its own', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: 'access-A', refresh_token: 'refresh-A' })) as unknown as typeof fetch;
    updateMany.mockResolvedValue({ count: 0 });
    const freshPair = enc({
      ...expiredConfig,
      accessToken: 'access-C',
      refreshToken: 'refresh-C',
      expiresAt: nowSeconds + 3600,
    });
    findUnique
      .mockResolvedValueOnce({ authConfig: enc(markReconnectRequired(expiredConfig, 'rejected', NOW)) }) // read: nothing usable
      .mockResolvedValue({ authConfig: freshPair }); // a third writer lands a live pair

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    // The live pair wins: the row's token is the one the provider considers current.
    expect(outcome.status).toBe('refreshed');
    expect(outcome.config?.accessToken).toBe('access-C');
    expect(outcome.authConfig).toBe(freshPair);
    expect(update).not.toHaveBeenCalled();
  });

  it('never reports refreshed when the pair it holds could not be stored', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: 'access-A', refresh_token: 'refresh-A' })) as unknown as typeof fetch;
    // The guarded write itself throws, rather than losing the compare-and-set. This is the
    // catch around the first persistIfUnchanged call; the count:0 variant below only
    // re-covered the retry-exhaustion path, which the test above already pins (#190 review).
    updateMany.mockRejectedValue(new Error('database unavailable'));
    findUnique.mockResolvedValue({ authConfig: null });

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    // Handing back tokens that are not in the row is the silent failure this guards.
    expect(outcome.status).toBe('unavailable');
    expect(outcome.reason).toContain('could not be stored');
  });

  it('honours a numeric-string expires_in from the provider', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: '3600' })
      ) as unknown as typeof fetch;
    updateMany.mockResolvedValue({ count: 1 });

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    // Dropped, the duration records no expiry and the new token is never refreshed ahead
    // of time (#190 review).
    expect(outcome.status).toBe('refreshed');
    expect(outcome.config?.expiresAt).toBe(nowSeconds + 3600);
    expect(dec(updateMany.mock.calls[0][0].data.authConfig).expiresAt).toBe(nowSeconds + 3600);
  });

  it('records no expiry when the response omits expires_in, rather than the old expired one', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2' })) as unknown as typeof fetch;
    updateMany.mockResolvedValue({ count: 1 });

    const outcome = await ensureFreshOAuthConfig({
      serverId: SERVER_ID,
      authConfig: enc(expiredConfig),
      nowMs: NOW,
    });

    // expiresAt here is already in the past (that is why we refreshed), so inheriting it
    // would mark the brand-new token stale on arrival.
    expect(outcome.status).toBe('refreshed');
    expect(outcome.config?.expiresAt).toBeNull();
    expect(dec(updateMany.mock.calls[0][0].data.authConfig).expiresAt).toBeNull();
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
