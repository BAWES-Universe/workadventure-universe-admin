/**
 * The game's chat member list (GET /api/chat/members) also carries each member's saved Woka, so the chat can draw
 * people who are away, not only the ones on the map.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    world: { findFirst: jest.fn() },
    worldMember: { findMany: jest.fn() },
    userAvatar: { findMany: jest.fn() },
    avatarLayer: { findMany: jest.fn() },
  },
}));
jest.mock('@/lib/wokas', () => ({
  getWokaList: jest.fn(() => ({})),
  getTextureMap: jest.fn(() => new Map([['male1', { url: 'resources/characters/pipoya/Male 01-1.png' }]])),
}));
jest.mock('@/lib/system-user', () => ({ NOT_SYSTEM_USER: {} }));

import { prisma } from '@/lib/db';
import { GET } from '@/app/api/chat/members/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

function request() {
  const url = new URL('http://localhost:3333/api/chat/members');
  url.searchParams.set('playUri', 'http://play.test/@/uni/world/room');
  return new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLAY_URL = 'http://play.test';
  db.world.findFirst.mockResolvedValue({ id: 'world-1' });
  db.avatarLayer.findMany.mockResolvedValue([{ textureId: 'hat1', url: 'https://cdn.test/hat1.png' }]);
});

describe('GET /api/chat/members', () => {
  it("sends each member's saved Woka, and an empty one for a member without", async () => {
    db.worldMember.findMany.mockResolvedValue([
      { tags: ['member'], user: { id: 'u1', uuid: 'alice-uuid', name: 'Alice', email: null, matrixChatId: '@alice:chat' } },
      { tags: [], user: { id: 'u2', uuid: 'bob-uuid', name: 'Bob', email: null, matrixChatId: '@bob:chat' } },
    ]);
    db.userAvatar.findMany.mockResolvedValue([{ userId: 'u1', worldId: 'world-1', textureIds: ['male1', 'hat1'] }]);

    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.members).toHaveLength(2);
    expect(body.members[0]).toMatchObject({ uuid: 'alice-uuid', chatId: '@alice:chat' });
    expect(body.members[0].characterTextures).toHaveLength(2);
    expect(body.members[0].characterTextures[0].id).toBe('male1');
    expect(body.members[1]).toMatchObject({ uuid: 'bob-uuid', characterTextures: [] });
  });

  it('still answers the list when Wokas cannot be read', async () => {
    db.worldMember.findMany.mockResolvedValue([
      { tags: [], user: { id: 'u1', uuid: 'alice-uuid', name: 'Alice', email: null, matrixChatId: '@alice:chat' } },
    ]);
    db.userAvatar.findMany.mockRejectedValue(new Error('database down'));

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).members[0]).toMatchObject({ uuid: 'alice-uuid', characterTextures: [] });
  });
});
