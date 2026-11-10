/**
 * Free greetings with a cooldown (approved by Khalid 10 Nov 2026): a greeting a bot makes on its own costs the person nothing, and
 * each bot greets a person at most once per cooldown (a super admin setting in minutes, 720 until changed). Only time and who the
 * person is count, never where anyone stands.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { claimGreeting, releaseGreeting } from '@/lib/bot-greetings';
import { checkReplyAllowance } from '@/lib/reply-limits';
import { POST as claimRoute } from '@/app/api/bots/[id]/greeting/route';
import { POST as releaseRoute } from '@/app/api/bots/[id]/greeting/release/route';
import { POST as trackUsage } from '@/app/api/bots/ai-usage/route';
import { requireServiceToken } from '@/lib/service-tokens';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: jest.fn(),
    appSetting: { findUnique: jest.fn() },
    bot: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    botGreeting: { findUnique: jest.fn(), deleteMany: jest.fn() },
    botsAiUsage: { count: jest.fn(), create: jest.fn() },
    botsAiProvider: { findUnique: jest.fn() },
    botReplyLimitHit: { createMany: jest.fn() },
  },
}));

const db = prisma as unknown as {
  $queryRaw: jest.Mock;
  appSetting: { findUnique: jest.Mock };
  bot: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
  botGreeting: { findUnique: jest.Mock; deleteMany: jest.Mock };
  botsAiUsage: { count: jest.Mock; create: jest.Mock };
  botsAiProvider: { findUnique: jest.Mock };
  botReplyLimitHit: { createMany: jest.Mock };
};

const NOW = new Date('2026-11-10T12:00:00Z');
const SARA = { userId: 'wa-sara', isGuest: false };
const GUEST = { userId: 'wa-guest', isGuest: true };

/**
 * A small stand-in for the bot_greetings table and its one statement: a row is written when there is none, or when the one
 * there is at least the cooldown old (the statement's last value), and the row is returned only then.
 */
let table: Map<string, Date>;
function fakeTable() {
  table = new Map();
  db.$queryRaw.mockImplementation(async (sql: { values: unknown[] }) => {
    const [botId, personKey, now, lastBefore] = sql.values as [string, string, Date, Date];
    const key = `${botId}|${personKey}`;
    const there = table.get(key);
    if (there && there.getTime() > lastBefore.getTime()) return [];
    table.set(key, now);
    return [{ greeted_at: now }];
  });
  db.botGreeting.findUnique.mockImplementation(async ({ where }: { where: { botId_personKey: { botId: string; personKey: string } } }) => {
    const at = table.get(`${where.botId_personKey.botId}|${where.botId_personKey.personKey}`);
    return at ? { greetedAt: at } : null;
  });
  db.botGreeting.deleteMany.mockImplementation(async ({ where }: { where: { botId: string; personKey: string; greetedAt: Date } }) => {
    const key = `${where.botId}|${where.personKey}`;
    const at = table.get(key);
    if (!at || at.getTime() !== where.greetedAt.getTime()) return { count: 0 };
    table.delete(key);
    return { count: 1 };
  });
}

const minutes = (n: number) => new Date(NOW.getTime() + n * 60 * 1000);

beforeEach(() => {
  jest.clearAllMocks();
  fakeTable();
  db.appSetting.findUnique.mockResolvedValue(null);
  db.bot.findUnique.mockResolvedValue({ id: 'bot-1', dailyReplyCap: null, createdById: 'u-maker' });
  db.user.findUnique.mockImplementation(async ({ where }: { where: { uuid?: string } }) => (where.uuid === 'wa-sara' ? { id: 'u-sara', isGuest: false } : null));
  db.botsAiUsage.count.mockResolvedValue(0);
  db.botsAiUsage.create.mockResolvedValue({});
  db.botsAiProvider.findUnique.mockResolvedValue({ providerId: 'deepseek-flash', ownerId: null });
});

