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
  { adapter: 'fish', name: 'Fish Audio', recognition: false, speech: true, models: [{ id: 's2.1-pro-free', label: 'S2.1 Pro (free)', kind: 'speech' }, { id: 's2.1-pro', kind: 'speech' }] },
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
  it.each([200, 500])('lets go of the company\'s answer without reading it (%s)', async (status) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status }));
    await send({ adapter: 'elevenlabs', apiKey: KEY });
    expect(cancelled).toBe(true);
  });

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

  it.each(VOICE_KEY_COMPANIES.filter((company) => !company.check.sign).map((company) => [company.adapter, company]))('%s: a GET to its own address with the key in one header and nothing billed', async (adapter, company) => {
    findMany.mockResolvedValue([{ adapter, name: company.label, recognition: true, speech: true, models: [{ id: 'm', kind: 'speech' }] }]);
    answer(200);
    // A company whose keys live at the person's own address (Azure) is asked there
    const address = company.account?.address ? 'https://my-resource.openai.azure.com' : undefined;
    expect((await send({ adapter, apiKey: KEY, ...(address ? { address } : {}) })).status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(company.check.url.replace('{address}', address ?? ''));
    expect(new URL(url).protocol).toBe('https:');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('manual');
    expect(init.headers[company.check.header]).toBe(`${company.check.prefix}${KEY}`);
    expect(Object.values(init.headers).filter((value) => String(value).includes(KEY))).toHaveLength(1);
  });

  it('checks an Azure key on the person’s own resource, then asks for the deployment to be typed', async () => {
    answer(200);
    const response = await send({ adapter: 'azure', apiKey: KEY, address: 'https://My-Res.openai.azure.com/openai/v1' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, models: [], typed: true });
    expect(fetchMock.mock.calls[0][0]).toBe('https://my-res.openai.azure.com/openai/v1/models');
    expect(fetchMock.mock.calls[0][1].headers['api-key']).toBe(KEY);
  });

  it.each([undefined, '', 'my-res', 'http://my-res.openai.azure.com', 'https://evil.example.com', 'https://openai.azure.com', 'https://my-res.openai.azure.com.evil.com', 'https://u:p@my-res.openai.azure.com'])(
    'never sends an Azure key to %p',
    async (address) => {
      answer(200);
      const response = await send({ adapter: 'azure', apiKey: KEY, address });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Paste your endpoint as it is, like https://your-resource.openai.azure.com.' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  describe('AWS: a key in two parts, made per region (#1910)', () => {
    const ID = 'AKIAIOSFODNN7EXAMPLE';
    const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const AWS = `${ID}:${SECRET}`;

    it('signs a free STS call in the region picked: the ID and a signature go, never the secret', async () => {
      answer(200);
      const response = await send({ adapter: 'aws', apiKey: AWS, region: 'eu-north-1' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, models: [{ id: 'amazon.nova-2-sonic-v1:0', label: 'Nova 2 Sonic', kind: 'talk' }] });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://sts.eu-north-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15');
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('manual');
      expect(init.headers.Authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${ID}/\\d{8}/eu-north-1/sts/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$`));
      expect(init.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
      expect(JSON.stringify(init)).not.toContain(SECRET);
    });

    it('says AWS refused a key it answers 403', async () => {
      answer(403, '<ErrorResponse><Error><Code>InvalidClientTokenId</Code></Error></ErrorResponse>');
      const response = await send({ adapter: 'aws', apiKey: AWS, region: 'us-east-1' });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: 'AWS didn’t accept that key. Check it and paste it again.' });
    });

    it.each([undefined, '', 'eu-west-1', 'us-east-1.evil.com'])('asks for a region first, and calls no one, for %p', async (region) => {
      answer(200);
      const response = await send({ adapter: 'aws', apiKey: AWS, region });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Pick the region first.' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([SECRET, `${ID}:`, `:${SECRET}`, `ASIAIOSFODNN7EXAMPLE:${SECRET}`, `${ID}:${SECRET}:x`])('refuses a key not in two parts, without calling anyone (%p)', async (apiKey) => {
      answer(200);
      const response = await send({ adapter: 'aws', apiKey, region: 'us-east-1' });
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('says Google refused a key it answers 400 API_KEY_INVALID, and counts any other 400 as not reached', async () => {
    answer(400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}');
    const refused = await send({ adapter: 'google', apiKey: KEY });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'Google didn’t accept that key. Check it and paste it again.' });
    answer(400, '{"error":{"code":400,"status":"FAILED_PRECONDITION"}}');
    expect((await send({ adapter: 'google', apiKey: KEY })).status).toBe(502);
  });

  it('says the company refused the key for a 401 or 403, and lists nothing', async () => {
    for (const status of [401, 403]) {
      answer(status);
      const response = await send({ adapter: 'cartesia', apiKey: KEY });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: 'Cartesia didn’t accept that key. Check it and paste it again.' });
    }
  });

  it('counts a key limited to other endpoints as accepted when the company says so, and a plain 401 as refused', async () => {
    answer(401, '{"detail":{"status":"missing_permissions","message":"The API key is missing the permission user_read"}}');
    expect((await send({ adapter: 'elevenlabs', apiKey: KEY })).status).toBe(200);
    answer(401, '{"detail":{"status":"invalid_api_key"}}');
    expect((await send({ adapter: 'elevenlabs', apiKey: KEY })).status).toBe(422);
    // Deepgram answers a key without projects:read with a 403, and a wrong key with a 401
    answer(403, '{"err_code":"FORBIDDEN","err_msg":"Insufficient permissions."}');
    expect((await send({ adapter: 'deepgram', apiKey: KEY })).status).toBe(200);
    answer(401, '{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials."}');
    expect((await send({ adapter: 'deepgram', apiKey: KEY })).status).toBe(422);
    // OpenAI answers a restricted key without the models permission with a 403 naming the scope; any other 403 is still refused
    findMany.mockResolvedValue([{ adapter: 'openai', name: 'OpenAI', recognition: true, speech: true, models: [{ id: 'm', kind: 'speech' }] }]);
    answer(403, '{"error":{"message":"You have insufficient permissions for this operation. Missing scopes: api.model.read."}}');
    expect((await send({ adapter: 'openai', apiKey: KEY })).status).toBe(200);
    answer(403, '{"error":{"message":"You are not allowed to sample from this model"}}');
    expect((await send({ adapter: 'openai', apiKey: KEY })).status).toBe(422);
    answer(401, '{"error":{"code":"invalid_api_key"}}');
    expect((await send({ adapter: 'openai', apiKey: KEY })).status).toBe(422);
  });

  it('Fish Audio: asks its free credit call, lists its models, and refuses a wrong key with its own name', async () => {
    answer(200);
    const accepted = await send({ adapter: 'fish', apiKey: KEY });
    expect(await accepted.json()).toEqual({ ok: true, models: [{ id: 's2.1-pro-free', label: 'S2.1 Pro (free)', kind: 'speech' }, { id: 's2.1-pro', kind: 'speech' }] });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.fish.audio/wallet/self/api-credit');
    answer(401);
    const refused = await send({ adapter: 'fish', apiKey: KEY });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'Fish Audio didn’t accept that key. Check it and paste it again.' });
  });

  it('AssemblyAI: lists past transcripts with the key as it is (no Bearer), so nothing is transcribed, and refuses a wrong key', async () => {
    answer(200);
    const accepted = await send({ adapter: 'assemblyai', apiKey: KEY });
    expect((await accepted.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.assemblyai.com/v2/transcript?limit=1');
    expect(init.headers.Authorization).toBe(KEY);
    answer(401);
    const refused = await send({ adapter: 'assemblyai', apiKey: KEY });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'AssemblyAI didn’t accept that key. Check it and paste it again.' });
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

  it('refuses a company that is not in the catalog without calling anyone', async () => {
    for (const adapter of ['unknown-co', undefined, 5]) {
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

  it('needs no setup by a super admin: a company the server has no provider for starts with the catalog\'s own models', async () => {
    findMany.mockImplementation(async ({ where }: { where: { adapter?: string } }) => (where.adapter ? [] : serverRows));
    for (const [adapter, models] of [
      ['soniox', [{ id: 'stt-rt-v6', label: 'Soniox real-time v6', kind: 'recognition' }, { id: 'tts-rt-v2', label: 'Soniox TTS v2', kind: 'speech' }]],
      ['assemblyai', [{ id: 'universal-3-6-pro', label: 'Universal-3.6 Pro', kind: 'recognition' }, { id: 'universal-streaming-multilingual', label: 'Universal Streaming Multilingual', kind: 'recognition' }, { id: 'universal-streaming-english', label: 'Universal Streaming English', kind: 'recognition' }]],
      ['deepgram', [{ id: 'nova-3', label: 'Nova 3', kind: 'recognition' }, { id: 'aura-2', label: 'Aura 2', kind: 'speech' }]],
      ['cartesia', [{ id: 'ink-whisper', label: 'Ink Whisper', kind: 'recognition' }, { id: 'sonic-3.6', label: 'Sonic 3.6', kind: 'speech' }]],
      ['fish', [{ id: 's2.1-pro-free', label: 'S2.1 Pro (free)', kind: 'speech' }, { id: 's2.1-pro', label: 'S2.1 Pro', kind: 'speech' }]],
      ['elevenlabs', [{ id: 'scribe_v2_realtime', label: 'Scribe v2 Realtime', kind: 'recognition' }, { id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo', kind: 'speech' }, { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5', kind: 'speech' }]],
    ] as const) {
      answer(200);
      const response = await send({ adapter, apiKey: KEY });
      expect([adapter, response.status, await response.json()]).toEqual([adapter, 200, { ok: true, models }]);
    }
  });

  it('lists the server\'s own models instead of the catalog\'s for each job the server has a provider for', async () => {
    answer(200);
    const response = await send({ adapter: 'elevenlabs', apiKey: KEY });
    const { models } = await response.json();
    expect(models.map((model: { id: string }) => model.id)).toEqual(['scribe_v1', 'eleven_flash_v2_5', 'eleven_v3']);
  });

  it('gives the catalog\'s starting models for a job the server has no provider for, after the server\'s own', async () => {
    answer(200);
    const response = await send({ adapter: 'cartesia', apiKey: KEY });
    expect(await response.json()).toEqual({ ok: true, models: [{ id: 'sonic-3', kind: 'speech' }, { id: 'ink-whisper', label: 'Ink Whisper', kind: 'recognition' }] });
    // The same for a company the server only listens with: its key still speaks
    answer(200);
    const deepgram = await (await send({ adapter: 'deepgram', apiKey: KEY })).json();
    expect(deepgram.models).toEqual([{ id: 'nova-3', label: 'Nova 3', kind: 'recognition' }, { id: 'aura-2', label: 'Aura 2', kind: 'speech' }]);
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
