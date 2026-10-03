import { NextRequest } from 'next/server';
import { GET } from '@/app/api/bots/[id]/dm-access/route';
import { prisma } from '@/lib/db';
import { isSuperAdmin } from '@/lib/super-admin';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn() },
    user: { findFirst: jest.fn() },
    ban: { findFirst: jest.fn() },
    worldMember: { findMany: jest.fn() },
  },
}));

jest.mock('@/lib/super-admin', () => ({
  isSuperAdmin: jest.fn(() => false),
}));

const TOKEN = 'service-token';

function botRecord(overrides: { enabled?: boolean; roomPublic?: boolean; worldPublic?: boolean; universePublic?: boolean; ownerId?: string } = {}) {
  return {
    enabled: overrides.enabled ?? true,
    room: {
      isPublic: overrides.roomPublic ?? true,
      world: {
        id: 'world-1',
        isPublic: overrides.worldPublic ?? true,
        universeId: 'universe-1',
        universe: { isPublic: overrides.universePublic ?? true, ownerId: overrides.ownerId ?? 'owner-1' },
      },
    },
  };
}

const alice = { id: 'user-1', uuid: 'uuid-alice', name: 'Alice', email: 'alice@example.com', isGuest: false };

function request(chatId: string | null, token: string | null = TOKEN) {
  const url = `http://localhost:3333/api/bots/bot-1/dm-access${chatId === null ? '' : `?chatId=${encodeURIComponent(chatId)}`}`;
  return new NextRequest(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

const params = { params: Promise.resolve({ id: 'bot-1' }) };

describe('GET /api/bots/:id/dm-access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BOT_SERVICE_TOKEN = TOKEN;
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue(botRecord());
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(alice);
    (prisma.ban.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.worldMember.findMany as jest.Mock).mockResolvedValue([]);
    (isSuperAdmin as jest.Mock).mockReturnValue(false);
  });

  it('refuses callers without the service token', async () => {
    expect((await GET(request('@alice:example.org', null), params)).status).toBe(401);
    expect((await GET(request('@alice:example.org', 'wrong'), params)).status).toBe(401);
    expect(prisma.bot.findUnique).not.toHaveBeenCalled();
  });

  it('needs a chatId', async () => {
    expect((await GET(request(null), params)).status).toBe(400);
  });

  it('allows anyone with an account when the room, world and universe are public', async () => {
    const res = await GET(request('@alice:example.org'), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: true, reason: null, user: { uuid: 'uuid-alice', name: 'Alice', isGuest: false } });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { matrixChatId: '@alice:example.org' } }));
  });

  it('refuses an unknown bot, a disabled bot and an unknown Matrix ID', async () => {
    (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce(null);
    expect((await (await GET(request('@alice:example.org'), params)).json()).reason).toBe('bot_not_found');

    (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce(botRecord({ enabled: false }));
    expect((await (await GET(request('@alice:example.org'), params)).json()).reason).toBe('bot_disabled');

    (prisma.user.findFirst as jest.Mock).mockResolvedValueOnce(null);
    const body = await (await GET(request('@stranger:example.org'), params)).json();
    expect(body).toEqual({ allowed: false, reason: 'unknown_person', user: null });
  });

  it('refuses a person banned from the world, universe or everywhere', async () => {
    (prisma.ban.findFirst as jest.Mock).mockResolvedValue({ id: 'ban-1' });
    const body = await (await GET(request('@alice:example.org'), params)).json();
    expect(body).toEqual({ allowed: false, reason: 'banned', user: null });
    const where = (prisma.ban.findFirst as jest.Mock).mock.calls[0][0].where;
    expect(where.userId).toBe('user-1');
    expect(where.AND[0].OR).toEqual([{ worldId: 'world-1' }, { universeId: 'universe-1' }, { worldId: null, universeId: null }]);
  });

  it('refuses a private room to people who are not members, owners or super admins', async () => {
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue(botRecord({ roomPublic: false }));
    expect(await (await GET(request('@alice:example.org'), params)).json()).toEqual({ allowed: false, reason: 'no_room_access', user: null });
  });

  it('allows a private room to world members, the universe owner and super admins', async () => {
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue(botRecord({ worldPublic: false }));

    (prisma.worldMember.findMany as jest.Mock).mockResolvedValueOnce([{ worldId: 'world-1' }]);
    expect((await (await GET(request('@alice:example.org'), params)).json()).allowed).toBe(true);

    (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce(botRecord({ worldPublic: false, ownerId: 'user-1' }));
    expect((await (await GET(request('@alice:example.org'), params)).json()).allowed).toBe(true);

    (isSuperAdmin as jest.Mock).mockReturnValueOnce(true);
    expect((await (await GET(request('@alice:example.org'), params)).json()).allowed).toBe(true);
  });
});
