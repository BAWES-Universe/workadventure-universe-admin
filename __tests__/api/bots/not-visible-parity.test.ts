import { NextRequest } from 'next/server';
import { GET as listBots } from '@/app/api/bots/route';
import { GET as getBot } from '@/app/api/bots/[id]/route';
import { GET as getConfiguration } from '@/app/api/bots/configuration/[id]/route';
import { GET as listMcpServers } from '@/app/api/bots/[id]/mcp-servers/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBots } from '@/lib/bot-permissions';
import { isSuperAdmin } from '@/lib/super-admin';

jest.mock('@/lib/db', () => ({
  prisma: {
    room: { findUnique: jest.fn(), findFirst: jest.fn() },
    bot: { findMany: jest.fn(), findUnique: jest.fn() },
    user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    worldMember: { findUnique: jest.fn(), findFirst: jest.fn() },
    botMcpServer: { findMany: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn(() => false) }));
jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn(async () => null) }));
jest.mock('@/lib/bot-permissions', () => ({
  canManageBots: jest.fn(async () => false),
  canManageBotMcpServers: jest.fn(async () => false),
}));
jest.mock('@/lib/bot-config-helpers', () => ({
  resolveRoomIdFromPlayUri: jest.fn(async () => 'room-1'),
  transformBotToServerFormat: jest.fn(async (bot: unknown) => bot),
}));

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const MISSING_ROOM_ID = '22222222-2222-4222-8222-222222222222';

const world = { id: 'world-1', isPublic: false, universe: { id: 'uni-1', isPublic: true, ownerId: 'owner-1' } };
const privateRoom = { id: ROOM_ID, isPublic: true, worldId: 'world-1', world };
const privateBot = { id: 'bot-1', roomId: ROOM_ID, createdById: 'someone', room: privateRoom };

function asUser(id: string) {
  (getSessionUser as jest.Mock).mockResolvedValue({ id, email: `${id}@example.com` });
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id, email: `${id}@example.com` });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (path: string) => new NextRequest(`http://localhost:3333${path}`);

// What a caller can compare: status, body and the headers that matter
async function look(res: Response) {
  return {
    status: res.status,
    body: await res.json(),
    cache: res.headers.get('cache-control'),
    cors: res.headers.get('access-control-allow-origin'),
  };
}

describe('bots that someone may not see look the same as bots that do not exist', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    (isSuperAdmin as jest.Mock).mockReturnValue(false);
    (canManageBots as jest.Mock).mockResolvedValue(false);
    (prisma.worldMember.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.worldMember.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.room.findUnique as jest.Mock).mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === ROOM_ID ? privateRoom : null,
    );
    (prisma.room.findFirst as jest.Mock).mockImplementation(async ({ where }: { where: { slug: string } }) =>
      where.slug === 'private-room' ? { id: ROOM_ID } : null,
    );
    (prisma.bot.findMany as jest.Mock).mockResolvedValue([privateBot]);
    (prisma.bot.findUnique as jest.Mock).mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'bot-1' ? privateBot : null,
    );
  });

  const callers: [string, () => void][] = [
    ['signed out', () => undefined],
    ['signed in but not a member (also a former member or someone only invited)', () => asUser('stranger')],
  ];

  describe.each(callers)('%s', (_who, signIn) => {
    beforeEach(signIn);

    it('the list of a room, by id', async () => {
      const real = await look(await listBots(get(`/api/bots?roomId=${ROOM_ID}`)));
      const missing = await look(await listBots(get(`/api/bots?roomId=${MISSING_ROOM_ID}`)));
      expect(real).toEqual(missing);
    });

    it('the list of a room, by its address', async () => {
      const real = await look(
        await listBots(get('/api/bots?roomId=http://play.example.test/@/universe/world/private-room')),
      );
      const missing = await look(
        await listBots(get('/api/bots?roomId=http://play.example.test/@/universe/world/no-such-room')),
      );
      expect(real).toEqual(missing);
    });

    it('one bot', async () => {
      const real = await look(await getBot(get('/api/bots/bot-1'), params('bot-1')));
      const missing = await look(await getBot(get('/api/bots/bot-2'), params('bot-2')));
      expect(real).toEqual(missing);
    });
  });

  describe('signed in but not allowed to manage', () => {
    beforeEach(() => asUser('stranger'));

    it('the configuration of one bot', async () => {
      const real = await look(await getConfiguration(get('/api/bots/configuration/bot-1'), params('bot-1')));
      const missing = await look(await getConfiguration(get('/api/bots/configuration/bot-2'), params('bot-2')));
      expect(real).toEqual(missing);
      expect(real.status).toBe(404);
    });

    it('the MCP servers of one bot', async () => {
      const real = await look(await listMcpServers(get('/api/bots/bot-1/mcp-servers'), params('bot-1')));
      const missing = await look(await listMcpServers(get('/api/bots/bot-2/mcp-servers'), params('bot-2')));
      expect(real).toEqual(missing);
      expect(real.status).toBe(404);
    });
  });

  it('still shows the bots of a public room to a signed-out visitor', async () => {
    (prisma.room.findUnique as jest.Mock).mockResolvedValue({
      ...privateRoom,
      world: { ...world, isPublic: true },
    });
    const res = await listBots(get(`/api/bots?roomId=${ROOM_ID}`));
    expect(res.status).toBe(200);
  });
});
