/**
 * Reply limits (game #1159): 30 Universe AI replies per 5 hours signed in, 10 for a guest, 200 shared by a bot's guests,
 * and a bot's own limit per person over 24 hours. A bot on its maker's own key never counts toward Universe AI.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { checkReplyAllowance } from '@/lib/reply-limits';
import { POST } from '@/app/api/bots/[id]/reply-allowance/route';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: jest.fn(),
    bot: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    botsAiUsage: { count: jest.fn() },
    botReplyLimitHit: { createMany: jest.fn() },
    appSetting: { findUnique: jest.fn() },
  },
}));

const db = prisma as unknown as {
  $queryRaw: jest.Mock;
  bot: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
  botsAiUsage: { count: jest.Mock };
  botReplyLimitHit: { createMany: jest.Mock };
  appSetting: { findUnique: jest.Mock };
};

const NOW = new Date('2026-10-27T15:20:00Z');
const STARTED = new Date('2026-10-27T13:20:00Z');
const BOT = { id: 'bot-1', dailyReplyCap: null as number | null, createdById: 'u-maker' };
const SARA = { userId: 'wa-sara', isGuest: false };
const GUEST = { userId: 'wa-guest', isGuest: true };

/** Every window started at 13:20; `used` says how many replies each count finds, in the order they are counted. */
function counts(...used: number[]) {
  for (const n of used) db.botsAiUsage.count.mockResolvedValueOnce(n);
}

beforeEach(() => {
  db.appSetting.findUnique.mockReset().mockResolvedValue(null);
  db.$queryRaw.mockReset().mockResolvedValue([{ started_at: STARTED }]);
  db.bot.findUnique.mockReset().mockResolvedValue({ ...BOT });
  db.user.findUnique.mockReset().mockImplementation(async ({ where }: { where: { uuid?: string } }) =>
    where.uuid === 'wa-sara' ? { id: 'u-sara', isGuest: false } : where.uuid === 'wa-maker' ? { id: 'u-maker', isGuest: false } : null,
  );
  db.botsAiUsage.count.mockReset().mockResolvedValue(0);
  db.botReplyLimitHit.createMany.mockReset().mockResolvedValue({ count: 1 });
});

describe('the numbers', () => {
  it('are the super admin\'s saved fair usage limits, 30 until changed', async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: { fairUsage: { signedIn: 50 } } });
    counts(40);
    expect(await checkReplyAllowance('bot-1', { ...SARA, source: 'universe-ai' }, NOW)).toEqual({ allowed: true });
    counts(50);
    expect(await checkReplyAllowance('bot-1', { ...SARA, source: 'universe-ai' }, NOW)).toMatchObject({ allowed: false, limit: 'universe-ai' });
  });

  it('keep the recommended values when the saved ones cannot be read', async () => {
    db.appSetting.findUnique.mockRejectedValue(new Error('down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    counts(30);
    expect(await checkReplyAllowance('bot-1', { ...SARA, source: 'universe-ai' }, NOW)).toMatchObject({ allowed: false, limit: 'universe-ai' });
  });
});

