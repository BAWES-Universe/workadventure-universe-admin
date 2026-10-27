/**
 * GET /api/bots/:id/usage (Orbit #491): what the people who manage a bot see about how much it is used. Names, never
 * words; guests as one count; days in the viewer's own time zone; older rows "Not split".
 */
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/bots/[id]/usage/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageThisBot } from '@/lib/bot-permissions';
import * as settings from '@/lib/bot-access-settings';
import { rangeDays, readTimeZone } from '@/lib/bot-usage-report';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageThisBot: jest.fn() }));
jest.mock('@/lib/bot-access-settings', () => ({ ...jest.requireActual('@/lib/bot-access-settings'), loadBotPlace: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: jest.fn(),
    appSetting: { findUnique: jest.fn() },
    bot: { findUnique: jest.fn() },
    user: { findMany: jest.fn() },
    botsAiUsage: { findFirst: jest.fn() },
    botsAiProvider: { findMany: jest.fn() },
    botReplyLimitHit: { findMany: jest.fn() },
  },
}));

const db = prisma as unknown as {
  $queryRaw: jest.Mock;
  appSetting: { findUnique: jest.Mock };
  bot: { findUnique: jest.Mock };
  user: { findMany: jest.Mock };
  botsAiUsage: { findFirst: jest.Mock };
  botsAiProvider: { findMany: jest.Mock };
  botReplyLimitHit: { findMany: jest.Mock };
};
const session = getSessionUser as jest.Mock;
const manages = canManageThisBot as jest.Mock;
const place = (settings as unknown as { loadBotPlace: jest.Mock }).loadBotPlace;

const today = rangeDays('today', 'UTC')[0];
const row = (extra: object) => ({
  day: today, channel: 'dm', person_id: null, guest: null, guest_id: null, provider_id: 'ds', key_owner_id: null,
  replies: 1, tokens: 100, cost_micros: null, unpriced: 1, first_at: new Date(`${today}T08:00:00Z`), last_at: new Date(`${today}T09:00:00Z`), ...extra,
});

const get = (query = '') =>
  GET(new NextRequest(`http://localhost:3333/api/bots/bot-1/usage${query}`), { params: Promise.resolve({ id: 'bot-1' }) });

