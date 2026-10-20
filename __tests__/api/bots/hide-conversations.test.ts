/**
 * Hide bot conversations (#435): the no-regression list for the Orbit half.
 *
 * Off (the default) every page, API and bot-server call answers exactly as before. On, nobody who can sign in reads a
 * transcript or what a bot remembers, super admins included, while the bot server still reads and writes memory.
 */
import { NextRequest } from 'next/server';
import { GET as getConversations } from '@/app/api/bots/[id]/conversations/route';
import { GET as getConversationStats } from '@/app/api/bots/[id]/conversations/stats/route';
import { GET as getEmotions } from '@/app/api/bots/[id]/emotions/route';
import { GET as getMemory, POST as saveMemory } from '@/app/api/bots/memory/[id]/route';
import { GET as getPrivacy, PUT as putPrivacy } from '@/app/api/bots/[id]/privacy/route';
import { POST as forget } from '@/app/api/bots/[id]/forget/route';
import { GET as listAllConversations } from '@/app/api/admin/bots/conversations/route';
import { GET as listAllMemory } from '@/app/api/admin/bots/memory/route';
import { PATCH as patchUniverse } from '@/app/api/admin/universes/[id]/route';
import { getSessionUser } from '@/lib/auth-session';
import { canManageThisBot } from '@/lib/bot-permissions';
import { prisma } from '@/lib/db';
import { deleteWithHiddenBotData, resolveBotPrivacy } from '@/lib/bot-privacy';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageThisBot: jest.fn(), canManageBots: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn((email?: string | null) => email === 'root@example.com') }));
jest.mock('@/lib/db', () => ({
  prisma: {
    $transaction: jest.fn(),
    bot: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    universe: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
    botsConversation: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), aggregate: jest.fn(), deleteMany: jest.fn() },
    botsMemory: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), aggregate: jest.fn(), upsert: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
    botsAiUsage: { count: jest.fn() },
    botMemoryForget: { findMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn(), updateMany: jest.fn() },
  },
}));

const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock };
const session = getSessionUser as jest.Mock;
const manages = canManageThisBot as jest.Mock;

const params = { params: Promise.resolve({ id: 'bot-1' }) };
const TRANSCRIPT = { id: 9, botId: 'bot-1', userUuid: 'uuid-bob', userId: null, userName: 'Bob', isGuest: false, messages: [{ sender: 'user', message: 'my secret plan', timestamp: 1 }], startedAt: new Date(0), endedAt: new Date(5), messageCount: 1, endReason: null, createdAt: new Date(0), user: null };
const MEMORY_ROW = { userUuid: 'uuid-bob', userId: null, userName: 'Bob', isGuest: false, memories: { personalInfo: { name: 'Bob', facts: ['has a secret plan'] } }, emotions: { botEmotion: { joy: 80 } }, lastEmotionUpdate: new Date(7) };

/** The bot as the privacy check finds it: its own choice and whether its universe hides bot conversations. */
function botIs(hideConversations: boolean | null, universeHides = false, id = 'bot-1') {
  db.bot.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === id ? { hideConversations, room: { world: { universe: { hideBotConversations: universeHides } } } } : null,
  );
}

