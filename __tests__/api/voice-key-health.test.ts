/**
 * Is a person's voice key working (#749): the bot server tells Orbit how each call went, a key the provider turns away is Down
 * and its bots reply in text, it is tried again at most every 5 minutes when a bot needs it, and its owner can ask for a
 * try now. The server's own providers have no health. Nothing here calls a provider. The database is a small in-memory stand-in.
 */
import { NextRequest } from 'next/server';
import { POST as report } from '@/app/api/voice/providers/[id]/health/route';
import { POST as check } from '@/app/api/me/voice-keys/[id]/check/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { claimVoiceKeyTry, reportVoiceKeyCall } from '@/lib/voice-key-health';
import { voiceProviderTable, type ProviderRow } from '../helpers/voice-provider-rows';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: {} }));
jest.mock('@/lib/voice-keys', () => ({
  ...jest.requireActual('@/lib/voice-keys'),
  voiceKeyCompanies: async () => [],
}));

let rows: ProviderRow[];

const row = (changes: ProviderRow = {}): ProviderRow => ({
  id: 'k1',
  ownerId: 'u-ana',
  adapter: 'elevenlabs',
  name: 'My ElevenLabs',
  recognition: false,
  speech: true,
  apiKeyLast4: '9f2a',
  models: [],
  createdAt: new Date('2026-10-30T10:00:00Z'),
  downSince: null,
  downReason: null,
  failedCalls: 0,
  healthCheckedAt: null,
  lends: [],
  ...changes,
});

const asGame = { Authorization: 'Bearer service-secret' };
const send = (route: typeof report | typeof check, body?: unknown, headers: Record<string, string> = asGame, id = 'k1') =>
  route(new NextRequest('http://localhost:3333/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 30, 11, minutes));
const THEN = at(0);

beforeEach(() => {
  process.env.BOT_SERVICE_TOKEN = 'service-secret';
  rows = [row(), row({ id: 'server', ownerId: null })];
  const table = voiceProviderTable(() => rows);
  Object.assign(prisma, {
    voiceProvider: { ...table, findMany: async ({ where }: { where: { ownerId: string } }) => rows.filter((r) => r.ownerId === where.ownerId) },
  });
  (getSessionUser as jest.Mock).mockReset().mockResolvedValue({ id: 'u-ana', email: 'ana@example.com' });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('what the bot server reports', () => {
  it('is for the bot server only, and well formed', async () => {
    expect((await send(report, { ok: true }, {})).status).toBe(401);
    expect((await send(report, { ok: true }, { Authorization: 'Bearer wrong' })).status).toBe(401);
    for (const body of [undefined, {}, { ok: 'yes' }, { ok: false, status: 99 }, { ok: true, status: 200 }, { ok: false, extra: 1 }]) {
      expect((await send(report, body)).status).toBe(400);
    }
  });

  it('says "not found" for a server provider and for a key that isn\'t there', async () => {
    expect((await send(report, { ok: false, status: 402 }, asGame, 'server')).status).toBe(404);
    expect((await send(report, { ok: false, status: 402 }, asGame, 'nope')).status).toBe(404);
    expect(rows[1].downSince).toBeNull();
  });

  it.each([
    [402, 'credit'],
    [401, 'rejected'],
    [403, 'rejected'],
    [404, 'model'],
  ])('marks a key Down at once for a %s, with the reason', async (status, reason) => {
    const response = await send(report, { ok: false, status });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'down', downReason: reason });
    expect(rows[0].downSince).toBeInstanceOf(Date);
  });

  it('marks a key Down when the provider refuses the key itself', async () => {
    expect(await (await send(report, { ok: false, rejected: true })).json()).toMatchObject({ status: 'down', downReason: 'rejected' });
  });

  it('counts other failures and marks the key Down on the second in a row, and a call that works starts the count again', async () => {
    expect(await (await send(report, { ok: false, status: 503 })).json()).toMatchObject({ status: 'working' });
    expect(await (await send(report, { ok: true })).json()).toMatchObject({ status: 'working' });
    expect(rows[0].failedCalls).toBe(0);
    await send(report, { ok: false });
    expect(await (await send(report, { ok: false, status: 500 })).json()).toMatchObject({ status: 'down', downReason: 'errors' });
  });

  it('doesn\'t count a request the provider found wrong (a 400 or 422), a slow-down is counted', async () => {
    await send(report, { ok: false, status: 400 });
    await send(report, { ok: false, status: 422 });
    expect(rows[0].failedCalls).toBe(0);
    await send(report, { ok: false, status: 429 });
    expect(rows[0].failedCalls).toBe(1);
  });

  it('marks a Down key Working again as soon as a call works', async () => {
    rows[0] = row({ downSince: THEN, downReason: 'credit', healthCheckedAt: THEN });
    expect(await (await send(report, { ok: true })).json()).toEqual({ status: 'working', downSince: null, downReason: null });
    expect(rows[0]).toMatchObject({ downSince: null, downReason: null, failedCalls: 0 });
  });

  it('keeps the first moment a key went Down, and updates the reason a failed try shows', async () => {
    rows[0] = row({ downSince: THEN, downReason: 'errors', healthCheckedAt: THEN });
    await reportVoiceKeyCall('k1', { ok: false, status: 402 }, at(10));
    expect(rows[0]).toMatchObject({ downSince: THEN, downReason: 'credit', healthCheckedAt: at(10) });
  });
});

describe('trying a Down key again', () => {
  it('gives one try per 5 minutes to whoever asks first, and never for a key that isn\'t Down', async () => {
    expect(await claimVoiceKeyTry('k1', at(0))).toBe(false);
    rows[0] = row({ downSince: THEN, downReason: 'credit', healthCheckedAt: THEN });
    expect(await claimVoiceKeyTry('k1', at(4))).toBe(false);
    expect(await claimVoiceKeyTry('k1', at(6))).toBe(true);
    expect(await claimVoiceKeyTry('k1', at(7))).toBe(false);
    expect(await claimVoiceKeyTry('k1', at(12))).toBe(true);
  });

  it('never claims a server provider', async () => {
    rows[1] = row({ id: 'server', ownerId: null, downSince: THEN });
    expect(await claimVoiceKeyTry('server', at(30))).toBe(false);
  });

  it('is brought forward by the owner\'s "Check now", which calls no provider', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    rows[0] = row({ downSince: THEN, downReason: 'credit', healthCheckedAt: at(2) });
    expect(await claimVoiceKeyTry('k1', at(3))).toBe(false);
    const response = await send(check, undefined, {});
    expect(response.status).toBe(200);
    expect((await response.json()).key).toMatchObject({ id: 'k1', health: { status: 'down', downReason: 'credit' } });
    expect(await claimVoiceKeyTry('k1', at(3))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is the owner\'s to ask for, and leaves a key that isn\'t Down as it is', async () => {
    rows[0] = row({ downSince: THEN, downReason: 'credit', healthCheckedAt: at(2) });
    (getSessionUser as jest.Mock).mockResolvedValue({ id: 'u-ben', email: 'ben@example.com' });
    expect((await send(check, undefined, {})).status).toBe(404);
    expect(rows[0].healthCheckedAt).toEqual(at(2));
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await send(check, undefined, {})).status).toBe(401);
    (getSessionUser as jest.Mock).mockResolvedValue({ id: 'u-ana', email: 'ana@example.com' });
    rows[0] = row({ healthCheckedAt: at(2) });
    expect((await (await send(check, undefined, {})).json()).key.health).toEqual({ status: 'working', downSince: null, downReason: null });
    expect(rows[0].healthCheckedAt).toEqual(at(2));
  });
});