beforeEach(() => {
  db.appSetting.findUnique.mockReset().mockResolvedValue(null);
  session.mockReset().mockResolvedValue({ id: 'u-maker', email: 'maker@example.com' });
  manages.mockReset().mockResolvedValue(true);
  place.mockReset().mockResolvedValue({ id: 'bot-1', createdById: 'u-maker', roomId: 'room-1', universeId: 'uni', universeOwnerId: 'u-owner' });
  db.$queryRaw.mockReset().mockResolvedValue([]);
  db.bot.findUnique.mockReset().mockResolvedValue({ dailyReplyCap: null, aiProviderRef: 'universe-ai' });
  db.user.findMany.mockReset().mockResolvedValue([]);
  db.botsAiUsage.findFirst.mockReset().mockResolvedValue(null);
  db.botsAiProvider.findMany.mockReset().mockResolvedValue([]);
  db.botReplyLimitHit.findMany.mockReset().mockResolvedValue([]);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('who sees it', () => {
  it('is nobody who is not signed in', async () => {
    session.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('is nobody who does not manage the bot, who gets the same answer as for no bot', async () => {
    manages.mockResolvedValue(false);
    expect((await get()).status).toBe(404);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('is a manager who is not the maker, told they are not the maker', async () => {
    session.mockResolvedValue({ id: 'u-manager', email: 'm@example.com' });
    const body = await (await get()).json();
    expect(body.viewerIsMaker).toBe(false);
  });
});

describe('the range', () => {
  it('is 7 days unless asked, in UTC unless a time zone is given', async () => {
    const body = await (await get()).json();
    expect(body).toMatchObject({ range: '7d', timeZone: 'UTC' });
    expect(body.days).toHaveLength(7);
    expect(body.perDay).toHaveLength(7);
  });

  it('takes today or 30 days, and refuses anything else', async () => {
    expect((await (await get('?range=30d')).json()).days).toHaveLength(30);
    expect((await (await get('?range=today')).json()).days).toHaveLength(1);
    expect((await get('?range=year')).status).toBe(400);
    // Names every object has are not ranges either
    expect((await get('?range=constructor')).status).toBe(400);
  });

  it("uses the viewer's own days, and ignores a time zone that does not exist", () => {
    expect(readTimeZone('Asia/Kuwait')).toBe('Asia/Kuwait');
    expect(readTimeZone('Mars/Olympus')).toBe('UTC');
    // 22:30 UTC on the 26th is already the 27th in Kuwait
    expect(rangeDays('today', 'Asia/Kuwait', new Date('2026-10-26T22:30:00Z'))).toEqual(['2026-10-27']);
    expect(rangeDays('7d', 'UTC', new Date('2026-10-27T10:00:00Z'))).toEqual(['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  });
});

describe('what it shows', () => {
  it('a brand-new bot as having no usage', async () => {
    const body = await (await get()).json();
    expect(body).toMatchObject({ hasUsage: false, totals: { replies: 0, people: 0, tokens: 0 }, people: [], guests: { count: 0 } });
  });

  it('replies split into direct messages, nearby chat and older rows that are not split', async () => {
    db.botsAiUsage.findFirst.mockResolvedValue({ id: 1 });
    db.$queryRaw.mockResolvedValue([row({ channel: 'dm', replies: 4 }), row({ channel: 'nearby', replies: 2 }), row({ channel: null, replies: 3 })]);
    const body = await (await get()).json();
    expect(body.hasUsage).toBe(true);
    expect(body.channels).toEqual({ dm: 4, nearby: 2, notSplit: 3 });
    expect(body.perDay.at(-1)).toEqual({ day: today, dm: 4, nearby: 2, notSplit: 3 });
    expect(body.totals).toMatchObject({ replies: 9, tokens: 300 });
  });

  it('signed-in people by name with replies, where and when, most replies first; guests as one count', async () => {
    db.$queryRaw.mockResolvedValue([
      row({ person_id: 'u-omar', guest: false, replies: 2, channel: 'nearby' }),
      row({ person_id: 'u-sara', guest: false, replies: 5, channel: 'dm' }),
      row({ person_id: 'u-sara', guest: false, replies: 1, channel: 'nearby', last_at: new Date(`${today}T11:00:00Z`) }),
      row({ guest: true, guest_id: 'wa-g1', replies: 3, channel: 'nearby' }),
      row({ guest: true, guest_id: 'wa-g2', replies: 1, channel: 'nearby' }),
    ]);
    db.user.findMany.mockResolvedValue([{ id: 'u-sara', name: 'Sara' }, { id: 'u-omar', name: 'Omar' }]);
    const body = await (await get()).json();
    expect(body.people).toEqual([
      { id: 'u-sara', name: 'Sara', replies: 6, dm: 5, nearby: 1, notSplit: 0, lastAt: `${today}T11:00:00.000Z` },
      { id: 'u-omar', name: 'Omar', replies: 2, dm: 0, nearby: 2, notSplit: 0, lastAt: `${today}T09:00:00.000Z` },
    ]);
    expect(body.guests).toEqual({ count: 2, replies: 4, dm: 0, nearby: 4, notSplit: 0 });
    expect(body.totals.people).toBe(4);
    // Only names are read about people: never an email, never what they said
    expect(db.user.findMany).toHaveBeenCalledWith({ where: { id: { in: ['u-omar', 'u-sara'] } }, select: { id: true, name: true } });
    expect(JSON.stringify(body)).not.toContain('wa-g1');
  });

  it("what it ran on: the maker's key with its estimated cost, Universe AI as one free line", async () => {
    db.$queryRaw.mockResolvedValue([
      row({ provider_id: 'key-1', key_owner_id: 'u-maker', replies: 5, tokens: 5000, cost_micros: 410000, unpriced: 0 }),
      row({ provider_id: 'ds', replies: 3, first_at: new Date(`${today}T10:00:00Z`) }),
      row({ provider_id: 'ds2', replies: 2, first_at: new Date(`${today}T10:30:00Z`) }),
    ]);
    db.botsAiProvider.findMany.mockResolvedValue([{ providerId: 'key-1', name: 'My OpenAI', type: 'openai', downSince: null, ifDown: 'universe-ai' }]);
    const body = await (await get()).json();
    expect(body.ranOn).toEqual([
      expect.objectContaining({ kind: 'own-key', name: 'My OpenAI', replies: 5, tokens: 5000, costMicros: 410000, unpricedReplies: 0 }),
      expect.objectContaining({ kind: 'universe-ai', name: null, replies: 5, costMicros: null, unpricedReplies: 0 }),
    ]);
  });

  it('a key with no price as not known, never as free', async () => {
    db.$queryRaw.mockResolvedValue([row({ provider_id: 'key-2', key_owner_id: 'u-maker', replies: 2, cost_micros: null, unpriced: 2 })]);
    const body = await (await get()).json();
    expect(body.ranOn[0]).toMatchObject({ kind: 'own-key', costMicros: null, unpricedReplies: 2 });
  });

  it("the bot's key not working now, and what it does meanwhile", async () => {
    db.bot.findUnique.mockResolvedValue({ dailyReplyCap: 20, aiProviderRef: 'key-1' });
    db.botsAiProvider.findMany.mockResolvedValue([{ providerId: 'key-1', name: 'My OpenAI', type: 'openai', downSince: new Date('2026-10-23T18:14:00Z'), ifDown: 'universe-ai' }]);
    const body = await (await get()).json();
    expect(body.keyProblem).toEqual({ name: 'My OpenAI', downSince: '2026-10-23T18:14:00.000Z', meanwhile: 'universe-ai' });
    expect(body.limits).toMatchObject({ botLimit: 20, botLimitWindowHours: 24, universeAi: { signedIn: 30, guest: 10, guestPool: 200, windowHours: 5 } });
  });

  it('the Universe AI numbers a super admin saved', async () => {
    db.appSetting.findUnique.mockResolvedValue({ key: 'bot-limits', value: { fairUsage: { signedIn: 50, guest: 5, guestPool: 100 } } });
    const body = await (await get()).json();
    expect(body.limits.universeAi).toEqual({ signedIn: 50, guest: 5, guestPool: 100, windowHours: 5 });
  });

  it('how many people ran out, each counted once, inside the range only', async () => {
    db.botReplyLimitHit.findMany.mockResolvedValue([
      { kind: 'universe-ai', talkedUserId: 'wa-sara', createdAt: new Date() },
      { kind: 'universe-ai', talkedUserId: 'wa-sara', createdAt: new Date() },
      { kind: 'guest', talkedUserId: 'wa-g1', createdAt: new Date() },
      { kind: 'bot', talkedUserId: 'wa-omar', createdAt: new Date() },
      { kind: 'universe-ai', talkedUserId: 'wa-old', createdAt: new Date('2020-01-01T00:00:00Z') },
      { kind: 'universe-ai', talkedUserId: 'wa-lina', createdAt: new Date(), askedAt: new Date() },
      { kind: 'universe-ai', talkedUserId: 'wa-yusuf', createdAt: new Date('2020-01-01T00:00:00Z'), askedAt: new Date('2020-01-01T00:00:00Z') },
    ]);
    const body = await (await get('?range=today')).json();
    expect(body.limits.ranOut).toEqual({ universeAi: 3, botLimit: 1 });
    expect(body.limits.askedMaker).toBe(1);
  });

  it('answers 500 without details when reading fails', async () => {
    db.$queryRaw.mockRejectedValue(new Error('boom'));
    const response = await get();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to read bot usage' });
  });
});