function call(handler: (r: NextRequest, c: typeof params) => Promise<Response>, method = 'GET', { url = 'http://localhost:3333/api/bots/bot-1/x', body, token }: { url?: string; body?: unknown; token?: string } = {}) {
  return handler(
    new NextRequest(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params,
  );
}

beforeEach(() => {
  process.env.ADMIN_API_TOKEN = 'admin-secret';
  process.env.BOT_SERVICE_TOKEN = 'service-secret';
  for (const group of Object.values(db)) if (typeof group === 'object') for (const fn of Object.values(group)) fn.mockReset();
  db.$transaction.mockReset().mockImplementation(async (steps: Promise<unknown>[]) => Promise.all(steps));
  session.mockReset().mockResolvedValue({ id: 'u-sara', email: 'sara@example.com', isSuperAdmin: false });
  manages.mockReset().mockResolvedValue(true);
  botIs(null);
  db.botsConversation.findMany.mockResolvedValue([TRANSCRIPT]);
  db.botsConversation.count.mockResolvedValue(1);
  db.botsConversation.findFirst.mockResolvedValue({ endedAt: new Date(5) });
  db.botsConversation.aggregate.mockResolvedValue({ _sum: { messageCount: 1 } });
  db.botsMemory.findMany.mockResolvedValue([MEMORY_ROW]);
  db.botsMemory.count.mockResolvedValue(1);
  db.botsMemory.aggregate.mockResolvedValue({ _count: { _all: 3 }, _max: { updatedAt: new Date(9000) } });
  db.botsAiUsage.count.mockResolvedValue(12);
  db.botMemoryForget.findMany.mockResolvedValue([]);
  db.bot.findMany.mockResolvedValue([]);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the answer: universe default, bot choice', () => {
  it('is off for a universe that does not hide and a bot that follows it (how every bot starts)', () => {
    expect(resolveBotPrivacy(false, null)).toEqual({ universeHides: false, choice: 'follow', hidden: false });
  });
  it('hides for a bot set to Private, and not for one set to Normal', () => {
    expect(resolveBotPrivacy(false, true).hidden).toBe(true);
    expect(resolveBotPrivacy(false, false)).toEqual({ universeHides: false, choice: 'normal', hidden: false });
  });
  it('lets a hiding universe win over a bot set to Normal', () => {
    expect(resolveBotPrivacy(true, false)).toEqual({ universeHides: true, choice: 'normal', hidden: true });
    expect(resolveBotPrivacy(true, null).hidden).toBe(true);
  });
});

describe('off: everything answers as it did', () => {
  it('shows a manager the transcripts, with the same fields', async () => {
    const response = await call(getConversations);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.conversations[0].messages).toEqual(TRANSCRIPT.messages);
    expect(body.count).toBe(1);
    expect(body).not.toHaveProperty('private');
  });

  it('shows the conversation figures, the emotions and the saved memory', async () => {
    expect((await (await call(getConversationStats)).json()).totalConversations).toBe(1);
    db.botsMemory.findMany.mockResolvedValue([{ userUuid: 'uuid-bob', userId: null, userName: 'Bob', isGuest: false, emotions: { botEmotion: { joy: 80 } }, lastEmotionUpdate: new Date(7), user: null }]);
    expect((await (await call(getEmotions)).json())[0].emotions).toEqual({ botEmotion: { joy: 80 } });
    db.botsMemory.findMany.mockResolvedValue([{ ...MEMORY_ROW, updatedAt: new Date(1) }]);
    const memory = await (await call(getMemory, 'GET', { token: 'service-secret' })).json();
    expect(memory.memories[0].memories).toEqual(MEMORY_ROW.memories);
    expect(memory).not.toHaveProperty('private');
  });

  it('lists every bot across bots, with nothing left out and no extra filter', async () => {
    session.mockResolvedValue({ id: 'u-root', email: 'root@example.com', isSuperAdmin: true });
    const response = await listAllConversations(new NextRequest('http://localhost:3333/api/admin/bots/conversations'));
    const body = await response.json();
    expect(body.hiddenCount).toBe(0);
    expect(db.botsConversation.findMany.mock.calls[0][0].where).toEqual({});
    const memory = await listAllMemory(new NextRequest('http://localhost:3333/api/admin/bots/memory'));
    expect((await memory.json()).hiddenCount).toBe(0);
    expect(db.botsMemory.findMany.mock.calls[0][0].where).toEqual({});
  });

  it('saves every person the bot server sends and tells it nothing to drop', async () => {
    const response = await call(saveMemory, 'POST', { token: 'service-secret', body: { memories: [{ userUuid: 'uuid-bob', memories: { personalInfo: { name: 'Bob' } } }, { userUuid: 'uuid-cy' }] } });
    expect(await response.json()).toEqual({ status: 'saved', saveType: 'periodic' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.botsMemory.upsert).toHaveBeenCalledTimes(2);
    expect(db.botMemoryForget.deleteMany).not.toHaveBeenCalled();
    expect(db.botMemoryForget.updateMany).not.toHaveBeenCalled();
  });
});

describe('on: nobody reads text, super admins included', () => {
  it.each([
    ['the bot is set to Private', [true, false]],
    ['the universe hides them', [null, true]],
    ['the universe hides them even though the bot says Normal', [false, true]],
  ] as const)('hides the transcripts when %s', async (_name, [choice, universe]) => {
    botIs(choice, universe);
    session.mockResolvedValue({ id: 'u-root', email: 'root@example.com', isSuperAdmin: true });
    const response = await call(getConversations);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ private: true, conversations: [], count: 0, replies: 12 });
    expect(JSON.stringify(body)).not.toContain('secret plan');
    expect(db.botsConversation.findMany).not.toHaveBeenCalled();
    expect(await (await call(getConversationStats)).json()).toEqual({ botId: 'bot-1', private: true });
    expect(db.botsConversation.count).not.toHaveBeenCalled();
  });

  it('hides emotions, and gives a person only the tally of what the bot remembers', async () => {
    botIs(true);
    expect(await (await call(getEmotions)).json()).toEqual([]);
    expect(db.botsMemory.findMany).not.toHaveBeenCalled();
    const memory = await (await call(getMemory)).json();
    expect(memory).toEqual({ memories: [], private: true, people: 3, lastUpdated: 9000 });
    expect(db.botsMemory.findMany).not.toHaveBeenCalled();
  });

  it('still lets the bot server read all it remembers, with its service token or the admin token it falls back to', async () => {
    botIs(true, true);
    db.botsMemory.findMany.mockResolvedValue([{ ...MEMORY_ROW, updatedAt: new Date(1) }]);
    for (const token of ['service-secret', 'admin-secret']) {
      const body = await (await call(getMemory, 'GET', { token })).json();
      expect(body.memories[0]).toMatchObject({ userUuid: 'uuid-bob', memories: MEMORY_ROW.memories });
      expect(body).not.toHaveProperty('private');
    }
  });

  it('leaves the bots that hide theirs out of the lists across bots, counts them, and leaves the others alone', async () => {
    session.mockResolvedValue({ id: 'u-root', email: 'root@example.com', isSuperAdmin: true });
    db.bot.findMany.mockResolvedValue([{ id: 'bot-hidden' }]);
    db.botsConversation.count.mockResolvedValue(4);
    const body = await (await listAllConversations(new NextRequest('http://localhost:3333/api/admin/bots/conversations?userUuid=uuid-bob'))).json();
    expect(body.hiddenCount).toBe(4);
    expect(db.botsConversation.findMany.mock.calls[0][0].where).toEqual({ userUuid: 'uuid-bob', AND: [{ botId: { notIn: ['bot-hidden'] } }] });
    db.botsMemory.count.mockResolvedValue(2);
    const memory = await (await listAllMemory(new NextRequest('http://localhost:3333/api/admin/bots/memory'))).json();
    expect(memory.hiddenCount).toBe(2);
    expect(db.botsMemory.findMany.mock.calls[0][0].where).toEqual({ AND: [{ botId: { notIn: ['bot-hidden'] } }] });
  });

  it('still refuses a stranger as before (the setting adds no way in)', async () => {
    botIs(true);
    manages.mockResolvedValue(false);
    expect((await call(getConversations)).status).toBe(403);
    expect((await call(getEmotions)).status).toBe(403);
  });
});

