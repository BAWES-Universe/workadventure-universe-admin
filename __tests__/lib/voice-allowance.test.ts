/**
 * Voice replies inside the Universe AI allowance (game #1669): of 30 replies in 5 hours a signed-in person may hear 25 and keeps
 * 5 for text; of 10 a guest may hear 3. A reply asked for again is counted once.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { checkVoiceAllowance } from '@/lib/voice-allowance';
import { POST } from '@/app/api/bots/[id]/voice-allowance/route';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: jest.fn(),
    appSetting: { findUnique: jest.fn() },
    bot: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    voiceReplyUse: { findUnique: jest.fn(), create: jest.fn(), count: jest.fn() },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
  },
}));

const db = prisma as unknown as {
  $queryRaw: jest.Mock;
  appSetting: { findUnique: jest.Mock };
  bot: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
  voiceReplyUse: { findUnique: jest.Mock; create: jest.Mock; count: jest.Mock };
  $executeRaw: jest.Mock;
  $transaction: jest.Mock;
};

const NOW = new Date('2026-11-02T10:00:00Z');
const STARTED = new Date('2026-11-02T08:00:00Z');
const SARA = { userId: 'wa-sara', isGuest: false, turnId: 'bot-1-player-4-aaa' };
const GUEST = { userId: 'wa-guest', isGuest: true, turnId: 'bot-1-player-5-bbb' };

beforeEach(() => {
  db.appSetting.findUnique.mockReset().mockResolvedValue(null);
  db.$queryRaw.mockReset().mockResolvedValue([{ started_at: STARTED }]);
  db.bot.findUnique.mockReset().mockResolvedValue({ id: 'bot-1' });
  db.user.findUnique.mockReset().mockImplementation(async ({ where }: { where: { uuid?: string } }) => (where.uuid === 'wa-sara' ? { id: 'u-sara', isGuest: false } : null));
  db.voiceReplyUse.findUnique.mockReset().mockResolvedValue(null);
  db.voiceReplyUse.create.mockReset().mockResolvedValue({});
  db.voiceReplyUse.count.mockReset().mockResolvedValue(0);
  db.$executeRaw.mockReset().mockResolvedValue(0);
  // The transaction runs its steps against the same mocks, in order
  db.$transaction.mockReset().mockImplementation(async (steps: (tx: unknown) => Promise<unknown>) => steps(db));
});

describe('the numbers', () => {
  it('give a signed-in person 25 of 30 and keep 5 for text', async () => {
    db.voiceReplyUse.count.mockResolvedValue(24);
    expect(await checkVoiceAllowance('bot-1', SARA, NOW)).toEqual({ allowed: true });
    db.voiceReplyUse.count.mockResolvedValue(25);
    expect(await checkVoiceAllowance('bot-1', { ...SARA, turnId: 'next' }, NOW)).toEqual({ allowed: false, resetsAt: '2026-11-02T13:00:00.000Z' });
  });

  it('give a guest 3, never more, however large the window is', async () => {
    db.voiceReplyUse.count.mockResolvedValue(2);
    expect(await checkVoiceAllowance('bot-1', GUEST, NOW)).toEqual({ allowed: true });
    db.voiceReplyUse.count.mockResolvedValue(3);
    expect(await checkVoiceAllowance('bot-1', { ...GUEST, turnId: 'next' }, NOW)).toMatchObject({ allowed: false });
  });

  it('are what a super admin saved: the reserve and the guest number', async () => {
    db.appSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === 'voice-limits' ? { value: { limits: { textReserveShare: 2, guestVoiceReplies: 1 } } } : where.key === 'bot-limits' ? { value: { fairUsage: { signedIn: 10, guest: 4 } } } : null);
    db.voiceReplyUse.count.mockResolvedValue(4);
    expect(await checkVoiceAllowance('bot-1', SARA, NOW)).toEqual({ allowed: true });
    db.voiceReplyUse.count.mockResolvedValue(5);
    expect(await checkVoiceAllowance('bot-1', { ...SARA, turnId: 'next' }, NOW)).toMatchObject({ allowed: false });
    db.voiceReplyUse.count.mockResolvedValue(1);
    expect(await checkVoiceAllowance('bot-1', GUEST, NOW)).toMatchObject({ allowed: false });
  });

  it('are the recommended ones when the saved limits cannot be read', async () => {
    db.appSetting.findUnique.mockRejectedValue(new Error('down'));
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    db.voiceReplyUse.count.mockResolvedValue(24);
    expect(await checkVoiceAllowance('bot-1', SARA, NOW)).toEqual({ allowed: true });
    logged.mockRestore();
  });
});

describe('counting', () => {
  it('counts a signed-in person by their account, in the same window as their Universe AI replies', async () => {
    await checkVoiceAllowance('bot-1', SARA, NOW);
    expect(db.$queryRaw.mock.calls[0][0].values).toEqual(expect.arrayContaining(['ua:person:u-sara']));
    expect(db.voiceReplyUse.create).toHaveBeenCalledWith({ data: { botId: 'bot-1', turnId: SARA.turnId, personKey: 'person:u-sara', createdAt: NOW } });
    expect(db.voiceReplyUse.count).toHaveBeenCalledWith({ where: { personKey: 'person:u-sara', createdAt: { gte: STARTED } } });
  });

  it('counts a guest by their own id without looking them up', async () => {
    await checkVoiceAllowance('bot-1', GUEST, NOW);
    expect(db.voiceReplyUse.create).toHaveBeenCalledWith({ data: expect.objectContaining({ personKey: 'guest:wa-guest' }) });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('counts a reply once however often it is asked for', async () => {
    db.voiceReplyUse.findUnique.mockResolvedValue({ id: 'u1' });
    expect(await checkVoiceAllowance('bot-1', SARA, NOW)).toEqual({ allowed: true });
    expect(db.voiceReplyUse.create).not.toHaveBeenCalled();
  });

  it("settles one person's replies one at a time, so two asked for together can't both take the last place", async () => {
    await checkVoiceAllowance('bot-1', SARA, NOW);
    const lock = db.$executeRaw.mock.calls[0];
    expect(lock[0].join('?')).toContain('pg_advisory_xact_lock');
    expect(lock[1]).toBe('person:u-sara');
    // The lock comes before anything is read or written
    expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.voiceReplyUse.count.mock.invocationCallOrder[0]);
  });

  it('writes nothing for a reply it turns down, so there is nothing to take back', async () => {
    db.voiceReplyUse.count.mockResolvedValue(99);
    expect(await checkVoiceAllowance('bot-1', SARA, NOW)).toMatchObject({ allowed: false });
    expect(db.voiceReplyUse.create).not.toHaveBeenCalled();
  });

  it('never stops someone the bot cannot name yet', async () => {
    expect(await checkVoiceAllowance('bot-1', { turnId: 't1' }, NOW)).toEqual({ allowed: true });
    expect(db.voiceReplyUse.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/bots/:id/voice-allowance', () => {
  const ask = (body: unknown, token = 'svc') =>
    POST(
      new NextRequest('http://localhost:3333/api/bots/bot-1/voice-allowance', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: 'bot-1' }) },
    );
  beforeEach(() => {
    process.env.BOT_SERVICE_TOKEN = 'svc';
  });

  it('answers the bot server', async () => {
    const response = await ask(SARA);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: true });
  });

  it('refuses anyone without the service token', async () => {
    expect((await ask(SARA, 'nope')).status).toBe(401);
  });

  it('says what is wrong with a bad request', async () => {
    expect((await ask({ userId: 'wa-sara' })).status).toBe(400);
    expect((await ask({ ...SARA, turnId: 'x'.repeat(256) })).status).toBe(400);
    db.bot.findUnique.mockResolvedValue(null);
    expect((await ask(SARA)).status).toBe(404);
  });
});
