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
import { clearVoiceListCache, languageCode, MAX_PREVIEW_BYTES, MAX_VOICES } from '@/lib/voice-voices';

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

  it('send on no more than 1,000 voices, however many a company puts in a page', async () => {
    const many = Array.from({ length: 1200 }, (_, index) => ({ voice_id: `v${index}`, name: `Voice ${index}` }));
    fetchMock.mockImplementation(async () => json(eleven({ voices: many, has_more: false })));
    const list = await (await voices()).json();
    expect(list).toHaveLength(MAX_VOICES);
    expect(list[MAX_VOICES - 1].voiceId).toBe(`v${MAX_VOICES - 1}`);
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
    providers = [provider({ defaultSpeech: true, adapter: 'soniox', name: 'Soniox' })];
    const response = await voices();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('Soniox’s voices can’t be listed here.');
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

  it('lets go of the answer\'s body when the company turns the key away or fails', async () => {
    for (const status of [401, 403, 500]) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      });
      fetchMock.mockImplementation(async () => new Response(body, { status }));
      expect((await voices('part=speech&source=key-1')).status).toBe(502);
      expect(cancelled).toBe(true);
    }
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

  it('stops reading a sample that goes past the cap when the company sent no length, and cancels the rest', async () => {
    await voices('part=speech&source=key-1');
    const chunk = new Uint8Array(MAX_PREVIEW_BYTES / 4 + 1);
    let pulled = 0;
    let cancelled = false;
    // Endless: only a reader that gives up at the cap ever finishes
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockImplementation(async () => new Response(body, { status: 200, headers: { 'content-type': 'audio/wav' } }));
    expect((await preview('c1')).status).toBe(502);
    expect(cancelled).toBe(true);
    // Four chunks go past the cap; the stream's own look-ahead may have asked for one more
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it('are not sampled on a key that isn\'t the maker\'s', async () => {
    await voices('part=speech&source=key-1');
    lends = [];
    expect((await preview('c1')).status).toBe(404);
    expect((await getPreview(new NextRequest('http://localhost:3333/x', { method: 'GET' }), { params: Promise.resolve({ id: 'bot-1', voiceId: 'c1' }) })).status).toBe(400);
  });
});

describe('Deepgram\'s voices', () => {
  const deepgram = () => key({ adapter: 'deepgram', name: 'Deepgram', models: [{ id: 'aura-2', label: 'Aura 2', kind: 'speech' }] });
  const answer = {
    stt: [{ name: 'general', canonical_name: 'nova-3-general' }],
    tts: [
      { name: 'thalia', canonical_name: 'aura-2-thalia-en', architecture: 'aura-2', languages: ['en', 'en-US'], metadata: { accent: 'American', age: 'Adult', tags: ['clear', 'confident'], sample: 'https://static.deepgram.com/samples/thalia.wav' } },
      { name: 'celeste', canonical_name: 'aura-2-celeste-es', architecture: 'aura-2', languages: ['es'], metadata: { sample: 'http://insecure.example.com/celeste.wav' } },
    ],
  };

  beforeEach(() => {
    providers = [deepgram()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
    fetchMock.mockImplementation(async () => json(answer));
  });

  it('are every speaking voice in one answer, each its own model, with a public sample, the key as a token', async () => {
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list).toEqual([
      { voiceId: 'aura-2-thalia-en', name: 'thalia', description: 'American, Adult, clear, confident', languages: ['en'], previewUrl: 'https://static.deepgram.com/samples/thalia.wav', providerId: 'key-1', model: 'aura-2' },
      { voiceId: 'aura-2-celeste-es', name: 'celeste', description: '', languages: ['es'], previewUrl: null, providerId: 'key-1', model: 'aura-2' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.deepgram.com/v1/models');
    expect(init.headers).toMatchObject({ Authorization: `Token ${SECRET}` });
  });
});

describe('Fish Audio\'s voices', () => {
  const fish = () => key({ adapter: 'fish', name: 'Fish Audio', models: [{ id: 's2.1-pro-free', label: 'S2.1 Pro (free)', kind: 'speech' }, { id: 's2.1-pro', kind: 'speech' }] });
  const voice = (id: string, extra: Row = {}) => ({ _id: id, type: 'tts', state: 'trained', title: `Voice ${id}`, description: '', languages: ['en'], samples: [{ audio: `https://public.fish.example/${id}.mp3` }], ...extra });
  const own = { items: [voice('f1', { title: 'Mine', description: 'My own voice', languages: ['ar-KW', 'en'] })], total: 1, has_more: false };
  const library = {
    items: [
      voice('f2'),
      // A voice that is not for speaking, one still training, a copy of an own voice, one with an unsafe sample, one with none
      voice('f3', { type: 'svc' }),
      voice('f4', { state: 'training' }),
      voice('f1'),
      voice('f5', { samples: [{ audio: 'http://insecure.example.com/f5.mp3' }] }),
      voice('f6', { samples: [] }),
    ],
    total: 6,
    has_more: false,
  };

  beforeEach(() => {
    providers = [fish()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
    fetchMock.mockImplementation(async (url: string) => json(url.includes('self=true') ? own : library));
  });

  it('are the person\'s own first, then the public library, with the key as a bearer and the first model the key lists', async () => {
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list).toEqual([
      { voiceId: 'f1', name: 'Mine', description: 'My own voice', languages: ['ar', 'en'], previewUrl: 'https://public.fish.example/f1.mp3', providerId: 'key-1', model: 's2.1-pro-free' },
      { voiceId: 'f2', name: 'Voice f2', description: '', languages: ['en'], previewUrl: 'https://public.fish.example/f2.mp3', providerId: 'key-1', model: 's2.1-pro-free' },
      { voiceId: 'f5', name: 'Voice f5', description: '', languages: ['en'], previewUrl: null, providerId: 'key-1', model: 's2.1-pro-free' },
      { voiceId: 'f6', name: 'Voice f6', description: '', languages: ['en'], previewUrl: null, providerId: 'key-1', model: 's2.1-pro-free' },
    ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.fish.audio/model?page_size=100&page_number=1&sort_by=score&self=true',
      'https://api.fish.audio/model?page_size=100&page_number=1&sort_by=score&self=false',
    ]);
    for (const [, init] of fetchMock.mock.calls) expect(init.headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
  });

  it('read more pages while the company says there are more, and stop at the cap', async () => {
    const full = (start: number) => ({ items: Array.from({ length: 100 }, (_, index) => voice(`p${start + index}`)), has_more: true });
    fetchMock.mockImplementation(async (url: string) => (url.includes('self=true') ? json({ items: [], has_more: false }) : json(full(Number(new URL(url).searchParams.get('page_number')) * 1000))));
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list).toHaveLength(MAX_VOICES);
    // Own voices (1 call), then ten pages of the library: never more than the cap
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it('read a full page without a "has more" as a sign of another, and a short one as the end', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('self=true')) return json({ items: [] });
      return json(url.includes('page_number=1&') ? { items: Array.from({ length: 100 }, (_, index) => voice(`a${index}`)) } : { items: [voice('z1')] });
    });
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('hand the sample over as the company\'s public address, never through Orbit with the key', async () => {
    const [first] = await (await voices('part=speech&source=key-1')).json();
    expect(first.previewUrl).toBe('https://public.fish.example/f1.mp3');
    expect(first.previewUrl).not.toContain('/api/bots/');
  });

  it('say Fish Audio did not accept the key, or could not be reached', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 401 }));
    const refused = await voices('part=speech&source=key-1');
    expect(refused.status).toBe(502);
    expect((await refused.json()).error).toBe('Fish Audio didn’t accept the key.');
    clearVoiceListCache();
    fetchMock.mockRejectedValue(new Error('down'));
    expect((await voices('part=speech&source=key-1')).status).toBe(502);
  });

  it('say so when the list is not one', async () => {
    fetchMock.mockImplementation(async () => json({ items: 'nope' }));
    expect((await voices('part=speech&source=key-1')).status).toBe(502);
  });
});