describe('the setting', () => {
  it('tells the bot server only the answer', async () => {
    botIs(false, true);
    const body = await (await call(getPrivacy, 'GET', { token: 'service-secret' })).json();
    expect(body).toEqual({ botId: 'bot-1', universeHides: true, choice: 'normal', hidden: true });
  });

  it('tells the bot server the same short answer when it only has the admin token (never the names)', async () => {
    botIs(true);
    session.mockResolvedValue(null);
    const body = await (await call(getPrivacy, 'GET', { token: 'admin-secret' })).json();
    expect(body).toEqual({ botId: 'bot-1', universeHides: false, choice: 'private', hidden: true });
    expect(db.botsMemory.findMany).not.toHaveBeenCalled();
  });

  it('tells a manager the tally and, for a hidden bot, who by name only (never an email or player id)', async () => {
    botIs(true);
    db.botsMemory.findMany.mockResolvedValue([{ id: 5, userName: 'Bob', isGuest: false, updatedAt: new Date(4000), user: null }]);
    const body = await (await call(getPrivacy)).json();
    expect(body).toMatchObject({ hidden: true, people: 3, lastUpdated: 9000, replies: 12, remembered: [{ id: 5, name: 'Bob', isGuest: false, updatedAt: 4000 }] });
    expect(JSON.stringify(body)).not.toContain('uuid-bob');
  });

  it('lists nobody when the bot is not hidden', async () => {
    const body = await (await call(getPrivacy)).json();
    expect(body.hidden).toBe(false);
    expect(body).not.toHaveProperty('remembered');
    expect(db.botsMemory.findMany).not.toHaveBeenCalled();
  });

  it('lets a manager set Private and set it back, saving null for Follow universe', async () => {
    expect((await call(putPrivacy, 'PUT', { body: { choice: 'private' } })).status).toBe(200);
    expect(db.bot.update).toHaveBeenLastCalledWith({ where: { id: 'bot-1' }, data: { hideConversations: true } });
    await call(putPrivacy, 'PUT', { body: { choice: 'follow' } });
    expect(db.bot.update).toHaveBeenLastCalledWith({ where: { id: 'bot-1' }, data: { hideConversations: null } });
    await call(putPrivacy, 'PUT', { body: { choice: 'normal' } });
    expect(db.bot.update).toHaveBeenLastCalledWith({ where: { id: 'bot-1' }, data: { hideConversations: false } });
  });

  it('does not let a manager loosen a universe that hides them, but lets them follow it or go Private', async () => {
    botIs(null, true);
    const refused = await call(putPrivacy, 'PUT', { body: { choice: 'normal' } });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/universe hides bot conversations/);
    expect(db.bot.update).not.toHaveBeenCalled();
    expect((await call(putPrivacy, 'PUT', { body: { choice: 'follow' } })).status).toBe(200);
    expect((await call(putPrivacy, 'PUT', { body: { choice: 'private' } })).status).toBe(200);
  });

  it('refuses someone who does not manage the bot, a made-up choice, and the admin token for writing', async () => {
    manages.mockResolvedValue(false);
    expect((await call(putPrivacy, 'PUT', { body: { choice: 'private' } })).status).toBe(404);
    manages.mockResolvedValue(true);
    expect((await call(putPrivacy, 'PUT', { body: { choice: 'maybe' } })).status).toBe(400);
    session.mockResolvedValue(null);
    expect((await call(putPrivacy, 'PUT', { body: { choice: 'private' }, token: 'admin-secret' })).status).toBe(401);
    expect(db.bot.update).not.toHaveBeenCalled();
  });
});

