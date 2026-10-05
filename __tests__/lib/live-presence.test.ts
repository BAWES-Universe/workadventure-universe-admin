/**
 * Live now: the game's live directory, narrowed to what one person may see.
 */
jest.mock('@/lib/db', () => ({
  prisma: {
    room: { findMany: jest.fn() },
    worldMember: { findMany: jest.fn() },
    user: { findMany: jest.fn() },
  },
}));

import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth-session';
import { buildLiveView, fetchPresenceSnapshot, resetPresenceCache, type PresenceSnapshot } from '@/lib/live-presence';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const PLAY = 'https://play.example.test';
const LOBBY = `${PLAY}/@/acme/office/lobby`;
const VAULT = `${PLAY}/@/acme/secret/vault`;

const ACME = { id: 'uni', name: 'Acme', slug: 'acme', isPublic: true, ownerId: 'owner' };
const ROOMS = [
  {
    id: 'r-lobby',
    name: 'Lobby',
    slug: 'lobby',
    isPublic: true,
    world: { id: 'w-office', name: 'Office', slug: 'office', isPublic: true, universe: ACME },
  },
  {
    id: 'r-vault',
    name: 'Vault',
    slug: 'vault',
    isPublic: true,
    world: { id: 'w-secret', name: 'Secret', slug: 'secret', isPublic: false, universe: ACME },
  },
];

const viewer: SessionUser = { id: 'u-me', uuid: 'me', email: null, name: 'Me', tags: [], isSuperAdmin: false };

function snapshot(): PresenceSnapshot {
  return {
    generatedAt: 1,
    users: [
      { uuid: 'me', status: 'online', woka: [], sessions: [{ playUri: LOBBY, since: 10 }] },
      { uuid: 'sara', status: 'busy', woka: ['/woka/sara.png'], sessions: [{ playUri: LOBBY, since: 20 }] },
      { uuid: 'hidden', status: 'online', woka: [], sessions: [{ playUri: LOBBY, since: 30 }] },
      { uuid: 'omar', status: 'online', woka: [], sessions: [{ playUri: VAULT, since: 5 }] },
    ],
    rooms: { [LOBBY]: { guests: 2, bots: 1 }, [VAULT]: { guests: 1, bots: 0 } },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLAY_URL = PLAY;
  db.room.findMany.mockResolvedValue(ROOMS);
  db.worldMember.findMany.mockResolvedValue([]);
  db.user.findMany.mockImplementation(({ where }: { where: { uuid: { in: string[] } } }) =>
    Promise.resolve(
      [
        { uuid: 'me', name: 'Me', preferences: [] },
        { uuid: 'sara', name: 'Sara', preferences: [] },
        { uuid: 'hidden', name: 'Hidden', preferences: [{ value: true }] },
        { uuid: 'omar', name: 'Omar', preferences: [] },
      ].filter((user) => where.uuid.in.includes(user.uuid)),
    ),
  );
});

describe('buildLiveView', () => {
  it('shows only rooms you could enter, and leaves a private world out entirely, counts too', async () => {
    const view = await buildLiveView(snapshot(), viewer);
    expect(view.places.map((place) => place.name)).toEqual(['Lobby']);
    expect(view.people.map((person) => person.name)).toEqual(['Sara']);
  });

  it('counts guests and bots, but not someone who hides where they are', async () => {
    const [lobby] = (await buildLiveView(snapshot(), viewer)).places;
    // Me, Sara, 2 guests and a bot; the hidden person is in neither the faces nor the count.
    expect(lobby).toMatchObject({ count: 5, guests: 2, bots: 1, here: true, playPath: '/@/acme/office/lobby' });
    expect(lobby.people.map((person) => person.uuid)).toEqual(['sara', 'me']);
  });

  it('shows a private world to its members', async () => {
    db.worldMember.findMany.mockResolvedValue([{ worldId: 'w-secret' }]);
    const view = await buildLiveView(snapshot(), viewer);
    expect(view.places.map((place) => place.name).sort()).toEqual(['Lobby', 'Vault']);
    expect(view.people.find((person) => person.name === 'Omar')?.place.name).toBe('Vault');
  });

  it('keeps a room whose slug holds a "/", and encodes it in the path to the room', async () => {
    const room = { ...ROOMS[0], id: 'r-team', name: 'Team A', slug: 'team/a' };
    db.room.findMany.mockResolvedValue([room]);
    const uri = `${PLAY}/@/acme/office/team%2Fa`;
    const view = await buildLiveView(
      { generatedAt: 1, users: [{ uuid: 'sara', status: 'online', woka: [], sessions: [{ playUri: uri, since: 1 }] }], rooms: {} },
      viewer,
    );
    expect(db.room.findMany.mock.calls[0][0].where.OR).toEqual([
      { slug: 'team/a', world: { slug: 'office', universe: { slug: 'acme' } } },
    ]);
    expect(view.places).toMatchObject([{ name: 'Team A', playPath: '/@/acme/office/team%2Fa' }]);
    expect(view.people.map((person) => person.name)).toEqual(['Sara']);
  });

  it('makes Woka layers absolute against the game and keeps the status', async () => {
    const view = await buildLiveView(snapshot(), viewer);
    expect(view.people[0]).toMatchObject({ status: 'busy', woka: [`${PLAY}/woka/sara.png`] });
  });
});

describe('fetchPresenceSnapshot', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    resetPresenceCache();
    process.env.ADMIN_API_TOKEN = 'token';
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
  });

  it('asks the game with the admin token, and shares the answer for a few seconds', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => snapshot() });
    await fetchPresenceSnapshot();
    await fetchPresenceSnapshot();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${PLAY}/presence`);
    expect(init.headers).toEqual({ Authorization: 'token' });
  });

  it('says nothing (null) when the game has no live directory yet', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect(await fetchPresenceSnapshot()).toBeNull();
  });

  it('says nothing when the game is unreachable', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await fetchPresenceSnapshot()).toBeNull();
  });
});
