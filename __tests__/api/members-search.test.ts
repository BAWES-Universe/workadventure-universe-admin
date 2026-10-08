/**
 * The game's member search (owner of a personal desk) reads GET /api/members as its MemberData:
 * `id` (not `uuid`), name and email as strings or null, and each member's Woka so the picker shows it.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    world: { findFirst: jest.fn() },
    worldMember: { findMany: jest.fn() },
    userAvatar: { findMany: jest.fn() },
    avatarLayer: { findMany: jest.fn() },
    user: { findFirst: jest.fn() },
  },
}));
jest.mock('@/lib/wokas', () => ({
  getWokaList: jest.fn(() => ({})),
  getTextureMap: jest.fn(() => new Map([['male1', { url: 'resources/characters/pipoya/Male 01-1.png' }]])),
}));

import { prisma } from '@/lib/db';
import { GET as search } from '@/app/api/members/route';
import { GET as getMember } from '@/app/api/members/[memberUUID]/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

function request(path: string, query: Record<string, string>) {
  const url = new URL(`http://localhost:3333${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } });
}

const PLAY_URI = 'http://play.test/@/uni/world/room';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLAY_URL = 'http://play.test';
  db.world.findFirst.mockResolvedValue({ id: 'world-1' });
  db.avatarLayer.findMany.mockResolvedValue([{ textureId: 'hat1', url: 'https://cdn.test/hat1.png' }]);
});

describe('GET /api/members', () => {
  it('answers in the shape the game reads, with each Woka', async () => {
    db.worldMember.findMany.mockResolvedValue([
      { tags: ['member'], user: { id: 'u1', uuid: 'alice-uuid', name: 'Alice', email: 'alice@test' } },
      { tags: [], user: { id: 'u2', uuid: 'bob-uuid', name: null, email: null } },
    ]);
    db.userAvatar.findMany.mockResolvedValue([
      // Alice's outfit in another world is newer, but this world's outfit wins.
      { userId: 'u1', worldId: 'world-2', textureIds: ['male1'] },
      { userId: 'u1', worldId: 'world-1', textureIds: ['male1', 'hat1'] },
    ]);

    const response = await search(request('/api/members', { playUri: PLAY_URI, searchText: 'a' }));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual([
      {
        id: 'alice-uuid',
        name: 'Alice',
        email: 'alice@test',
        tags: ['member'],
        visitCardUrl: null,
        characterTextures: [
          { id: 'male1', url: 'http://play.test/resources/characters/pipoya/Male%2001-1.png' },
          { id: 'hat1', url: 'https://cdn.test/hat1.png' },
        ],
      },
      // No outfit: no textures, and the game draws its default Woka.
      { id: 'bob-uuid', name: null, email: null, tags: [], visitCardUrl: null, characterTextures: [] },
    ]);
    expect(db.worldMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20 }));
  });

  it('still answers when the Wokas cannot be read', async () => {
    db.worldMember.findMany.mockResolvedValue([
      { tags: [], user: { id: 'u1', uuid: 'alice-uuid', name: 'Alice', email: null } },
    ]);
    db.userAvatar.findMany.mockRejectedValue(new Error('db down'));

    const body = await (await search(request('/api/members', { playUri: PLAY_URI, searchText: '' }))).json();
    expect(body).toEqual([
      { id: 'alice-uuid', name: 'Alice', email: null, tags: [], visitCardUrl: null, characterTextures: [] },
    ]);
  });
});

describe('GET /api/members/:uuid', () => {
  it("adds the member's Woka in the world of the room asked about", async () => {
    db.user.findFirst.mockResolvedValue({ id: 'u1', uuid: 'alice-uuid', name: 'Alice', email: 'alice@test', matrixChatId: null });
    db.userAvatar.findMany.mockResolvedValue([{ userId: 'u1', worldId: 'world-1', textureIds: ['hat1'] }]);

    const response = await getMember(request('/api/members/alice-uuid', { playUri: PLAY_URI }), {
      params: Promise.resolve({ memberUUID: 'alice-uuid' }),
    });
    const body = await response.json();
    expect(body).toMatchObject({ id: 'alice-uuid', name: 'Alice', characterTextures: [{ id: 'hat1', url: 'https://cdn.test/hat1.png' }] });
  });
});
