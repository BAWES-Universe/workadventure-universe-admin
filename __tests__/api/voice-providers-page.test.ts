/**
 * What the Universe AI voice page (#792) needs from the server: a free key check for Universe's own keys, the voices of any server
 * speaking provider (not only the default), and a sample for a company that keeps samples behind its key. The voice companies are
 * stood in for by a fake `fetch`, so nothing real is called.
 */
import { NextRequest } from 'next/server';
import { POST as checkPasted } from '@/app/api/admin/voice-providers/check/route';
import { POST as checkSaved } from '@/app/api/admin/voice-providers/[id]/check/route';
import { GET as listVoices } from '@/app/api/admin/voice-providers/[id]/voices/route';
import { GET as getSample } from '@/app/api/admin/voice-providers/[id]/voices/[voiceId]/preview/route';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { prisma } from '@/lib/db';
import { encryptApiKey } from '@/lib/encryption';
import { clearVoiceListCache } from '@/lib/voice-voices';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('@/lib/ai-key-models', () => ({ ...jest.requireActual('@/lib/ai-key-models'), allowKeyAttempt: jest.fn(() => true) }));
jest.mock('@/lib/db', () => ({ prisma: { voiceProvider: { findUnique: jest.fn(), findFirst: jest.fn() } } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const db = (prisma as unknown as { voiceProvider: { findUnique: jest.Mock; findFirst: jest.Mock } }).voiceProvider;
const fetchMock = jest.fn();
const SECRET = 'xi-secret-key-123456';

const row = (changes: Row = {}): Row => ({
  id: 'mouth',
  adapter: 'elevenlabs',
  name: 'ElevenLabs',
  recognition: false,
  speech: true,
  enabled: true,
  endpoint: null,
  apiKeyEncrypted: encryptApiKey(SECRET),
  models: [{ id: 'eleven_v4', kind: 'speech' }],
  ownerId: null,
  defaultSpeech: false,
  updatedAt: new Date('2026-11-03T10:00:00Z'),
  ...changes,
});

const post = (route: typeof checkPasted, body: unknown) => route(new NextRequest('http://localhost:3333/api/x', { method: 'POST', body: JSON.stringify(body) }));
const ctx = (id = 'mouth', voiceId = 'nora') => ({ params: Promise.resolve({ id, voiceId }) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const eleven = { voices: [{ voice_id: 'nora', name: 'Nora', description: 'Relaxed', preview_url: 'https://storage.example.com/nora.mp3', verified_languages: [{ language: 'en' }] }], has_more: false };

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  clearVoiceListCache();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  (getSessionUser as jest.Mock).mockReset().mockResolvedValue({ id: 'u-root', email: 'root@example.com' });
  (isSuperAdmin as jest.Mock).mockReset().mockImplementation((email?: string | null) => email === 'root@example.com');
  db.findUnique.mockReset().mockResolvedValue(row());
  db.findFirst.mockReset().mockImplementation(async ({ where }: { where: Row }) => (where.id === 'mouth' && where.ownerId === null && where.speech === true ? row() : null));
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('super admins only', () => {
  it('turns anyone else away before any company is asked', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue({ id: 'u1', email: 'someone@example.com' });
    for (const response of [
      await post(checkPasted, { adapter: 'elevenlabs', apiKey: SECRET }),
      await checkSaved(new NextRequest('http://localhost:3333/api/x', { method: 'POST' }), ctx()),
      await listVoices(new NextRequest('http://localhost:3333/api/x'), ctx()),
      await getSample(new NextRequest('http://localhost:3333/api/x'), ctx()),
    ]) {
      expect(response.status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Check key', () => {
  it('asks the company\'s own address with the pasted key, one free call, and says it knows the key', async () => {
    fetchMock.mockResolvedValue(json({}));
    const response = await post(checkPasted, { adapter: 'elevenlabs', apiKey: SECRET });
    expect(response.status).toBe(200);
    // The list that followed wasn't one, so the models are typed
    expect(await response.json()).toEqual({ ok: true, models: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/user');
    expect(init.method).toBe('GET');
    expect(init.headers['xi-api-key']).toBe(SECRET);
    expect(init.redirect).toBe('manual');
  });

  it('then reads the company\'s own list of models, kept to the ones Universe runs for its job (#840)', async () => {
    const lists: Record<string, unknown> = {
      'https://api.elevenlabs.io/v1/models': [
        { model_id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5', can_do_text_to_speech: true, description: 'Fast,   low latency.', languages: [{ language_id: 'en', name: 'English' }, { language_id: 'ar', name: 'Arabic' }] },
        { model_id: 'eleven_english_sts_v2', name: 'Eleven English v2', can_do_text_to_speech: false },
        { model_id: 'eleven_v3', name: 'Eleven v3', can_do_text_to_speech: true },
      ],
      'https://api.soniox.com/v1/models': {
        models: [
          { id: 'stt-rt-v4', name: 'Speech-to-Text Real-time v4', transcription_mode: 'real_time', aliased_model_id: null, languages: [{ code: 'en', name: 'English' }] },
          { id: 'stt-rt-preview', name: 'Speech-to-Text Real-time Preview', transcription_mode: 'real_time', aliased_model_id: 'stt-rt-v4', languages: [{ code: 'en' }, { code: 'ar' }, { code: 'de' }] },
          { id: 'stt-async-v4', name: 'Speech-to-Text Async v4', transcription_mode: 'async' },
        ],
      },
      'https://api.deepgram.com/v1/models': {
        stt: [
          { name: 'general', canonical_name: 'nova-3-general', streaming: true, languages: ['en', 'en-US'] },
          { name: 'general', canonical_name: 'nova-3-general', streaming: true, languages: ['es', 'en'] },
          { name: 'whisper', canonical_name: 'whisper-large', streaming: false },
        ],
        tts: [{ name: 'asteria', canonical_name: 'aura-asteria-en' }],
      },
      'https://api.cartesia.ai/models?capability=tts': { data: [{ id: 'sonic-3', capability: 'tts' }, { id: 'ink-whisper', capability: 'stt' }] },
      'https://api.cartesia.ai/models?capability=stt': { data: [{ id: 'ink-whisper', capability: 'stt', modes: ['stream'] }, { id: 'sonic-3', capability: 'tts' }] },
    };
    fetchMock.mockImplementation(async (url: string) => json(lists[url] ?? {}));
    const models = async (adapter: string, job?: string) => (await (await post(checkPasted, { adapter, apiKey: SECRET, job })).json()).models;
    // Each with a line from what the company says about it, to help choose: its languages and its own description
    expect(await models('elevenlabs', 'speech')).toEqual([
      { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5', kind: 'speech', note: '2 languages · Fast, low latency.' },
      { id: 'eleven_v3', label: 'Eleven v3', kind: 'speech' },
    ]);
    expect(await models('soniox')).toEqual([
      { id: 'stt-rt-v4', label: 'Speech-to-Text Real-time v4', kind: 'recognition', note: '1 language (en)' },
      { id: 'stt-rt-preview', label: 'Speech-to-Text Real-time Preview', kind: 'recognition', note: 'Always the same as stt-rt-v4 · 3 languages' },
    ]);
    // Listed once per language: one model, its languages added up
    expect(await models('deepgram')).toEqual([{ id: 'nova-3-general', kind: 'recognition', note: '3 languages' }]);
    // ElevenLabs lists no listening models: those are typed
    expect(await models('elevenlabs', 'recognition')).toBeNull();
    // A company that listens and speaks lists each job's models from that job's own list (#844); its first job when none is named
    expect(await models('cartesia', 'speech')).toEqual([{ id: 'sonic-3', kind: 'speech' }]);
    expect(await models('cartesia', 'recognition')).toEqual([{ id: 'ink-whisper', kind: 'recognition' }]);
    expect(await models('cartesia')).toEqual([{ id: 'ink-whisper', kind: 'recognition' }]);
    // The list goes with the same key header as the check, to the company's own address, and is never followed elsewhere
    const listCall = fetchMock.mock.calls.find(([url]) => url === 'https://api.cartesia.ai/models?capability=tts')!;
    expect(listCall[1].headers).toMatchObject({ Authorization: `Bearer ${SECRET}`, 'Cartesia-Version': '2026-08-14' });
    expect(listCall[1].redirect).toBe('manual');
  });

  it('leaves the models to be typed for a company with no list, or a list that can\'t be read', async () => {
    fetchMock.mockResolvedValue(json({}));
    // Fish Audio has no list of its models: only the check is made
    expect(await (await post(checkPasted, { adapter: 'fish', apiKey: SECRET })).json()).toEqual({ ok: true, models: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset().mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ error: 'nope' }, 403));
    expect(await (await post(checkPasted, { adapter: 'deepgram', apiKey: SECRET })).json()).toEqual({ ok: true, models: null });
    fetchMock.mockReset().mockResolvedValueOnce(json({})).mockRejectedValueOnce(new Error(`timeout ${SECRET}`));
    const failed = await post(checkPasted, { adapter: 'soniox', apiKey: SECRET });
    expect(failed.status).toBe(200);
    expect(JSON.stringify(await failed.json())).not.toContain(SECRET);
  });

  it('says what happened when the company turns the key away, can\'t be reached, or the key isn\'t usable', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401));
    const refused = await post(checkPasted, { adapter: 'cartesia', apiKey: SECRET });
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toBe('Cartesia turned this key away. Check that you copied all of it.');
    fetchMock.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${SECRET}`));
    const down = await post(checkPasted, { adapter: 'soniox', apiKey: SECRET });
    expect(down.status).toBe(502);
    expect(JSON.stringify(await down.json())).not.toContain(SECRET);
    expect((await post(checkPasted, { adapter: 'nobody', apiKey: SECRET })).status).toBe(400);
    expect((await post(checkPasted, { adapter: 'soniox', apiKey: '  ' })).status).toBe(400);
    expect((await post(checkPasted, { adapter: 'soniox', apiKey: 'has a space inside' })).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('checks the key a saved provider holds, and says when there is none or the provider is somebody\'s own key', async () => {
    fetchMock.mockResolvedValue(json({}));
    const saved = await checkSaved(new NextRequest('http://localhost:3333/api/x', { method: 'POST' }), ctx());
    expect(saved.status).toBe(200);
    expect(fetchMock.mock.calls[0][1].headers['xi-api-key']).toBe(SECRET);
    db.findUnique.mockResolvedValue(row({ apiKeyEncrypted: null }));
    expect((await checkSaved(new NextRequest('http://localhost:3333/api/x', { method: 'POST' }), ctx())).status).toBe(409);
    db.findUnique.mockResolvedValue(row({ ownerId: 'u-maker' }));
    expect((await checkSaved(new NextRequest('http://localhost:3333/api/x', { method: 'POST' }), ctx())).status).toBe(404);
    // A provider with its own address: the company's address can't vouch for its key, so it isn't asked
    db.findUnique.mockResolvedValue(row({ endpoint: 'https://eleven.example.com' }));
    const own = await checkSaved(new NextRequest('http://localhost:3333/api/x', { method: 'POST' }), ctx());
    expect(own.status).toBe(409);
    expect((await own.json()).error).toBe('This provider uses its own address, so the company can\u2019t check its key.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the voices of a server provider', () => {
  it('are listed for any speaking provider, default or not, free from the company', async () => {
    fetchMock.mockResolvedValue(json(eleven));
    const response = await listVoices(new NextRequest('http://localhost:3333/api/x'), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ voices: [{ voiceId: 'nora', name: 'Nora', description: 'Relaxed', languages: ['en'], previewUrl: 'https://storage.example.com/nora.mp3' }] });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.elevenlabs.io/v2/voices?page_size=100');
  });

  it('are not listed for a provider that isn\'t there, doesn\'t speak, or is somebody\'s own key', async () => {
    expect((await listVoices(new NextRequest('http://localhost:3333/api/x'), ctx('other'))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('say so when the company can\'t list voices here, or didn\'t answer', async () => {
    db.findFirst.mockResolvedValue(row({ adapter: 'soniox', name: 'Soniox', speech: true }));
    const none = await listVoices(new NextRequest('http://localhost:3333/api/x'), ctx());
    expect(none.status).toBe(409);
    db.findFirst.mockResolvedValue(row());
    fetchMock.mockResolvedValue(json({}, 401));
    const refused = await listVoices(new NextRequest('http://localhost:3333/api/x'), ctx());
    expect(refused.status).toBe(502);
    expect(JSON.stringify(await refused.json())).not.toContain(SECRET);
  });

  it('give a sample for a company that keeps it behind the key, fetched from the address the list named', async () => {
    db.findFirst.mockResolvedValue(row({ adapter: 'cartesia', name: 'Cartesia' }));
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/preview.wav')
        ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/wav' } })
        : json({ data: [{ id: 'nora', name: 'Nora', preview_file_url: 'https://api.cartesia.ai/voices/nora/preview.wav' }], has_more: false })
    );
    const list = await (await listVoices(new NextRequest('http://localhost:3333/api/x'), ctx())).json();
    expect(list.voices[0].previewUrl).toBe('/api/admin/voice-providers/mouth/voices/nora/preview');
    const sample = await getSample(new NextRequest('http://localhost:3333/api/x'), ctx());
    expect(sample.status).toBe(200);
    expect(sample.headers.get('content-type')).toBe('audio/wav');
    expect(new Uint8Array(await sample.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await getSample(new NextRequest('http://localhost:3333/api/x'), ctx('mouth', 'unknown'))).status).toBe(404);
  });
});
