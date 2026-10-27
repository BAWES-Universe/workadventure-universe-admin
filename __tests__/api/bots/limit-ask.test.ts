/**
 * POST /api/bots/:id/limit-ask (game #1159 step 3): "Ask <bot>'s maker" on the limit card. Only someone who has used their
 * Universe AI replies on this bot can ask, once per window; the maker gets a count, never a name.
 */
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/bots/[id]/limit-ask/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    botReplyLimitHit: { findFirst: jest.fn(), update: jest.fn() },
  },
}));

const db = prisma as unknown as { user: { findUnique: jest.Mock }; botReplyLimitHit: { findFirst: jest.Mock; update: jest.Mock } };
const session = getSessionUser as jest.Mock;
const ask = () => POST(new NextRequest('http://localhost:3333/api/bots/bot-1/limit-ask', { method: 'POST' }), { params: Promise.resolve({ id: 'bot-1' }) });

beforeEach(() => {
  session.mockReset().mockResolvedValue({ id: 'u-sara', email: 'sara@example.com' });
  db.user.findUnique.mockReset().mockResolvedValue({ uuid: 'wa-sara', email: 'sara@example.com' });
  db.botReplyLimitHit.findFirst.mockReset().mockResolvedValue({ id: 'hit-1', askedAt: null });
  db.botReplyLimitHit.update.mockReset().mockResolvedValue({});
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it('records the ask on the limit they reached on this bot, by either of their ids, in a window still running', async () => {
  const response = await ask();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ asked: true });
  expect(db.botReplyLimitHit.findFirst).toHaveBeenCalledWith(expect.objectContaining({
    where: { botId: 'bot-1', kind: 'universe-ai', talkedUserId: { in: ['wa-sara', 'sara@example.com'] }, windowEndsAt: { gt: expect.any(Date) } },
  }));
  expect(db.botReplyLimitHit.update).toHaveBeenCalledWith({ where: { id: 'hit-1' }, data: { askedAt: expect.any(Date) } });
});

it('counts a second tap in the same window once', async () => {
  db.botReplyLimitHit.findFirst.mockResolvedValue({ id: 'hit-1', askedAt: new Date() });
  expect((await ask()).status).toBe(200);
  expect(db.botReplyLimitHit.update).not.toHaveBeenCalled();
});

it('has nothing to ask for when they have not reached a limit here', async () => {
  db.botReplyLimitHit.findFirst.mockResolvedValue(null);
  expect((await ask()).status).toBe(404);
  expect(db.botReplyLimitHit.update).not.toHaveBeenCalled();
});

it('is only for someone signed in', async () => {
  session.mockResolvedValue(null);
  expect((await ask()).status).toBe(401);
  expect(db.botReplyLimitHit.findFirst).not.toHaveBeenCalled();
});
