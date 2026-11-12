/**
 * The routes for a person's own Bricks (game #1995): the Brick everyone gets, the list for the Bricks page, what its
 * owner can change, and the shape the bot server reads a Brick in. A Brick is its owner's: a guest has none, nobody asks
 * for someone else, and a super admin gets no further than anyone. A bot server from before Bricks is never handed one.
 *
 * With them (game #1996): New Brick, deleting one, Undo, and the sweep that removes what waited long enough.
 */
import { NextRequest } from 'next/server';
import { GET as listMine, POST as makeMine } from '@/app/api/bricks/route';
import { POST as ensureMine } from '@/app/api/bricks/default/route';
import { DELETE as deleteMine, PATCH as changeBrick } from '@/app/api/bricks/[id]/route';
import { POST as undoMine } from '@/app/api/bricks/[id]/undo/route';
import { POST as sweep } from '@/app/api/bricks/sweep/route';
import { GET as getConfiguration } from '@/app/api/bots/configuration/[id]/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { ensureDefaultBrick, isDefaultBrick, listBricks, listDeletedBricks } from '@/lib/brick-default';
import { deleteBrick, removeGoneBricks, undoBrickDelete } from '@/lib/brick-delete';
import { makeBrick } from '@/lib/brick-make';
import { BRICK_HAS_NO_ROOM } from '@/lib/brick';
import { checkAiProviderRef, checkBotModel } from '@/lib/ai-provider-ref';
import { checkConfigVision, dropOthersVisionKey } from '@/lib/bot-vision';
import { clearBotRunsOnNotices } from '@/lib/notices';

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
  listDeletedBricks: jest.fn(),
  isDefaultBrick: jest.fn(),
}));
jest.mock('@/lib/brick-delete', () => ({ deleteBrick: jest.fn(), undoBrickDelete: jest.fn(), removeGoneBricks: jest.fn() }));
jest.mock('@/lib/brick-visit', () => ({ endStaleVisits: jest.fn(async () => 0) }));
jest.mock('@/lib/brick-home', () => ({ dropHomesWithoutAccess: jest.fn(async () => 0) }));
jest.mock('@/lib/brick-make', () => ({ ...jest.requireActual('@/lib/brick-make'), makeBrick: jest.fn() }));
jest.mock('@/lib/bot-limits', () => ({ ...jest.requireActual('@/lib/bot-limits'), getBrickLimits: jest.fn(async () => ({ undoDays: 7, offerAfter: 3 })) }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/ai-provider-ref', () => ({ checkAiProviderRef: jest.fn(async () => null), checkBotModel: jest.fn(async () => null) }));
jest.mock('@/lib/bot-vision', () => ({ ...jest.requireActual('@/lib/bot-vision'), checkConfigVision: jest.fn(async () => null), dropOthersVisionKey: jest.fn(async () => null) }));
jest.mock('@/lib/notices', () => ({ ...jest.requireActual('@/lib/notices'), clearBotRunsOnNotices: jest.fn(async () => undefined) }));

const db = prisma as unknown as { bot: Record<'findUnique' | 'update', jest.Mock>; user: Record<'findUnique', jest.Mock> };
const session = getSessionUser as jest.Mock;
const ensure = ensureDefaultBrick as jest.Mock;
const list = listBricks as jest.Mock;
const listDeleted = listDeletedBricks as jest.Mock;
const isDefault = isDefaultBrick as jest.Mock;
const remove = deleteBrick as jest.Mock;
const undo = undoBrickDelete as jest.Mock;
const removeGone = removeGoneBricks as jest.Mock;
const make = makeBrick as jest.Mock;

const ADMIN_TOKEN = 'admin-secret';
const SERVICE_TOKEN = 'bot-server-secret';
const BRICK_ID = '7b0f3c1e-52a4-4d0b-9a3e-6f1d2c3b4a5e';
const SARA = { id: 'u-sara', email: 'sara@example.com', name: 'Sara' };
const OMAR = { id: 'u-omar', email: 'omar@example.com', name: 'Omar' };
const ROOT = { id: 'u-root', email: 'root@example.com', name: 'Root' };
const GUEST = { id: 'u-guest', email: null, name: 'Visitor' };

const card = { id: BRICK_ID, name: 'Brick', description: 'Your everyday helper', characterTextureId: 'brick-orange', enabled: true, isDefault: true, hello: null, createdAt: '2026-11-11T00:00:00.000Z' };
const MADE_ID = '0a7d2f4c-1b3e-4c5d-8e9f-a0b1c2d3e4f5';
const madeCard = { id: MADE_ID, name: 'Recipe Brick', description: 'Keeps your mum’s recipes', characterTextureId: 'brick-red', enabled: true, isDefault: false, hello: 'Send me the first recipe.', createdAt: '2026-11-12T00:00:00.000Z' };
const waitingCard = { ...madeCard, enabled: false, deletedAt: '2026-11-12T09:00:00.000Z', goneAt: '2026-11-19T09:00:00.000Z' };
const brick = {
  id: BRICK_ID,
  roomId: null,
  ownerId: SARA.id,
  deletedAt: null as Date | null,
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

const envBefore = { superAdmins: process.env.SUPER_ADMINS, adminToken: process.env.ADMIN_API_TOKEN, serviceToken: process.env.BOT_SERVICE_TOKEN };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPER_ADMINS = ROOT.email;
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ isGuest: where.id === GUEST.id }));
  db.bot.findUnique.mockResolvedValue(brick);
  db.bot.update.mockResolvedValue(brick);
  ensure.mockResolvedValue({ brick: card, made: true, deleted: false });
  list.mockResolvedValue([card]);
  listDeleted.mockResolvedValue([]);
  removeGone.mockResolvedValue([]);
  isDefault.mockResolvedValue(true);
});