describe('Async\'s voices', () => {
  const asyncKey = () => key({ adapter: 'async', name: 'Async', models: [{ id: 'async_flash_v1.0', label: 'Flash v1.0', kind: 'speech' }] });
  const answer = {
    voices: [
      { voice_id: 'a1', name: 'Layla', description: 'Calm and clear', language: 'ar', gender: 'female', voice_type: 'library' },
      { voice_id: 'a2', name: 'Theo', description: '', language: 'en', gender: 'male', voice_type: 'library' },
    ],
    next_cursor: null,
  };

  beforeEach(() => {
    providers = [asyncKey()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
    fetchMock.mockImplementation(async () => json(answer));
  });

  it('are asked for with a POST that carries the page size, the key and the API version', async () => {
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list.map((voice: Row) => [voice.voiceId, voice.name, voice.languages, voice.model])).toEqual([
      ['a1', 'Layla', ['ar'], 'async_flash_v1.0'],
      ['a2', 'Theo', ['en'], 'async_flash_v1.0'],
    ]);
    expect(list[0].description).toContain('Calm and clear');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.async.com/voices');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ limit: 100 });
    expect(init.headers).toMatchObject({ 'x-api-key': SECRET, version: 'v1', 'Content-Type': 'application/json' });
  });

  it('say Async did not accept the key', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 401 }));
    const refused = await voices('part=speech&source=key-1');
    expect(refused.status).toBe(502);
    expect((await refused.json()).error).toBe('Async didn’t accept the key.');
  });
});

