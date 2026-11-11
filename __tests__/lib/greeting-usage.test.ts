/**
 * Free greetings (approved by Khalid 10 Nov 2026): a greeting a bot makes on its own when someone walks up costs that person
 * nothing. Its usage row is marked `greeting`, kept as the usage of whoever's key the bot runs on, and left out of every count of
 * the person's replies: the Universe AI window, a bot's own limit per person and the guests' pool.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { checkReplyAllowance } from '@/lib/reply-limits';
import { POST as trackUsage } from '@/app/api/bots/ai-usage/route';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
// The meter's books copy each report (game #1998); these tests are about the report, not the books
jest.mock('@/lib/meter', () => ({ recordModelCall: jest.fn(async () => null) }));
jest.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: jest.fn(),
    appSetting: { findUnique: jest.fn() },
    bot: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
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
  botsAiUsage: { count: jest.Mock; create: jest.Mock };
  botsAiProvider: { findUnique: jest.Mock };
  botReplyLimitHit: { createMany: jest.Mock };
};

const NOW = new Date('2026-11-10T12:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  db.appSetting.findUnique.mockResolvedValue(null);
  db.$queryRaw.mockResolvedValue([{ started_at: NOW }]);
  db.bot.findUnique.mockResolvedValue({ id: 'bot-1', dailyReplyCap: 5, createdById: 'u-maker' });
  db.user.findUnique.mockResolvedValue(null);
  db.botsAiUsage.count.mockResolvedValue(0);
  db.botsAiUsage.create.mockResolvedValue({});
  db.botsAiProvider.findUnique.mockResolvedValue({ providerId: 'deepseek-flash', ownerId: null });
});

describe('what a greeting costs the person', () => {
  it("is left out of their Universe AI window, the guests' pool and a bot's own limit", async () => {
    await checkReplyAllowance('bot-1', { userId: 'wa-guest', isGuest: true, source: 'universe-ai' }, NOW);
    const wheres = db.botsAiUsage.count.mock.calls.map(([arg]) => arg.where);
    expect(wheres).toHaveLength(3);
    for (const where of wheres) expect(where).toMatchObject({ greeting: false });
  });

  it('is still kept as usage of the key that paid for it, marked as a greeting', async () => {
    const track = (body: object) =>
      trackUsage(new NextRequest('http://localhost:3333/api/bots/ai-usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: 'bot-1', providerId: 'deepseek-flash', ...body }) }));
    await track({ userId: 'wa-sara', isGuest: false, greeting: true });
    await track({ userId: 'wa-sara', isGuest: false });
    await track({ userId: 'wa-sara', isGuest: false, greeting: 'yes' });
    expect(db.botsAiUsage.create.mock.calls.map(([arg]) => arg.data.greeting)).toEqual([true, false, false]);
  });
});
