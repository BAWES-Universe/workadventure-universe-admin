/**
 * A Brick (game #1992) is its owner's by its id, a super admin included in "nobody else". The routes here kept a pass for
 * super admins that came before the bot was looked at: its figures, clearing its saved chats, what it may run on. Each
 * now asks whose Brick it is first. The bot server (the admin token) is not a person and still passes, and room bots are
 * read and cleared by the same people as before.
 *
 * The parts of a bot's page that need a room write nothing for a Brick: turning voice on or off and saving a voice draft
 * answer "This bot is not in a room" before anything is stored.
 *
 * Who manages the bot is the real check (lib/bot-permissions.ts), not a stand-in.
 */
import { NextRequest } from 'next/server';
import { GET as getMetrics } from '@/app/api/bots/[id]/metrics/route';
import { GET as getMetricStats } from '@/app/api/bots/[id]/metrics/stats/route';
import { GET as getConversationStats } from '@/app/api/bots/[id]/conversations/stats/route';
import { DELETE as cleanUp } from '@/app/api/bots/[id]/conversations/cleanup/route';
import { GET as previewCleanUp } from '@/app/api/bots/[id]/conversations/cleanup/preview/route';
import { GET as listAllMetrics } from '@/app/api/admin/bots/metrics/route';
import { GET as getBotAi } from '@/app/api/me/bot-ai/route';
import { PUT as putVoice } from '@/app/api/bots/[id]/voice/route';
import { PUT as putVoiceDraft } from '@/app/api/bots/[id]/voice/draft/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { BRICK_HAS_NO_ROOM } from '@/lib/brick';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    botsMetric: { findMany: jest.fn() },
    botsConversation: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), deleteMany: jest.fn() },
    botVoiceDraft: { upsert: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));

const db = prisma as unknown as {
  bot: Record<'findUnique' | 'findMany' | 'update', jest.Mock>;
  botsMetric: Record<'findMany', jest.Mock>;
  botsConversation: Record<'findMany' | 'findFirst' | 'count' | 'deleteMany', jest.Mock>;
  botVoiceDraft: Record<'upsert', jest.Mock>;
};
const session = getSessionUser as jest.Mock;

const ADMIN_TOKEN = 'admin-secret';
const BRICK_ID = '7b0f3c1e-52a4-4d0b-9a3e-6f1d2c3b4a5e';
const SARA = { id: 'u-sara', email: 'sara@example.com', name: 'Sara', isSuperAdmin: false };
const OMAR = { id: 'u-omar', email: 'omar@example.com', name: 'Omar', isSuperAdmin: false };
const ROOT = { id: 'u-root', email: 'root@example.com', name: 'Root', isSuperAdmin: true };

const brick = { id: BRICK_ID, name: 'Brick', roomId: null, ownerId: SARA.id, createdById: SARA.id, room: null, aiProviderRef: 'universe-ai', aiModel: null, behaviorConfig: {} };
const roomBot = { ...brick, id: 'room-bot', roomId: 'room-1', ownerId: null, room: { world: { universeId: 'uni-1', universe: { hideBotConversations: false } } } };

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
  jest.resetAllMocks();
  process.env.SUPER_ADMINS = ROOT.email;
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  db.bot.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === BRICK_ID ? brick : where.id === roomBot.id ? roomBot : null));
  db.bot.findMany.mockResolvedValue([]);
  db.botsMetric.findMany.mockResolvedValue([]);
  db.botsConversation.findMany.mockResolvedValue([]);
  db.botsConversation.findFirst.mockResolvedValue(null);
  db.botsConversation.count.mockResolvedValue(0);
  db.botsConversation.deleteMany.mockResolvedValue({ count: 0 });
});