describe('Bland\'s voices', () => {
  const bland = () => key({ adapter: 'bland', name: 'Bland', models: [{ id: 'btts-3', label: 'Bland TTS v3', kind: 'speech' }] });
  const answer = {
    voices: [
      { id: 'b1', name: 'Karen', description: 'Mature, calm', public: true, tags: ['english', 'support'], service: 'BTTS_V3' },
      { id: 'b2', name: 'My clone', description: null, public: false, tags: ['arabic'], service: 'BTTS_V3' },
    ],
  };

  beforeEach(() => {
    providers = [bland()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
    fetchMock.mockImplementation(async () => json(answer));
  });

  it('are every voice in one answer, with the key as a bearer', async () => {
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list.map((voice: Row) => [voice.voiceId, voice.name, voice.description, voice.model])).toEqual([
      ['b1', 'Karen', 'Mature, calm', 'btts-3'],
      ['b2', 'My clone', 'arabic', 'btts-3'],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.bland.ai/v1/voices');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
  });
});

describe('CAMB.AI\'s voices', () => {
  const camb = () => key({ adapter: 'camb', name: 'CAMB.AI', models: [{ id: 'mars-flash', label: 'MARS Flash', kind: 'speech' }] });
  const answer = [
    { id: 147320, voice_name: 'Noor', gender: 2, age: 30, language: 1, description: 'Warm Gulf voice' },
    { id: 9, voice_name: 'Sam', description: null },
  ];

  beforeEach(() => {
    providers = [camb()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
    fetchMock.mockImplementation(async () => json(answer));
  });

  it('are the answer itself, each id a whole number kept as its digits, with the key in x-api-key', async () => {
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list.map((voice: Row) => [voice.voiceId, voice.name, voice.description, voice.model])).toEqual([
      ['147320', 'Noor', 'Warm Gulf voice', 'mars-flash'],
      ['9', 'Sam', '', 'mars-flash'],
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://client.camb.ai/apis/list-voices');
    expect(init.headers).toMatchObject({ 'x-api-key': SECRET });
  });

  it('say so when a voice has an id that is not a whole number, or the answer is not a list', async () => {
    fetchMock.mockImplementation(async () => json([{ id: 1.5, voice_name: 'Odd' }]));
    expect((await voices('part=speech&source=key-1')).status).toBe(502);
    clearVoiceListCache();
    fetchMock.mockImplementation(async () => json({ voices: [] }));
    expect((await voices('part=speech&source=key-1')).status).toBe(502);
  });
});

describe('Gradium\'s voices', () => {
  const gradium = () => key({ adapter: 'gradium', name: 'Gradium', models: [{ id: 'default', label: 'Gradium TTS (current)', kind: 'speech' }] });
  const answer = [
    { uid: 'own-1', name: 'My voice', description: null, is_catalog: false, language: 'fr', tags: [] },
    { uid: '_6Aslh2DxfmnRLmP', name: 'Emma', description: 'Warm and clear', is_catalog: true, language: 'en', tags: [{ category: 'use_case', value: 'Narration' }] },
  ];

  beforeEach(() => {
    providers = [gradium()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
    fetchMock.mockImplementation(async () => json(answer));
  });

  it('are the account\'s own and Gradium\'s catalog in one answer, with the key in x-api-key', async () => {
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list.map((voice: Row) => [voice.voiceId, voice.name, voice.description, voice.languages])).toEqual([
      ['own-1', 'My voice', '', ['fr']],
      ['_6Aslh2DxfmnRLmP', 'Emma', 'Warm and clear', ['en']],
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.gradium.ai/api/voices/?include_catalog=true&limit=1000');
    expect(init.headers).toMatchObject({ 'x-api-key': SECRET });
  });
});

describe('Mistral\'s voices', () => {
  const mistral = () => key({ adapter: 'mistral', name: 'Mistral', models: [{ id: 'voxtral-mini-tts-2603', label: 'Voxtral Mini TTS', kind: 'speech' }] });
  const pages = [
    { data: [{ id: 'v-1', name: 'Paul', description: 'Calm narrator', gender: 'male', tags: ['narration'], languages: ['en', 'fr'], type: 'preset' }], next_page_token: 'page-2' },
    { data: [{ id: 'v-2', name: 'My voice', description: null, gender: 'female', tags: ['custom'], languages: ['ar'], type: 'custom' }], next_page_token: null },
  ];

  beforeEach(() => {
    providers = [mistral()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
    let page = 0;
    fetchMock.mockImplementation(async () => json(pages[page++]));
  });

  it('are read page after page while Mistral gives a token, with the key as a bearer', async () => {
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list.map((voice: Row) => [voice.voiceId, voice.name, voice.description, voice.languages])).toEqual([
      ['v-1', 'Paul', 'Calm narrator', ['en', 'fr']],
      ['v-2', 'My voice', 'female, custom', ['ar']],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, init] = fetchMock.mock.calls[0];
    expect(first).toBe('https://api.mistral.ai/v2/audio/voices?page_size=100');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.mistral.ai/v2/audio/voices?page_size=100&page_token=page-2');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
  });
});

describe('Neuphonic\'s voices', () => {
  const neuphonic = () => key({ adapter: 'neuphonic', name: 'Neuphonic', models: [{ id: 'neuphonic', label: 'Neuphonic TTS', kind: 'speech' }] });

  beforeEach(() => {
    providers = [neuphonic()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
    fetchMock.mockImplementation(async () =>
      json({
        data: {
          voices: [
            { id: 'v-1', voice_id: 'v-1', name: 'Holly', tags: ['Female', 'British'], lang_code: 'en', type: 'Standard' },
            { id: 'v-2', voice_id: 'v-2', name: 'Amira', tags: null, lang_code: 'ar', type: 'Cloned' },
          ],
        },
      })
    );
  });

  it('come in one answer inside its data, each with its language, the key in its own header', async () => {
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list.map((voice: Row) => [voice.voiceId, voice.name, voice.description, voice.languages, voice.model])).toEqual([
      ['v-1', 'Holly', 'Female, British', ['en'], 'neuphonic'],
      ['v-2', 'Amira', '', ['ar'], 'neuphonic'],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.neuphonic.com/voices');
    expect(init.headers).toMatchObject({ 'X-API-KEY': SECRET });
  });
});

describe('Resemble\'s voices', () => {
  const resemble = () => key({ adapter: 'resemble', name: 'Resemble', models: [{ id: 'resemble', label: 'Resemble TTS', kind: 'speech' }] });
  const full = Array.from({ length: 100 }, (_, i) => ({ uuid: `v-${i}`, name: `Voice ${i}`, default_language: 'en-US', supported_languages: ['en-US'] }));

  beforeEach(() => {
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
    let page = 0;
    fetchMock.mockImplementation(async () => json(page++ === 0 ? { success: true, page: 1, num_pages: 2, items: full } : { success: true, page: 2, num_pages: 2, items: [{ uuid: 'v-ar', name: 'Noor', default_language: 'ar-SA', supported_languages: ['ar-SA', 'en-US'] }] }));
  });

  it('are read at app.resemble.ai page after page while a page is full, with the key as a bearer, not where it speaks', async () => {
    providers = [resemble()];
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list).toHaveLength(101);
    expect(list[100]).toMatchObject({ voiceId: 'v-ar', name: 'Noor', languages: ['ar', 'en'], model: 'resemble' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://app.resemble.ai/api/v2/voices?page=1&page_size=100', 'https://app.resemble.ai/api/v2/voices?page=2&page_size=100']);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
  });
});

describe('Groq\'s voices', () => {
  const ENGLISH = { id: 'canopylabs/orpheus-v1-english', label: 'Orpheus English', kind: 'speech' };
  const ARABIC = { id: 'canopylabs/orpheus-arabic-saudi', label: 'Orpheus Arabic (Saudi)', kind: 'speech' };
  const groq = (models = [ENGLISH, ARABIC]) => key({ adapter: 'groq', name: 'Groq', models });

  beforeEach(() => {
    providers = [groq()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
  });

  it('are the ones its docs name, each with its language and its own model, and nothing is asked with the key', async () => {
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list).toHaveLength(12);
    expect(list[0]).toEqual({ voiceId: 'autumn', name: 'Autumn', description: 'Orpheus English', languages: ['en'], previewUrl: null, providerId: 'key-1', model: 'canopylabs/orpheus-v1-english' });
    expect(list.find((voice: Row) => voice.voiceId === 'noura')).toMatchObject({ name: 'Noura', languages: ['ar'], model: 'canopylabs/orpheus-arabic-saudi' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('are only the voices of the models set up on the key and allowed in the universe', async () => {
    providers = [groq([ARABIC])];
    const arabicOnly = await (await voices('part=speech&source=key-1')).json();
    expect(arabicOnly.map((voice: Row) => voice.voiceId)).toEqual(['abdullah', 'fahad', 'sultan', 'lulwa', 'noura', 'aisha']);

    providers = [groq()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: ['speech:canopylabs/orpheus-v1-english'] }];
    const lentEnglish = await (await voices('part=speech&source=key-1')).json();
    expect(lentEnglish.map((voice: Row) => voice.model)).toEqual(Array(6).fill('canopylabs/orpheus-v1-english'));
  });
});

describe('Hume\'s voices', () => {
  const hume = () => key({ adapter: 'hume', name: 'Hume', models: [{ id: 'octave-2', label: 'Octave 2', kind: 'speech' }] });
  const voice = (id: string, provider: string) => ({ id, name: `Voice ${id}`, provider, compatible_octave_models: ['2'] });

  beforeEach(() => {
    providers = [hume()];
    lends = [{ providerId: 'key-1', universeId: 'uni-1', models: null }];
  });

  it('are the account\'s own, then Hume\'s library, counting pages from 0, with the key in X-Hume-Api-Key', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('CUSTOM_VOICE')) return json({ page_number: 0, page_size: 100, total_pages: 1, voices_page: [voice('mine', 'CUSTOM_VOICE')] });
      const page = Number(new URL(url).searchParams.get('page_number'));
      return json({ page_number: page, page_size: 100, total_pages: 2, voices_page: page === 0 ? Array.from({ length: 100 }, (_, i) => voice(`lib${i}`, 'HUME_AI')) : [voice('last', 'HUME_AI')] });
    });
    const list = await (await voices('part=speech&source=key-1')).json();
    expect(list).toHaveLength(102);
    expect(list[0]).toMatchObject({ voiceId: 'mine', name: 'Voice mine', model: 'octave-2' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.hume.ai/v0/tts/voices?page_size=100&page_number=0&provider=CUSTOM_VOICE',
      'https://api.hume.ai/v0/tts/voices?page_size=100&page_number=0&provider=HUME_AI',
      'https://api.hume.ai/v0/tts/voices?page_size=100&page_number=1&provider=HUME_AI',
    ]);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'X-Hume-Api-Key': SECRET });
  });
});

describe('languageCode', () => {
  it('keeps the language of a code and drops anything that isn\'t one', () => {
    expect([languageCode('en-GB'), languageCode('AR_kw'), languageCode('ara'), languageCode('English'), languageCode(''), languageCode(7)]).toEqual(['en', 'ar', 'ara', null, null, null]);
  });
});