afterAll(() => {
  for (const [key, value] of [['SUPER_ADMINS', envBefore.superAdmins], ['ADMIN_API_TOKEN', envBefore.adminToken], ['BOT_SERVICE_TOKEN', envBefore.serviceToken]] as const) {
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
    expect(await response.json()).toEqual({ bricks: [card], deleted: [], undoDays: 7 });
    expect(list).toHaveBeenCalledWith(SARA.id);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('lists the ones that wait deleted on their own, each with the day it is gone for good, and how long a delete waits (game #1996)', async () => {
    listDeleted.mockResolvedValue([waitingCard]);
    const response = await listMine(request('/api/bricks', SARA));
    expect(await response.json()).toEqual({ bricks: [card], deleted: [waitingCard], undoDays: 7 });
    expect(listDeleted).toHaveBeenCalledWith(SARA.id, expect.any(Date));
  });

  it('clears away this person’s own Bricks whose days are over on the way, and nobody else’s', async () => {
    await listMine(request('/api/bricks', SARA));
    expect(removeGone).toHaveBeenCalledTimes(1);
    expect(removeGone).toHaveBeenCalledWith(expect.any(Date), SARA.id);
  });

  it('still lists when that tidying fails: no list ever shows a Brick whose days are over anyway', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    removeGone.mockRejectedValue(new Error('down'));
    const response = await listMine(request('/api/bricks', SARA));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bricks: [card], deleted: [], undoDays: 7 });
    error.mockRestore();
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
    expect(listDeleted).not.toHaveBeenCalled();
    expect(removeGone).not.toHaveBeenCalled();
  });
});