describe('Universe AI, per person', () => {
  it('answers the 30th reply and stops the 31st, with the end of the window', async () => {
    counts(29);
    expect(await checkReplyAllowance('bot-1', { ...SARA, source: 'universe-ai' }, NOW)).toEqual({ allowed: true });
    counts(30);
    expect(await checkReplyAllowance('bot-1', { ...SARA, source: 'universe-ai' }, NOW)).toEqual({
      allowed: false, limit: 'universe-ai', resetsAt: '2026-10-27T18:20:00.000Z', who: 'member',
    });
  });

  it('counts a signed-in person by their account across every Universe AI bot, and never key-paid replies', async () => {
    counts(0);
    await checkReplyAllowance('bot-1', { ...SARA, source: 'universe-ai' }, NOW);
    expect(db.botsAiUsage.count).toHaveBeenCalledWith({ where: { talkedPersonId: 'u-sara', keyOwnerId: null, error: false, timestamp: { gte: STARTED } } });
    expect(db.$queryRaw.mock.calls[0][0].values).toEqual(expect.arrayContaining(['ua:person:u-sara']));
  });

  it('gives a guest 10, counted by their own id, then the Sign in card', async () => {
    counts(10);
    expect(await checkReplyAllowance('bot-1', { ...GUEST, source: 'universe-ai' }, NOW)).toMatchObject({ allowed: false, limit: 'guest', who: 'guest' });
    expect(db.botsAiUsage.count).toHaveBeenCalledWith({ where: { talkedUserId: 'wa-guest', talkedGuest: true, keyOwnerId: null, error: false, timestamp: { gte: STARTED } } });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('treats a bot on a server provider the same as Universe AI', async () => {
    counts(30);
    expect(await checkReplyAllowance('bot-1', { ...SARA, source: 'provider' }, NOW)).toMatchObject({ allowed: false, limit: 'universe-ai' });
  });

  it("never counts or stops anyone on the maker's own key", async () => {
    expect(await checkReplyAllowance('bot-1', { ...SARA, source: 'own-key' }, NOW)).toEqual({ allowed: true });
    expect(db.botsAiUsage.count).not.toHaveBeenCalled();
  });

  it('tells the maker apart, for the Use my AI key button', async () => {
    counts(30);
    expect(await checkReplyAllowance('bot-1', { userId: 'wa-maker', isGuest: false, source: 'universe-ai' }, NOW)).toMatchObject({ who: 'maker' });
  });
});

describe("a bot's guests share 200", () => {
  it('stops a guest with replies of their own left once the bot\'s guests used 200', async () => {
    counts(3, 200);
    expect(await checkReplyAllowance('bot-1', { ...GUEST, source: 'universe-ai' }, NOW)).toMatchObject({ allowed: false, limit: 'guests', who: 'guest' });
    expect(db.botsAiUsage.count).toHaveBeenLastCalledWith({ where: { botId: 'bot-1', talkedGuest: true, keyOwnerId: null, error: false, timestamp: { gte: STARTED } } });
  });

  it('never touches a signed-in person', async () => {
    counts(3);
    expect(await checkReplyAllowance('bot-1', { ...SARA, source: 'universe-ai' }, NOW)).toEqual({ allowed: true });
    expect(db.botsAiUsage.count).toHaveBeenCalledTimes(1);
  });
});

describe("the bot's own limit", () => {
  beforeEach(() => db.bot.findUnique.mockResolvedValue({ ...BOT, dailyReplyCap: 20 }));

  it('stops at the number its managers set, over 24 hours, whatever it runs on', async () => {
    counts(20);
    expect(await checkReplyAllowance('bot-1', { ...SARA, source: 'own-key' }, NOW)).toEqual({
      allowed: false, limit: 'bot', resetsAt: '2026-10-28T13:20:00.000Z', who: 'member',
    });
    expect(db.botsAiUsage.count).toHaveBeenCalledWith({ where: { talkedPersonId: 'u-sara', botId: 'bot-1', error: false, timestamp: { gte: STARTED } } });
  });

  it('is checked after Universe AI, which has the earlier end', async () => {
    counts(5, 19);
    expect(await checkReplyAllowance('bot-1', { ...SARA, source: 'universe-ai' }, NOW)).toEqual({ allowed: true });
    expect(db.botsAiUsage.count).toHaveBeenCalledTimes(2);
  });
});

describe('windows and reached limits', () => {
  it('asks for the window with when the last one ended, so a finished window starts again now', async () => {
    await checkReplyAllowance('bot-1', { ...SARA, source: 'universe-ai' }, NOW);
    expect(db.$queryRaw.mock.calls[0][0].values).toEqual(['ua:person:u-sara', NOW, new Date('2026-10-27T10:20:00Z')]);
  });

  it('remembers a reached limit once per person and window', async () => {
    counts(30);
    await checkReplyAllowance('bot-1', { ...SARA, source: 'universe-ai' }, NOW);
    expect(db.botReplyLimitHit.createMany).toHaveBeenCalledWith({
      data: [{ botId: 'bot-1', kind: 'universe-ai', talkedUserId: 'wa-sara', windowEndsAt: new Date('2026-10-27T18:20:00Z') }],
      skipDuplicates: true,
    });
  });

  it('still stops the reply when remembering fails', async () => {
    counts(30);
    db.botReplyLimitHit.createMany.mockRejectedValue(new Error('db'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await checkReplyAllowance('bot-1', { ...SARA, source: 'universe-ai' }, NOW)).toMatchObject({ allowed: false });
  });

  it('never stops someone the bot cannot name yet', async () => {
    expect(await checkReplyAllowance('bot-1', { source: 'universe-ai' }, NOW)).toEqual({ allowed: true });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('POST /api/bots/:id/reply-allowance', () => {
  const ask = (body: unknown, token = 'svc') =>
    POST(
      new NextRequest('http://localhost:3333/api/bots/bot-1/reply-allowance', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: 'bot-1' }) },
    );
  beforeEach(() => {
    process.env.BOT_SERVICE_TOKEN = 'svc';
  });

  it('answers the bot server', async () => {
    counts(30);
    const response = await ask({ ...SARA, source: 'universe-ai' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ allowed: false, limit: 'universe-ai' });
  });

  it('refuses anyone without the service token', async () => {
    expect((await ask({ ...SARA, source: 'universe-ai' }, 'nope')).status).toBe(401);
  });

  it('says what is wrong with a bad request', async () => {
    expect((await ask({ ...SARA, source: 'somewhere' })).status).toBe(400);
    db.bot.findUnique.mockResolvedValue(null);
    expect((await ask({ ...SARA, source: 'universe-ai' })).status).toBe(404);
  });
});
