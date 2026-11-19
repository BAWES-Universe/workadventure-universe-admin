import { NextRequest } from 'next/server';
import { POST as testRoute } from '@/app/api/bots/[id]/mcp-servers/[serverId]/test/route';
import { GET as oauthStart } from '@/app/api/bots/[id]/mcp-servers/[serverId]/oauth/start/route';
import { ensureFreshOAuthConfig } from '@/lib/mcp/oauth-refresh';
import { testMcpConnection } from '@/lib/mcp/test-connection';
import { managesConnection } from '@/lib/app-team-access';
import { beginConnectionSignIn } from '@/lib/app-connections';
import { prisma } from '@/lib/db';
import * as authSession from '@/lib/auth-session';

/**
 * An app lent by someone else (or a universe's own) is handled only by whoever manages the app itself, never by a bot's manager
 * alone. The sign-in start already said so; the connection test did not, and a test uses the lender's sign-in and may renew their
 * token. And the admin token, which is no person, must not start a sign-in on a connection: its return is refused, and starting it
 * replaced the sign-in the owner may be in the middle of.
 */

jest.mock('@/lib/db', () => ({
  prisma: {
    botMcpServer: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
    bot: { findUnique: jest.fn() },
  },
}));
jest.mock('@/lib/bot-permissions', () => ({ canManageBotMcpServers: jest.fn().mockResolvedValue(true) }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/app-team-access', () => ({ managesConnection: jest.fn() }));
jest.mock('@/lib/mcp/oauth-refresh', () => ({ ensureFreshOAuthConfig: jest.fn() }));
jest.mock('@/lib/mcp/test-connection', () => ({ testMcpConnection: jest.fn() }));
jest.mock('@/lib/app-connections', () => ({
  WITH_CONNECTION: { connection: true },
  effectiveServer: (row: Record<string, unknown>) => ({ ...row, ...(row.connection as object) }),
  newSignInNonce: jest.fn().mockResolvedValue('nonce-1'),
  beginConnectionSignIn: jest.fn().mockResolvedValue({ nonce: 'nonce-1', generation: 1 }),
  newSignInGeneration: jest.fn().mockResolvedValue(1),
}));
jest.mock('@/lib/github/check', () => ({ testGitHub: jest.fn() }));
jest.mock('@/lib/app-adapter/ready-made', () => ({ testReadyMade: jest.fn() }));
jest.mock('@/lib/encryption', () => ({ encryptApiKey: (v: string) => `enc:${v}`, decryptApiKey: (v: string) => v.replace(/^enc:/, '') }));

const BASE = 'https://admin.example.com';
const BOT_ID = 'bot-1';
const SERVER_ID = 'server-1';
const lenderConnection = {
  id: 'conn-1',
  ownerId: 'lender',
  universeId: null,
  kind: 'oauth',
  source: 'mcp',
  authType: 'oauth',
  authConfig: `enc:${JSON.stringify({ clientId: 'c', authorizeUrl: 'https://auth.example.com/authorize', tokenUrl: 'https://auth.example.com/token' })}`,
  serverUrl: 'https://mcp.example.com/mcp',
  headers: null,
};
const grant = { id: SERVER_ID, botId: BOT_ID, connectionId: 'conn-1', connection: lenderConnection, bot: { id: BOT_ID, name: 'B' } };

const findUnique = prisma.botMcpServer.findUnique as jest.Mock;
const getSessionUser = authSession.getSessionUser as jest.Mock;
const manages = managesConnection as jest.Mock;
const params = { params: Promise.resolve({ id: BOT_ID, serverId: SERVER_ID }) };
const postTest = () => testRoute(new NextRequest(`${BASE}/api/bots/${BOT_ID}/mcp-servers/${SERVER_ID}/test`, { method: 'POST' }), params);
const startSignIn = (headers?: Record<string, string>) =>
  oauthStart(new NextRequest(`${BASE}/api/bots/${BOT_ID}/mcp-servers/${SERVER_ID}/oauth/start`, { headers }), params);

const originalEnv = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...originalEnv, ADMIN_API_URL: BASE, CORS_ALLOWED_ORIGINS: BASE, ADMIN_API_TOKEN: 'admin-secret' };
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ email: 'x@example.com' });
  (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ id: BOT_ID, createdById: 'bot-manager', roomId: 'r', ownerId: null, deletedAt: null });
  findUnique.mockResolvedValue(grant);
});
afterAll(() => {
  process.env = originalEnv;
});

describe('testing a connection', () => {
  it('refuses a bot manager who does not manage the lent app, before the lender’s sign-in is used or renewed', async () => {
    getSessionUser.mockResolvedValue({ id: 'bot-manager' });
    manages.mockResolvedValue(false);
    const response = await postTest();
    expect(response.status).toBe(403);
    expect(ensureFreshOAuthConfig).not.toHaveBeenCalled();
    expect(testMcpConnection).not.toHaveBeenCalled();
    expect(prisma.botMcpServer.update).not.toHaveBeenCalled();
  });

  it('lets the person who manages the app test it', async () => {
    getSessionUser.mockResolvedValue({ id: 'lender' });
    manages.mockResolvedValue(true);
    (ensureFreshOAuthConfig as jest.Mock).mockResolvedValue({ status: 'ok', authConfig: lenderConnection.authConfig });
    (testMcpConnection as jest.Mock).mockResolvedValue({ success: true, toolCount: 1, toolNames: ['a'] });
    const response = await postTest();
    expect(response.status).toBe(200);
    expect(testMcpConnection).toHaveBeenCalledTimes(1);
  });
});

describe('starting a sign-in with the admin token', () => {
  it('is refused for an app on a connection, and leaves the owner’s pending sign-in alone', async () => {
    getSessionUser.mockResolvedValue(null);
    const response = await startSignIn({ authorization: 'Bearer admin-secret' });
    expect(response.status).toBe(403);
    expect(beginConnectionSignIn).not.toHaveBeenCalled();
  });

  it('still works for a bot’s own app (no connection, nothing to replace)', async () => {
    getSessionUser.mockResolvedValue(null);
    findUnique.mockResolvedValue({
      id: SERVER_ID,
      botId: BOT_ID,
      connectionId: null,
      connection: null,
      authType: lenderConnection.authType,
      authConfig: lenderConnection.authConfig,
      serverUrl: lenderConnection.serverUrl,
      bot: grant.bot,
    });
    const response = await startSignIn({ authorization: 'Bearer admin-secret' });
    expect(response.status).toBe(200);
    expect(beginConnectionSignIn).not.toHaveBeenCalled();
  });
});
