import { NextRequest } from 'next/server';
import { GET } from '@/app/api/me/ai-keys/route';
import { DELETE } from '@/app/api/me/ai-keys/[id]/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { moveBotsOffKey } from '@/lib/ai-key-lend';
import { clearDownNotice } from '@/lib/ai-key-health';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    botsAiProvider: { findMany: jest.fn(), findFirst: jest.fn(), deleteMany: jest.fn() },
    botsAiUsage: { groupBy: jest.fn() },
    aiKeyLend: { findMany: jest.fn(async () => []) },
    bot: { findMany: jest.fn(async () => []) },
  },
}));
jest.mock('@/lib/ai-key-lend', () => ({ moveBotsOffKey: jest.fn(async () => ({ count: 0, universes: [] })) }));
jest.mock('@/lib/ai-key-health', () => ({ ...jest.requireActual('@/lib/ai-key-health'), clearDownNotice: jest.fn(async () => undefined) }));

const provider = prisma.botsAiProvider as unknown as Record<'findMany' | 'findFirst' | 'deleteMany', jest.Mock>;
const usage = prisma.botsAiUsage as unknown as { groupBy: jest.Mock };
const lendRows = (prisma as unknown as { aiKeyLend: { findMany: jest.Mock } }).aiKeyLend;
const botRows = (prisma as unknown as { bot: { findMany: jest.Mock } }).bot;
const alice = { id: 'user-a', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };

const row = {
  providerId: 'key-1', name: 'My DeepSeek', model: 'deepseek-v4-flash', endpoint: 'https://api.deepseek.com',
  apiKeyLast4: '4f2a', settings: { kind: 'deepseek' }, createdAt: new Date('2026-10-19T00:00:00Z'),
  // Fields a leak would come from: the list must never copy them out.
  apiKeyEncrypted: 'iv:tag:secret',
};

