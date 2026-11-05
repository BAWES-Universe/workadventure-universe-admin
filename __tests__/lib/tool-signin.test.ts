/**
 * A tool's lost sign-in (game #1819): what the bot server reports is kept on the connection, one card per person and bot goes to
 * whoever connected it (the bot's maker for old connections), it is told once per outage, and reconnecting clears it.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { canManageBotMcpServers, preloadBotRules } from '@/lib/bot-permissions';
import { describeToolSignIn, type ToolSignInNoticeData } from '@/lib/tool-signin-words';
import { dropOrphanedToolSignInNotices, markToolReconnected, reportToolSignIn, syncToolSignInNotices } from '@/lib/tool-signin';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
// Who still manages a bot's tools is the tools page's own rule; here it is a switch
jest.mock('@/lib/bot-permissions', () => ({ canManageBotMcpServers: jest.fn(), preloadBotRules: jest.fn() }));
// The notices are worked out inside one transaction that first takes a lock on the bot: the transaction hands the same
// mocks to its callback, and `$executeRaw` is the lock.
jest.mock('@/lib/db', () => {
  const prisma: Record<string, unknown> = {
    bot: { findUnique: jest.fn(), findMany: jest.fn() },
    user: { findUnique: jest.fn() },
    botMcpServer: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    userNotice: { findMany: jest.fn(), update: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    $executeRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn((work: (tx: unknown) => unknown) => work(prisma));
  return { prisma };
});

const db = prisma as unknown as {
  bot: { findUnique: jest.Mock; findMany: jest.Mock };
  user: { findUnique: jest.Mock };
  botMcpServer: Record<'findFirst' | 'findUnique' | 'findMany' | 'updateMany' | 'update', jest.Mock>;
  userNotice: Record<'findMany' | 'update' | 'create' | 'updateMany', jest.Mock>;
  $executeRaw: jest.Mock;
  $transaction: jest.Mock;
};
const addNotice = db.userNotice.create;
const mayManage = canManageBotMcpServers as jest.Mock;
const created = (index = 0) => addNotice.mock.calls[index][0].data;
const dismissed = () => db.userNotice.updateMany.mock.calls.map(([call]) => call.where.id);

const BOT = { id: 'bot-1', name: 'Tavily Researcher', createdById: 'maker', roomId: 'room-1', mcpServers: [{ connectedById: 'yousef' }, { connectedById: 'sara' }], room: { world: { universe: { name: 'autonode-labs' } } } };
const T1 = new Date('2026-11-05T09:54:00.000Z');
const T2 = new Date('2026-11-05T09:58:00.000Z');
const tavily = { id: 's1', name: 'Tavily', authType: 'oauth', signInLostAt: T1, connectedById: 'yousef' };
const attio = { id: 's2', name: 'Attio', authType: 'oauth', signInLostAt: T2, connectedById: 'yousef' };

beforeEach(() => {
  jest.resetAllMocks();
  db.bot.findUnique.mockResolvedValue(BOT);
  db.userNotice.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation((work: (tx: unknown) => unknown) => work(prisma));
  db.userNotice.create.mockResolvedValue({});
  db.botMcpServer.update.mockResolvedValue({});
  db.user.findUnique.mockResolvedValue({ email: 'someone@example.test' });
  mayManage.mockResolvedValue(true);
});

const data = (servers: ToolSignInNoticeData['servers']): ToolSignInNoticeData => ({ botId: 'bot-1', bot: 'Tavily Researcher', universe: 'autonode-labs', servers });
const at = (iso: string) => ({ id: 'x', name: 'x', kind: 'oauth' as const, at: iso });

describe('the words of the card', () => {
  it('names one tool, says what the bot does meanwhile and writes the time with the clock it is given', () => {
    const words = describeToolSignIn(data([{ ...at(T1.toISOString()), name: 'Tavily' }]), () => '12:54 PM');
    expect(words).toEqual({
      title: 'Tavily Researcher can’t use Tavily',
      badge: 'Sign-in expired',
      body: 'In autonode-labs. Tavily stopped accepting this bot’s sign-in at 12:54 PM. Until it’s reconnected, this bot answers without its tools and tells people who ask for them.',
    });
  });

  it('names two together with both times, and leaves the times out without a clock', () => {
    const servers = [{ ...at(T1.toISOString()), name: 'Tavily' }, { ...at(T2.toISOString()), id: 'y', name: 'Attio' }];
    expect(describeToolSignIn(data(servers), (iso) => (iso === T1.toISOString() ? '12:54 PM' : '12:58 PM'))).toMatchObject({
      title: 'Tavily Researcher can’t use Tavily and Attio',
      body: expect.stringContaining('Both stopped accepting this bot’s sign-in (12:54 PM and 12:58 PM). Until they’re reconnected'),
    });
    expect(describeToolSignIn(data(servers)).body).toContain('Both stopped accepting this bot’s sign-in. Until');
  });

  it('calls a rejected key a key, and sends the person to the bot’s page to paste a new one', () => {
    const words = describeToolSignIn(data([{ ...at(T1.toISOString()), name: 'Tavily', kind: 'key' }]), () => '12:54 PM');
    expect(words.badge).toBe('Key rejected');
    expect(words.body).toBe('In autonode-labs. Tavily stopped accepting this bot’s API key at 12:54 PM. Tap to open this bot’s tools page, remove it there and add it again with a new key.');
  });
});

describe('the words for a server with no sign-in at all', () => {
  it('is not called a key, and the hint is for the tools page', () => {
    const words = describeToolSignIn(data([{ ...at(T1.toISOString()), name: 'Open', kind: 'open' }]), () => '12:54 PM');
    expect(words.badge).not.toBe('Key rejected');
    expect(words.body).not.toMatch(/API key/);
    expect(words.body).toMatch(/tools page/);
  });

  it('names the tools page for the ones that need a new key when the card is mixed', () => {
    const words = describeToolSignIn(data([{ ...at(T1.toISOString()), name: 'Tavily', kind: 'key' }, { ...at(T2.toISOString()), id: 'y', name: 'Attio', kind: 'oauth' }]), () => '12:54 PM');
    expect(words.body).toContain('where the ones that need a new key can be removed and added again');
  });
});

describe('the bot server’s report', () => {
  it('is a 404 for a bot with no such server', async () => {
    db.botMcpServer.findFirst.mockResolvedValue(null);
    expect(await reportToolSignIn('bot-1', 'nope', { state: 'expired' })).toBeNull();
  });

  it('keeps the first time as "since": only a connection that is not already expired changes', async () => {
    db.botMcpServer.findFirst.mockResolvedValue({ id: 's1' });
    db.botMcpServer.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    db.botMcpServer.findMany.mockResolvedValue([tavily]);
    expect(await reportToolSignIn('bot-1', 's1', { state: 'expired', at: T1, status: 401 })).toEqual({ changed: true });
    expect(await reportToolSignIn('bot-1', 's1', { state: 'expired', at: T2, status: 401 })).toEqual({ changed: false });
    expect(db.botMcpServer.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 's1', botId: 'bot-1', signInLostAt: null, OR: [{ reconnectedAt: null }, { reconnectedAt: { lt: T1 } }] },
      data: { signInLostAt: T1, signInLostStatus: 401, noAnswerAt: null },
    });
    expect(addNotice).toHaveBeenCalledTimes(1);
  });

  it('ignores a failure seen before the tool was connected again: the stored state and the cards stay as they are', async () => {
    db.botMcpServer.findFirst.mockResolvedValue({ id: 's1' });
    // The database finds no row: its reconnectedAt is later than the failure
    db.botMcpServer.updateMany.mockResolvedValue({ count: 0 });
    expect(await reportToolSignIn('bot-1', 's1', { state: 'expired', at: T1, status: 401 })).toEqual({ changed: false });
    expect(db.botMcpServer.updateMany.mock.calls[0][0].where.OR).toEqual([{ reconnectedAt: null }, { reconnectedAt: { lt: T1 } }]);
    expect(addNotice).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('takes a time from the future as now', async () => {
    db.botMcpServer.findFirst.mockResolvedValue({ id: 's1' });
    db.botMcpServer.updateMany.mockResolvedValue({ count: 0 });
    const before = Date.now();
    await reportToolSignIn('bot-1', 's1', { state: 'expired', at: new Date(Date.now() + 3_600_000) });
    const saved = db.botMcpServer.updateMany.mock.calls[0][0].data.signInLostAt as Date;
    expect(saved.getTime()).toBeGreaterThanOrEqual(before);
    expect(saved.getTime()).toBeLessThan(before + 5_000);
  });

  it('keeps "didn’t answer" apart: it never replaces an expired sign-in and tells nobody', async () => {
    db.botMcpServer.findFirst.mockResolvedValue({ id: 's1' });
    db.botMcpServer.updateMany.mockResolvedValue({ count: 1 });
    expect(await reportToolSignIn('bot-1', 's1', { state: 'no-answer', at: T1 })).toEqual({ changed: true });
    expect(db.botMcpServer.updateMany.mock.calls[0][0].where).toEqual({
      id: 's1',
      botId: 'bot-1',
      signInLostAt: null,
      noAnswerAt: null,
      OR: [{ reconnectedAt: null }, { reconnectedAt: { lt: T1 } }],
    });
    // The time of the last reconnect stays: a late "expired" from before it must still be turned away
    expect(db.botMcpServer.updateMany.mock.calls[0][0].data).toEqual({ noAnswerAt: T1 });
    expect(addNotice).not.toHaveBeenCalled();
  });

  it('"ok" clears both and takes the card down; a repeat changes nothing', async () => {
    db.botMcpServer.findFirst.mockResolvedValue({ id: 's1' });
    // Each report is the clear, then the time kept
    db.botMcpServer.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    db.botMcpServer.findMany.mockResolvedValue([]);
    db.userNotice.findMany.mockResolvedValue([{ id: 'n1', userId: 'yousef' }]);
    expect(await reportToolSignIn('bot-1', 's1', { state: 'ok' })).toEqual({ changed: true });
    expect(await reportToolSignIn('bot-1', 's1', { state: 'ok' })).toEqual({ changed: false });
    expect(db.botMcpServer.updateMany.mock.calls[0][0].data).toEqual({ signInLostAt: null, signInLostStatus: null, noAnswerAt: null });
    expect(dismissed()).toEqual(['n1']);
  });

  it('"ok" keeps the time it saw the tool working, so an older failure that reports after it is turned away', async () => {
    db.botMcpServer.findFirst.mockResolvedValue({ id: 's1' });
    db.botMcpServer.updateMany.mockResolvedValue({ count: 0 });
    // Nothing was down: the clear changes nothing, but the time is still kept
    expect(await reportToolSignIn('bot-1', 's1', { state: 'ok', at: T2 })).toEqual({ changed: false });
    const stamp = db.botMcpServer.updateMany.mock.calls[1][0];
    expect(stamp).toEqual({
      where: { id: 's1', botId: 'bot-1', OR: [{ reconnectedAt: null }, { reconnectedAt: { lt: T2 } }] },
      data: { reconnectedAt: T2 },
    });
    // The failure from before it (T1) is refused by the same rule that guards a reconnect
    await reportToolSignIn('bot-1', 's1', { state: 'expired', at: T1 });
    expect(db.botMcpServer.updateMany.mock.calls[2][0].where.OR).toEqual([{ reconnectedAt: null }, { reconnectedAt: { lt: T1 } }]);
  });
});

describe('the card on Orbit home', () => {
  it('goes to whoever connected it, once, with the connection to reconnect', async () => {
    db.botMcpServer.findMany.mockResolvedValue([tavily]);
    await syncToolSignInNotices('bot-1', { serverId: 's1', at: T1 });
    expect(addNotice).toHaveBeenCalledTimes(1);
    expect(created()).toEqual(
      expect.objectContaining({
        userId: 'yousef',
        kind: 'tool-signin',
        dedupeKey: `tool-signin:bot-1:${T1.toISOString()}`,
        title: 'Tavily Researcher can’t use Tavily',
        badge: 'Sign-in expired',
        href: null,
        data: { botId: 'bot-1', bot: 'Tavily Researcher', universe: 'autonode-labs', servers: [{ id: 's1', name: 'Tavily', kind: 'oauth', at: T1.toISOString() }] },
      }),
    );
  });

  it('goes to the bot’s maker when the connection has no one recorded', async () => {
    db.botMcpServer.findMany.mockResolvedValue([{ ...tavily, connectedById: null }]);
    await syncToolSignInNotices('bot-1', { serverId: 's1', at: T1 });
    expect(created().userId).toBe('maker');
  });

  it('is one card for two connections of one bot, updated in place and not made again', async () => {
    db.botMcpServer.findMany.mockResolvedValue([tavily, attio]);
    db.userNotice.findMany.mockResolvedValue([{ id: 'n1', userId: 'yousef' }]);
    await syncToolSignInNotices('bot-1', { serverId: 's2', at: T2 });
    expect(addNotice).not.toHaveBeenCalled();
    expect(db.userNotice.update).toHaveBeenCalledTimes(1);
    expect(db.userNotice.update.mock.calls[0][0].data).toMatchObject({ title: 'Tavily Researcher can’t use Tavily and Attio' });
    expect(db.userNotice.update.mock.calls[0][0].data.data.servers).toHaveLength(2);
  });

  it('stays dismissed: a connection that was already down makes no new card', async () => {
    db.botMcpServer.findMany.mockResolvedValue([tavily]);
    await syncToolSignInNotices('bot-1');
    expect(addNotice).not.toHaveBeenCalled();
  });

  it('leads to the bot’s page when a key has to be pasted', async () => {
    db.botMcpServer.findMany.mockResolvedValue([{ ...tavily, authType: 'bearer' }]);
    await syncToolSignInNotices('bot-1', { serverId: 's1', at: T1 });
    expect(created()).toEqual(expect.objectContaining({ badge: 'Key rejected', href: '/admin/bots/bot-1/mcp-servers' }));
  });

  it('keeps the card for the one still down when the other comes back', async () => {
    db.botMcpServer.findMany.mockResolvedValue([attio]);
    db.userNotice.findMany.mockResolvedValue([{ id: 'n1', userId: 'yousef' }]);
    await syncToolSignInNotices('bot-1');
    expect(dismissed()).toEqual([]);
    expect(db.userNotice.update.mock.calls[0][0].data.title).toBe('Tavily Researcher can’t use Attio');
  });
});

describe('the card on Orbit home, when things happen together', () => {
  it('works on one bot at a time: the lock is taken first, in the same transaction as the reads and writes', async () => {
    db.botMcpServer.findMany.mockResolvedValue([tavily]);
    await syncToolSignInNotices('bot-1', { serverId: 's1', at: T1 });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    // Who may be told is read first, outside the lock; the bot's own reads inside the transaction come after the lock
    const reads = db.bot.findUnique.mock.invocationCallOrder;
    expect(reads).toHaveLength(2);
    expect(reads[0]).toBeLessThan(db.$transaction.mock.invocationCallOrder[0]);
    expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(reads[1]);
    expect(db.$executeRaw.mock.calls[0].slice(1)).toEqual(['tool-signin:bot-1']);
  });

  it('takes the card down when the bot or the connection is gone', async () => {
    db.bot.findUnique.mockResolvedValue(null);
    db.userNotice.findMany.mockResolvedValue([{ id: 'n1', userId: 'yousef' }]);
    await syncToolSignInNotices('bot-1');
    expect(dismissed()).toEqual(['n1']);
    expect(addNotice).not.toHaveBeenCalled();
    db.userNotice.updateMany.mockClear();
    db.bot.findUnique.mockResolvedValue(BOT);
    db.botMcpServer.findMany.mockResolvedValue([]);
    await syncToolSignInNotices('bot-1');
    expect(dismissed()).toEqual(['n1']);
  });

  it('treats a card made twice for the same instant as already told, not a failure', async () => {
    db.botMcpServer.findMany.mockResolvedValue([tavily]);
    db.userNotice.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }));
    await expect(syncToolSignInNotices('bot-1', { serverId: 's1', at: T1 })).resolves.toBeUndefined();
  });
});

describe('who is told', () => {
  it('skips someone who can no longer manage this bot’s tools, and goes to the maker instead', async () => {
    db.botMcpServer.findMany.mockResolvedValue([tavily]);
    mayManage.mockImplementation(async (userId: string) => userId !== 'yousef');
    await syncToolSignInNotices('bot-1', { serverId: 's1', at: T1 });
    expect(created().userId).toBe('maker');
  });

  it('makes no card, and takes an open one down, when nobody who can manage it is left', async () => {
    db.botMcpServer.findMany.mockResolvedValue([tavily]);
    db.userNotice.findMany.mockResolvedValue([{ id: 'n1', userId: 'yousef' }]);
    mayManage.mockResolvedValue(false);
    await syncToolSignInNotices('bot-1', { serverId: 's1', at: T1 });
    expect(addNotice).not.toHaveBeenCalled();
    expect(dismissed()).toEqual(['n1']);
  });

  it('asks the tools page’s own rule, with the bot’s room', async () => {
    db.botMcpServer.findMany.mockResolvedValue([tavily]);
    await syncToolSignInNotices('bot-1', { serverId: 's1', at: T1 });
    expect(mayManage).toHaveBeenCalledWith('yousef', 'someone@example.test', expect.objectContaining({ id: 'bot-1', createdById: 'maker', roomId: 'room-1' }));
  });

  it('links to the tools page for a server with no sign-in, but not for a sign-in alone', async () => {
    db.botMcpServer.findMany.mockResolvedValue([{ ...tavily, authType: 'none' }]);
    await syncToolSignInNotices('bot-1', { serverId: 's1', at: T1 });
    expect(created().href).toBe('/admin/bots/bot-1/mcp-servers');
    expect(created().data.servers[0].kind).toBe('open');
  });
});

describe('reconnecting', () => {
  it('remembers who did it, clears what was down with the time, and takes the card down', async () => {
    db.botMcpServer.findUnique.mockResolvedValue({ botId: 'bot-1', signInLostAt: T1, noAnswerAt: null });
    db.botMcpServer.findMany.mockResolvedValue([]);
    db.userNotice.findMany.mockResolvedValue([{ id: 'n1', userId: 'yousef' }]);
    await markToolReconnected('s1', 'sara');
    // The clear comes first and on its own, then who did it
    const clear = db.botMcpServer.update.mock.calls[0][0].data;
    expect(clear).toMatchObject({ signInLostAt: null, signInLostStatus: null, noAnswerAt: null });
    expect(clear).not.toHaveProperty('connectedById');
    expect(clear.reconnectedAt).toBeInstanceOf(Date);
    expect(db.botMcpServer.update.mock.calls[1][0].data).toEqual({ connectedById: 'sara' });
    expect(dismissed()).toEqual(['n1']);
  });

  it('clears the lost sign-in even when who did it cannot be saved (that account may be gone)', async () => {
    db.botMcpServer.findUnique.mockResolvedValue({ botId: 'bot-1', signInLostAt: T1, noAnswerAt: null });
    db.botMcpServer.findMany.mockResolvedValue([]);
    db.userNotice.findMany.mockResolvedValue([{ id: 'n1', userId: 'yousef' }]);
    db.botMcpServer.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('foreign key'));
    await markToolReconnected('s1', 'gone');
    expect(db.botMcpServer.update.mock.calls[0][0].data.signInLostAt).toBeNull();
    expect(dismissed()).toEqual(['n1']);
  });

  it('when nothing was down, keeps the time and the person, and clears nothing: a failure seen before it cannot start an outage', async () => {
    db.botMcpServer.findUnique.mockResolvedValue({ botId: 'bot-1', signInLostAt: null, noAnswerAt: null });
    await markToolReconnected('s1', 'sara');
    const stamp = db.botMcpServer.update.mock.calls[0][0].data;
    expect(Object.keys(stamp)).toEqual(['reconnectedAt']);
    expect(stamp.reconnectedAt).toBeInstanceOf(Date);
    expect(db.botMcpServer.update.mock.calls[1][0].data).toEqual({ connectedById: 'sara' });
    expect(db.userNotice.findMany).not.toHaveBeenCalled();
  });

  it('never throws: the sign-in has already gone through', async () => {
    db.botMcpServer.findUnique.mockRejectedValue(new Error('db down'));
    await expect(markToolReconnected('s1', 'sara')).resolves.toBeUndefined();
  });
});

describe('cards about bots that were removed, or that the person can no longer manage', () => {
  const card = (id: string, bot: string) => ({ id, dedupeKey: `tool-signin:${bot}:2026-11-05T09:54:00.000Z` });
  const bot = (id: string) => ({ id, createdById: 'sara', roomId: 'room-1' });

  it('takes down only the ones whose bot is gone', async () => {
    db.userNotice.findMany.mockResolvedValue([card('n1', 'bot-1'), card('n2', 'bot-gone')]);
    db.bot.findMany.mockResolvedValue([bot('bot-1')]);
    db.user.findUnique.mockResolvedValue({ email: 'yousef@example.com' });
    mayManage.mockResolvedValue(true);
    await dropOrphanedToolSignInNotices('yousef');
    expect(db.userNotice.findMany.mock.calls[0][0].where).toEqual({ userId: 'yousef', kind: 'tool-signin', dismissedAt: null });
    expect(db.userNotice.updateMany).toHaveBeenCalledTimes(1);
    expect(db.userNotice.updateMany.mock.calls[0][0].where).toEqual({ userId: 'yousef', id: { in: ['n2'] }, dismissedAt: null });
  });

  it('takes down a card about a bot whose tools the person can no longer manage, and keeps the others', async () => {
    db.userNotice.findMany.mockResolvedValue([card('n1', 'bot-1'), card('n2', 'bot-2')]);
    db.bot.findMany.mockResolvedValue([bot('bot-1'), bot('bot-2')]);
    db.user.findUnique.mockResolvedValue({ email: 'yousef@example.com' });
    mayManage.mockImplementation(async (_user: string, _email: string | null, managed: { id: string }) => managed.id === 'bot-1');
    await dropOrphanedToolSignInNotices('yousef');
    expect(preloadBotRules).toHaveBeenCalledWith(expect.any(Map), ['bot-1', 'bot-2']);
    expect(mayManage).toHaveBeenCalledWith('yousef', 'yousef@example.com', bot('bot-2'), expect.any(Map));
    expect(db.userNotice.updateMany).toHaveBeenCalledTimes(1);
    expect(db.userNotice.updateMany.mock.calls[0][0].where).toEqual({ userId: 'yousef', id: { in: ['n2'] }, dismissedAt: null });
  });

  it('asks nothing more when there are no such cards, and changes nothing when the person manages every bot', async () => {
    db.userNotice.findMany.mockResolvedValue([]);
    await dropOrphanedToolSignInNotices('yousef');
    expect(db.bot.findMany).not.toHaveBeenCalled();
    db.userNotice.findMany.mockResolvedValue([card('n1', 'bot-1')]);
    db.bot.findMany.mockResolvedValue([bot('bot-1')]);
    db.user.findUnique.mockResolvedValue({ email: 'yousef@example.com' });
    mayManage.mockResolvedValue(true);
    await dropOrphanedToolSignInNotices('yousef');
    expect(db.userNotice.updateMany).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    db.userNotice.findMany.mockRejectedValue(new Error('db down'));
    await expect(dropOrphanedToolSignInNotices('yousef')).resolves.toBeUndefined();
  });
});
