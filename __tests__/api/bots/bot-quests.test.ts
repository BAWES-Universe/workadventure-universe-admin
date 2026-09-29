/**
 * What a quest-giver bot is told about its quests (workadventure-universe#565): the bots service reads it with the
 * service token; a person only for a bot they can manage.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBots: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBots } from '@/lib/bot-permissions';
import { GET } from '@/app/api/bots/[id]/quests/route';
import { welcomeQuestsForRoom } from '@/lib/quests/bot-quests';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const OWNER = { id: 'u-owner', uuid: 'uuid-owner', email: 'o@example.test', name: 'Owner', tags: [], isSuperAdmin: false };
const VISITOR = { id: 'u-visitor', uuid: 'uuid-visitor', email: 'v@example.test', name: 'Visitor', tags: [], isSuperAdmin: false };

const req = (as?: 'owner' | 'visitor' | 'admin-token') =>
  new NextRequest('http://localhost:3333/api/bots/b-1/quests', {
    headers:
      as === 'admin-token' ? { Authorization: `Bearer ${process.env.ADMIN_API_TOKEN}` } : as ? { Authorization: `Bearer session-${as}` } : {},
  });
const params = { params: Promise.resolve({ id: 'b-1' }) };

const BOT = {
  id: 'b-1',
  enabled: true,
  roomId: 'r-1',
  room: { slug: 'lobby', world: { slug: 'office', universe: { slug: 'bawes' } } },
};

const WAM = {
  version: '2.0.0',
  areas: [
    { id: 'a-2', name: 'Courtyard', x: 0, y: 0, width: 10, height: 10 },
    { id: 'a-1', name: 'Atrium', x: 0, y: 0, width: 10, height: 10 },
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
    const who = request.headers.get('authorization')?.replace('Bearer session-', '');
    return Promise.resolve(who === 'owner' ? OWNER : who === 'visitor' ? VISITOR : null);
  });
  (canManageBots as jest.Mock).mockImplementation((userId: string) => Promise.resolve(userId === OWNER.id));
  db.bot.findUnique.mockResolvedValue(BOT);
  fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(WAM) });
});

describe('GET /api/bots/[id]/quests', () => {
  it('answers 401 without the service token or a session', async () => {
    expect((await GET(req(), params)).status).toBe(401);
    expect(db.bot.findUnique).not.toHaveBeenCalled();
  });

  it('answers 404 for a bot that does not exist or is disabled', async () => {
    db.bot.findUnique.mockResolvedValue(null);
    expect((await GET(req('admin-token'), params)).status).toBe(404);
    db.bot.findUnique.mockResolvedValue({ ...BOT, enabled: false });
    expect((await GET(req('admin-token'), params)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 403 to a signed-in person who cannot manage this bot', async () => {
    const res = await GET(req('visitor'), params);
    expect(res.status).toBe(403);
    expect(canManageBots).toHaveBeenCalledWith(VISITOR.id, 'r-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives the service token the Welcome chapter as this room offers it, in the game\'s words', async () => {
    const res = await GET(req('admin-token'), params);
    expect(res.status).toBe(200);
    expect(canManageBots).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      botId: 'b-1',
      roomId: 'r-1',
      source: 'welcome-chapter',
      quests: [
        {
          id: 'welcome.meet',
          title: 'Meet someone',
          description: "Say hi to whoever's here.",
          objective: 'Say hi to someone',
          minutes: 2,
          badge: 'First Hello',
        },
        {
          id: 'welcome.explore',
          title: 'Explore this place',
          description: 'Find the area.',
          objective: 'Find the area',
          minutes: 1,
          badge: 'Explorer',
          areas: ['Atrium', 'Courtyard'],
        },
        {
          id: 'welcome.build',
          title: 'Try building',
          description: 'Add one thing to the map.',
          objective: 'Add one thing',
          minutes: 2,
          badge: 'Builder',
          needs: 'Needs: edit rights in this room',
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://map-storage.test/play.test/bawes/office/lobby/map.wam',
      expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer map-token' } }),
    );
  });

  it('lets the room\'s manager read it too', async () => {
    const res = await GET(req('owner'), params);
    expect(res.status).toBe(200);
    expect(canManageBots).toHaveBeenCalledWith(OWNER.id, 'r-1');
  });

  it('leaves Explore out when the room has no named area to find', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    const body = await (await GET(req('admin-token'), params)).json();
    expect(body.quests.map((quest: { id: string }) => quest.id)).toEqual(['welcome.meet', 'welcome.build']);
  });

  it('carries no player text or private data', async () => {
    const body = JSON.stringify(await (await GET(req('admin-token'), params)).json());
    expect(body).not.toMatch(/email|uuid|token|instructions/i);
  });
});

describe('welcomeQuestsForRoom', () => {
  it('names every area the game could pick for Explore, in order', () => {
    const explore = welcomeQuestsForRoom([
      { id: 'a-1', name: 'Atrium' },
      { id: 'a-2', name: 'Courtyard' },
    ]).find((quest) => quest.id === 'welcome.explore');
    expect(explore?.areas).toEqual(['Atrium', 'Courtyard']);
  });

  it('offers Meet and Build in a room with no areas', () => {
    expect(welcomeQuestsForRoom([]).map((quest) => quest.id)).toEqual(['welcome.meet', 'welcome.build']);
  });
});
