import { NextRequest } from 'next/server';
import { GET } from '@/app/api/me/ai-keys/route';
import { DELETE } from '@/app/api/me/ai-keys/[id]/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    botsAiProvider: { findMany: jest.fn(), deleteMany: jest.fn() },
    botsAiUsage: { groupBy: jest.fn() },
  },
}));

const provider = prisma.botsAiProvider as unknown as Record<'findMany' | 'deleteMany', jest.Mock>;
const usage = prisma.botsAiUsage as unknown as { groupBy: jest.Mock };
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
      last4: '4f2a', month: { replies: 12, tokens: 3400 }, createdAt: '2026-10-19T00:00:00.000Z',
    }]);
    expect(JSON.stringify(body)).not.toContain('secret');
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
    provider.deleteMany.mockResolvedValue({ count: 1 });
    expect((await revoke('key-1')).status).toBe(200);
    expect(provider.deleteMany).toHaveBeenCalledWith({ where: { providerId: 'key-1', ownerId: 'user-a' } });
  });

  it('gives the same "not found" for someone else’s key and for a server provider', async () => {
    provider.deleteMany.mockResolvedValue({ count: 0 });
    expect((await revoke('key-of-bob')).status).toBe(404);
    expect((await revoke('deepseek-flash')).status).toBe(404);
  });
});
