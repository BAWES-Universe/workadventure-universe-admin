/**
 * The routes for a person's own Bricks (game #1995): the Brick everyone gets, the list for the Bricks page, what its
 * owner can change, and the shape the bot server reads a Brick in. A Brick is its owner's: a guest has none, nobody asks
 * for someone else, and a super admin gets no further than anyone. A bot server from before Bricks is never handed one.
 */
import { NextRequest } from 'next/server';
import { GET as listMine } from '@/app/api/bricks/route';
import { POST as ensureMine } from '@/app/api/bricks/default/route';
import { PATCH as changeBrick } from '@/app/api/bricks/[id]/route';
import { GET as getConfiguration } from '@/app/api/bots/configuration/[id]/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { ensureDefaultBrick, isDefaultBrick, listBricks } from '@/lib/brick-default';
import { BRICK_HAS_NO_ROOM } from '@/lib/brick';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/auth', () => ({ ...jest.requireActual('@/lib/auth'), requireAuth: jest.fn() }));
jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn(async () => null) }));
jest.mock('@/lib/tool-signin', () => ({ syncToolSignInNotices: jest.fn() }));
jest.mock('@/lib/brick-default', () => ({
  ...jest.requireActual('@/lib/brick-default'),
  ensureDefaultBrick: jest.fn(),
  listBricks: jest.fn(),
  isDefaultBrick: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const db = prisma as unknown as { bot: Record<'findUnique' | 'update', jest.Mock>; user: Record<'findUnique', jest.Mock> };
const session = getSessionUser as jest.Mock;
const ensure = ensureDefaultBrick as jest.Mock;
const list = listBricks as jest.Mock;
const isDefault = isDefaultBrick as jest.Mock;

const ADMIN_TOKEN = 'admin-secret';
const BRICK_ID = '7b0f3c1e-52a4-4d0b-9a3e-6f1d2c3b4a5e';
const SARA = { id: 'u-sara', email: 'sara@example.com', name: 'Sara' };
const OMAR = { id: 'u-omar', email: 'omar@example.com', name: 'Omar' };
const ROOT = { id: 'u-root', email: 'root@example.com', name: 'Root' };
const GUEST = { id: 'u-guest', email: null, name: 'Visitor' };

const card = { id: BRICK_ID, name: 'Brick', description: 'Your everyday helper', characterTextureId: 'brick-orange', enabled: true, isDefault: true, createdAt: '2026-11-11T00:00:00.000Z' };
const brick = {
  id: BRICK_ID,
  roomId: null,
  ownerId: SARA.id,
  room: null,
  name: 'Brick',
  description: 'Your everyday helper',
  characterTextureId: 'brick-orange',
  companionTextureId: 'dog',
  enabled: true,
  behaviorType: 'idle',
  behaviorConfig: { showToolCalls: true, assignedSpace: { center: { x: 9, y: 9 }, radius: 4 } },
  chatInstructions: 'Be brief.',
  movementInstructions: 'Walk about.',
  aiProviderRef: 'universe-ai',
  aiModel: null,
  toolTimeoutSeconds: null,
  maxReplyTokens: null,
  maxSteps: null,
  voiceEnabled: true,
  createdById: SARA.id,
  createdAt: new Date('2026-11-11'),
  updatedAt: new Date('2026-11-11'),
};

type Who = typeof SARA | typeof GUEST | 'token' | null;

function request(path: string, who: Who, init: { method?: string; body?: unknown; rawBody?: string } = {}) {
  session.mockResolvedValue(who && who !== 'token' ? who : null);
  return new NextRequest(`http://localhost:3333${path}`, {
    method: init.method ?? 'GET',
    headers: who === 'token' ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {},
    ...(init.rawBody !== undefined ? { body: init.rawBody } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
const params = (id = BRICK_ID) => ({ params: Promise.resolve({ id }) });

const envBefore = { superAdmins: process.env.SUPER_ADMINS, adminToken: process.env.ADMIN_API_TOKEN };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPER_ADMINS = ROOT.email;
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ isGuest: where.id === GUEST.id }));
  db.bot.findUnique.mockResolvedValue(brick);
  db.bot.update.mockResolvedValue(brick);
  ensure.mockResolvedValue({ brick: card, made: true, deleted: false });
  list.mockResolvedValue([card]);
  isDefault.mockResolvedValue(true);
});

afterAll(() => {
  for (const [key, value] of [['SUPER_ADMINS', envBefore.superAdmins], ['ADMIN_API_TOKEN', envBefore.adminToken]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /api/bricks/default: the Brick everyone gets', () => {
  it('answers a signed-in person with their own Brick, made for their account and nobody else’s', async () => {
    const response = await ensureMine(request('/api/bricks/default', SARA, { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ brick: card, made: true, deleted: false });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith(SARA.id);
  });

  it('says so, and makes nothing, when its owner deleted it on purpose', async () => {
    ensure.mockResolvedValue({ brick: null, made: false, deleted: true });
    const response = await ensureMine(request('/api/bricks/default', SARA, { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ brick: null, made: false, deleted: true });
  });

  it('makes none for a guest, for someone who is not signed in, or for the bot server’s token', async () => {
    expect((await ensureMine(request('/api/bricks/default', GUEST, { method: 'POST' }))).status).toBe(403);
    expect((await ensureMine(request('/api/bricks/default', null, { method: 'POST' }))).status).toBe(401);
    expect((await ensureMine(request('/api/bricks/default', 'token', { method: 'POST' }))).status).toBe(401);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('takes nobody’s name from the request: only the session says whose Brick it is', async () => {
    await ensureMine(request(`/api/bricks/default?userId=${OMAR.id}`, SARA, { method: 'POST', body: { userId: OMAR.id, ownerId: OMAR.id } }));
    expect(ensure).toHaveBeenCalledWith(SARA.id);
  });

  it('answers the game’s own origin, so the page it runs on can read it, and no other origin', async () => {
    const before = process.env.NEXT_PUBLIC_PLAY_URL;
    process.env.NEXT_PUBLIC_PLAY_URL = 'https://play.example.test';
    try {
      const fromGame = request('/api/bricks/default', SARA, { method: 'POST' });
      fromGame.headers.set('origin', 'https://play.example.test');
      const toGame = await ensureMine(fromGame);
      expect(toGame.headers.get('Access-Control-Allow-Origin')).toBe('https://play.example.test');
      expect(toGame.headers.get('Vary')).toBe('Origin');

      const fromElsewhere = request('/api/bricks/default', SARA, { method: 'POST' });
      fromElsewhere.headers.set('origin', 'https://elsewhere.example.test');
      expect((await ensureMine(fromElsewhere)).headers.get('Access-Control-Allow-Origin')).toBeNull();
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_PLAY_URL;
      else process.env.NEXT_PUBLIC_PLAY_URL = before;
    }
  });
});

describe('GET /api/bricks: a person’s own Bricks', () => {
  it('lists the person’s own, and reading the list makes nothing', async () => {
    const response = await listMine(request('/api/bricks', SARA));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bricks: [card] });
    expect(list).toHaveBeenCalledWith(SARA.id);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('gives a super admin their own Bricks, like anyone', async () => {
    await listMine(request('/api/bricks', ROOT));
    expect(list).toHaveBeenCalledWith(ROOT.id);
  });

  it('lists nothing for a guest, for someone who is not signed in, or for the bot server’s token', async () => {
    expect((await listMine(request('/api/bricks', GUEST))).status).toBe(403);
    expect((await listMine(request('/api/bricks', null))).status).toBe(401);
    expect((await listMine(request('/api/bricks', 'token'))).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/bricks/:id: what a Brick’s owner can change', () => {
  it('saves its name, its line, what it is told to be like and whether it is on', async () => {
    const response = await changeBrick(
      request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { name: '  Helper ', description: ' For recipes ', chatInstructions: ' Be kind. ', enabled: false } }),
      params(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ brick: card });
    expect(db.bot.update).toHaveBeenCalledWith({
      where: { id: BRICK_ID },
      data: { name: 'Helper', description: 'For recipes', chatInstructions: 'Be kind.', enabled: false, updatedById: SARA.id },
    });
  });

  it('changes only what was sent, and an emptied line is stored as none', async () => {
    await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { enabled: false } }), params());
    expect(db.bot.update).toHaveBeenLastCalledWith({ where: { id: BRICK_ID }, data: { enabled: false, updatedById: SARA.id } });
    await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { description: '  ', chatInstructions: null } }), params());
    expect(db.bot.update).toHaveBeenLastCalledWith({ where: { id: BRICK_ID }, data: { description: null, chatInstructions: null, updatedById: SARA.id } });
  });

  it.each([
    ['a room', { roomId: 'room-1' }],
    ['another owner', { ownerId: OMAR.id }],
    ['another key', { aiProviderRef: 'key-1' }],
    ['a voice', { voiceEnabled: true }],
    ['a look', { characterTextureId: 'woka-1' }],
  ])('refuses a save that names %s, and writes nothing', async (_what, extra) => {
    const response = await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { name: 'Helper', ...extra } }), params());
    expect(response.status).toBe(400);
    expect(db.bot.update).not.toHaveBeenCalled();
  });

  it('refuses an empty name, a name that is too long and a body that is not JSON', async () => {
    for (const init of [{ body: { name: '   ' } }, { body: { name: 'x'.repeat(101) } }, { rawBody: 'not json' }, { body: { enabled: 'yes' } }]) {
      const response = await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', ...init }), params());
      expect(response.status).toBe(400);
    }
    expect(db.bot.update).not.toHaveBeenCalled();
  });

  it('is not there for anyone but its owner, a super admin included, and the answer is the same as for no Brick at all', async () => {
    for (const who of [OMAR, ROOT]) {
      const response = await changeBrick(request(`/api/bricks/${BRICK_ID}`, who, { method: 'PATCH', body: { enabled: false } }), params());
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Brick not found' });
    }
    db.bot.findUnique.mockResolvedValue(null);
    const missing = await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { enabled: false } }), params());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Brick not found' });
    expect(db.bot.update).not.toHaveBeenCalled();
  });

  it('never changes a bot that lives in a room, even for the person who made it', async () => {
    db.bot.findUnique.mockResolvedValue({ id: BRICK_ID, roomId: 'room-1', ownerId: null });
    const response = await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { enabled: false } }), params());
    expect(response.status).toBe(404);
    expect(db.bot.update).not.toHaveBeenCalled();
  });

  it('changes nothing for a guest, for someone who is not signed in, or for the bot server’s token', async () => {
    expect((await changeBrick(request(`/api/bricks/${BRICK_ID}`, GUEST, { method: 'PATCH', body: { enabled: false } }), params())).status).toBe(403);
    expect((await changeBrick(request(`/api/bricks/${BRICK_ID}`, null, { method: 'PATCH', body: { enabled: false } }), params())).status).toBe(401);
    expect((await changeBrick(request(`/api/bricks/${BRICK_ID}`, 'token', { method: 'PATCH', body: { enabled: false } }), params())).status).toBe(401);
    expect(db.bot.update).not.toHaveBeenCalled();
  });
});

