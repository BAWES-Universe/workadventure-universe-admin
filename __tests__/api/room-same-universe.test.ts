/**
 * GET /api/room/sameUniverse: every room the player may see in their universe, grouped by world, most visited first,
 * with stars, visits and the busiest hour.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    universe: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    worldMember: { findMany: jest.fn() },
    favorite: { groupBy: jest.fn() },
    $queryRaw: jest.fn(),
  },
}));

import { prisma } from '@/lib/db';
import { GET } from '@/app/api/room/sameUniverse/route';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $queryRaw: jest.Mock };

const ROOM_URL = 'https://play.example.test/@/acme/office/lobby';

function req(query: Record<string, string>, authorized = true) {
  const url = new URL('http://localhost:3333/api/room/sameUniverse');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const headers: Record<string, string> = {};
  if (authorized) headers.Authorization = `Bearer ${process.env.ADMIN_API_TOKEN}`;
  return new NextRequest(url, { headers });
}

function room(id: string, slug: string, isPublic = true, description: string | null = null) {
  return { id, name: slug[0].toUpperCase() + slug.slice(1), slug, description, isPublic };
}

const UNIVERSE = {
  id: 'uni',
  name: 'Acme',
  isPublic: true,
  ownerId: 'u-owner',
  worlds: [
    {
      id: 'w-garden',
      name: 'Garden',
      slug: 'garden',
      isPublic: true,
      thumbnailUrl: 'https://cdn.example.test/garden.png',
      rooms: [room('r-pond', 'pond'), room('r-shed', 'shed', true, 'Tools')],
    },
    {
      id: 'w-office',
      name: 'Office',
      slug: 'office',
      isPublic: true,
      thumbnailUrl: null,
      rooms: [room('r-lobby', 'lobby'), room('r-kitchen', 'kitchen'), room('r-vault', 'vault', false)],
    },
    {
      id: 'w-private',
      name: 'Backstage',
      slug: 'backstage',
      isPublic: false,
      thumbnailUrl: null,
      rooms: [room('r-green', 'green')],
    },
    { id: 'w-empty', name: 'Empty', slug: 'empty', isPublic: true, thumbnailUrl: null, rooms: [] },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  db.universe.findUnique.mockResolvedValue(UNIVERSE);
  db.user.findUnique.mockResolvedValue(null);
  db.worldMember.findMany.mockResolvedValue([]);
  db.favorite.groupBy.mockResolvedValue([{ roomId: 'r-kitchen', _count: { _all: 3 } }]);
  db.$queryRaw.mockResolvedValue([
    // kitchen: 7 visits, busiest at 14 UTC
    { room_id: 'r-kitchen', hour: 9, count: BigInt(2) },
    { room_id: 'r-kitchen', hour: 14, count: BigInt(5) },
    // lobby: 1 visit
    { room_id: 'r-lobby', hour: 8, count: 1 },
    // garden: 20 visits, a tie between 10 and 18 goes to the earlier hour
    { room_id: 'r-pond', hour: 18, count: 10 },
    { room_id: 'r-pond', hour: 10, count: 10 },
  ]);
});

describe('GET /api/room/sameUniverse', () => {
  it('needs the admin token', async () => {
    const res = await GET(req({ roomUrl: ROOM_URL }, false));
    expect(res.status).toBe(401);
  });

  it('needs a roomUrl in /@/universe/world/room form', async () => {
    expect((await GET(req({}))).status).toBe(400);
    expect((await GET(req({ roomUrl: 'https://play.example.test/nowhere' }))).status).toBe(400);
  });

  it('answers 404 for an unknown universe', async () => {
    db.universe.findUnique.mockResolvedValue(null);
    expect((await GET(req({ roomUrl: ROOM_URL }))).status).toBe(404);
  });

  it('groups rooms by world, current world and room first, then by visits', async () => {
    const res = await GET(req({ roomUrl: ROOM_URL }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.universeName).toBe('Acme');
    // Office is current so it leads even though Garden has more visits; Backstage is private, Empty has no rooms.
    expect(body.worlds.map((w: { slug: string }) => w.slug)).toEqual(['office', 'garden']);

    const [office, garden] = body.worlds;
    expect(office.isCurrent).toBe(true);
    expect(office.thumbnailUrl).toBeUndefined();
    // Lobby is current so it leads; the private vault is hidden from a guest.
    expect(office.rooms).toEqual([
      {
        name: 'Lobby',
        roomUrl: 'https://play.example.test/@/acme/office/lobby',
        stars: 0,
        visits: 1,
        peakHourUtc: 8,
        isCurrent: true,
      },
      {
        name: 'Kitchen',
        roomUrl: 'https://play.example.test/@/acme/office/kitchen',
        stars: 3,
        visits: 7,
        peakHourUtc: 14,
        isCurrent: false,
      },
    ]);

    expect(garden.isCurrent).toBe(false);
    expect(garden.thumbnailUrl).toBe('https://cdn.example.test/garden.png');
    expect(garden.rooms.map((r: { name: string }) => r.name)).toEqual(['Pond', 'Shed']);
    expect(garden.rooms[0].peakHourUtc).toBe(10);
    // A room nobody visited has no peak.
    expect(garden.rooms[1]).toEqual({
      name: 'Shed',
      roomUrl: 'https://play.example.test/@/acme/garden/shed',
      description: 'Tools',
      stars: 0,
      visits: 0,
      isCurrent: false,
    });
  });

  it('shows a private world to its members', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'u-member', uuid: 'uuid-member', email: 'm@example.test', name: 'M' });
    db.worldMember.findMany.mockResolvedValue([{ worldId: 'w-private' }]);

    const body = await (await GET(req({ roomUrl: ROOM_URL, userUuid: 'uuid-member' }))).json();
    expect(body.worlds.map((w: { slug: string }) => w.slug)).toEqual(['office', 'garden', 'backstage']);
    expect(db.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { uuid: 'uuid-member' } }));
  });

  it('shows private worlds and rooms to the universe owner', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'u-owner', uuid: 'uuid-owner', email: 'o@example.test', name: 'O' });

    const body = await (await GET(req({ roomUrl: ROOM_URL, userUuid: 'uuid-owner' }))).json();
    expect(body.worlds.map((w: { slug: string }) => w.slug)).toContain('backstage');
    expect(body.worlds[0].rooms.map((r: { name: string }) => r.name)).toContain('Vault');
  });

  it("still lists the current world's public rooms in a private universe", async () => {
    db.universe.findUnique.mockResolvedValue({ ...UNIVERSE, isPublic: false });

    const body = await (await GET(req({ roomUrl: ROOM_URL }))).json();
    expect(body.worlds.map((w: { slug: string }) => w.slug)).toEqual(['office']);
    expect(body.worlds[0].rooms.map((r: { name: string }) => r.name)).toEqual(['Lobby', 'Kitchen']);
  });
});
