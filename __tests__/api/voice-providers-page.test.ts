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
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/user');
    expect(init.method).toBe('GET');
    expect(init.headers['xi-api-key']).toBe(SECRET);
    expect(init.redirect).toBe('manual');
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
    db.findFirst.mockResolvedValue(row({ adapter: 'deepgram', name: 'Deepgram', speech: true }));
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
