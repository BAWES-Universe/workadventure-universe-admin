import { NextRequest } from 'next/server';
import { POST } from '@/app/api/bots/[id]/mcp-servers/[serverId]/test/route';
import { prisma } from '@/lib/db';
import * as authSession from '@/lib/auth-session';
import * as superAdmin from '@/lib/super-admin';

/**
 * A failing connection test must store the cause, not just the status text (#186).
 *
 * `HTTP 401: Unauthorized` is true and useless. The response body carries the
 * error code (`invalid_token`) and the WWW-Authenticate header points at the
 * resource-metadata document that explains the rejection; both were previously
 * read off the socket and thrown away.
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

jest.mock('@/lib/encryption', () => ({
  encryptApiKey: (value: string) => `encrypted:${value}`,
  decryptApiKey: (value: string) => value.replace('encrypted:', ''),
}));

jest.mock('dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

const BOT_ID = 'bot-123';
const USER_ID = 'user-456';
const SERVER_ID = 'server-789';
const MCP_URL = 'https://mcp.example.com/mcp';

const WWW_AUTHENTICATE =
  'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp"';

const originalFetch = global.fetch;

function postTest() {
  return POST(
    new NextRequest(`https://admin.example.com/api/bots/${BOT_ID}/mcp-servers/${SERVER_ID}/test`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ id: BOT_ID, serverId: SERVER_ID }) }
  );
}

function storedResult() {
  return (prisma.botMcpServer.update as jest.Mock).mock.calls[0][0].data.lastTestResult;
}

describe('MCP connection test: failure detail is captured, not discarded', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (authSession.getSessionUser as jest.Mock).mockResolvedValue({
      id: USER_ID,
      uuid: USER_ID,
      email: 'owner@example.com',
      name: 'Owner',
      tags: [],
      isSuperAdmin: false,
    });
    (superAdmin.isSuperAdmin as jest.Mock).mockReturnValue(false);
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ id: BOT_ID, createdById: USER_ID });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ email: 'owner@example.com' });
    (prisma.botMcpServer.findUnique as jest.Mock).mockResolvedValue({
      id: SERVER_ID,
      botId: BOT_ID,
      name: 'Test MCP',
      serverUrl: MCP_URL,
      authType: 'bearer',
      authConfig: 'encrypted:stored-key',
      headers: null,
      enabled: true,
    });
    (prisma.botMcpServer.update as jest.Mock).mockResolvedValue({ id: SERVER_ID });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('stores the error code and WWW-Authenticate header from a 401', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_token' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'www-authenticate': WWW_AUTHENTICATE },
      })
    ) as unknown as typeof fetch;

    const response = await postTest();
    const body = await response.json();

    expect(body.success).toBe(false);
    expect(body.status).toBe(401);
    expect(body.statusText).toBe('Unauthorized');
    expect(body.errorCode).toBe('invalid_token');
    expect(body.wwwAuthenticate).toBe(WWW_AUTHENTICATE);
    // The message the UI shows now names the cause too.
    expect(body.error).toContain('HTTP 401');
    expect(body.error).toContain('invalid_token');

    const persisted = storedResult();
    expect(persisted.success).toBe(false);
    expect(persisted.status).toBe(401);
    expect(persisted.errorCode).toBe('invalid_token');
    expect(persisted.wwwAuthenticate).toBe(WWW_AUTHENTICATE);
    expect(persisted.errorBody).toContain('invalid_token');
    expect((prisma.botMcpServer.update as jest.Mock).mock.calls[0][0].data.lastTestedAt).toBeInstanceOf(Date);
  });

  it('never stores credential material echoed back by a server', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'bad_request', access_token: 'super-secret-value' }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'www-authenticate': 'Bearer error="invalid_request"' },
      })
    ) as unknown as typeof fetch;

    const body = await (await postTest()).json();

    expect(body.errorCode).toBe('bad_request');
    expect(JSON.stringify(body)).not.toContain('super-secret-value');
    // The RFC 6750 challenge stays readable — it is the diagnostic, not a secret.
    expect(body.wwwAuthenticate).toBe('Bearer error="invalid_request"');

    const persisted = JSON.stringify(storedResult());
    expect(persisted).not.toContain('super-secret-value');
    // Nor the bearer key we sent ourselves.
    expect(persisted).not.toContain('stored-key');
  });

  it('records success without failure detail', async () => {
    const fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as { method?: string };
      if (payload.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'init',
            result: { protocolVersion: '2024-11-05', capabilities: {} },
          }),
          {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
          }
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          result: { tools: [{ name: 'list_meetings' }, { name: 'create_task' }] },
        }),
        { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' } }
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const body = await (await postTest()).json();

    expect(body.success).toBe(true);
    expect(body.toolCount).toBe(2);
    expect(body.errorCode ?? null).toBeNull();

    const persisted = storedResult();
    expect(persisted.success).toBe(true);
    expect(persisted.toolCount).toBe(2);
    expect(persisted.errorCode).toBeNull();
    expect(persisted.wwwAuthenticate).toBeNull();
  });
});