describe('Forget', () => {
  it('is only for a bot that hides its conversations', async () => {
    const response = await call(forget, 'POST', { body: { everyone: true } });
    expect(response.status).toBe(409);
    expect(db.botsMemory.deleteMany).not.toHaveBeenCalled();
    expect(db.botMemoryForget.create).not.toHaveBeenCalled();
  });

  it('forgets everyone: deletes the saved rows and leaves a mark for the bot server', async () => {
    botIs(true);
    db.botsMemory.deleteMany.mockResolvedValue({ count: 3 });
    db.botMemoryForget.create.mockResolvedValue({});
    const response = await call(forget, 'POST', { body: { everyone: true } });
    expect(await response.json()).toEqual({ forgotten: 3, everyone: true });
    expect(db.botMemoryForget.create).toHaveBeenCalledWith({ data: { botId: 'bot-1', userUuid: null } });
    expect(db.botsMemory.deleteMany).toHaveBeenCalledWith({ where: { botId: 'bot-1' } });
  });

  it('forgets one person by the id the list gave, never by a player id from the caller', async () => {
    botIs(true);
    db.botsMemory.findFirst.mockResolvedValue({ id: 5, userUuid: 'bob@example.com' });
    db.botsMemory.deleteMany.mockResolvedValue({ count: 1 });
    const response = await call(forget, 'POST', { body: { memoryId: 5 } });
    expect(await response.json()).toEqual({ forgotten: 1, everyone: false });
    expect(db.botsMemory.findFirst).toHaveBeenCalledWith({ where: { id: 5, botId: 'bot-1' }, select: { id: true, userUuid: true } });
    expect(db.botMemoryForget.create).toHaveBeenCalledWith({ data: { botId: 'bot-1', userUuid: 'bob@example.com' } });
    expect(db.botsMemory.deleteMany).toHaveBeenCalledWith({ where: { id: 5 } });
    expect((await call(forget, 'POST', { body: { userUuid: 'x' } })).status).toBe(400);
  });

  it('succeeds when another manager forgot the same person a moment earlier', async () => {
    botIs(true);
    db.botsMemory.findFirst.mockResolvedValue({ id: 5, userUuid: 'bob@example.com' });
    db.botsMemory.deleteMany.mockResolvedValue({ count: 0 });
    const response = await call(forget, 'POST', { body: { memoryId: 5 } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ forgotten: 0, everyone: false });
    expect(db.botMemoryForget.create).toHaveBeenCalled();
  });

  it('says so when the bot does not remember that person, and refuses a stranger', async () => {
    botIs(true);
    db.botsMemory.findFirst.mockResolvedValue(null);
    expect((await call(forget, 'POST', { body: { memoryId: 99 } })).status).toBe(404);
    manages.mockResolvedValue(false);
    expect((await call(forget, 'POST', { body: { everyone: true } })).status).toBe(404);
  });
});

