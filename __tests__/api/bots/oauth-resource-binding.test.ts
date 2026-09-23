import { NextRequest } from 'next/server';
import { GET as oauthStart } from '@/app/api/bots/[id]/mcp-servers/[serverId]/oauth/start/route';
import { GET as oauthCallback } from '@/app/api/oauth/mcp-callback/route';
import { prisma } from '@/lib/db';
import * as authSession from '@/lib/auth-session';

/**
 * RFC 8707 resource indicator (#185).
 *
 * MCP clients MUST send `resource`, addressed to the MCP server's canonical URI,
 * on BOTH the authorization request and the token request — regardless of whether
 * the authorization server supports it. Servers that enforce audience binding
 * reject tokens that are not addressed to them with 401 invalid_token, so a flow
 * that omits it silently produces unusable tokens.
 *
 * These tests pin both requests to the connection's stored serverUrl, used
 * verbatim.
 */

jest.mock('@/lib/db', () => ({
  prisma: {
    botMcpServer: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    bot: {
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock('@/lib/auth-session', () => ({
  getSessionUser: jest.fn(),
}));

jest.mock('@/lib/super-admin', () => ({
  isSuperAdmin: jest.fn(() => false),
}));

// The real module encrypts with AES-256-GCM; a reversible stub keeps the tests
// about request construction rather than crypto.
jest.mock('@/lib/encryption', () => ({
  encryptApiKey: (value: string) => `enc:${value}`,
  decryptApiKey: (value: string) => value.replace(/^enc:/, ''),
}));

const ADMIN_BASE = 'https://admin.example.com';
const MCP_SERVER_URL = 'https://mcp.example.com/mcp';
const TOKEN_URL = 'https://auth.example.com/oauth2/token';
const AUTHORIZE_URL = 'https://auth.example.com/oauth2/authorize';
const BOT_ID = 'bot-1';
const SERVER_ID = 'server-1';

const providerConfig = {
  clientId: 'client-abc',
  authorizeUrl: AUTHORIZE_URL,
  tokenUrl: TOKEN_URL,
  scopes: 'openid mcp',
};

const getSessionUser = authSession.getSessionUser as jest.Mock;
const findUnique = prisma.botMcpServer.findUnique as jest.Mock;
const update = prisma.botMcpServer.update as jest.Mock;

const originalEnv = process.env;
const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...originalEnv,
    ADMIN_API_URL: ADMIN_BASE,
    CORS_ALLOWED_ORIGINS: ADMIN_BASE,
  };
  getSessionUser.mockResolvedValue({ id: 'user-1' });
});

afterAll(() => {
  process.env = originalEnv;
  global.fetch = originalFetch;
});

describe('OAuth authorization request carries the RFC 8707 resource indicator', () => {
  it('adds resource=<stored serverUrl> to the authorize URL, verbatim', async () => {
    findUnique.mockResolvedValue({
      id: SERVER_ID,
      botId: BOT_ID,
      authType: 'oauth',
      authConfig: `enc:${JSON.stringify(providerConfig)}`,
      serverUrl: MCP_SERVER_URL,
      bot: { id: BOT_ID, createdById: 'user-1', name: 'Test bot' },
    });

    const request = new NextRequest(
      `${ADMIN_BASE}/api/bots/${BOT_ID}/mcp-servers/${SERVER_ID}/oauth/start`
    );
    const response = await oauthStart(request, {
      params: Promise.resolve({ id: BOT_ID, serverId: SERVER_ID }),
    });

    expect(response.status).toBe(200);
    const { authorizeUrl } = await response.json();
    const url = new URL(authorizeUrl);

    // The value under test: byte-identical to the stored serverUrl, no normalization.
    expect(url.searchParams.get('resource')).toBe(MCP_SERVER_URL);

    // The rest of the request is intact.
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(`${ADMIN_BASE}/api/oauth/mcp-callback`);
    expect(url.searchParams.get('scope')).toBe('openid mcp');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('emits it once, not duplicated', async () => {
    findUnique.mockResolvedValue({
      id: SERVER_ID,
      botId: BOT_ID,
      authType: 'oauth',
      authConfig: `enc:${JSON.stringify(providerConfig)}`,
      serverUrl: MCP_SERVER_URL,
      bot: { id: BOT_ID, createdById: 'user-1', name: 'Test bot' },
    });

    const request = new NextRequest(
      `${ADMIN_BASE}/api/bots/${BOT_ID}/mcp-servers/${SERVER_ID}/oauth/start`
    );
    const response = await oauthStart(request, {
      params: Promise.resolve({ id: BOT_ID, serverId: SERVER_ID }),
    });
    const { authorizeUrl } = await response.json();

    expect(authorizeUrl.match(/[?&]resource=/g)).toHaveLength(1);
  });

  it('omits the parameter entirely when the row has no server URL', async () => {
    // An empty value would emit `resource=`, which some authorization servers reject
    // as malformed — a worse outcome than omitting it. The token request guards the
    // same way; the two call sites must not differ.
    findUnique.mockResolvedValue({
      id: SERVER_ID,
      botId: BOT_ID,
      authType: 'oauth',
      authConfig: `enc:${JSON.stringify(providerConfig)}`,
      serverUrl: '',
      bot: { id: BOT_ID, createdById: 'user-1', name: 'Test bot' },
    });

    const request = new NextRequest(
      `${ADMIN_BASE}/api/bots/${BOT_ID}/mcp-servers/${SERVER_ID}/oauth/start`
    );
    const response = await oauthStart(request, {
      params: Promise.resolve({ id: BOT_ID, serverId: SERVER_ID }),
    });
    const { authorizeUrl } = await response.json();
    const url = new URL(authorizeUrl);

    expect(url.searchParams.has('resource')).toBe(false);
    expect(authorizeUrl).not.toContain('resource=');
    // The rest of the authorization request is unaffected.
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('OAuth token request carries the RFC 8707 resource indicator', () => {
  const stateToken = `enc:${JSON.stringify({
    botId: BOT_ID,
    serverId: SERVER_ID,
    redirectUrl: `${ADMIN_BASE}/admin/bots/${BOT_ID}`,
    codeVerifier: 'test-code-verifier',
    redirectUri: `${ADMIN_BASE}/api/oauth/mcp-callback`,
    exp: Math.floor(Date.now() / 1000) + 600,
  })}`;

  it('includes resource=<stored serverUrl> in the code exchange body', async () => {
    findUnique.mockResolvedValue({
      id: SERVER_ID,
      botId: BOT_ID,
      authType: 'oauth',
      authConfig: `enc:${JSON.stringify(providerConfig)}`,
      serverUrl: MCP_SERVER_URL,
    });
    update.mockResolvedValue({ id: SERVER_ID });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const request = new NextRequest(
      `${ADMIN_BASE}/api/oauth/mcp-callback?code=auth-code-1&state=${encodeURIComponent(stateToken)}`
    );
    const response = await oauthCallback(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(TOKEN_URL);

    const body = new URLSearchParams(init.body as string);
    expect(body.get('resource')).toBe(MCP_SERVER_URL);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-1');
    expect(body.get('client_id')).toBe('client-abc');
    expect(body.get('code_verifier')).toBe('test-code-verifier');
    expect(body.get('redirect_uri')).toBe(`${ADMIN_BASE}/api/oauth/mcp-callback`);

    // The flow still completes: tokens persisted, endpoints preserved.
    expect(update).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(
      (update.mock.calls[0][0].data.authConfig as string).replace(/^enc:/, '')
    );
    expect(persisted.accessToken).toBe('access-1');
    expect(persisted.refreshToken).toBe('refresh-1');
    expect(persisted.tokenUrl).toBe(TOKEN_URL);
    expect(persisted.authorizeUrl).toBe(AUTHORIZE_URL);
    expect(persisted.clientId).toBe('client-abc');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('oauth=success');
  });

  it('does not send a resource when the row has none (defensive)', async () => {
    findUnique.mockResolvedValue({
      id: SERVER_ID,
      botId: BOT_ID,
      authType: 'oauth',
      authConfig: `enc:${JSON.stringify(providerConfig)}`,
      serverUrl: '',
    });
    update.mockResolvedValue({ id: SERVER_ID });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'access-1', expires_in: 3600 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const request = new NextRequest(
      `${ADMIN_BASE}/api/oauth/mcp-callback?code=auth-code-2&state=${encodeURIComponent(stateToken)}`
    );
    await oauthCallback(request);

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get('resource')).toBeNull();
  });
});

describe('the token resource is bound to the authorization, not re-read from the row', () => {
  const stateWithResource = `enc:${JSON.stringify({
    botId: BOT_ID,
    serverId: SERVER_ID,
    redirectUrl: `${ADMIN_BASE}/admin/bots/${BOT_ID}`,
    codeVerifier: 'test-code-verifier',
    redirectUri: `${ADMIN_BASE}/api/oauth/mcp-callback`,
    resource: MCP_SERVER_URL,
    exp: Math.floor(Date.now() / 1000) + 600,
  })}`;

  it('stores the resource in the state token it hands to the provider', async () => {
    findUnique.mockResolvedValue({
      id: SERVER_ID,
      botId: BOT_ID,
      authType: 'oauth',
      authConfig: `enc:${JSON.stringify(providerConfig)}`,
      serverUrl: MCP_SERVER_URL,
      bot: { id: BOT_ID, createdById: 'user-1', name: 'Test bot' },
    });

    const response = await oauthStart(
      new NextRequest(`${ADMIN_BASE}/api/bots/${BOT_ID}/mcp-servers/${SERVER_ID}/oauth/start`),
      { params: Promise.resolve({ id: BOT_ID, serverId: SERVER_ID }) }
    );

    const { authorizeUrl } = await response.json();
    const state = new URL(authorizeUrl).searchParams.get('state') as string;
    const payload = JSON.parse(state.replace(/^enc:/, ''));

    // Without this the token request could only re-read the row, and an edit during the
    // state's ten-minute lifetime would leave the two requests naming different resources.
    expect(payload.resource).toBe(MCP_SERVER_URL);
  });

  it('refuses the exchange when the row was repointed while the authorization was in flight', async () => {
    findUnique.mockResolvedValue({
      id: SERVER_ID,
      botId: BOT_ID,
      authType: 'oauth',
      authConfig: `enc:${JSON.stringify(providerConfig)}`,
      serverUrl: 'https://moved.example.com/mcp',
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await oauthCallback(
      new NextRequest(
        `${ADMIN_BASE}/api/oauth/mcp-callback?code=auth-code-3&state=${encodeURIComponent(stateWithResource)}`
      )
    );

    // Exchanging it would store a token addressed to the URL the flow was started for
    // against a row that now names a different server: a connection that reports success
    // and then 401s on its next use.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('message=server_url_changed');
  });

  it('exchanges against the state resource when the row still matches', async () => {
    findUnique.mockResolvedValue({
      id: SERVER_ID,
      botId: BOT_ID,
      authType: 'oauth',
      authConfig: `enc:${JSON.stringify(providerConfig)}`,
      serverUrl: MCP_SERVER_URL,
    });
    update.mockResolvedValue({ id: SERVER_ID });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'access-1', expires_in: 3600 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await oauthCallback(
      new NextRequest(
        `${ADMIN_BASE}/api/oauth/mcp-callback?code=auth-code-4&state=${encodeURIComponent(stateWithResource)}`
      )
    );

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get('resource')).toBe(MCP_SERVER_URL);
    expect(update).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('oauth=success');
  });
});
