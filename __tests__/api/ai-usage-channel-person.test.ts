/**
 * Usage rows say where a reply was given and who it was for (Orbit #491, game #1159 step 6). A signed-in person is
 * matched to their Orbit account; a guest is only counted; a bot server from before it leaves all three empty.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { POST as trackUsage } from '@/app/api/bots/ai-usage/route';
import { readUsageChannel } from '@/lib/usage-person';
import { recordModelCall } from '@/lib/meter';

jest.mock('@/lib/db', () => ({
  prisma: {
    botsAiProvider: { findUnique: jest.fn(), findFirst: jest.fn() },
    botsAiUsage: { create: jest.fn(async () => ({})) },
    user: { findUnique: jest.fn() },
  },
}));
jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/meter', () => ({ recordModelCall: jest.fn(async () => null) }));

const provider = prisma.botsAiProvider as unknown as Record<'findUnique', jest.Mock>;
const usage = prisma.botsAiUsage as unknown as Record<'create', jest.Mock>;
const users = prisma.user as unknown as Record<'findUnique', jest.Mock>;

const track = (body: object) =>
  trackUsage(new NextRequest('http://localhost:3333/api/bots/ai-usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: 'b1', providerId: 'deepseek-flash', tokensUsed: 900, ...body }) }));
const saved = () => usage.create.mock.calls[0][0].data;

beforeEach(() => {
  usage.create.mockReset().mockResolvedValue({});
  users.findUnique.mockReset().mockResolvedValue(null);
  provider.findUnique.mockResolvedValue({ providerId: 'deepseek-flash', ownerId: null });
});

describe('where a reply was given', () => {
  it('keeps direct messages and nearby chat apart', async () => {
    await track({ channel: 'dm' });
    await track({ channel: 'nearby' });
    expect(usage.create.mock.calls.map((call) => call[0].data.channel)).toEqual(['dm', 'nearby']);
  });

  it("reads the bot server's own word for nearby chat", () => {
    expect(readUsageChannel('world')).toBe('nearby');
  });

  it('saves anything else as not split', async () => {
    await track({ channel: 'carrier-pigeon' });
    expect(saved().channel).toBeNull();
  });
});

describe('who it was for', () => {
  it('names a signed-in person by their Orbit account', async () => {
    users.findUnique.mockResolvedValue({ id: 'user-sara', isGuest: false });
    await track({ userId: 'wa-uuid-sara', isGuest: false, channel: 'dm' });
    expect(users.findUnique).toHaveBeenCalledWith({ where: { uuid: 'wa-uuid-sara' }, select: { id: true, isGuest: true } });
    expect(saved()).toMatchObject({ talkedUserId: 'wa-uuid-sara', talkedPersonId: 'user-sara', talkedGuest: false });
  });

  it('finds someone who signed in with an email by that email', async () => {
    users.findUnique.mockResolvedValue({ id: 'user-omar', isGuest: false });
    await track({ userId: 'omar@example.com', isGuest: false });
    expect(users.findUnique).toHaveBeenCalledWith({ where: { email: 'omar@example.com' }, select: { id: true, isGuest: true } });
    expect(saved()).toMatchObject({ talkedPersonId: 'user-omar', talkedGuest: false });
  });

  it('counts a guest without looking them up or naming them', async () => {
    await track({ userId: 'wa-uuid-guest', isGuest: true, channel: 'nearby' });
    expect(users.findUnique).not.toHaveBeenCalled();
    expect(saved()).toMatchObject({ talkedUserId: 'wa-uuid-guest', talkedPersonId: null, talkedGuest: true });
  });

  it('counts someone Orbit does not know as a guest', async () => {
    await track({ userId: 'wa-uuid-unknown', isGuest: false });
    expect(saved()).toMatchObject({ talkedPersonId: null, talkedGuest: true });
  });

  it('counts an Orbit guest account as a guest', async () => {
    users.findUnique.mockResolvedValue({ id: 'user-guest', isGuest: true });
    await track({ userId: 'wa-uuid-guest-account', isGuest: false });
    expect(saved()).toMatchObject({ talkedPersonId: null, talkedGuest: true });
  });

  it('still saves the reply when the lookup fails', async () => {
    users.findUnique.mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const response = await track({ userId: 'wa-uuid-sara', isGuest: false });
    spy.mockRestore();
    expect(response.status).toBe(200);
    expect(saved()).toMatchObject({ botId: 'b1', talkedPersonId: null, talkedGuest: false });
  });

  it('keeps what the bot server said about the speaker when the lookup fails, and says nothing when it told nothing', async () => {
    users.findUnique.mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await track({ userId: 'wa-uuid-sara' });
    spy.mockRestore();
    expect(saved()).toMatchObject({ talkedPersonId: null, talkedGuest: null });
  });

  it('never takes a person id from the request', async () => {
    await track({ talkedPersonId: 'user-someone-else', userId: 'wa-uuid-guest', isGuest: true });
    expect(saved().talkedPersonId).toBeNull();
  });
});

describe('a bot server from before this', () => {
  it('leaves where and who empty, as on older rows', async () => {
    await track({});
    expect(users.findUnique).not.toHaveBeenCalled();
    expect(saved()).toMatchObject({ channel: null, talkedUserId: null, talkedPersonId: null, talkedGuest: null });
  });

  it('keeps whose key paid from the provider row', async () => {
    provider.findUnique.mockResolvedValue({ providerId: 'key-1', ownerId: 'maker-1' });
    await track({ providerId: 'key-1', keyOwnerId: 'someone-else' });
    expect(saved().keyOwnerId).toBe('maker-1');
  });
});

describe('the meter’s books (game #1998)', () => {
  const books = recordModelCall as unknown as jest.Mock;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const row = (over: object = {}) => ({
    id: 41,
    keyOwnerId: null,
    talkedUserId: 'wa-uuid-sara',
    talkedPersonId: 'user-sara',
    talkedGuest: false,
    channel: 'dm',
    tokensUsed: 900,
    apiCalls: 1,
    error: false,
    greeting: false,
    costBasis: 'priced',
    costMicros: 1200,
    inputTokens: 700,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 200,
    reasoningTokens: 0,
    timestamp: new Date('2026-11-11T10:00:00Z'),
    ...over,
  });

  beforeEach(() => books.mockClear());

  it('copies the call from the row that was just counted, with the same ids and the same figures', async () => {
    usage.create.mockResolvedValue(row());
    await track({ userId: 'wa-uuid-sara', providerId: 'deepseek-flash', channel: 'dm' });
    await flush();
    expect(books).toHaveBeenCalledTimes(1);
    expect(books.mock.calls[0][0]).toMatchObject({
      usageRowId: 41,
      botId: 'b1',
      clientEventId: null,
      providerId: 'deepseek-flash',
      keyOwnerId: null,
      talkedPersonId: 'user-sara',
      costBasis: 'priced',
      costMicros: 1200,
      occurredAt: new Date('2026-11-11T10:00:00Z'),
    });
  });

  it('passes on the bot server’s own id for the call, so a report sent twice is one event in the books', async () => {
    usage.create.mockResolvedValue(row());
    await track({ eventId: 'turn-9' });
    await flush();
    expect(books.mock.calls[0][0].clientEventId).toBe('turn-9');
  });

  it('answers the report even when the books are down', async () => {
    usage.create.mockResolvedValue(row());
    books.mockRejectedValueOnce(new Error('books down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const response = await track({});
    await flush();
    spy.mockRestore();
    expect(response.status).toBe(200);
  });
});