describe('a bot greeting the same person', () => {
  it('greets the first time, then not again until 12 hours have passed', async () => {
    expect(await claimGreeting('bot-1', SARA, NOW)).toEqual({ greet: true, greetedAt: NOW.toISOString() });
    // Stepping out of the bubble and back in a minute later, or an hour later: no new greeting, and when the next one can come
    expect(await claimGreeting('bot-1', SARA, minutes(1))).toEqual({ greet: false, nextAt: minutes(720).toISOString() });
    expect(await claimGreeting('bot-1', SARA, minutes(60))).toEqual({ greet: false, nextAt: minutes(720).toISOString() });
    expect(await claimGreeting('bot-1', SARA, minutes(720))).toEqual({ greet: true, greetedAt: minutes(720).toISOString() });
  });

  it('uses the cooldown a super admin saved, and greets on every walk-up when it is 0', async () => {
    db.appSetting.findUnique.mockResolvedValue({ key: 'bot-limits', value: { fairUsage: { greetingCooldown: 30 } } });
    expect(await claimGreeting('bot-1', SARA, NOW)).toMatchObject({ greet: true });
    expect(await claimGreeting('bot-1', SARA, minutes(29))).toMatchObject({ greet: false });
    expect(await claimGreeting('bot-1', SARA, minutes(30))).toMatchObject({ greet: true });
    db.appSetting.findUnique.mockResolvedValue({ key: 'bot-limits', value: { fairUsage: { greetingCooldown: 0 } } });
    expect(await claimGreeting('bot-1', SARA, minutes(30))).toMatchObject({ greet: true });
  });

  it('remembers each bot on its own: another bot still greets them', async () => {
    await claimGreeting('bot-1', SARA, NOW);
    db.bot.findUnique.mockResolvedValue({ id: 'bot-2' });
    expect(await claimGreeting('bot-2', SARA, minutes(1))).toMatchObject({ greet: true });
  });

  it('remembers a signed-in person by their account (any device) and a guest by their own id', async () => {
    await claimGreeting('bot-1', SARA, NOW);
    await claimGreeting('bot-1', GUEST, NOW);
    expect([...table.keys()]).toEqual(['bot-1|person:u-sara', 'bot-1|guest:wa-guest']);
    expect(db.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('greets someone nobody can name yet without remembering anything', async () => {
    expect(await claimGreeting('bot-1', { isGuest: true }, NOW)).toEqual({ greet: true });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('gives a greeting that was not made back, so they are greeted next time, but never a newer one', async () => {
    const first = await claimGreeting('bot-1', SARA, NOW);
    expect(first.greet).toBe(true);
    const greetedAt = first.greet ? first.greetedAt : undefined;
    expect(await releaseGreeting('bot-1', { ...SARA, greetedAt })).toEqual({ released: true });
    expect(await claimGreeting('bot-1', SARA, minutes(1))).toMatchObject({ greet: true });
    // The old claim is gone: handing it back again does not forget the newer greeting
    expect(await releaseGreeting('bot-1', { ...SARA, greetedAt })).toEqual({ released: false });
    expect(await claimGreeting('bot-1', SARA, minutes(2))).toMatchObject({ greet: false });
  });
});

describe('what a greeting costs the person', () => {
  it('is left out of their Universe AI window, the guests pool and a bot\'s own limit', async () => {
    db.bot.findUnique.mockResolvedValue({ id: 'bot-1', dailyReplyCap: 5, createdById: 'u-maker' });
    db.$queryRaw.mockResolvedValue([{ started_at: NOW }]);
    await checkReplyAllowance('bot-1', { ...GUEST, source: 'universe-ai' }, NOW);
    const wheres = db.botsAiUsage.count.mock.calls.map(([arg]) => arg.where);
    expect(wheres).toHaveLength(3);
    for (const where of wheres) expect(where).toMatchObject({ greeting: false });
  });

  it('is still kept as usage of the key that paid for it, marked as a greeting', async () => {
    const track = (body: object) =>
      trackUsage(new NextRequest('http://localhost:3333/api/bots/ai-usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: 'bot-1', providerId: 'deepseek-flash', ...body }) }));
    await track({ userId: 'wa-sara', isGuest: false, greeting: true });
    await track({ userId: 'wa-sara', isGuest: false });
    expect(db.botsAiUsage.create.mock.calls.map(([arg]) => arg.data.greeting)).toEqual([true, false]);
  });
});

describe('the routes', () => {
  const post = (path: string, body: unknown) =>
    new NextRequest(`http://localhost:3333${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const params = { params: Promise.resolve({ id: 'bot-1' }) };

  it('answers the bot server and hands a greeting back', async () => {
    const claimed = await (await claimRoute(post('/api/bots/bot-1/greeting', SARA), params)).json();
    expect(claimed).toMatchObject({ greet: true });
    expect(await (await claimRoute(post('/api/bots/bot-1/greeting', SARA), params)).json()).toMatchObject({ greet: false });
    expect(await (await releaseRoute(post('/api/bots/bot-1/greeting/release', { ...SARA, greetedAt: claimed.greetedAt }), params)).json()).toEqual({ released: true });
  });

  it('turns down a bot that does not exist, a release without its time, and anyone without the service token', async () => {
    db.bot.findUnique.mockResolvedValue(null);
    expect((await claimRoute(post('/api/bots/nope/greeting', SARA), params)).status).toBe(404);
    db.bot.findUnique.mockResolvedValue({ id: 'bot-1' });
    expect((await releaseRoute(post('/api/bots/bot-1/greeting/release', SARA), params)).status).toBe(400);
    (requireServiceToken as jest.Mock).mockImplementationOnce(() => {
      throw new Error('Unauthorized: Invalid service token');
    });
    expect((await claimRoute(post('/api/bots/bot-1/greeting', SARA), params)).status).toBe(401);
  });
});
