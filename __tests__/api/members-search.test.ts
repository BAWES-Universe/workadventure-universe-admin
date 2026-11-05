/**
 * The game's member search (owner of a personal desk) reads GET /api/members as its MemberData:
 * `id` (not `uuid`), the name as a string or null, and each member's Woka so the picker shows it. Never an email
 * address, and a search matches names only.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    world: { findFirst: jest.fn(), findUnique: jest.fn() },
    worldMember: { findMany: jest.fn() },
    userOutfit: { findMany: jest.fn() },
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
  db.world.findUnique.mockResolvedValue({ universeId: 'uni-1' });
  db.avatarLayer.findMany.mockResolvedValue([{ textureId: 'hat1', url: 'https://cdn.test/hat1.png', avatarSet: { lifecycle: 'active', scopes: [{ scopeType: 'world', scopeId: 'world-1' }] } }]);
});

describe('GET /api/members', () => {
  it('answers in the shape the game reads, with each Woka', async () => {
    db.worldMember.findMany.mockResolvedValue([
      { tags: ['member'], user: { id: 'u1', uuid: 'alice-uuid', name: 'Alice', email: 'alice@test' } },
      { tags: [], user: { id: 'u2', uuid: 'bob-uuid', name: null, email: null } },
    ]);
    db.userOutfit.findMany.mockResolvedValue([
      // The Woka she wears now (the newest) is the one shown; an older one she wore is not.
      { userId: 'u1', textureIds: ['male1', 'hat1'] },
      { userId: 'u1', textureIds: ['male1'] },
    ]);

    const response = await search(request('/api/members', { playUri: PLAY_URI, searchText: 'a' }));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual([
      {
        id: 'alice-uuid',
        name: 'Alice',
        email: null,
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

  it('never sends an email, even when the database row carries one', async () => {
    db.worldMember.findMany.mockResolvedValue([
      { tags: [], user: { id: 'u1', uuid: 'alice-uuid', name: 'Alice', email: 'alice@example.test' } },
    ]);
    db.userOutfit.findMany.mockResolvedValue([]);

    const response = await search(request('/api/members', { playUri: PLAY_URI, searchText: '' }));
    const text = await response.text();
    expect(text).not.toContain('alice@example.test');
    // The game's parser still needs the key, so it is there, and empty
    expect(JSON.parse(text)[0].email).toBeNull();
    // The query does not even read the email column
    const query = db.worldMember.findMany.mock.calls[0][0];
    expect(query.include.user.select).not.toHaveProperty('email');
  });

  it('searches by name only, never by email', async () => {
    db.worldMember.findMany.mockResolvedValue([]);

    await search(request('/api/members', { playUri: PLAY_URI, searchText: 'someone@example.test' }));

    const query = db.worldMember.findMany.mock.calls[0][0];
    expect(JSON.stringify(query.where)).toContain('"name"');
    // (The System account filter names the email column; what must be gone is a search on it.)
    expect(JSON.stringify(query.where)).not.toMatch(/"email":\{"contains"/);
  });

  it('still answers when the Wokas cannot be read', async () => {
    db.worldMember.findMany.mockResolvedValue([
      { tags: [], user: { id: 'u1', uuid: 'alice-uuid', name: 'Alice', email: null } },
    ]);
    db.userOutfit.findMany.mockRejectedValue(new Error('db down'));

    const body = await (await search(request('/api/members', { playUri: PLAY_URI, searchText: '' }))).json();
    expect(body).toEqual([
      { id: 'alice-uuid', name: 'Alice', email: null, tags: [], visitCardUrl: null, characterTextures: [] },
    ]);
  });
});

describe('GET /api/members/:uuid', () => {
  it("adds the Woka the member wears now", async () => {
    db.user.findFirst.mockResolvedValue({ id: 'u1', uuid: 'alice-uuid', name: 'Alice', email: 'alice@test', matrixChatId: null });
    db.userOutfit.findMany.mockResolvedValue([{ userId: 'u1', textureIds: ['hat1'] }]);

    const response = await getMember(request('/api/members/alice-uuid', { playUri: PLAY_URI }), {
      params: Promise.resolve({ memberUUID: 'alice-uuid' }),
    });
    const body = await response.json();
    expect(body).toMatchObject({ id: 'alice-uuid', name: 'Alice', characterTextures: [{ id: 'hat1', url: 'https://cdn.test/hat1.png' }] });
  });

  it('never sends the email of the person asked about', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'u1', uuid: 'alice-uuid', name: 'Alice', email: 'alice@example.test', matrixChatId: '@alice:chat' });
    db.userOutfit.findMany.mockResolvedValue([]);

    const response = await getMember(request('/api/members/alice-uuid', { playUri: PLAY_URI }), {
      params: Promise.resolve({ memberUUID: 'alice-uuid' }),
    });
    const text = await response.text();
    expect(text).not.toContain('alice@example.test');
    expect(JSON.parse(text)).not.toHaveProperty('email');
    expect(JSON.parse(text)).toMatchObject({ id: 'alice-uuid', name: 'Alice', chatID: '@alice:chat' });
  });
});
