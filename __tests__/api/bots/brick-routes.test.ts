/**
 * A Brick (game #1992) behind the routes that were written for room bots. A Brick is read by its owner and the bot server
 * and by nobody else, a super admin included. The room editor's save and delete, and the bot server's configuration in the
 * room bot shape, answer "This bot is not in a room" (or "Bot not found" to anyone else) and write nothing. The lists that
 * are about rooms never hold a Brick: above all the list a bot server reads, because a bot server that only knows room bots
 * must not be handed a bot with no room URL.
 *
 * Who manages the bot is the real check (lib/bot-permissions.ts), not a stand-in.
 */
import { NextRequest } from 'next/server';
import { GET as getBot, PUT as putBot, DELETE as deleteBot } from '@/app/api/bots/[id]/route';
import { GET as listConfigurations, POST as saveConfiguration } from '@/app/api/bots/configuration/route';
import { GET as getConfiguration, DELETE as deleteConfiguration } from '@/app/api/bots/configuration/[id]/route';
import { GET as listAllBots } from '@/app/api/admin/bots/route';
import { GET as getBotPage } from '@/app/api/admin/bots/[id]/route';
import { GET as getProviderPage } from '@/app/api/admin/ai-providers/[id]/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { BRICK_HAS_NO_ROOM } from '@/lib/brick';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: {
      findUnique: jest.fn(),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      create: jest.fn(),
    },
    room: { findUnique: jest.fn(), findFirst: jest.fn() },
    user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    botsAiProvider: { findUnique: jest.fn() },
    botsAiUsage: { aggregate: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn(async () => null) }));
jest.mock('@/lib/tool-signin', () => ({ syncToolSignInNotices: jest.fn() }));
jest.mock('@/lib/bot-config-helpers', () => ({
  ...jest.requireActual('@/lib/bot-config-helpers'),
  resolveRoomIdFromPlayUri: jest.fn(async () => 'room-123'),
}));

const db = prisma as unknown as {
  bot: Record<'findUnique' | 'findMany' | 'count' | 'update' | 'delete' | 'deleteMany' | 'create', jest.Mock>;
  botsAiProvider: { findUnique: jest.Mock };
  botsAiUsage: Record<'aggregate' | 'findMany' | 'count' | 'groupBy', jest.Mock>;
};
const session = getSessionUser as jest.Mock;

const ADMIN_TOKEN = 'admin-secret';
const BRICK_ID = '7b0f3c1e-52a4-4d0b-9a3e-6f1d2c3b4a5e';
const SARA = { id: 'u-sara', email: 'sara@example.com', name: 'Sara' };
const OMAR = { id: 'u-omar', email: 'omar@example.com', name: 'Omar' };
const ROOT = { id: 'u-root', email: 'root@example.com', name: 'Root' };

const brick = {
  id: BRICK_ID,
  roomId: null,
  ownerId: SARA.id,
  room: null,
  name: 'Brick',
  description: null,
  characterTextureId: null,
  companionTextureId: null,
  enabled: true,
  behaviorType: 'idle',
  behaviorConfig: { showToolCalls: true },
  chatInstructions: 'Be brief.',
  movementInstructions: null,
  aiProviderRef: 'universe-ai',
  aiModel: null,
  createdById: SARA.id,
  createdAt: new Date('2026-11-11'),
  updatedAt: new Date('2026-11-11'),
  createdBy: { id: SARA.id, name: SARA.name },
  updatedBy: null,
};

type Who = typeof SARA | 'token' | null;