describe('GET /api/bots/configuration/:id: a Brick, as the bot server reads it', () => {
  const configuration = (who: Who, query = '?bricks=1') => getConfiguration(request(`/api/bots/configuration/${BRICK_ID}${query}`, who), params());

  it('answers the bot server that knows Bricks with the Brick: no room, world or universe, and whose it is', async () => {
    const response = await configuration('token');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      botId: BRICK_ID,
      name: 'Brick',
      brick: { ownerId: SARA.id, isDefault: true },
      roomUrl: null,
      worldUrl: null,
      universeUrl: null,
      userId: SARA.id,
      behaviorType: 'idle',
      behaviorConfig: { showToolCalls: true, behaviorType: 'idle', assignedSpace: { center: { x: 0, y: 0 }, radius: 0 } },
      assignedSpace: { center: { x: 0, y: 0 }, radius: 0 },
      enabled: true,
      characterTextureIds: ['brick-orange'],
      createdAt: '2026-11-11T00:00:00.000Z',
      updatedAt: '2026-11-11T00:00:00.000Z',
      aiProviderRef: 'universe-ai',
      chatInstructions: 'Be brief.',
      movementInstructions: null,
      toolTimeoutSeconds: null,
      maxReplyTokens: null,
      maxSteps: null,
      companionTextureId: null,
      voiceEnabled: false,
    });
  });

  it('says which Brick is one its owner made', async () => {
    isDefault.mockResolvedValue(false);
    expect(await (await configuration('token')).json()).toMatchObject({ brick: { ownerId: SARA.id, isDefault: false } });
  });

  it('never hands a Brick to a bot server from before Bricks, which would read it as a bot in a room', async () => {
    for (const query of ['', '?bricks=0', '?bricks=true', '?includeSensitive=true']) {
      const response = await configuration('token', query);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: BRICK_HAS_NO_ROOM });
    }
  });

  it('answers its owner the same way, and tells its owner why when the shape was not asked for', async () => {
    expect((await configuration(SARA)).status).toBe(200);
    const plain = await configuration(SARA, '');
    expect(plain.status).toBe(404);
    expect(await plain.json()).toEqual({ error: BRICK_HAS_NO_ROOM });
  });

  it('is not there for anyone else, a super admin included, whatever they ask for', async () => {
    for (const who of [OMAR, ROOT]) {
      for (const query of ['?bricks=1', '']) {
        const response = await configuration(who, query);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Bot not found' });
      }
    }
  });
});
