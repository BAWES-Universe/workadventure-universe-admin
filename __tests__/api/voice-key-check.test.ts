/**
 * "Load models" for a voice key (#749): one free, authenticated call to the company with the pasted key, then the models the
 * server's own providers for that company list. The key goes only to the company's own address and is never logged or returned.
 * The company is a stand-in: no real call is made.
 */
import { NextRequest } from 'next/server';
import { POST as check } from '@/app/api/me/voice-keys/check/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { VOICE_KEY_COMPANIES } from '@/lib/voice-key-companies';
import { CHECK_TIMEOUT_MS } from '@/lib/voice-key-check';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: { voiceProvider: { findMany: jest.fn() } } }));

const findMany = (prisma as unknown as { voiceProvider: { findMany: jest.Mock } }).voiceProvider.findMany;
const fetchMock = jest.fn();
const KEY = 'sk-secret-key-9f2a';

// The server's own providers that are on
const serverRows = [
  { adapter: 'elevenlabs', name: 'ElevenLabs', recognition: true, speech: true, models: [{ id: 'scribe_v1', label: 'Scribe v1', kind: 'recognition' }, { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5', kind: 'speech' }] },
  // A second ElevenLabs provider: its models are merged, the first listing of a model wins, and a model for a job it doesn't do is left out
  { adapter: 'elevenlabs', name: 'ElevenLabs EU', recognition: false, speech: true, models: [{ id: 'eleven_flash_v2_5', label: 'Flash (EU)', kind: 'speech' }, { id: 'eleven_v3', kind: 'speech' }, { id: 'scribe_v1', kind: 'recognition' }] },
  { adapter: 'deepgram', name: 'Deepgram', recognition: true, speech: false, models: [{ id: 'nova-3', label: 'Nova 3', kind: 'recognition' }] },
  { adapter: 'cartesia', name: 'Cartesia', recognition: false, speech: true, models: [{ id: 'sonic-3', kind: 'speech' }] },
];

const send = (body: unknown) =>
  check(new NextRequest('http://localhost:3333/api/me/voice-keys/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const answer = (status: number, text = '') => fetchMock.mockResolvedValue({ status, text: async () => text });

// A new person for each test, so the limit on tries (kept per person) starts over
let people = 0;
beforeEach(() => {
  jest.resetAllMocks();
  people += 1;
  (getSessionUser as jest.Mock).mockResolvedValue({ id: `u-${people}`, email: 'ana@example.com' });
  findMany.mockImplementation(async ({ where }: { where: { adapter?: string } }) => (where.adapter ? serverRows.filter((row) => row.adapter === where.adapter) : serverRows));
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('Load models for a voice key', () => {
  it('is for signed-in people', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await send({ adapter: 'elevenlabs', apiKey: KEY })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the company once, then lists the server providers’ models: each kind and id once, exactly as listed', async () => {
    answer(200);
    const response = await send({ adapter: 'elevenlabs', apiKey: KEY });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      models: [
        { id: 'scribe_v1', label: 'Scribe v1', kind: 'recognition' },
        { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5', kind: 'speech' },
        { id: 'eleven_v3', kind: 'speech' },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(VOICE_KEY_COMPANIES.map((company) => [company.adapter, company]))('%s: a GET to its own address with the key in one header and nothing billed', async (adapter, company) => {
    findMany.mockResolvedValue([{ adapter, name: company.label, recognition: true, speech: true, models: [{ id: 'm', kind: 'speech' }] }]);
    answer(200);
    expect((await send({ adapter, apiKey: KEY })).status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(company.check.url);
    expect(new URL(url).protocol).toBe('https:');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('manual');
    expect(init.headers[company.check.header]).toBe(`${company.check.prefix}${KEY}`);
    expect(Object.values(init.headers).filter((value) => String(value).includes(KEY))).toHaveLength(1);
  });

  it('says the company refused the key for a 401 or 403, and lists nothing', async () => {
    for (const status of [401, 403]) {
      answer(status);
      const response = await send({ adapter: 'deepgram', apiKey: KEY });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: 'Deepgram didn’t accept that key. Check it and paste it again.' });
    }
  });

  it('counts a key limited to other endpoints as accepted when the company says so, and a plain 401 as refused', async () => {
    answer(401, '{"detail":{"status":"missing_permissions","message":"The API key is missing the permission user_read"}}');
    expect((await send({ adapter: 'elevenlabs', apiKey: KEY })).status).toBe(200);
    answer(401, '{"detail":{"status":"invalid_api_key"}}');
    expect((await send({ adapter: 'elevenlabs', apiKey: KEY })).status).toBe(422);
  });

  it('says it could not be reached for a timeout, a dropped connection or any other answer', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    for (const respond of [() => undefined, () => fetchMock.mockRejectedValue(new Error('ECONNRESET')), () => answer(500), () => answer(429), () => answer(302)]) {
      respond();
      const response = await send({ adapter: 'cartesia', apiKey: KEY });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'Couldn’t reach Cartesia. Try again in a moment.' });
    }
  });

  it('waits a short time only', async () => {
    answer(200);
    const spy = jest.spyOn(AbortSignal, 'timeout');
    await send({ adapter: 'deepgram', apiKey: KEY });
    expect(spy).toHaveBeenCalledWith(CHECK_TIMEOUT_MS);
    expect(CHECK_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('refuses a company that is not in the catalog, or that the server has not turned on, without calling anyone', async () => {
    for (const adapter of ['unknown-co', 'soniox', undefined, 5]) {
      const response = await send({ adapter, apiKey: KEY });
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a missing key and one that could not go in a header, without calling anyone', async () => {
    expect((await send({ adapter: 'deepgram' })).status).toBe(400);
    expect((await send({ adapter: 'deepgram', apiKey: '   ' })).status).toBe(400);
    expect((await send({ adapter: 'deepgram', apiKey: 'bad key\nX-Evil: 1' })).status).toBe(400);
    expect((await send([1])).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says so when the company has no models set up', async () => {
    findMany.mockImplementation(async ({ where }: { where: { adapter?: string } }) => (where.adapter ? [] : serverRows));
    answer(200);
    expect((await send({ adapter: 'deepgram', apiKey: KEY })).status).toBe(409);
  });

  it('never returns or logs the key', async () => {
    const log = jest.spyOn(console, 'error');
    for (const respond of [() => answer(200), () => answer(401), () => fetchMock.mockRejectedValue(new Error(`failed with ${KEY}`))]) {
      respond();
      const response = await send({ adapter: 'deepgram', apiKey: KEY });
      expect(JSON.stringify(await response.json())).not.toContain(KEY);
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });

  it('slows down someone who tries too often', async () => {
    answer(200);
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) statuses.push((await send({ adapter: 'deepgram', apiKey: KEY })).status);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });
});