function request(path: string, who: Who, init: { method?: string; body?: unknown } = {}) {
  session.mockResolvedValue(who && who !== 'token' ? who : null);
  return new NextRequest(`http://localhost:3333${path}`, {
    method: init.method ?? 'GET',
    headers: who === 'token' ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {},
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
const params = (id = BRICK_ID) => ({ params: Promise.resolve({ id }) });

const envBefore = { superAdmins: process.env.SUPER_ADMINS, adminToken: process.env.ADMIN_API_TOKEN };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPER_ADMINS = ROOT.email;
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  db.bot.findUnique.mockResolvedValue(brick);
  db.bot.findMany.mockResolvedValue([]);
  db.bot.count.mockResolvedValue(0);
});

afterAll(() => {
  for (const [key, value] of [['SUPER_ADMINS', envBefore.superAdmins], ['ADMIN_API_TOKEN', envBefore.adminToken]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function nothingWritten() {
  expect(db.bot.update).not.toHaveBeenCalled();
  expect(db.bot.delete).not.toHaveBeenCalled();
  expect(db.bot.deleteMany).not.toHaveBeenCalled();
  expect(db.bot.create).not.toHaveBeenCalled();
}

describe('reading one Brick (GET /api/bots/:id)', () => {
  it('gives its owner the whole bot, with no room', async () => {
    const response = await getBot(request(`/api/bots/${BRICK_ID}`, SARA), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ id: BRICK_ID, roomId: null, name: 'Brick', chatInstructions: 'Be brief.', aiProviderRef: 'universe-ai' });
    expect(body).not.toHaveProperty('room');
  });

  it('gives the bot server the whole bot', async () => {
    const response = await getBot(request(`/api/bots/${BRICK_ID}`, 'token'), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: BRICK_ID, roomId: null, chatInstructions: 'Be brief.' });
  });

  it.each([
    ['another person', OMAR],
    ['a super admin', ROOT],
  ])('answers %s as for a bot that does not exist', async (_who, person) => {
    const response = await getBot(request(`/api/bots/${BRICK_ID}`, person), params());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Bot not found' });
  });

  it('answers someone who is not signed in as for a bot that does not exist', async () => {
    const response = await getBot(request(`/api/bots/${BRICK_ID}`, null), params());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });
});

describe('the room editor’s save and delete (PUT and DELETE /api/bots/:id)', () => {
  it.each([
    ['its owner', SARA, BRICK_HAS_NO_ROOM],
    ['the bot server', 'token', BRICK_HAS_NO_ROOM],
    ['another person', OMAR, 'Bot not found'],
    ['a super admin', ROOT, 'Bot not found'],
  ] as const)('does not save a Brick for %s', async (_who, who, error) => {
    const response = await putBot(request(`/api/bots/${BRICK_ID}`, who, { method: 'PUT', body: { name: 'Renamed' } }), params());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error });
    nothingWritten();
  });

  it('does not move a Brick into a room: placing a Brick is its own issue', async () => {
    const response = await putBot(
      request(`/api/bots/${BRICK_ID}`, SARA, { method: 'PUT', body: { roomId: '3f1c7a5e-9a52-4a52-8d3b-0c0f6d2f9a11' } }),
      params(),
    );
    expect(response.status).toBe(404);
    nothingWritten();
  });

  it.each([
    ['its owner', SARA, BRICK_HAS_NO_ROOM],
    ['the bot server', 'token', BRICK_HAS_NO_ROOM],
    ['another person', OMAR, 'Bot not found'],
    ['a super admin', ROOT, 'Bot not found'],
  ] as const)('does not delete a Brick for %s', async (_who, who, error) => {
    const response = await deleteBot(request(`/api/bots/${BRICK_ID}`, who, { method: 'DELETE' }), params());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error });
    nothingWritten();
  });
});