afterAll(() => {
  for (const [key, value] of [['SUPER_ADMINS', envBefore.superAdmins], ['ADMIN_API_TOKEN', envBefore.adminToken]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('a Brick’s figures (GET /api/bots/:id/metrics, /metrics/stats, /conversations/stats)', () => {
  const routes = [
    ['metrics', getMetrics, '/metrics'],
    ['metrics totals', getMetricStats, '/metrics/stats'],
    ['conversation counts', getConversationStats, '/conversations/stats'],
  ] as const;

  it.each(routes)('refuses a super admin who does not own it, and reads nothing: %s', async (_name, route, path) => {
    const response = await route(request(`/api/bots/${BRICK_ID}${path}`, ROOT), params());
    expect(response.status).toBe(403);
    expect(db.botsMetric.findMany).not.toHaveBeenCalled();
    expect(db.botsConversation.count).not.toHaveBeenCalled();
  });

  it.each(routes)('refuses anyone else the same way: %s', async (_name, route, path) => {
    expect((await route(request(`/api/bots/${BRICK_ID}${path}`, OMAR), params())).status).toBe(403);
    expect((await route(request(`/api/bots/${BRICK_ID}${path}`, null), params())).status).toBe(401);
  });

  it.each(routes)('lets its owner and the bot server through: %s', async (_name, route, path) => {
    expect((await route(request(`/api/bots/${BRICK_ID}${path}`, SARA), params())).status).toBe(200);
    expect((await route(request(`/api/bots/${BRICK_ID}${path}`, 'token'), params())).status).toBe(200);
  });

  it('lets a super admin who owns the Brick read it as its owner', async () => {
    db.bot.findUnique.mockResolvedValue({ ...brick, ownerId: ROOT.id });
    expect((await getMetrics(request(`/api/bots/${BRICK_ID}/metrics`, ROOT), params())).status).toBe(200);
  });

  it('still lets a super admin read a room bot’s metrics', async () => {
    const response = await getMetrics(request(`/api/bots/${roomBot.id}/metrics`, ROOT), params(roomBot.id));
    expect(response.status).toBe(200);
    expect(db.botsMetric.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { botId: roomBot.id } }));
  });
});

describe('clearing a Brick’s saved chats (DELETE /api/bots/:id/conversations/cleanup, GET …/preview)', () => {
  const path = `/api/bots/${BRICK_ID}/conversations/cleanup?olderThanDays=30`;

  it('refuses a super admin who does not own it, and deletes nothing', async () => {
    expect((await cleanUp(request(path, ROOT, { method: 'DELETE' }), params())).status).toBe(403);
    expect((await previewCleanUp(request(path.replace('cleanup?', 'cleanup/preview?'), ROOT), params())).status).toBe(403);
    expect(db.botsConversation.deleteMany).not.toHaveBeenCalled();
    expect(db.botsConversation.findMany).not.toHaveBeenCalled();
    expect(db.botsConversation.count).not.toHaveBeenCalled();
  });

  it('refuses anyone else the same way', async () => {
    expect((await cleanUp(request(path, OMAR, { method: 'DELETE' }), params())).status).toBe(403);
    expect((await cleanUp(request(path, null, { method: 'DELETE' }), params())).status).toBe(401);
    expect(db.botsConversation.deleteMany).not.toHaveBeenCalled();
  });

  it('lets its owner clear them, and the bot server', async () => {
    for (const who of [SARA, 'token'] as const) {
      db.botsConversation.deleteMany.mockClear();
      const response = await cleanUp(request(path, who, { method: 'DELETE' }), params());
      expect(response.status).toBe(200);
      expect(db.botsConversation.deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({ botId: BRICK_ID }) });
    }
  });

  it('still lets a super admin clear a room bot’s', async () => {
    const response = await cleanUp(request(`/api/bots/${roomBot.id}/conversations/cleanup?olderThanDays=30`, ROOT, { method: 'DELETE' }), params(roomBot.id));
    expect(response.status).toBe(200);
    expect(db.botsConversation.deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({ botId: roomBot.id }) });
  });
});

describe('the super admin’s metrics page (GET /api/admin/bots/metrics)', () => {
  it('is about room bots only: Bricks are left out by id', async () => {
    db.bot.findMany.mockResolvedValue([{ id: BRICK_ID }]);
    expect((await listAllMetrics(request('/api/admin/bots/metrics', ROOT))).status).toBe(200);
    expect(db.bot.findMany).toHaveBeenCalledWith({ where: { roomId: null }, select: { id: true } });
    expect(db.botsMetric.findMany.mock.calls[0][0].where).toEqual({ NOT: { botId: { in: [BRICK_ID] } } });
  });

  it('finds nothing when asked for a Brick by its id', async () => {
    db.bot.findMany.mockResolvedValue([{ id: BRICK_ID }]);
    await listAllMetrics(request(`/api/admin/bots/metrics?botId=${BRICK_ID}`, ROOT));
    expect(db.botsMetric.findMany.mock.calls[0][0].where).toEqual({ botId: BRICK_ID, NOT: { botId: { in: [BRICK_ID] } } });
  });

  it('reads as before while there are no Bricks', async () => {
    await listAllMetrics(request('/api/admin/bots/metrics?botId=room-bot', ROOT));
    expect(db.botsMetric.findMany.mock.calls[0][0].where).toEqual({ botId: 'room-bot' });
  });
});

describe('what a Brick may run on (GET /api/me/bot-ai)', () => {
  const ask = async (who: typeof SARA) => {
    const response = await getBotAi(request(`/api/me/bot-ai?botId=${BRICK_ID}`, who));
    return { status: response.status, body: await response.json() };
  };

  it('tells its owner why: it is not in a room', async () => {
    expect(await ask(SARA)).toEqual({ status: 404, body: { error: BRICK_HAS_NO_ROOM } });
  });

  it('answers anyone else, a super admin included, as for a bot that does not exist', async () => {
    db.bot.findUnique.mockResolvedValueOnce(null);
    const missing = await getBotAi(request('/api/me/bot-ai?botId=no-such-bot', OMAR));
    const gone = { status: missing.status, body: await missing.json() };
    expect(gone).toEqual({ status: 404, body: { error: 'Bot not found' } });
    expect(await ask(OMAR)).toEqual(gone);
    expect(await ask(ROOT)).toEqual(gone);
  });
});

describe('a Brick’s voice (PUT /api/bots/:id/voice, PUT /api/bots/:id/voice/draft)', () => {
  it.each([true, false])('answers "not in a room" when voice is turned %s, and writes nothing', async (enabled) => {
    const response = await putVoice(request(`/api/bots/${BRICK_ID}/voice`, SARA, { method: 'PUT', body: { enabled } }), params());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: BRICK_HAS_NO_ROOM });
    expect(db.bot.update).not.toHaveBeenCalled();
  });

  it('answers "not in a room" for a draft, and saves none', async () => {
    const response = await putVoiceDraft(request(`/api/bots/${BRICK_ID}/voice/draft`, SARA, { method: 'PUT', body: { expression: 'restrained' } }), params());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: BRICK_HAS_NO_ROOM });
    expect(db.botVoiceDraft.upsert).not.toHaveBeenCalled();
  });
});
