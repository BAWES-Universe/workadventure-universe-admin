import { NextRequest } from 'next/server';
import { GET as listBots } from '@/app/api/bots/route';
import { GET as getBot } from '@/app/api/bots/[id]/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';

jest.mock('@/lib/db', () => ({
  prisma: {
    room: { findUnique: jest.fn(), findFirst: jest.fn() },
    bot: { findMany: jest.fn(), findUnique: jest.fn() },
    user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    worldMember: { findUnique: jest.fn() },
  },
}));

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn(() => false) }));
jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn(async () => null) }));

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_TOKEN = 'test-admin-token';

const world = { id: 'world-1', isPublic: false, universe: { id: 'uni-1', isPublic: true, ownerId: 'owner-1' } };
const privateRoom = { id: ROOM_ID, isPublic: true, worldId: 'world-1', world };
const bot = { id: 'bot-1', roomId: ROOM_ID, name: 'Guide', chatInstructions: 'Secret instructions', room: privateRoom };

function asUser(id: string, email = `${id}@example.com`) {
  (getSessionUser as jest.Mock).mockResolvedValue({ id, email });
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id, email });
}

function list(token?: string) {
  return listBots(
    new NextRequest(`http://localhost:3333/api/bots?roomId=${ROOM_ID}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );
}

function one(token?: string) {
  return getBot(
    new NextRequest('http://localhost:3333/api/bots/bot-1', { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
    { params: Promise.resolve({ id: 'bot-1' }) },
  );
}

describe('reading the bots of a members-only room', () => {
  beforeAll(() => {
    process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    (isSuperAdmin as jest.Mock).mockReturnValue(false);
    (prisma.room.findUnique as jest.Mock).mockResolvedValue(privateRoom);
    (prisma.bot.findMany as jest.Mock).mockResolvedValue([bot]);
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue(bot);
    (prisma.worldMember.findUnique as jest.Mock).mockResolvedValue(null);
  });

  describe.each([
    ['the list of a room', list],
    ['one bot', one],
  ])('%s', (_name, read) => {
    it('is refused to someone who is signed in but not a member, and looks like a missing room', async () => {
      asUser('stranger');
      const res = await read();
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain('Secret instructions');
    });

    it('is refused to a person with only a pending invitation (no membership yet)', async () => {
      asUser('invitee');
      const res = await read();
      expect(res.status).toBe(404);
    });

    it('is refused without signing in', async () => {
      const res = await read();
      expect(res.status).toBe(401);
    });

    it('is shown to a member of the world', async () => {
      asUser('member');
      (prisma.worldMember.findUnique as jest.Mock).mockResolvedValue({ worldId: 'world-1' });
      const res = await read();
      expect(res.status).toBe(200);
    });

    it('is shown to the owner of the universe, who is not a member', async () => {
      asUser('owner-1');
      const res = await read();
      expect(res.status).toBe(200);
    });

    it('is shown to a super admin', async () => {
      asUser('boss', 'boss@example.com');
      (isSuperAdmin as jest.Mock).mockImplementation((email: string | null) => email === 'boss@example.com');
      const res = await read();
      expect(res.status).toBe(200);
    });

    it('is shown to the bot server (admin token)', async () => {
      const res = await read(ADMIN_TOKEN);
      expect(res.status).toBe(200);
    });
  });

  it('keeps showing the bots of a public room to everyone, signed in or not', async () => {
    const publicRoom = { ...privateRoom, world: { ...world, isPublic: true } };
    (prisma.room.findUnique as jest.Mock).mockResolvedValue(publicRoom);
    expect((await list()).status).toBe(200);
    asUser('stranger');
    expect((await list()).status).toBe(200);
  });
});