describe('POST /api/bricks: New Brick (game #1996)', () => {
  beforeEach(() => make.mockResolvedValue(madeCard));

  it('makes a Brick for the person who asks and answers with its card', async () => {
    const response = await makeMine(
      request('/api/bricks', SARA, { method: 'POST', body: { name: '  Recipe Brick ', characterTextureId: 'brick-red', description: ' Keeps your mum’s recipes ', hello: ' Send me the first recipe. ' } }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ brick: madeCard });
    expect(make).toHaveBeenCalledTimes(1);
    expect(make).toHaveBeenCalledWith(SARA.id, { name: 'Recipe Brick', characterTextureId: 'brick-red', description: 'Keeps your mum’s recipes', hello: 'Send me the first recipe.' });
  });

  it('needs only a name', async () => {
    expect((await makeMine(request('/api/bricks', SARA, { method: 'POST', body: { name: 'Teal Brick' } }))).status).toBe(201);
    expect(make).toHaveBeenCalledWith(SARA.id, { name: 'Teal Brick' });
  });

  it('saves its look, the way it is checked when a Brick is made: a Brick look or a WOKA id, never empty or too long', async () => {
    const response = await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { characterTextureId: ' brick-red ' } }), params());
    expect(response.status).toBe(200);
    expect(db.bot.update).toHaveBeenLastCalledWith({ where: { id: BRICK_ID }, data: { characterTextureId: 'brick-red', updatedById: SARA.id } });
    for (const characterTextureId of ['  ', 'x'.repeat(101), null]) {
      expect((await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { characterTextureId } }), params())).status).toBe(400);
    }
  });

  describe('what it runs on (Mind)', () => {
    const home = { actorId: SARA.id, makerId: SARA.id, roomId: null, ownerId: SARA.id, botId: BRICK_ID };

    it('puts it on one of its owner’s keys judged as a room bot’s is, with its owner in place of a room, and starts it on that key’s own model', async () => {
      const response = await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { aiProviderRef: 'key-1' } }), params());
      expect(response.status).toBe(200);
      expect(checkAiProviderRef).toHaveBeenCalledWith('key-1', 'universe-ai', home);
      expect(checkBotModel).toHaveBeenCalledWith(undefined, { ...home, ref: 'key-1', currentRef: 'universe-ai', currentModel: null });
      expect(db.bot.update).toHaveBeenLastCalledWith({ where: { id: BRICK_ID }, data: { aiProviderRef: 'key-1', aiModel: null, updatedById: SARA.id } });
      expect(dropOthersVisionKey).toHaveBeenCalledWith(brick.behaviorConfig, SARA.id);
      expect(clearBotRunsOnNotices).toHaveBeenCalledWith(BRICK_ID);
    });

    it('saves a model picked on the key, and writes nothing when the key is not its owner’s', async () => {
      await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { aiProviderRef: 'key-1', aiModel: 'm-2' } }), params());
      expect(db.bot.update).toHaveBeenLastCalledWith({ where: { id: BRICK_ID }, data: { aiProviderRef: 'key-1', aiModel: 'm-2', updatedById: SARA.id } });
      db.bot.update.mockClear();
      (checkAiProviderRef as jest.Mock).mockResolvedValueOnce('AI provider "key-9" does not exist');
      const refused = await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { aiProviderRef: 'key-9' } }), params());
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'AI provider "key-9" does not exist' });
      (checkBotModel as jest.Mock).mockResolvedValueOnce('That model isn’t on this key’s list. Pick one it has.');
      expect((await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { aiModel: 'nope' } }), params())).status).toBe(400);
      expect(db.bot.update).not.toHaveBeenCalled();
    });

    it('does not touch what it runs on, or its notices, when a save says nothing about it', async () => {
      await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { name: 'Helper' } }), params());
      expect(clearBotRunsOnNotices).not.toHaveBeenCalled();
      expect(checkAiProviderRef).not.toHaveBeenCalled();
    });
  });

  describe('how it behaves, and its companion', () => {
    it('merges the Behavior keys sent into what is saved, so what the other parts keep there stays', async () => {
      const response = await changeBrick(
        request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { behaviorType: 'social', behaviorConfig: { moves: 'wander', goesToPeople: true, conversationRadius: 100 }, companionTextureId: 'dog-2' } }),
        params(),
      );
      expect(response.status).toBe(200);
      expect(checkConfigVision).toHaveBeenCalledWith({ moves: 'wander', goesToPeople: true, conversationRadius: 100 }, expect.objectContaining({ roomId: null, ownerId: SARA.id }));
      expect(db.bot.update).toHaveBeenLastCalledWith({
        where: { id: BRICK_ID },
        data: {
          behaviorType: 'social',
          behaviorConfig: { ...brick.behaviorConfig, moves: 'wander', goesToPeople: true, conversationRadius: 100 },
          companionTextureId: 'dog-2',
          updatedById: SARA.id,
        },
      });
    });

    it('takes the direction and pause of a route it was saved with', async () => {
      const response = await changeBrick(
        request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { behaviorConfig: { loop: false, pauseAtWaypoints: 5 } } }),
        params(),
      );
      expect(response.status).toBe(200);
      expect(db.bot.update).toHaveBeenLastCalledWith({
        where: { id: BRICK_ID },
        data: { behaviorConfig: { ...brick.behaviorConfig, loop: false, pauseAtWaypoints: 5 }, updatedById: SARA.id },
      });
    });

    it('clears its companion with null, and refuses a behavior it does not know', async () => {
      await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body: { companionTextureId: null } }), params());
      expect(db.bot.update).toHaveBeenLastCalledWith({ where: { id: BRICK_ID }, data: { companionTextureId: null, updatedById: SARA.id } });
      db.bot.update.mockClear();
      for (const body of [{ behaviorType: 'run' }, { behaviorConfig: { moves: 'fly' } }, { behaviorConfig: { conversationRadius: -1 } }, { companionTextureId: '' }]) {
        expect((await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body }), params())).status).toBe(400);
      }
      expect(db.bot.update).not.toHaveBeenCalled();
    });
  });

  it('gives none of it to anyone but its owner: a super admin gets "not found" and nothing is checked or written', async () => {
    const body = { characterTextureId: 'brick-red', aiProviderRef: 'key-1', behaviorType: 'social', companionTextureId: 'dog' };
    for (const who of [OMAR, ROOT]) {
      const response = await changeBrick(request(`/api/bricks/${BRICK_ID}`, who, { method: 'PATCH', body }), params());
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Brick not found' });
    }
    expect(checkAiProviderRef).not.toHaveBeenCalled();
    expect(db.bot.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a room', { roomId: 'room-1' }],
    ['another owner', { ownerId: OMAR.id }],
    ['another person', { userId: OMAR.id }],
    ['a key', { aiProviderRef: 'key-1' }],
    ['a voice', { voiceEnabled: true }],
    ['a switch', { enabled: false }],
  ])('refuses a Brick that names %s, and makes nothing', async (_what, extra) => {
    const response = await makeMine(request('/api/bricks', SARA, { method: 'POST', body: { name: 'Recipe Brick', ...extra } }));
    expect(response.status).toBe(400);
    expect(make).not.toHaveBeenCalled();
  });

  it('refuses no name, a name, line, look or hello that is too long, and a body that is not JSON', async () => {
    for (const init of [
      { body: {} },
      { body: { name: '   ' } },
      { body: { name: 'x'.repeat(101) } },
      { body: { name: 'Ok', description: 'x'.repeat(201) } },
      { body: { name: 'Ok', characterTextureId: 'x'.repeat(101) } },
      { body: { name: 'Ok', hello: 'x'.repeat(301) } },
      { rawBody: 'not json' },
    ]) {
      expect((await makeMine(request('/api/bricks', SARA, { method: 'POST', ...init }))).status).toBe(400);
    }
    expect(make).not.toHaveBeenCalled();
  });

  it('makes none for a guest, for someone who is not signed in, or for the bot server’s token', async () => {
    expect((await makeMine(request('/api/bricks', GUEST, { method: 'POST', body: { name: 'Mine' } }))).status).toBe(403);
    expect((await makeMine(request('/api/bricks', null, { method: 'POST', body: { name: 'Mine' } }))).status).toBe(401);
    expect((await makeMine(request('/api/bricks', 'token', { method: 'POST', body: { name: 'Mine' } }))).status).toBe(401);
    expect(make).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/bricks/:id and POST /api/bricks/:id/undo: deleting a Brick, with Undo (game #1996)', () => {
  beforeEach(() => {
    remove.mockResolvedValue(waitingCard);
    undo.mockResolvedValue(madeCard);
  });

  it('deletes the Brick for its owner and answers with it as it waits, the day it is gone for good with it', async () => {
    const response = await deleteMine(request(`/api/bricks/${MADE_ID}`, SARA, { method: 'DELETE' }), params(MADE_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ brick: waitingCard });
    expect(remove).toHaveBeenCalledWith(MADE_ID, SARA.id);
  });

  it('gives it back to its owner with Undo, as its card', async () => {
    const response = await undoMine(request(`/api/bricks/${MADE_ID}/undo`, SARA, { method: 'POST' }), params(MADE_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ brick: madeCard });
    expect(undo).toHaveBeenCalledWith(MADE_ID, SARA.id);
  });

  it('asks only in the name of the person signed in: whose Brick it is comes from the session, never from the request', async () => {
    await deleteMine(request(`/api/bricks/${MADE_ID}?userId=${OMAR.id}`, ROOT, { method: 'DELETE', body: { ownerId: OMAR.id } }), params(MADE_ID));
    expect(remove).toHaveBeenCalledWith(MADE_ID, ROOT.id);
    await undoMine(request(`/api/bricks/${MADE_ID}/undo?userId=${OMAR.id}`, ROOT, { method: 'POST', body: { ownerId: OMAR.id } }), params(MADE_ID));
    expect(undo).toHaveBeenCalledWith(MADE_ID, ROOT.id);
  });

  it('is not there when there is nothing of theirs to delete or give back, in the same words as for no Brick at all', async () => {
    remove.mockResolvedValue(null);
    undo.mockResolvedValue(null);
    for (const response of [
      await deleteMine(request(`/api/bricks/${MADE_ID}`, OMAR, { method: 'DELETE' }), params(MADE_ID)),
      await undoMine(request(`/api/bricks/${MADE_ID}/undo`, OMAR, { method: 'POST' }), params(MADE_ID)),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Brick not found' });
    }
  });

  it('does nothing for a guest, for someone who is not signed in, or for the bot server’s token', async () => {
    for (const [who, status] of [[GUEST, 403], [null, 401], ['token', 401]] as const) {
      expect((await deleteMine(request(`/api/bricks/${MADE_ID}`, who, { method: 'DELETE' }), params(MADE_ID))).status).toBe(status);
      expect((await undoMine(request(`/api/bricks/${MADE_ID}/undo`, who, { method: 'POST' }), params(MADE_ID))).status).toBe(status);
    }
    expect(remove).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
  });

  it('answers the game’s own origin on both, so the Bricks page can read them', async () => {
    const before = process.env.NEXT_PUBLIC_PLAY_URL;
    process.env.NEXT_PUBLIC_PLAY_URL = 'https://play.example.test';
    try {
      const del = request(`/api/bricks/${MADE_ID}`, SARA, { method: 'DELETE' });
      del.headers.set('origin', 'https://play.example.test');
      expect((await deleteMine(del, params(MADE_ID))).headers.get('Access-Control-Allow-Origin')).toBe('https://play.example.test');
      const back = request(`/api/bricks/${MADE_ID}/undo`, SARA, { method: 'POST' });
      back.headers.set('origin', 'https://play.example.test');
      expect((await undoMine(back, params(MADE_ID))).headers.get('Access-Control-Allow-Origin')).toBe('https://play.example.test');
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_PLAY_URL;
      else process.env.NEXT_PUBLIC_PLAY_URL = before;
    }
  });
});

describe('POST /api/bricks/sweep: what waited long enough is removed for good (game #1996)', () => {
  it('removes for everyone when the bot server asks, and names what went so their chats can be closed', async () => {
    removeGone.mockResolvedValue([MADE_ID]);
    const asked = request('/api/bricks/sweep', null, { method: 'POST' });
    asked.headers.set('authorization', `Bearer ${SERVICE_TOKEN}`);
    const response = await sweep(asked);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: [MADE_ID] });
    expect(removeGone).toHaveBeenCalledWith();
  });

  it('is for the bot server only: a person, a super admin included, starts no sweep, and neither does the admin token', async () => {
    for (const who of [SARA, ROOT, GUEST, null, 'token'] as const) {
      expect((await sweep(request('/api/bricks/sweep', who, { method: 'POST' }))).status).toBe(401);
    }
    expect(removeGone).not.toHaveBeenCalled();
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
    ['a voice', { voiceEnabled: true }],
    ['a behavior key that is not Behavior’s', { behaviorConfig: { showToolCalls: true } }],
    ['a tool timeout', { toolTimeoutSeconds: 5 }],
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

  it('changes nothing about a Brick that waits deleted, its switch least of all: it is not there until Undo (game #1996)', async () => {
    db.bot.findUnique.mockResolvedValue({ id: BRICK_ID, roomId: null, ownerId: SARA.id, deletedAt: new Date('2026-11-12T09:00:00Z') });
    for (const body of [{ enabled: true }, { name: 'Back' }]) {
      const response = await changeBrick(request(`/api/bricks/${BRICK_ID}`, SARA, { method: 'PATCH', body }), params());
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Brick not found' });
    }
    expect(db.bot.update).not.toHaveBeenCalled();
  });

  it('never changes a bot that lives in a room, even for the person who made it', async () => {
    db.bot.findUnique.mockResolvedValue({ id: BRICK_ID, roomId: 'room-1', ownerId: null, deletedAt: null });
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
      brick: { ownerId: SARA.id, isDefault: true, deleted: false },
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

  it('tells the bot server a Brick that waits deleted is off and deleted, and never that it is gone, so its chat is kept for Undo (game #1996)', async () => {
    db.bot.findUnique.mockResolvedValue({ ...brick, enabled: false, deletedAt: new Date('2026-11-12T09:00:00Z') });
    const response = await configuration('token');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ botId: BRICK_ID, enabled: false, brick: { ownerId: SARA.id, isDefault: true, deleted: true } });
    // Never on while deleted, whatever the row says
    db.bot.findUnique.mockResolvedValue({ ...brick, enabled: true, deletedAt: new Date('2026-11-12T09:00:00Z') });
    expect(await (await configuration('token')).json()).toMatchObject({ enabled: false, brick: { deleted: true } });
  });

  it('is not there for its owner while it waits deleted: only the bot server reads it then', async () => {
    db.bot.findUnique.mockResolvedValue({ ...brick, enabled: false, deletedAt: new Date('2026-11-12T09:00:00Z') });
    const response = await configuration(SARA);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Bot not found' });
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