describe('the bot server really forgets (it saves a person again whenever they talk to the bot)', () => {
  const save = (body: unknown) => call(saveMemory, 'POST', { token: 'service-secret', body });
  const saved = () => db.botsMemory.upsert.mock.calls.map((callArgs) => callArgs[0].where.botId_userUuid.userUuid);

  it('skips a forgotten person, saves the rest, tells the bot server, and marks the row told', async () => {
    db.botMemoryForget.findMany.mockResolvedValue([{ id: 'f1', userUuid: 'uuid-bob', reportedAt: null }]);
    const response = await save({ memories: [{ userUuid: 'uuid-bob' }, { userUuid: 'uuid-cy' }] });
    expect(await response.json()).toEqual({ status: 'saved', saveType: 'periodic', forget: { everyone: false, userUuids: ['uuid-bob'], rows: [{ id: 'f1', userUuid: 'uuid-bob' }] } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(saved()).toEqual(['uuid-cy']);
    expect(db.botMemoryForget.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['f1'] } }, data: { reportedAt: expect.any(Date) } });
  });

  it('skips everybody when everyone was forgotten, emotion-only saves included', async () => {
    db.botMemoryForget.findMany.mockResolvedValue([{ id: 'f2', userUuid: null, reportedAt: null }]);
    const response = await save({ memories: [{ userUuid: 'uuid-bob' }], saveType: 'immediate', emotions: { joy: 1 }, userUuid: 'uuid-cy' });
    expect((await response.json()).forget).toEqual({ everyone: true, userUuids: [], rows: [{ id: 'f2', userUuid: null }] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.botsMemory.upsert).not.toHaveBeenCalled();
  });

  it('keeps skipping and telling for a minute, in case the answer was lost, then lets the bot save the person again', async () => {
    const now = Date.now();
    db.botMemoryForget.findMany.mockResolvedValue([{ id: 'f3', userUuid: 'uuid-bob', reportedAt: new Date(now - 20_000) }]);
    expect((await (await save({ memories: [{ userUuid: 'uuid-bob' }] })).json()).forget.userUuids).toEqual(['uuid-bob']);
    expect(db.botMemoryForget.updateMany).not.toHaveBeenCalled();

    db.botMemoryForget.findMany.mockResolvedValue([{ id: 'f3', userUuid: 'uuid-bob', reportedAt: new Date(now - 120_000) }]);
    const later = await (await save({ memories: [{ userUuid: 'uuid-bob' }] })).json();
    expect(later).toEqual({ status: 'saved', saveType: 'periodic' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.botMemoryForget.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['f3'] } } });
    expect(saved()).toEqual(['uuid-bob']);
  });

  it('tells the bot server on its 30-second privacy check too, so a forget lands while nobody is talking to the bot', async () => {
    botIs(true);
    db.botMemoryForget.findMany.mockResolvedValue([{ id: 'f1', userUuid: 'uuid-bob', reportedAt: null }, { id: 'f4', userUuid: null, reportedAt: new Date(Date.now() - 20_000) }]);
    const body = await (await call(getPrivacy, 'GET', { token: 'service-secret' })).json();
    expect(body).toEqual({ botId: 'bot-1', universeHides: false, choice: 'private', hidden: true, forget: { everyone: true, userUuids: ['uuid-bob'], rows: [{ id: 'f1', userUuid: 'uuid-bob' }, { id: 'f4', userUuid: null }] } });
    expect(db.botMemoryForget.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['f1'] } }, data: { reportedAt: expect.any(Date) } });
  });

  it('sends each Forget with its own id, so a second Forget of the same person within the minute is not taken for a repeat', async () => {
    botIs(true);
    db.botMemoryForget.findMany.mockResolvedValue([
      { id: 'f1', userUuid: 'uuid-bob', reportedAt: new Date(Date.now() - 20_000) },
      { id: 'f5', userUuid: 'uuid-bob', reportedAt: null },
    ]);
    const body = await (await call(getPrivacy, 'GET', { token: 'service-secret' })).json();
    expect(body.forget).toEqual({ everyone: false, userUuids: ['uuid-bob'], rows: [{ id: 'f1', userUuid: 'uuid-bob' }, { id: 'f5', userUuid: 'uuid-bob' }] });
  });

  it('adds nothing to the privacy check of a bot nobody asked to forget anything', async () => {
    const body = await (await call(getPrivacy, 'GET', { token: 'service-secret' })).json();
    expect(body).toEqual({ botId: 'bot-1', universeHides: false, choice: 'follow', hidden: false });
    expect(db.botMemoryForget.updateMany).not.toHaveBeenCalled();
  });

  it('never hands the forget list to a person, only to the bot server', async () => {
    botIs(true);
    db.botMemoryForget.findMany.mockResolvedValue([{ id: 'f1', userUuid: 'uuid-bob', reportedAt: null }]);
    db.botsMemory.findMany.mockResolvedValue([]);
    const body = await (await call(getPrivacy)).json();
    expect(JSON.stringify(body)).not.toContain('uuid-bob');
    expect(db.botMemoryForget.updateMany).not.toHaveBeenCalled();
  });

  it('fails the save, so the bot server tries again, when it cannot tell who was forgotten', async () => {
    db.botMemoryForget.findMany.mockRejectedValue(new Error('db down'));
    const response = await save({ memories: [{ userUuid: 'uuid-bob' }] });
    expect(response.status).toBe(500);
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.botsMemory.upsert).not.toHaveBeenCalled();
  });

  it('takes out what a save just wrote for someone whose Forget landed while it was running', async () => {
    db.botMemoryForget.findMany.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'f9', userUuid: 'uuid-bob', reportedAt: null }]);
    const response = await save({ memories: [{ userUuid: 'uuid-bob' }, { userUuid: 'uuid-cy' }] });
    expect(await response.json()).toEqual({ status: 'saved', saveType: 'periodic' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(saved()).toEqual(['uuid-bob', 'uuid-cy']);
    expect(db.botsMemory.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.botsMemory.deleteMany).toHaveBeenCalledWith({ where: { botId: 'bot-1', userUuid: { in: ['uuid-bob'] } } });
    expect(db.botMemoryForget.updateMany).not.toHaveBeenCalled();
  });

  it('deletes nothing after a save when nobody was forgotten, and a failed re-check does not fail the save', async () => {
    const response = await save({ memories: [{ userUuid: 'uuid-bob' }] });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.botsMemory.deleteMany).not.toHaveBeenCalled();

    db.botMemoryForget.findMany.mockResolvedValueOnce([]).mockRejectedValue(new Error('db down'));
    const again = await save({ memories: [{ userUuid: 'uuid-bob' }] });
    expect(again.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.botsMemory.deleteMany).not.toHaveBeenCalled();
  });
});