const list = () => GET(new NextRequest('http://localhost:3333/api/me/ai-keys'));
const revoke = (id: string) => DELETE(new NextRequest(`http://localhost:3333/api/me/ai-keys/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  jest.clearAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue(alice);
});

describe('GET /api/me/ai-keys', () => {
  it('needs a signed-in user', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await list()).status).toBe(401);
  });

  it('lists only the caller’s keys, with this month’s use, and never a key', async () => {
    provider.findMany.mockResolvedValue([row]);
    usage.groupBy.mockResolvedValue([{ providerId: 'key-1', _sum: { apiCalls: 12, tokensUsed: 3400 } }]);
    const response = await list();
    expect(provider.findMany.mock.calls[0][0].where).toEqual({ ownerId: 'user-a' });
    // Failed replies are not counted as replies.
    expect(usage.groupBy.mock.calls[0][0].where).toMatchObject({ providerId: { in: ['key-1'] }, error: false });
    const body = await response.json();
    expect(body.keys).toEqual([{
      id: 'key-1', name: 'My DeepSeek', kind: 'deepseek', kindLabel: 'DeepSeek', model: 'deepseek-v4-flash', address: null,
      last4: '4f2a', month: { replies: 12, tokens: 3400 }, lentTo: [], createdAt: '2026-10-19T00:00:00.000Z',
      status: 'working', downSince: null, downReason: null, ifDown: 'universe-ai',
    }]);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('says where a key is lent and which bots run on it there, with their replies this month', async () => {
    provider.findMany.mockResolvedValue([row]);
    usage.groupBy.mockImplementation(async ({ by }: { by: string[] }) =>
      by.includes('botId')
        ? [{ providerId: 'key-1', botId: 'b1', _sum: { apiCalls: 1240 } }]
        : [{ providerId: 'key-1', _sum: { apiCalls: 1240, tokensUsed: 412000 } }]);
    lendRows.findMany.mockResolvedValue([
      { providerId: 'key-1', universe: { id: 'bawes', name: 'BAWES Universe', ownerId: 'someone-else' } },
      { providerId: 'key-1', universe: { id: 'sandbox', name: 'Sandbox Universe', ownerId: 'user-a' } },
    ]);
    botRows.findMany.mockResolvedValue([
      { id: 'b1', name: 'Sam', aiProviderRef: 'key-1', room: { world: { universeId: 'bawes' } } },
      { id: 'b2', name: 'Elsewhere', aiProviderRef: 'key-1', room: { world: { universeId: 'not-lent-here' } } },
    ]);
    const [key] = (await (await list()).json()).keys;
    expect(key.lentTo).toEqual([
      { universeId: 'bawes', universeName: 'BAWES Universe', ownedByYou: false, bots: [{ id: 'b1', name: 'Sam', replies: 1240 }] },
      { universeId: 'sandbox', universeName: 'Sandbox Universe', ownedByYou: true, bots: [] },
    ]);
    // Only this key's lends and bots are read
    expect(lendRows.findMany.mock.calls[0][0].where).toEqual({ providerId: { in: ['key-1'] } });
    expect(botRows.findMany.mock.calls[0][0].where).toEqual({ aiProviderRef: { in: ['key-1'] } });
    lendRows.findMany.mockResolvedValue([]);
    botRows.findMany.mockResolvedValue([]);
    usage.groupBy.mockReset();
  });

  it('shows only the host of an own-computer key, never its path or query', async () => {
    provider.findMany.mockResolvedValue([{ ...row, name: 'My LM Studio', endpoint: 'https://lm.example.com/private/path?token=x', apiKeyLast4: null, settings: { kind: 'lmstudio' } }]);
    usage.groupBy.mockResolvedValue([]);
    const [key] = (await (await list()).json()).keys;
    expect(key.address).toBe('lm.example.com');
    expect(key.month).toEqual({ replies: 0, tokens: 0 });
  });

  it('answers with an empty list, with no usage lookup, for someone with no keys', async () => {
    provider.findMany.mockResolvedValue([]);
    expect(await (await list()).json()).toEqual({ keys: [] });
    expect(usage.groupBy).not.toHaveBeenCalled();
  });

  it('says so when it fails, never an empty list', async () => {
    provider.findMany.mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await list()).status).toBe(500);
    spy.mockRestore();
  });
});

describe('DELETE /api/me/ai-keys/:id', () => {
  it('needs a signed-in user', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await revoke('key-1')).status).toBe(401);
    expect(provider.deleteMany).not.toHaveBeenCalled();
  });

  it('revokes the caller’s own key, matching on owner so no one else’s can go', async () => {
    provider.findFirst.mockResolvedValue({ providerId: 'key-1' });
    provider.deleteMany.mockResolvedValue({ count: 1 });
    const response = await revoke('key-1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'revoked', moved: 0 });
    expect(provider.findFirst).toHaveBeenCalledWith({ where: { providerId: 'key-1', ownerId: 'user-a' }, select: { providerId: true } });
    expect(provider.deleteMany).toHaveBeenCalledWith({ where: { providerId: 'key-1', ownerId: 'user-a' } });
  });

  it('moves the bots on the key to Universe AI before it is deleted, and says how many', async () => {
    provider.findFirst.mockResolvedValue({ providerId: 'key-1' });
    provider.deleteMany.mockResolvedValue({ count: 1 });
    const order: string[] = [];
    (moveBotsOffKey as jest.Mock).mockImplementationOnce(async () => {
      order.push('moved');
      return { count: 2, universes: [] };
    });
    provider.deleteMany.mockImplementationOnce(async () => {
      order.push('deleted');
      return { count: 1 };
    });
    const response = await revoke('key-1');
    expect(await response.json()).toEqual({ status: 'revoked', moved: 2 });
    expect(order).toEqual(['moved', 'deleted']);
    expect(moveBotsOffKey).toHaveBeenCalledWith('key-1', { actor: { id: 'user-a', name: 'A' }, why: 'revoked' });
  });

  it('dismisses the key’s "is down" notice when the key is revoked, and still revokes if that fails', async () => {
    provider.findFirst.mockResolvedValue({ providerId: 'key-1' });
    provider.deleteMany.mockResolvedValue({ count: 1 });
    expect((await revoke('key-1')).status).toBe(200);
    expect(clearDownNotice).toHaveBeenCalledWith('user-a', 'key-1');
    (clearDownNotice as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await revoke('key-1');
    quiet.mockRestore();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'revoked', moved: 0 });
  });

  it('gives the same "not found" for someone else’s key and for a server provider, and moves nothing', async () => {
    provider.findFirst.mockResolvedValue(null);
    expect((await revoke('key-of-bob')).status).toBe(404);
    expect((await revoke('deepseek-flash')).status).toBe(404);
    expect(moveBotsOffKey).not.toHaveBeenCalled();
    expect(provider.deleteMany).not.toHaveBeenCalled();
  });
});
