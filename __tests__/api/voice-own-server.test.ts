/**
 * A speech server on a person's own computer (game #1874): "Load models" reads the server's own list, never guesses what a model does
 * from its name, refuses a private address, and a key is optional. The server is a stand-in: no real call is made.
 */
import { NextRequest } from 'next/server';
import { POST as check } from '@/app/api/me/voice-keys/check/route';
import { POST as create } from '@/app/api/me/voice-keys/route';
import { PATCH as patch } from '@/app/api/me/voice-keys/[id]/route';
import { GET as credentials } from '@/app/api/voice/providers/[id]/credentials/route';
import { getSessionUser } from '@/lib/auth-session';
import { lendAccess } from '@/lib/ai-key-lend';
import { AddressError, checkPublicHttpsUrl, safeGet } from '@/lib/ai-key-fetch';
import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';
import { effectiveBotVoice, ownServerLentToBot } from '@/lib/bot-voice';
import { clearVoiceListCache, listBotVoices } from '@/lib/voice-voices';
import { describeVoice } from '@/app/admin/you/ai-keys/voice-key-text';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/bot-voice', () => ({ effectiveBotVoice: jest.fn(), ownServerLentToBot: jest.fn() }));
jest.mock('@/lib/ai-key-lend', () => ({ ...jest.requireActual('@/lib/ai-key-lend'), lendAccess: jest.fn() }));
jest.mock('@/lib/ai-key-fetch', () => ({ ...jest.requireActual('@/lib/ai-key-fetch'), checkPublicHttpsUrl: jest.fn(), safeGet: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    $transaction: jest.fn(),
    voiceProvider: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    voiceKeyLend: { findMany: jest.fn(), update: jest.fn(), delete: jest.fn() },
    voiceKeyUsage: { findMany: jest.fn() },
    appSetting: { findUnique: jest.fn() },
    bot: { findMany: jest.fn(), findUnique: jest.fn() },
    botVoiceRevision: { findMany: jest.fn() },
  },
}));

type Mocks = Record<string, jest.Mock>;
const db = prisma as unknown as { $transaction: jest.Mock; voiceProvider: Mocks; voiceKeyLend: Mocks; voiceKeyUsage: Mocks; appSetting: Mocks; bot: Mocks; botVoiceRevision: Mocks };
const session = getSessionUser as jest.Mock;
const checked = checkPublicHttpsUrl as jest.Mock;
const get = safeGet as jest.Mock;

const checkedOk = { url: new URL('https://speech.example.com'), address: '93.184.216.34', family: 4, addresses: [{ address: '93.184.216.34', family: 4 }] };
const answer = (status: number, body: unknown) => ({ ok: true, status, body: typeof body === 'string' ? body : JSON.stringify(body) });
/** Each path on the server answers what the test says; any other path is "not found". */
const server = (paths: Record<string, ReturnType<typeof answer> | { ok: false; reason: string }>) =>
  get.mockImplementation(async (target: { url: URL }) => paths[target.url.pathname] ?? answer(404, 'not found'));

const send = (route: (request: NextRequest, context: never) => Promise<Response>, body: unknown, method = 'POST', id = 'k1') =>
  route(new NextRequest('http://localhost:3333/api/x', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) } as never);

// Speaches names the task of each model
const SPEACHES = {
  object: 'list',
  data: [
    { id: 'Systran/faster-whisper-small', object: 'model', task: 'automatic-speech-recognition' },
    { id: 'speaches-ai/Kokoro-82M-v1.0-ONNX', object: 'model', task: 'text-to-speech' },
  ],
};
// Kokoro-FastAPI lists models without a task
const KOKORO = { object: 'list', data: [{ id: 'tts-1', object: 'model' }, { id: 'kokoro', object: 'model' }] };