describe('what a bot server reads (GET /api/bots/configuration)', () => {
  it('lists room bots only, so a bot server that only knows room bots is never handed a Brick', async () => {
    const response = await listConfigurations(request('/api/bots/configuration', 'token'));
    expect(response.status).toBe(200);
    expect(db.bot.findMany).toHaveBeenCalledTimes(1);
    expect(db.bot.findMany.mock.calls[0][0].where).toMatchObject({ enabled: true, roomId: { not: null } });
  });

  it('keeps Bricks out when the list is asked for one person’s bots, by the bot server or a super admin', async () => {
    await listConfigurations(request(`/api/bots/configuration?userId=${SARA.id}`, 'token'));
    await listConfigurations(request(`/api/bots/configuration?userId=${SARA.id}&includeSensitive=true`, ROOT));
    expect(db.bot.findMany).toHaveBeenCalledTimes(2);
    for (const [args] of db.bot.findMany.mock.calls) {
      expect(args.where).toMatchObject({ createdById: SARA.id, roomId: { not: null } });
    }
  });

  it('still asks for one room’s bots by that room', async () => {
    await listConfigurations(request('/api/bots/configuration?roomUrl=http://play.example/@/u/w/r', 'token'));
    expect(db.bot.findMany.mock.calls[0][0].where).toMatchObject({ enabled: true, roomId: 'room-123' });
  });

  it.each([
    ['the bot server', 'token', BRICK_HAS_NO_ROOM],
    ['its owner', SARA, BRICK_HAS_NO_ROOM],
    ['another person', OMAR, 'Bot not found'],
    ['a super admin', ROOT, 'Bot not found'],
  ] as const)('has no configuration in the room bot shape for a Brick, asked by %s', async (_who, who, error) => {
    const response = await getConfiguration(request(`/api/bots/configuration/${BRICK_ID}`, who), params());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error });
  });
});

describe('the bot server’s save and delete (POST /api/bots/configuration, DELETE /api/bots/configuration/:id)', () => {
  const body = { botId: BRICK_ID, name: 'Brick', roomUrl: 'http://play.example/@/u/w/r', behaviorType: 'idle' };

  it.each([
    ['its owner', SARA, BRICK_HAS_NO_ROOM],
    ['the bot server', 'token', BRICK_HAS_NO_ROOM],
    ['another person', OMAR, 'Bot not found'],
    ['a super admin', ROOT, 'Bot not found'],
  ] as const)('does not put a Brick in the room the save names, for %s', async (_who, who, error) => {
    const response = await saveConfiguration(request('/api/bots/configuration', who, { method: 'POST', body }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error });
    nothingWritten();
  });

  it.each([
    ['its owner', SARA, BRICK_HAS_NO_ROOM],
    ['the bot server', 'token', BRICK_HAS_NO_ROOM],
    ['another person', OMAR, 'Bot not found'],
    ['a super admin', ROOT, 'Bot not found'],
  ] as const)('does not delete a Brick for %s', async (_who, who, error) => {
    const response = await deleteConfiguration(request(`/api/bots/configuration/${BRICK_ID}`, who, { method: 'DELETE' }), params());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error });
    nothingWritten();
  });
});

describe('a super admin’s pages', () => {
  it('lists room bots only (GET /api/admin/bots)', async () => {
    const response = await listAllBots(request('/api/admin/bots?search=brick&enabled=true', ROOT));
    expect(response.status).toBe(200);
    expect(db.bot.findMany.mock.calls[0][0].where).toMatchObject({ roomId: { not: null }, enabled: true });
    expect(db.bot.count.mock.calls[0][0].where).toMatchObject({ roomId: { not: null } });
  });

  it('does not open a Brick’s page (GET /api/admin/bots/:id)', async () => {
    const response = await getBotPage(request(`/api/admin/bots/${BRICK_ID}`, ROOT), params());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Bot not found' });
    expect(db.botsAiUsage.findMany).not.toHaveBeenCalled();
    expect(db.botsAiUsage.aggregate).not.toHaveBeenCalled();
  });

  it('lists only room bots under a provider (GET /api/admin/ai-providers/:id)', async () => {
    db.botsAiProvider.findUnique.mockResolvedValue({ providerId: 'p1', name: 'Provider', type: 'openai', apiKeyEncrypted: null, settings: null });
    const response = await getProviderPage(request('/api/admin/ai-providers/p1', ROOT), params('p1'));
    expect(response.status).toBe(200);
    expect(db.bot.findMany.mock.calls[0][0].where).toEqual({ aiProviderRef: 'p1', roomId: { not: null } });
  });
});
