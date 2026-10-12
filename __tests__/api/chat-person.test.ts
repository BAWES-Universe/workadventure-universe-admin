/**
 * GET /api/chat/person: one person's name and Woka by chat ID, for a direct chat with someone outside the asker's
 * world. The Woka follows the same rule as everywhere (the Woka they wear now, wherever the asker is), and the answer
 * never carries an email address or an id.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findFirst: jest.fn() },
    world: { findFirst: jest.fn(), findUnique: jest.fn() },
    userOutfit: { findMany: jest.fn() },
    avatarLayer: { findMany: jest.fn() },
  },
}));
jest.mock('@/lib/wokas', () => ({
  getWokaList: jest.fn(() => ({})),
  getTextureMap: jest.fn(() => new Map([['male1', { url: 'resources/characters/pipoya/Male 01-1.png' }]])),
}));
jest.mock('@/lib/system-user', () => ({ NOT_SYSTEM_USER: { OR: [{ email: null }] } }));

import { prisma } from '@/lib/db';
import { GET } from '@/app/api/chat/person/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const platform = { lifecycle: 'active', scopes: [{ scopeType: 'platform' }] };
const worldOnly = { lifecycle: 'active', scopes: [{ scopeType: 'world', scopeId: 'world-1' }] };

function request(query: Record<string, string | undefined>, authorized = true) {
  const url = new URL('http://localhost:3333/api/chat/person');
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
  return new NextRequest(url, { headers: authorized ? { Authorization: process.env.ADMIN_API_TOKEN as string } : {} });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLAY_URL = 'http://play.test';
  db.user.findFirst.mockResolvedValue({ id: 'u1', name: 'Alice' });
  db.world.findFirst.mockResolvedValue({ id: 'world-1' });
  db.world.findUnique.mockResolvedValue({ universeId: 'uni-1' });
  db.avatarLayer.findMany.mockResolvedValue([
    { textureId: 'hat1', url: 'https://cdn.test/hat1.png', avatarSet: platform },
    { textureId: 'costume', url: 'https://cdn.test/costume.png', avatarSet: worldOnly },
  ]);
});

describe('GET /api/chat/person', () => {
  it("answers with the person's current name and the Woka they wear now, outside the asker's world", async () => {
    db.world.findFirst.mockResolvedValue(null);
    db.userOutfit.findMany.mockResolvedValue([
      { userId: 'u1', textureIds: ['male1', 'hat1'] }, // the Woka they wear now
      { userId: 'u1', textureIds: ['costume'] },
    ]);

    const response = await GET(request({ chatId: '@alice:chat.test', playUri: 'http://play.test/@/uni/world/room' }));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({
      wokaName: 'Alice',
      characterTextures: [
        { id: 'male1', url: 'http://play.test/resources/characters/pipoya/Male%2001-1.png' },
        { id: 'hat1', url: 'https://cdn.test/hat1.png' },
      ],
    });
    expect(db.user.findFirst.mock.calls[0][0].where.AND).toContainEqual({ matrixChatId: '@alice:chat.test', isGuest: false });
  });

  it("shows the Woka they wear now even when it is a costume from another world than the asker's", async () => {
    db.userOutfit.findMany.mockResolvedValue([
      { userId: 'u1', textureIds: ['costume'] },
      { userId: 'u1', textureIds: ['hat1'] },
    ]);
    const body = await (await GET(request({ chatId: '@alice:chat.test', playUri: 'http://play.test/@/uni/world/room' }))).json();
    expect(body.characterTextures).toEqual([{ id: 'costume', url: 'https://cdn.test/costume.png' }]);
  });

  it('answers with no Woka (the game draws its default) for someone with no Woka yet, and for an asker with no room', async () => {
    db.userOutfit.findMany.mockResolvedValue([]);
    const body = await (await GET(request({ chatId: '@alice:chat.test' }))).json();
    expect(body).toEqual({ wokaName: 'Alice', characterTextures: [] });
    expect(db.world.findFirst).not.toHaveBeenCalled();
  });

  it('never carries an email address, an id or a sign-in name', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'u1', name: 'Alice', email: 'alice@example.test', uuid: 'alice@example.test' });
    db.userOutfit.findMany.mockResolvedValue([]);
    const body = await (await GET(request({ chatId: '@alice:chat.test' }))).json();
    expect(Object.keys(body).sort()).toEqual(['characterTextures', 'wokaName']);
    expect(db.user.findFirst.mock.calls[0][0].select).toEqual({ id: true, name: true });
  });

  it('still answers the name when the Woka cannot be read', async () => {
    db.userOutfit.findMany.mockRejectedValue(new Error('database down'));
    const response = await GET(request({ chatId: '@alice:chat.test' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wokaName: 'Alice', characterTextures: [] });
  });

  it('answers 404 for a chat ID nobody has, 400 for something that is not a chat ID, 401 without the admin token', async () => {
    db.user.findFirst.mockResolvedValue(null);
    expect((await GET(request({ chatId: '@nobody:chat.test' }))).status).toBe(404);
    for (const chatId of [undefined, '', 'alice@example.test', '@alice', '@a:b c']) {
      expect((await GET(request({ chatId }))).status).toBe(400);
    }
    expect((await GET(request({ chatId: '@alice:chat.test' }, false))).status).toBe(401);
  });
});