let people = 0;
beforeEach(() => {
  jest.resetAllMocks();
  clearVoiceListCache();
  people += 1;
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.BOT_SERVICE_TOKEN = 'service-secret';
  session.mockResolvedValue({ id: `u-${people}`, email: 'ana@example.com' });
  checked.mockResolvedValue(checkedOk);
  (lendAccess as jest.Mock).mockResolvedValue(true);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  db.voiceProvider.findMany.mockResolvedValue([]);
  db.voiceKeyUsage.findMany.mockResolvedValue([]);
  db.appSetting.findUnique.mockResolvedValue(null);
  db.bot.findMany.mockResolvedValue([]);
  db.botVoiceRevision.findMany.mockResolvedValue([]);
  db.voiceKeyLend.findMany.mockResolvedValue([]);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('Load models for your own speech server', () => {
  it('reads what each model does from the server’s own list, and counts the voices it lists', async () => {
    server({ '/v1/models': answer(200, SPEACHES), '/v1/audio/voices': answer(200, { voices: ['af_heart', 'am_adam', { id: 'bf_emma' }] }) });
    const response = await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      models: [
        { id: 'Systran/faster-whisper-small', kind: 'recognition' },
        { id: 'speaches-ai/Kokoro-82M-v1.0-ONNX', kind: 'speech' },
      ],
      unsure: [],
      voices: 3,
    });
  });

  it('never guesses from a name: a model with no task is left for the person to pick', async () => {
    server({ '/v1/models': answer(200, KOKORO), '/v1/audio/voices': answer(200, { voices: ['af_bella'] }) });
    const body = await (await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com' })).json();
    expect(body).toMatchObject({ ok: true, models: [], unsure: ['tts-1', 'kokoro'], voices: 1 });
    // Even a model called whisper or tts is unsure when the server doesn't say
    server({ '/v1/models': answer(200, { data: [{ id: 'whisper-1' }, { id: 'tts-hd', task: 'chat' }, { id: 'odd', task: 'constructor' }] }) });
    expect(await (await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com' })).json()).toMatchObject({ models: [], unsure: ['whisper-1', 'tts-hd', 'odd'] });
  });

  it('says a server has no voice list when it has none', async () => {
    server({ '/v1/models': answer(200, SPEACHES) });
    expect(await (await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com' })).json()).toMatchObject({ ok: true, voices: null });
  });

  it('asks the saved address with /v1, drops a pasted path, and sends the key only as a bearer header when there is one', async () => {
    server({ '/v1/models': answer(200, SPEACHES) });
    await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com/v1/audio/?x=1', apiKey: 'own-key-1' });
    const [target, options] = get.mock.calls[0];
    expect(target.url.href).toBe('https://speech.example.com/v1/models');
    expect(options.headers).toEqual({ Authorization: 'Bearer own-key-1' });
    get.mockClear();
    await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com' });
    expect(get.mock.calls[0][1].headers).toEqual({});
  });

  it('refuses a private address before asking anything', async () => {
    checked.mockRejectedValue(new AddressError('private'));
    const response = await send(check, { adapter: 'openai-compatible', address: 'https://nas.example.com' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('That address points to a private network, so Universe can’t reach it.');
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ['localhost', 'https://localhost:8000'],
    ['a bare address', 'https://192.168.1.20'],
    ['plain http', 'http://speech.example.com'],
    ['a user name', 'https://me:pw@speech.example.com'],
  ])('refuses %s without a lookup', async (_name, address) => {
    const response = await send(check, { adapter: 'openai-compatible', address });
    expect(response.status).toBe(400);
    expect(checked).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('asks for an address first', async () => {
    const response = await send(check, { adapter: 'openai-compatible' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Paste the https address of your server.');
  });

  it('says the server is down in the chat key’s own words', async () => {
    server({ '/v1/models': { ok: false, reason: 'unreachable' } });
    const response = await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com' });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('It didn’t answer. Is the server running and the tunnel up?');
    // A name that doesn't exist is the same: nothing answered
    checked.mockRejectedValue(new AddressError('unresolved'));
    expect((await send(check, { adapter: 'openai-compatible', address: 'https://gone.example.com' })).status).toBe(502);
  });

  it('turns away a wrong or missing key, a wrong address, and a list that is not a list', async () => {
    server({ '/v1/models': answer(401, 'nope') });
    const refused = await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com', apiKey: 'wrong-key' });
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toBe('The server asked for a key, or didn’t accept the one you gave.');
    server({});
    expect((await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com' })).status).toBe(400);
    server({ '/v1/models': answer(200, '<html>') });
    expect((await (await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com' })).json()).error).toBe('It answered, but not like an AI server.');
    server({ '/v1/models': answer(200, { data: [] }) });
    expect((await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com' })).status).toBe(409);
  });

  it('refuses a key a header can’t carry, and never returns the key', async () => {
    const response = await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com', apiKey: 'smart “quote”' });
    expect(response.status).toBe(400);
    server({ '/v1/models': answer(200, SPEACHES) });
    expect(JSON.stringify(await (await send(check, { adapter: 'openai-compatible', address: 'https://speech.example.com', apiKey: 'own-key-1' })).json())).not.toContain('own-key-1');
  });
});

describe('adding your own speech server', () => {
  const saved = (data: Record<string, unknown>) => ({
    id: 'k1', ownerId: 'u-1', createdById: 'u-1', enabled: true, region: null, models: [], downSince: null, downReason: null, downPart: null, failedRecognition: 0, failedSpeech: 0,
    healthCheckedAt: null, voiceLimits: null, createdAt: new Date('2026-11-07T10:00:00Z'), updatedAt: new Date('2026-11-07T10:00:00Z'), lends: [], ...data,
  });
  const body = {
    adapter: 'openai-compatible',
    address: 'https://speech.example.com/some/path',
    recognition: true,
    speech: true,
    models: [{ id: 'whisper-small', kind: 'recognition' }, { id: 'kokoro', kind: 'speech' }],
  };

  it('saves the address as its origin with /v1, a missing key as none, and names it My speech server', async () => {
    db.voiceProvider.create.mockImplementation(async ({ data }) => saved(data));
    const response = await send(create, body);
    expect(response.status).toBe(201);
    const { data } = db.voiceProvider.create.mock.calls[0][0];
    expect(data).toMatchObject({ adapter: 'openai-compatible', name: 'My speech server', endpoint: 'https://speech.example.com/v1', apiKeyEncrypted: null, apiKeyLast4: null, recognition: true, speech: true, enabled: true });
    expect((await response.json()).key).toMatchObject({ address: 'speech.example.com', last4: null, company: 'Any OpenAI-compatible speech server' });
  });

  it('keeps a given key encrypted, with no last four', async () => {
    db.voiceProvider.create.mockImplementation(async ({ data }) => saved(data));
    await send(create, { ...body, apiKey: 'own-key-1' });
    const { data } = db.voiceProvider.create.mock.calls[0][0];
    expect(decryptApiKey(data.apiKeyEncrypted)).toBe('own-key-1');
    expect(data.apiKeyLast4).toBeNull();
  });

  it('refuses a private address again at save, and an address with no job picked', async () => {
    checked.mockRejectedValue(new AddressError('private'));
    expect((await send(create, body)).status).toBe(400);
    checked.mockResolvedValue(checkedOk);
    expect((await send(create, { ...body, recognition: false, speech: false, models: [] })).status).toBe(400);
    expect(db.voiceProvider.create).not.toHaveBeenCalled();
  });

  it('keeps a company’s own address fixed: a company can’t be given one', async () => {
    const response = await send(create, { adapter: 'elevenlabs', speech: true, apiKey: 'sk-secret-key-9f2a', address: 'https://evil.example.com', models: [] });
    expect(response.status).toBe(400);
    expect(db.voiceProvider.create).not.toHaveBeenCalled();
  });

  it('shows its address where a company shows its last four', () => {
    const key = { company: 'Any OpenAI-compatible speech server', address: 'speech.example.com', last4: null, recognition: true, speech: true, models: [{ id: 'a', kind: 'speech' }, { id: 'b', kind: 'recognition' }] };
    expect(describeVoice(key as never)).toBe('Listens and speaks · 2 models · speech.example.com');
  });
});

describe('changing the address of your own speech server', () => {
  const row = (changes: Record<string, unknown> = {}) => ({
    id: 'k1', ownerId: 'u-1', adapter: 'openai-compatible', name: 'My speech server', recognition: true, speech: true, enabled: true, endpoint: 'https://old.example.com/v1',
    apiKeyEncrypted: null, apiKeyLast4: null, models: [{ id: 'Systran/faster-whisper-small', kind: 'recognition' }], voiceLimits: null, downSince: new Date('2026-11-07T08:00:00Z'), downReason: 'errors',
    downPart: null, failedRecognition: 2, failedSpeech: 0, healthCheckedAt: null, createdAt: new Date(), updatedAt: new Date(), lends: [], ...changes,
  });

  it('saves nothing until the new address answers, has the key’s models, and then starts the key clean', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(row());
    server({ '/v1/models': answer(200, SPEACHES) });
    const response = await send(patch, { address: 'https://new.example.com' }, 'PATCH');
    expect(response.status).toBe(200);
    expect(db.voiceProvider.update.mock.calls[0][0].data).toMatchObject({ endpoint: 'https://new.example.com/v1', downSince: null, downReason: null, failedRecognition: 0, healthCheckedAt: null });
  });

  it('refuses an address that doesn’t answer, is private, or doesn’t have the models', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(row());
    server({ '/v1/models': { ok: false, reason: 'unreachable' } });
    expect((await send(patch, { address: 'https://new.example.com' }, 'PATCH')).status).toBe(409);
    checked.mockRejectedValue(new AddressError('private'));
    expect((await send(patch, { address: 'https://nas.example.com' }, 'PATCH')).status).toBe(400);
    checked.mockResolvedValue(checkedOk);
    server({ '/v1/models': answer(200, { data: [{ id: 'another-model', task: 'text-to-speech' }] }) });
    const other = await send(patch, { address: 'https://new.example.com' }, 'PATCH');
    expect(other.status).toBe(400);
    expect((await other.json()).error).toContain('Systran/faster-whisper-small');
    expect(db.voiceProvider.update).not.toHaveBeenCalled();
  });

  it('holds a changed key to what a header can carry, as when it was added', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(row());
    for (const key of ['abc\ndef', 'clé-secrète', 'has a space', 'a'.repeat(513)]) {
      expect((await send(patch, { apiKey: key }, 'PATCH')).status).toBe(400);
    }
    expect(db.voiceProvider.update).not.toHaveBeenCalled();
    // A short key is fine for an own server
    expect((await send(patch, { apiKey: 'short1' }, 'PATCH')).status).toBe(200);
    expect(db.voiceProvider.update.mock.calls[0][0].data).toHaveProperty('apiKeyEncrypted');
  });

  it('finds a saved model on a server that lists more than a person can pick through', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `model-${i}`, task: 'text-to-speech' }));
    db.voiceProvider.findFirst.mockResolvedValue(row({ models: [{ id: 'model-149', kind: 'speech' }] }));
    server({ '/v1/models': answer(200, { data: many }) });
    expect((await send(patch, { address: 'https://new.example.com' }, 'PATCH')).status).toBe(200);
  });

  it('asks the new address with the key sent in the same request, not the old one', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(row());
    server({ '/v1/models': answer(200, SPEACHES) });
    expect((await send(patch, { address: 'https://new.example.com', apiKey: 'fresh-key' }, 'PATCH')).status).toBe(200);
    expect(get.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer fresh-key' });
  });

  it('is only for an own speech server', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(row({ adapter: 'elevenlabs', endpoint: null }));
    const response = await send(patch, { address: 'https://new.example.com' }, 'PATCH');
    expect(response.status).toBe(400);
    expect(db.voiceProvider.update).not.toHaveBeenCalled();
  });
});

describe('serving the credentials of an own speech server', () => {
  const serverRow = { id: 'k1', ownerId: 'u-1', adapter: 'openai-compatible', name: 'My speech server', recognition: true, speech: true, enabled: true, endpoint: 'https://speech.example.com/v1', region: null, models: [], apiKeyEncrypted: null };
  const ask = () =>
    credentials(new NextRequest('http://localhost:3333/api/voice/providers/k1/credentials?botId=b1', { headers: { Authorization: 'Bearer service-secret' } }), { params: Promise.resolve({ id: 'k1' }) });

  beforeEach(() => {
    (effectiveBotVoice as jest.Mock).mockResolvedValue({ speaks: true, profile: { recognition: { providerId: 'k1' }, speech: { providerId: 'k1' } } });
  });

  it('serves a server with no key, with its address and no key', async () => {
    db.voiceProvider.findUnique.mockResolvedValue(serverRow);
    const response = await ask();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ adapter: 'openai-compatible', endpoint: 'https://speech.example.com/v1', apiKeyEncrypted: null, keyless: true });
  });

  it('still refuses any other provider that has no key', async () => {
    db.voiceProvider.findUnique.mockResolvedValue({ ...serverRow, adapter: 'elevenlabs', endpoint: null });
    expect((await ask()).status).toBe(400);
  });

  describe('for a hello before voice is on', () => {
    const askHello = (query = '?botId=b1&hello=1') =>
      credentials(new NextRequest(`http://localhost:3333/api/voice/providers/k1/credentials${query}`, { headers: { Authorization: 'Bearer service-secret' } }), { params: Promise.resolve({ id: 'k1' }) });

    beforeEach(() => {
      db.voiceProvider.findUnique.mockResolvedValue(serverRow);
      // No profile names the server yet: the bot does not speak
      (effectiveBotVoice as jest.Mock).mockResolvedValue({ speaks: false, profile: null });
    });

    it('serves the server while it is lent to the bot’s universe, though voice is off', async () => {
      (ownServerLentToBot as jest.Mock).mockResolvedValue(true);
      const response = await askHello();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ adapter: 'openai-compatible', endpoint: 'https://speech.example.com/v1', keyless: true });
      expect(ownServerLentToBot).toHaveBeenCalledWith(serverRow, 'b1');
    });

    it('does not serve it when it is not lent there, or the bot is not its owner’s', async () => {
      (ownServerLentToBot as jest.Mock).mockResolvedValue(false);
      expect((await askHello()).status).toBe(404);
    });

    it('is not served without asking for a hello, or without a bot', async () => {
      (ownServerLentToBot as jest.Mock).mockResolvedValue(true);
      expect((await askHello('?botId=b1')).status).toBe(404);
      expect((await askHello('?hello=1')).status).toBe(404);
      expect(ownServerLentToBot).not.toHaveBeenCalledWith(expect.anything(), null);
    });
  });
});

describe('whether a speech server is lent to a bot’s universe, for a hello before voice is on', () => {
  const { ownServerLentToBot: real } = jest.requireActual('@/lib/bot-voice') as typeof import('@/lib/bot-voice');
  const own = { id: 'k1', ownerId: 'u-1', adapter: 'openai-compatible' };
  beforeEach(() => {
    db.bot.findUnique.mockResolvedValue({ createdById: 'u-1', room: { world: { universeId: 'uni1' } } });
    (db.voiceKeyLend as Mocks).findUnique = jest.fn().mockResolvedValue({ id: 'lend1' });
  });

  it('is so for the maker’s own server that is lent to the universe', async () => {
    expect(await real(own, 'b1')).toBe(true);
    expect((db.voiceKeyLend as Mocks).findUnique).toHaveBeenCalledWith({ where: { providerId_universeId: { providerId: 'k1', universeId: 'uni1' } }, select: { id: true } });
  });

  it('is not so for a company’s key, a server of someone else’s, a server not lent here, or an owner who lost access', async () => {
    expect(await real({ ...own, adapter: 'elevenlabs' }, 'b1')).toBe(false);
    expect(await real({ ...own, ownerId: null }, 'b1')).toBe(false);
    expect(await real({ ...own, ownerId: 'u-2' }, 'b1')).toBe(false);
    (db.voiceKeyLend as Mocks).findUnique.mockResolvedValue(null);
    expect(await real(own, 'b1')).toBe(false);
    (db.voiceKeyLend as Mocks).findUnique.mockResolvedValue({ id: 'lend1' });
    (lendAccess as jest.Mock).mockResolvedValue(false);
    expect(await real(own, 'b1')).toBe(false);
  });
});

describe('a bot’s Voice row for an own speech server', () => {
  const provider = { id: 'k1', ownerId: 'u-1', adapter: 'openai-compatible', name: 'My speech server', speech: true, enabled: true, endpoint: 'https://speech.example.com/v1', apiKeyEncrypted: null, models: [{ id: 'kokoro', kind: 'speech' }], updatedAt: new Date('2026-11-07T10:00:00Z'), lends: [{ models: null }] };
  beforeEach(() => {
    db.bot.findUnique.mockResolvedValue({ createdById: 'u-1', room: { world: { universeId: 'uni1' } } });
    db.voiceProvider.findFirst.mockResolvedValue(provider);
  });

  it('lists the voices the server lists, with no sample', async () => {
    server({ '/v1/audio/voices': answer(200, { voices: ['af_heart', 'am_adam'] }) });
    expect(await listBotVoices('b1', 'k1')).toEqual([
      expect.objectContaining({ voiceId: 'af_heart', name: 'af_heart', previewUrl: null, providerId: 'k1', model: 'kokoro' }),
      expect.objectContaining({ voiceId: 'am_adam' }),
    ]);
    expect(get.mock.calls[0][0].url.href).toBe('https://speech.example.com/v1/audio/voices');
  });

  it('says it has no list when the server has none, so the voice is typed', async () => {
    server({});
    await expect(listBotVoices('b1', 'k1')).rejects.toMatchObject({ status: 409, code: 'no_voice_list', message: 'My speech server doesn’t list its voices. Type the voice’s name.' });
  });

  it('says a server that is down or refuses the key is down or refusing, never that it has no list', async () => {
    server({ '/v1/audio/voices': { ok: false, reason: 'unreachable' } });
    await expect(listBotVoices('b1', 'k1')).rejects.toMatchObject({ status: 502, code: undefined, message: 'It didn’t answer. Is the server running and the tunnel up?' });
    clearVoiceListCache();
    server({ '/v1/audio/voices': answer(401, 'nope') });
    await expect(listBotVoices('b1', 'k1')).rejects.toMatchObject({ status: 502, message: 'The server asked for a key, or didn’t accept the one you gave.' });
  });

  it('says a busy or timed-out server is down for now, never that it has no list', async () => {
    server({ '/v1/audio/voices': answer(429, 'slow down') });
    await expect(listBotVoices('b1', 'k1')).rejects.toMatchObject({ status: 502, code: undefined, message: 'It didn’t answer. Is the server running and the tunnel up?' });
    clearVoiceListCache();
    server({ '/v1/audio/voices': answer(408, 'request timeout') });
    await expect(listBotVoices('b1', 'k1')).rejects.toMatchObject({ status: 502, code: undefined, message: 'It didn’t answer. Is the server running and the tunnel up?' });
  });

  it('says a server whose tunnel answers for it while it is down (502, 503) is down, never that it has no list', async () => {
    server({ '/v1/audio/voices': answer(502, 'Bad gateway') });
    await expect(listBotVoices('b1', 'k1')).rejects.toMatchObject({ status: 502, code: undefined, message: 'It didn’t answer. Is the server running and the tunnel up?' });
    clearVoiceListCache();
    server({ '/v1/audio/voices': answer(503, 'unavailable') });
    await expect(listBotVoices('b1', 'k1')).rejects.toMatchObject({ status: 502, code: undefined });
  });

  it('checks the address again on every list: a name that now points inside a network is never reached', async () => {
    checked.mockRejectedValue(new AddressError('private'));
    await expect(listBotVoices('b1', 'k1')).rejects.toMatchObject({ status: 409 });
    expect(get).not.toHaveBeenCalled();
  });
});
