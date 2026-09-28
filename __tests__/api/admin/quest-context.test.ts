/**
 * What an owner can point a quest at: the room's named areas and bots, only for those who can edit the room.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    room: { findUnique: jest.fn() },
    worldMember: { findMany: jest.fn(), findFirst: jest.fn() },
    bot: { findMany: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET } from '@/app/api/admin/rooms/[id]/quest-context/route';
import { namedAreas } from '@/lib/quests/room-areas';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const SESSIONS = {
  owner: { id: 'u-owner', uuid: 'uuid-owner', email: 'o@example.test', name: 'Owner', tags: [], isSuperAdmin: false },
  editor: { id: 'u-editor', uuid: 'uuid-editor', email: 'e@example.test', name: 'Editor', tags: [], isSuperAdmin: false },
  visitor: { id: 'u-visitor', uuid: 'uuid-visitor', email: 'v@example.test', name: 'Visitor', tags: [], isSuperAdmin: false },
};
type Who = keyof typeof SESSIONS;

const req = (as?: Who | 'admin-token') =>
  new NextRequest('http://localhost:3333/api/admin/rooms/r-1/quest-context', {
    headers: as === 'admin-token' ? { Authorization: `Bearer ${process.env.ADMIN_API_TOKEN}` } : as ? { Authorization: `Bearer session-${as}` } : {},
  });
const params = { params: Promise.resolve({ id: 'r-1' }) };

const ROOM = {
  id: 'r-1',
  slug: 'lobby',
  isPublic: true,
  worldId: 'w-1',
  world: { id: 'w-1', slug: 'office', isPublic: true, universe: { slug: 'bawes', ownerId: 'u-owner', isPublic: true } },
};

const WAM = {
  version: '2.0.0',
  areas: [
    { id: 'a-2', name: 'Courtyard', x: 0, y: 0, width: 10, height: 10 },
    { id: 'a-1', name: ' Atrium ', x: 0, y: 0, width: 10, height: 10 },
    { id: 'a-3', name: '', x: 0, y: 0, width: 10, height: 10 },
    { id: 'a-4', name: 'courtyard', x: 0, y: 0, width: 10, height: 10 },
    { name: 'No id' },
  ],
};

const fetchMock = jest.fn();

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'test-admin-token';
  global.fetch = fetchMock as unknown as typeof fetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PUBLIC_MAP_STORAGE_URL = 'http://map-storage.test/';
  process.env.MAP_STORAGE_API_TOKEN = 'map-token';
  process.env.PLAY_URL = 'http://play.test';
  delete process.env.DEFAULT_DOMAIN;
  (getSessionUser as jest.Mock).mockImplementation((request: NextRequest) => {
    const who = request.headers.get('authorization')?.replace('Bearer session-', '') as Who | undefined;
    return Promise.resolve(who && who in SESSIONS ? SESSIONS[who] : null);
  });
  db.room.findUnique.mockResolvedValue(ROOM);
  db.worldMember.findMany.mockResolvedValue([]);
  db.worldMember.findFirst.mockImplementation(({ where }: { where: { userId: string } }) =>
    Promise.resolve(where.userId === 'u-editor' ? { id: 'm-1' } : null),
  );
  db.bot.findMany.mockResolvedValue([{ id: 'b-1', name: 'Nova' }]);
  fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(WAM) });
});

describe('GET /api/admin/rooms/[id]/quest-context', () => {
  it('answers 401 without a session', async () => {
    expect((await GET(req(), params)).status).toBe(401);
  });

  it('answers 404 for a room that does not exist', async () => {
    db.room.findUnique.mockResolvedValue(null);
    expect((await GET(req('owner'), params)).status).toBe(404);
  });

  it('answers 404 for a private room the person cannot see', async () => {
    db.room.findUnique.mockResolvedValue({ ...ROOM, isPublic: false });
    expect((await GET(req('visitor'), params)).status).toBe(404);
  });

  it('answers 403 to someone who can see the room but not edit it', async () => {
    const res = await GET(req('visitor'), params);
    expect(res.status).toBe(403);
    expect(db.bot.findMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives the owner the named areas from the WAM and the enabled bots of this room', async () => {
    const res = await GET(req('owner'), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      areas: [
        { id: 'a-1', name: 'Atrium' },
        { id: 'a-2', name: 'Courtyard' },
      ],
      bots: [{ id: 'b-1', name: 'Nova' }],
      source: 'wam',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://map-storage.test/play.test/bawes/office/lobby/map.wam',
      expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer map-token' } }),
    );
    expect(db.bot.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { roomId: 'r-1', enabled: true } }));
  });

  it('lets a world editor and the admin token in', async () => {
    expect((await GET(req('editor'), params)).status).toBe(200);
    expect((await GET(req('admin-token'), params)).status).toBe(200);
  });

  it('says there is no map to read when map-storage is not configured or the WAM is missing', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    expect(await (await GET(req('owner'), params)).json()).toEqual(expect.objectContaining({ areas: [], source: 'none' }));
    delete process.env.PUBLIC_MAP_STORAGE_URL;
    expect(await (await GET(req('owner'), params)).json()).toEqual(expect.objectContaining({ areas: [], source: 'none' }));
  });
});

describe('namedAreas', () => {
  it('ignores anything that is not a list of areas', () => {
    expect(namedAreas({})).toEqual([]);
    expect(namedAreas({ areas: 'nope' })).toEqual([]);
    expect(namedAreas({ areas: [null, 3, { id: 'x', name: 'x'.repeat(101), width: 10, height: 10 }] })).toEqual([]);
  });

  it('leaves out areas the game never sends a newcomer to: no size, or restricted', () => {
    const area = { x: 0, y: 0, width: 10, height: 10, properties: [] };
    expect(
      namedAreas({
        areas: [
          { ...area, id: 'a-1', name: 'Hall' },
          { ...area, id: 'a-2', name: 'Flat', height: 0 },
          { ...area, id: 'a-3', name: 'Sizeless', width: undefined },
          { ...area, id: 'a-4', name: 'Office', properties: [{ id: 'p', type: 'restrictedRightsPropertyData', writeTags: [], readTags: ['staff'] }] },
        ],
      }),
    ).toEqual([{ id: 'a-1', name: 'Hall' }]);
  });
});
