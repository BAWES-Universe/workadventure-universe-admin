import { NextRequest } from 'next/server';
import { PATCH } from '@/app/api/bots/[id]/mcp-servers/[serverId]/route';
import { prisma } from '@/lib/db';

/**
 * Saving an OAuth connection's settings merges the edit onto the stored config, tokens
 * included. A token refresh can store a new pair between that read and the write; an
 * unguarded write would put the old, possibly already spent, pair back (#193 review).
 */

jest.mock('@/lib/db', () => ({
  prisma: {
    botMcpServer: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    bot: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
  },
}));

jest.mock('@/lib/auth-session', () => ({
  getSessionUser: jest.fn().mockResolvedValue({ id: 'user-1' }),
}));

jest.mock('@/lib/super-admin', () => ({
  isSuperAdmin: jest.fn(() => false),
}));

jest.mock('@/lib/encryption', () => ({
  encryptApiKey: (value: string) => `enc:${value}`,
  decryptApiKey: (value: string) => value.replace(/^enc:/, ''),
}));

const BOT_ID = 'bot-1';
const SERVER_ID = 'server-1';

const enc = (config: Record<string, unknown>) => `enc:${JSON.stringify(config)}`;
const dec = (encrypted: string) => JSON.parse(encrypted.replace(/^enc:/, ''));

const endpoints = {
  clientId: 'client-abc',
  authorizeUrl: 'https://auth.example.com/oauth2/authorize',
  tokenUrl: 'https://auth.example.com/oauth2/token',
};
const storedBefore = enc({ ...endpoints, scopes: 'mcp', accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: 1 });
// What a concurrent refresh stores while the save is in flight.
const storedAfterRefresh = enc({
  ...endpoints,
  scopes: 'mcp',
  accessToken: 'access-new',
  refreshToken: 'refresh-new',
  expiresAt: 2,
});

const findUnique = prisma.botMcpServer.findUnique as jest.Mock;
const update = prisma.botMcpServer.update as jest.Mock;
const updateMany = prisma.botMcpServer.updateMany as jest.Mock;

const serverRow = (authConfig: string) => ({
  id: SERVER_ID,
  botId: BOT_ID,
  name: 'OAuth Server',
  serverUrl: 'https://mcp.example.com/mcp',
  authType: 'oauth',
  authConfig,
  enabled: true,
  headers: null,
  lastTestedAt: null,
  lastTestResult: null,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
});

function save(authConfig: Record<string, unknown>) {
  return PATCH(
    new NextRequest(`http://localhost:3333/api/bots/${BOT_ID}/mcp-servers/${SERVER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authConfig: JSON.stringify(authConfig) }),
    }),
    { params: Promise.resolve({ id: BOT_ID, serverId: SERVER_ID }) }
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ id: BOT_ID, createdById: 'user-1' });
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ email: 'owner@example.com' });
});

describe('saving an OAuth connection guards against a concurrent token refresh', () => {
  it('writes only if the stored config is still the one the edit was merged onto', async () => {
    findUnique
      .mockResolvedValueOnce(serverRow(storedBefore)) // the route's initial read
      .mockResolvedValueOnce(serverRow('ignored')); // the record returned after the write
    updateMany.mockResolvedValueOnce({ count: 1 });

    const response = await save({ ...endpoints, scopes: 'mcp mcp:write' });

    expect(response.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: SERVER_ID, authConfig: storedBefore });
    const written = dec(updateMany.mock.calls[0][0].data.authConfig);
    expect(written.scopes).toBe('mcp mcp:write');
    expect(written.accessToken).toBe('access-old');
  });

  it('keeps the pair a refresh stored while the save was in flight', async () => {
    findUnique
      .mockResolvedValueOnce(serverRow(storedBefore)) // initial read, before the refresh
      .mockResolvedValueOnce({ authType: 'oauth', authConfig: storedAfterRefresh }) // re-read after losing
      .mockResolvedValueOnce(serverRow('ignored'));
    updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    const response = await save({ ...endpoints, scopes: 'mcp mcp:write' });

    expect(response.status).toBe(200);
    expect(updateMany).toHaveBeenCalledTimes(2);
    // The second attempt is merged onto, and guarded on, what the refresh stored.
    expect(updateMany.mock.calls[1][0].where).toEqual({ id: SERVER_ID, authConfig: storedAfterRefresh });
    const written = dec(updateMany.mock.calls[1][0].data.authConfig);
    expect(written.scopes).toBe('mcp mcp:write');
    expect(written.accessToken).toBe('access-new');
    expect(written.refreshToken).toBe('refresh-new');
  });

  it('still clears the tokens when the save switches provider, even after a concurrent refresh', async () => {
    findUnique
      .mockResolvedValueOnce(serverRow(storedBefore))
      .mockResolvedValueOnce({ authType: 'oauth', authConfig: storedAfterRefresh })
      .mockResolvedValueOnce(serverRow('ignored'));
    updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    const response = await save({ ...endpoints, tokenUrl: 'https://other-auth.example.com/token' });

    expect(response.status).toBe(200);
    const written = dec(updateMany.mock.calls[1][0].data.authConfig);
    expect(written.tokenUrl).toBe('https://other-auth.example.com/token');
    expect(written.accessToken).toBeNull();
    expect(written.refreshToken).toBeNull();
  });

  it('reports a conflict rather than writing blind when the config keeps changing', async () => {
    findUnique
      .mockResolvedValueOnce(serverRow(storedBefore))
      .mockResolvedValue({ authType: 'oauth', authConfig: storedAfterRefresh });
    updateMany.mockResolvedValue({ count: 0 });

    const response = await save({ ...endpoints, scopes: 'mcp mcp:write' });

    expect(response.status).toBe(409);
    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(update).not.toHaveBeenCalled();
  });
});
