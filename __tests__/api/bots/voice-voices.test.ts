/**
 * GET /api/bots/:id/voice/voices and /voice/voices/:voiceId/preview (game #1668): the speaking voices a bot's maker can pick from,
 * for Universe AI or for a voice key the maker lent to the bot's universe. The voice companies are stood in for by a fake
 * `fetch`, so nothing real is called, and the database is a small in-memory stand-in.
 */
import { NextRequest } from 'next/server';
import { GET as getVoices } from '@/app/api/bots/[id]/voice/voices/route';
import { GET as getPreview } from '@/app/api/bots/[id]/voice/voices/[voiceId]/preview/route';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBotMcpServers } from '@/lib/bot-permissions';
import { lendAccess } from '@/lib/ai-key-lend';
import { prisma } from '@/lib/db';
import { encryptApiKey } from '@/lib/encryption';
import { clearVoiceListCache, languageCode, MAX_PREVIEW_BYTES } from '@/lib/voice-voices';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBotMcpServers: jest.fn() }));
jest.mock('@/lib/ai-key-lend', () => ({ lendAccess: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: { bot: { findUnique: jest.fn() }, voiceProvider: { findFirst: jest.fn() } } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const db = prisma as unknown as { bot: { findUnique: jest.Mock }; voiceProvider: { findFirst: jest.Mock } };
const fetchMock = jest.fn();

const SECRET = 'xi-secret-key-123456';
let providers: Row[];
let lends: Row[];

const provider = (changes: Row = {}): Row => ({
  id: 'mouth',
  adapter: 'elevenlabs',
  name: 'ElevenLabs',
  recognition: false,
  speech: true,
  enabled: true,
  endpoint: null,
  apiKeyEncrypted: encryptApiKey(SECRET),
  models: [
    { id: 'eleven_v4', label: 'Eleven v4', kind: 'speech' },
    { id: 'eleven_v3', kind: 'speech' },
  ],
  ownerId: null,
  defaultSpeech: false,
  updatedAt: new Date('2026-11-03T10:00:00Z'),
  ...changes,
});
const key = (changes: Row = {}): Row => provider({ id: 'key-1', ownerId: 'u-maker', ...changes });

const ctx = { params: Promise.resolve({ id: 'bot-1' }) };
const voices = (query = 'part=speech&source=universe-ai') =>
  getVoices(new NextRequest(`http://localhost:3333/api/bots/bot-1/voice/voices?${query}`, { method: 'GET' }), ctx);
const preview = (voiceId: string, source = 'key-1') =>
  getPreview(new NextRequest(`http://localhost:3333/x?source=${source}`, { method: 'GET' }), { params: Promise.resolve({ id: 'bot-1', voiceId }) });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const eleven = (extra: Row = {}) => ({
  voices: [
    { voice_id: 'nora', name: 'Nora', description: 'Relaxed, neutral', labels: { language: 'en' }, preview_url: 'https://storage.example.com/nora.mp3', verified_languages: [{ language: 'en', locale: 'en-US' }, { language: 'ar', locale: 'ar-SA' }] },
    { voice_id: 'sami', name: 'Sami', description: '', labels: { descriptive: 'warm', accent: 'gulf', gender: 'male', age: 'middle_aged', use_case: 'x' }, preview_url: 'http://insecure.example.com/sami.mp3' },
  ],
  has_more: false,
  next_page_token: null,
  ...extra,
});

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  providers = [provider({ defaultSpeech: true })];
  lends = [];
  clearVoiceListCache();
  fetchMock.mockReset().mockImplementation(async () => json(eleven()));
  global.fetch = fetchMock as unknown as typeof fetch;
  db.bot.findUnique.mockReset().mockResolvedValue({ id: 'bot-1', createdById: 'u-maker', room: { world: { universeId: 'uni-1' } } });
  db.voiceProvider.findFirst.mockReset().mockImplementation(async ({ where }: { where: Row }) => {
    const found = providers.find((p) => p.ownerId === where.ownerId && p.enabled === where.enabled && p.speech === where.speech && (where.id === undefined ? p.defaultSpeech === where.defaultSpeech : p.id === where.id));
    if (!found) return null;
    if (!where.lends) return found;
    const lend = lends.find((l) => l.providerId === found.id && l.universeId === where.lends.some.universeId);
    return lend ? { ...found, lends: [{ models: lend.models }] } : null;
  });
  (getSessionUser as jest.Mock).mockReset().mockResolvedValue({ id: 'u-sara', email: 'sara@example.com' });
  (canManageBotMcpServers as jest.Mock).mockReset().mockResolvedValue(true);
  (lendAccess as jest.Mock).mockReset().mockResolvedValue('manage');
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('who may list', () => {
  it('people with Manage bots, nobody else', async () => {
    (canManageBotMcpServers as jest.Mock).mockResolvedValue(false);
    expect((await voices()).status).toBe(403);
    expect((await preview('nora')).status).toBe(403);
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await voices()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only the speaking voices of a source that is named', async () => {
    expect((await voices('part=recognition&source=universe-ai')).status).toBe(400);
    expect((await voices('source=universe-ai')).status).toBe(400);
    expect((await voices('part=speech')).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Universe AI\'s voices', () => {
  it('are the default speaking provider\'s, with a model, a sample that is a public address, and the languages it lists', async () => {
    const response = await voices();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { voiceId: 'nora', name: 'Nora', description: 'Relaxed, neutral', languages: ['en', 'ar'], previewUrl: 'https://storage.example.com/nora.mp3', providerId: 'mouth', model: 'eleven_v4' },
      // No description: what the company labels it with. A sample that isn't https is left out
      { voiceId: 'sami', name: 'Sami', description: 'warm, gulf, male, middle_aged', languages: [], previewUrl: null, providerId: 'mouth', model: 'eleven_v4' },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v2/voices?page_size=100');
    expect(init.headers['xi-api-key']).toBe(SECRET);
    expect(init.redirect).toBe('manual');
  });

  it('read every page the company has, and ask the company once for a while', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('next_page_token=t2') ? json(eleven({ voices: [{ voice_id: 'zed', name: 'Zed' }], has_more: false })) : json(eleven({ has_more: true, next_page_token: 't2' }))
    );
    const list = await (await voices()).json();
    expect(list.map((voice: Row) => voice.voiceId)).toEqual(['nora', 'sami', 'zed']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await voices();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A new key is a new version of the row, so it is listed again
    providers[0].updatedAt = new Date('2026-11-03T11:00:00Z');
    await voices();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('say so when the server has none: no default speaking provider, no key, or no speaking model', async () => {
    providers = [provider()];
    const none = await voices();
    expect(none.status).toBe(409);
    expect((await none.json()).error).toBe('Universe AI has no voice set up on this server.');
    providers = [provider({ defaultSpeech: true, apiKeyEncrypted: null })];
    expect((await voices()).status).toBe(409);
    providers = [provider({ defaultSpeech: true, models: [{ id: 'ears', kind: 'recognition' }] })];
    expect((await (await voices()).json()).error).toBe('ElevenLabs has no speaking model set up here.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('say so when the company is one whose voices can\'t be listed', async () => {
    providers = [provider({ defaultSpeech: true, adapter: 'deepgram', name: 'Deepgram' })];
    const response = await voices();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('Deepgram’s voices can’t be listed here.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a lent key\'s voices', () => {
  beforeEach(() => {
    providers = [provider({ defaultSpeech: true }), key()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
  });

  it('are listed on the key, with the first model the lend allows', async () => {
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: ['speech:eleven_v3'] }];
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list[0]).toMatchObject({ voiceId: 'nora', providerId: 'key-1', model: 'eleven_v3' });
    expect(fetchMock.mock.calls[0][1].headers['xi-api-key']).toBe(SECRET);
  });

  it('are never listed on a key that isn\'t the maker\'s, isn\'t lent here, or whose maker may no longer lend here', async () => {
    const refused = async () => {
      const response = await voices('part=speech&source=key-1');
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe('Voice key not found.');
    };
    providers = [key({ ownerId: 'u-someone-else' })];
    await refused();
    providers = [key()];
    lends = [{ providerId: 'key-1', universeId: 'uni-2', models: null }];
    await refused();
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
    (lendAccess as jest.Mock).mockResolvedValue(null);
    await refused();
    (lendAccess as jest.Mock).mockResolvedValue('owner');
    db.bot.findUnique.mockResolvedValue({ id: 'bot-1', createdById: null, room: { world: { universeId: 'uni-1' } } });
    await refused();
    providers = [key({ speech: false })];
    db.bot.findUnique.mockResolvedValue({ id: 'bot-1', createdById: 'u-maker', room: { world: { universeId: 'uni-1' } } });
    await refused();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('say so when the company turns the key away or can\'t be reached, without the key anywhere in the answer', async () => {
    fetchMock.mockImplementation(async () => json({ detail: SECRET }, 401));
    const rejected = await voices('part=speech&source=key-1');
    expect(rejected.status).toBe(502);
    expect(await rejected.json()).toEqual({ error: 'ElevenLabs didn’t accept the key.' });
    fetchMock.mockRejectedValue(new Error(`connect failed with ${SECRET}`));
    const away = await voices('part=speech&source=key-1');
    expect(away.status).toBe(502);
    expect(JSON.stringify(await away.json())).not.toContain(SECRET);
    fetchMock.mockImplementation(async () => json({ nothing: 'useful' }));
    expect((await voices('part=speech&source=key-1')).status).toBe(502);
    fetchMock.mockImplementation(async () => new Response('<html>', { status: 200 }));
    expect((await voices('part=speech&source=key-1')).status).toBe(502);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining(SECRET));
  });

  it('are cached for each key on its own', async () => {
    await voices('part=speech&source=key-1');
    await voices();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Cartesia\'s voices', () => {
  const cartesia = () => key({ adapter: 'cartesia', name: 'Cartesia', models: [{ id: 'sonic-3', kind: 'speech' }] });
  const page = (extra: Row = {}) => ({
    data: [
      { id: 'c1', name: 'Skylar', tagline: 'Friendly Guide', description: 'Approachable and warm.', language: 'en', accents: [{ locale: 'en-US' }, { locale: 'ar-EG' }], preview_file_url: 'https://api.cartesia.ai/voices/c1/preview.wav' },
      { id: 'c2', name: 'Omar', tagline: 'Calm', description: '', language: 'ar', preview_file_url: 'https://elsewhere.example.com/c2.wav' },
      { id: 'c3', name: 'Lina', tagline: '', description: '', language: 'en', preview_file_url: null },
    ],
    has_more: false,
    next_page: null,
    ...extra,
  });

  beforeEach(() => {
    providers = [cartesia()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
    fetchMock.mockImplementation(async () => json(page()));
  });

  it('are listed with the key and the pinned version, and a sample that needs the key goes through Orbit', async () => {
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list).toEqual([
      { voiceId: 'c1', name: 'Skylar', description: 'Approachable and warm.', languages: ['en', 'ar'], previewUrl: '/api/bots/bot-1/voice/voices/c1/preview?source=key-1', providerId: 'key-1', model: 'sonic-3' },
      // No description: its tagline. A sample at another address is never used (the key would go there)
      { voiceId: 'c2', name: 'Omar', description: 'Calm', languages: ['ar'], previewUrl: null, providerId: 'key-1', model: 'sonic-3' },
      { voiceId: 'c3', name: 'Lina', description: '', languages: ['en'], previewUrl: null, providerId: 'key-1', model: 'sonic-3' },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.cartesia.ai/voices?limit=100&expand%5B%5D=preview_file_url');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${SECRET}`, 'Cartesia-Version': expect.any(String) });
  });

  it('read every page', async () => {
    fetchMock.mockImplementation(async (url: string) => (url.includes('starting_after=c3') ? json({ data: [{ id: 'c4', name: 'Zed', language: 'en' }], has_more: false }) : json(page({ has_more: true, next_page: 'c3' }))));
    expect((await (await voices('part=speech&source=key-1')).json()).map((voice: Row) => voice.voiceId)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('give the sample, fetched with the key from the address the company named, and nowhere else', async () => {
    await voices('part=speech&source=key-1');
    fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/wav' } }));
    const response = await preview('c1');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.cartesia.ai/voices/c1/preview.wav');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    // No sample, an address it must not use, and a voice that isn't in the list
    expect((await preview('c2')).status).toBe(404);
    expect((await preview('c3')).status).toBe(404);
    expect((await preview('nobody')).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('say so when the sample is not audio, too big, empty, or the company can\'t be reached', async () => {
    await voices('part=speech&source=key-1');
    fetchMock.mockImplementation(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect((await preview('c1')).status).toBe(502);
    fetchMock.mockImplementation(async () => new Response(new Uint8Array(MAX_PREVIEW_BYTES + 1), { status: 200, headers: { 'content-type': 'audio/wav' } }));
    expect((await preview('c1')).status).toBe(502);
    fetchMock.mockImplementation(async () => new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'audio/wav' } }));
    expect((await preview('c1')).status).toBe(502);
    fetchMock.mockRejectedValue(new Error('down'));
    expect((await preview('c1')).status).toBe(502);
  });

  it('are not sampled on a key that isn\'t the maker\'s', async () => {
    await voices('part=speech&source=key-1');
    lends = [];
    expect((await preview('c1')).status).toBe(404);
    expect((await getPreview(new NextRequest('http://localhost:3333/x', { method: 'GET' }), { params: Promise.resolve({ id: 'bot-1', voiceId: 'c1' }) })).status).toBe(400);
  });
});

describe('languageCode', () => {
  it('keeps the language of a code and drops anything that isn\'t one', () => {
    expect([languageCode('en-GB'), languageCode('AR_kw'), languageCode('ara'), languageCode('English'), languageCode(''), languageCode(7)]).toEqual(['en', 'ar', 'ara', null, null, null]);
  });
});