describe('deleting a bot, room, world or universe', () => {
  const remove = jest.fn();

  beforeEach(() => remove.mockReset().mockReturnValue('removed'));

  it('is just the delete, with nothing else touched, when no bot in it hides its conversations (how it was)', async () => {
    db.bot.findMany.mockResolvedValue([]);
    expect(await deleteWithHiddenBotData({ roomId: 'r1' }, remove as never)).toBe('removed');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.botsConversation.deleteMany).not.toHaveBeenCalled();
    expect(db.botsMemory.deleteMany).not.toHaveBeenCalled();
  });

  it('only looks at the bots that go with it, and only at those that hide', async () => {
    db.bot.findMany.mockResolvedValue([]);
    await deleteWithHiddenBotData({ roomId: 'r1' }, remove as never);
    expect(db.bot.findMany).toHaveBeenCalledWith({
      where: { AND: [{ roomId: 'r1' }, { OR: [{ hideConversations: true }, { room: { world: { universe: { hideBotConversations: true } } } }] }] },
      select: { id: true },
    });
  });

  it('removes the hidden bots\' transcripts, memory and forget rows in the same transaction as the delete', async () => {
    db.bot.findMany.mockResolvedValue([{ id: 'bot-1' }, { id: 'bot-2' }]);
    db.$transaction.mockImplementation(async (steps: unknown[]) => steps.map((_, index) => (index === steps.length - 1 ? 'removed' : { count: 1 })));
    expect(await deleteWithHiddenBotData({ room: { worldId: 'w1' } }, remove as never)).toBe('removed');
    const where = { where: { botId: { in: ['bot-1', 'bot-2'] } } };
    expect(db.botsConversation.deleteMany).toHaveBeenCalledWith(where);
    expect(db.botsMemory.deleteMany).toHaveBeenCalledWith(where);
    expect(db.botMemoryForget.deleteMany).toHaveBeenCalledWith(where);
    expect(db.$transaction.mock.calls[0][0]).toHaveLength(4);
  });

  it('does not take the data of a bot that does not hide, and takes nothing if the delete cannot happen', async () => {
    db.bot.findMany.mockResolvedValue([{ id: 'bot-1' }]);
    db.$transaction.mockRejectedValue(new Error('constraint'));
    await expect(deleteWithHiddenBotData({ id: 'bot-1' }, remove as never)).rejects.toThrow('constraint');
    // the data is deleted inside the transaction, so a rolled back delete rolls it back too
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('the universe switch', () => {
  const patch = (body: unknown) =>
    patchUniverse(new NextRequest('http://localhost:3333/api/admin/universes/u1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'u1' }) });

  beforeEach(() => {
    db.universe.findUnique.mockResolvedValue({ id: 'u1', slug: 'acme', ownerId: 'u-owner', featured: false });
    db.universe.update.mockResolvedValue({ id: 'u1' });
  });

  it('is saved by the owner and by a super admin, and sent nowhere else when left out', async () => {
    session.mockResolvedValue({ id: 'u-owner', email: 'owner@example.com', isSuperAdmin: false });
    expect((await patch({ hideBotConversations: true })).status).toBe(200);
    expect(db.universe.update.mock.calls[0][0].data).toEqual({ hideBotConversations: true });
    session.mockResolvedValue({ id: 'u-root', email: 'root@example.com', isSuperAdmin: true });
    await patch({ name: 'Acme 2' });
    expect(db.universe.update.mock.calls[1][0].data).toEqual({ name: 'Acme 2' });
  });

  it('is refused to anyone else, so a bot manager cannot turn it off', async () => {
    session.mockResolvedValue({ id: 'u-sara', email: 'sara@example.com', isSuperAdmin: false });
    expect((await patch({ hideBotConversations: false })).status).toBe(403);
    expect(db.universe.update).not.toHaveBeenCalled();
  });
});
