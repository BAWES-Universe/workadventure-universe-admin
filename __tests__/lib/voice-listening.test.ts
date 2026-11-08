/**
 * A bot's daily listening limit (game #1859): the bot server adds the seconds of group speech it sent to the listening provider and
 * is told when the day's minutes are used. The limit is the voice limit, or the one a lent listening key sets.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { effectiveBotVoice } from '@/lib/bot-voice';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { reportListening } from '@/lib/voice-listening';
import { POST } from '@/app/api/bots/[id]/voice-listening/route';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: { voiceListenUse: { upsert: jest.fn(), findUnique: jest.fn() } } }));
jest.mock('@/lib/bot-voice', () => ({ effectiveBotVoice: jest.fn() }));

const db = prisma as unknown as { voiceListenUse: { upsert: jest.Mock; findUnique: jest.Mock } };
const voice = effectiveBotVoice as unknown as jest.Mock;

const NOW = new Date('2026-11-06T21:30:00Z');
const DAY = new Date('2026-11-06T00:00:00Z');
const RESETS = '2026-11-07T00:00:00.000Z';

beforeEach(() => {
  voice.mockReset().mockResolvedValue({ limits: { listenMinutesPerDay: 60 } });
  db.voiceListenUse.upsert.mockReset().mockResolvedValue({ seconds: 30 });
  db.voiceListenUse.findUnique.mockReset().mockResolvedValue(null);
});

describe('the day', () => {
  it('adds the seconds to the bot\'s UTC day in one statement', async () => {
    expect(await reportListening('bot-1', { seconds: 30 }, NOW)).toEqual({ spent: false, usedSeconds: 30, limitSeconds: 3600, resetsAt: RESETS });
    expect(db.voiceListenUse.upsert).toHaveBeenCalledWith({
      where: { botId_day: { botId: 'bot-1', day: DAY } },
      create: { botId: 'bot-1', day: DAY, seconds: 30 },
      update: { seconds: { increment: 30 } },
      select: { seconds: true },
    });
  });

  it('only reads when no seconds are sent, and a day with no row is unused', async () => {
    expect(await reportListening('bot-1', {}, NOW)).toEqual({ spent: false, usedSeconds: 0, limitSeconds: 3600, resetsAt: RESETS });
    expect(await reportListening('bot-1', { seconds: 0 }, NOW)).toMatchObject({ usedSeconds: 0 });
    expect(db.voiceListenUse.upsert).not.toHaveBeenCalled();
  });

  it('starts a new day at UTC midnight', async () => {
    await reportListening('bot-1', { seconds: 5 }, new Date('2026-11-06T23:59:59Z'));
    await reportListening('bot-1', { seconds: 5 }, new Date('2026-11-07T00:00:01Z'));
    expect(db.voiceListenUse.upsert.mock.calls[0][0].where.botId_day.day).toEqual(DAY);
    expect(db.voiceListenUse.upsert.mock.calls[1][0].where.botId_day.day).toEqual(new Date('2026-11-07T00:00:00Z'));
  });

  it('rounds a part of a second to the nearest second', async () => {
    await reportListening('bot-1', { seconds: 2.6 }, NOW);
    expect(db.voiceListenUse.upsert.mock.calls[0][0].update).toEqual({ seconds: { increment: 3 } });
  });
});

describe('the limit', () => {
  it('is spent once the day holds the limit, and not before', async () => {
    voice.mockResolvedValue({ limits: { listenMinutesPerDay: 1 } });
    db.voiceListenUse.upsert.mockResolvedValue({ seconds: 59 });
    expect(await reportListening('bot-1', { seconds: 59 }, NOW)).toMatchObject({ spent: false, limitSeconds: 60 });
    db.voiceListenUse.upsert.mockResolvedValue({ seconds: 60 });
    expect(await reportListening('bot-1', { seconds: 1 }, NOW)).toMatchObject({ spent: true, usedSeconds: 60 });
  });

  it('still counts a report that goes past the limit in full', async () => {
    voice.mockResolvedValue({ limits: { listenMinutesPerDay: 1 } });
    db.voiceListenUse.upsert.mockResolvedValue({ seconds: 150 });
    expect(await reportListening('bot-1', { seconds: 150 }, NOW)).toMatchObject({ spent: true, usedSeconds: 150 });
  });

  it('stays spent when it is only asked about', async () => {
    voice.mockResolvedValue({ limits: { listenMinutesPerDay: 1 } });
    db.voiceListenUse.findUnique.mockResolvedValue({ seconds: 61 });
    expect(await reportListening('bot-1', {}, NOW)).toMatchObject({ spent: true });
  });

  it('is what the voice limits say, so a change needs no deploy, including a lent key\'s own', async () => {
    voice.mockResolvedValue({ limits: { listenMinutesPerDay: 5 } });
    db.voiceListenUse.findUnique.mockResolvedValue({ seconds: 299 });
    expect(await reportListening('bot-1', {}, NOW)).toMatchObject({ spent: false, limitSeconds: 300 });
    // Whatever the key's health, the limit a lent listening key sets is the one that applies
    expect(voice).toHaveBeenCalledWith('bot-1', { ignoreSwitch: true, ignoreKeyHealth: true });
  });

  it('is 0 minutes: the bot does not listen to groups at all', async () => {
    voice.mockResolvedValue({ limits: { listenMinutesPerDay: 0 } });
    expect(await reportListening('bot-1', {}, NOW)).toMatchObject({ spent: true, limitSeconds: 0 });
  });
});

describe('POST /api/bots/:id/voice-listening', () => {
  const ask = (body: unknown, token = 'svc') =>
    POST(
      new NextRequest('http://localhost:3333/api/bots/bot-1/voice-listening', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: 'bot-1' }) },
    );
  beforeEach(() => {
    process.env.BOT_SERVICE_TOKEN = 'svc';
  });

  it('answers the bot server', async () => {
    const response = await ask({ seconds: 30 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ spent: false, usedSeconds: 30, limitSeconds: 3600 });
  });

  it('refuses anyone without the service token', async () => {
    expect((await ask({ seconds: 30 }, 'nope')).status).toBe(401);
  });

  it('says what is wrong with a bad request', async () => {
    expect((await ask({ seconds: -1 })).status).toBe(400);
    expect((await ask({ seconds: 'ten' })).status).toBe(400);
    expect((await ask({ seconds: 3601 })).status).toBe(400);
    voice.mockRejectedValue(new BotSettingsError(404, 'Bot not found'));
    expect((await ask({ seconds: 5 })).status).toBe(404);
  });
});
