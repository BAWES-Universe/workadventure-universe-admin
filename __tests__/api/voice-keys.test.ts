/**
 * Personal voice keys (#749): a person adds a voice key, lends it to a universe where they manage bots, and nobody else sees
 * or changes it. The server's own voice providers never show a person's key. Nothing here calls a provider.
 */
import { NextRequest } from 'next/server';
import { GET as list, POST as create } from '@/app/api/me/voice-keys/route';
import { DELETE as remove, PATCH as patch } from '@/app/api/me/voice-keys/[id]/route';
import { POST as lend } from '@/app/api/me/voice-keys/[id]/lend/route';
import { DELETE as pull } from '@/app/api/me/voice-keys/[id]/lend/[universeId]/route';
import { GET as listAdmin } from '@/app/api/admin/voice-providers/route';
import { GET as getAdmin } from '@/app/api/admin/voice-providers/[id]/route';
import { GET as listServed } from '@/app/api/voice/providers/route';
import { GET as credentials } from '@/app/api/voice/providers/[id]/credentials/route';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { lendAccess } from '@/lib/ai-key-lend';
import { prisma } from '@/lib/db';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { decryptApiKey } from '@/lib/encryption';
import { effectiveBotVoice } from '@/lib/bot-voice';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('@/lib/bot-voice', () => ({ effectiveBotVoice: jest.fn() }));
jest.mock('@/lib/ai-key-lend', () => ({ ...jest.requireActual('@/lib/ai-key-lend'), lendAccess: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    $transaction: jest.fn(),
    voiceProvider: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
    voiceKeyLend: { findMany: jest.fn(), update: jest.fn(), delete: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
    appSetting: { findUnique: jest.fn() },
    voiceKeyUsage: { findMany: jest.fn() },
    bot: { findMany: jest.fn() },
    botVoiceRevision: { findMany: jest.fn() },
  },
}));

type Mocks = Record<string, jest.Mock>;
const db = prisma as unknown as { $transaction: jest.Mock; voiceProvider: Mocks; voiceKeyLend: Mocks; voiceKeyUsage: Mocks; appSetting: Mocks; bot: Mocks; botVoiceRevision: Mocks };
const session = getSessionUser as jest.Mock;

const ana = { id: 'u-ana', email: 'ana@example.com', name: 'Ana' };
type Context = { params: Promise<{ id: string; universeId: string }> };
const call = (route: (request: NextRequest, context: Context) => Promise<Response>, method: string, body?: unknown, id = 'k1', universeId = 'uni1') =>
  route(new NextRequest('http://localhost:3333/api/x', { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), {
    params: Promise.resolve({ id, universeId }),
  });

const key = (changes: Record<string, unknown> = {}) => ({
  id: 'k1',
  adapter: 'elevenlabs',
  name: 'My ElevenLabs',
  recognition: false,
  speech: true,
  enabled: true,
  endpoint: null,
  region: null,
  apiKeyEncrypted: 'iv:tag:data',
  apiKeyLast4: '9f2a',
  models: [
    { id: 'flash', label: 'Flash', kind: 'speech' },
    { id: 'turbo', label: 'Turbo', kind: 'speech' },
  ],
  defaultRecognition: false,
  defaultSpeech: false,
  ownerId: 'u-ana',
  createdById: 'u-ana',
  createdAt: new Date('2026-10-31T10:00:00Z'),
  updatedAt: new Date('2026-10-31T10:00:00Z'),
  lends: [] as unknown[],
  ...changes,
});
// The server's own providers that are on: what companies a key can be added for
const serverProviders = [
  { adapter: 'elevenlabs', name: 'ElevenLabs', recognition: true, speech: true },
  { adapter: 'deepgram', name: 'Deepgram', recognition: true, speech: false },
];
const withProviders = (keys: unknown[] = []) =>
  db.voiceProvider.findMany.mockImplementation(async ({ where }: { where: { ownerId: unknown } }) => (where.ownerId === null ? serverProviders : keys));
const lent = (models: string[] | null = null) => ({ models, universe: { id: 'uni1', name: 'Sales', ownerId: 'u-ana' } });

beforeEach(() => {
  jest.resetAllMocks();
  process.env.BOT_SERVICE_TOKEN = 'service-secret';
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  (isSuperAdmin as jest.Mock).mockImplementation((email?: string | null) => email === 'root@example.com');
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  session.mockResolvedValue(ana);
  withProviders();
  db.voiceKeyUsage.findMany.mockResolvedValue([]);
  // The server's voice limits as a super admin saved them: none, so the recommended ones
  db.appSetting.findUnique.mockResolvedValue(null);
  db.bot.findMany.mockResolvedValue([]);
  db.botVoiceRevision.findMany.mockResolvedValue([]);
});

describe('voice keys are for signed-in people', () => {
  it('turn away everyone else', async () => {
    session.mockResolvedValue(null);
    for (const response of [
      await list(new NextRequest('http://localhost:3333/api/x')),
      await call(create, 'POST', {}),
      await call(patch, 'PATCH', {}),
      await call(remove, 'DELETE'),
      await call(lend, 'POST', {}),
      await call(pull, 'DELETE'),
    ]) {
      expect(response.status).toBe(401);
    }
    expect(db.voiceProvider.create).not.toHaveBeenCalled();
  });
});

describe('adding a key', () => {
  it('saves it encrypted for its owner, on, and never a default', async () => {
    withProviders();
    db.voiceProvider.create.mockImplementation(async ({ data }) => key({ ...data, id: 'k1', createdAt: new Date('2026-10-31T10:00:00Z'), lends: [] }));
    const response = await call(create, 'POST', {
      adapter: 'elevenlabs',
      speech: true,
      apiKey: 'sk-secret-key-9f2a',
      models: [{ id: 'flash', label: 'Flash', kind: 'speech' }],
    });
    expect(response.status).toBe(201);
    const { data } = db.voiceProvider.create.mock.calls[0][0];
    expect(data).toMatchObject({ adapter: 'elevenlabs', name: 'ElevenLabs', speech: true, recognition: false, enabled: true, ownerId: 'u-ana', createdById: 'u-ana', apiKeyLast4: '9f2a' });
    expect(data).not.toHaveProperty('defaultSpeech');
    expect(decryptApiKey(data.apiKeyEncrypted)).toBe('sk-secret-key-9f2a');
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain('sk-secret-key-9f2a');
    expect(text).not.toContain('apiKeyEncrypted');
    expect(text).toContain('9f2a');
  });

  it.each([
    ['a company that isn’t on the list', { adapter: 'unknown-co', speech: true, apiKey: 'sk-secret-key-9f2a' }],
    ['a job the company doesn’t do', { adapter: 'deepgram', speech: true, apiKey: 'sk-secret-key-9f2a' }],
    ['a key that does nothing', { adapter: 'elevenlabs', apiKey: 'sk-secret-key-9f2a' }],
    ['a key that is too short', { adapter: 'elevenlabs', speech: true, apiKey: 'short' }],
    ['a model for a job the key doesn’t do', { adapter: 'elevenlabs', speech: true, apiKey: 'sk-secret-key-9f2a', models: [{ id: 'a', kind: 'recognition' }] }],
    ['a field it doesn’t know (an endpoint, a default)', { adapter: 'elevenlabs', speech: true, apiKey: 'sk-secret-key-9f2a', endpoint: 'https://x.example.com' }],
    ['a default', { adapter: 'elevenlabs', speech: true, apiKey: 'sk-secret-key-9f2a', defaultSpeech: true }],
  ])('refuses %s', async (_name, body) => {
    withProviders();
    expect((await call(create, 'POST', body)).status).toBe(400);
    expect(db.voiceProvider.create).not.toHaveBeenCalled();
  });
});

describe('the list', () => {
  it('is the caller’s own keys with where each is lent, and the companies the server’s providers cover', async () => {
    withProviders([key({ lends: [lent(['speech:flash'])] })]);
    const response = await list(new NextRequest('http://localhost:3333/api/x'));
    expect(db.voiceProvider.findMany.mock.calls.map(([arg]) => arg.where)).toContainEqual({ ownerId: 'u-ana' });
    const body = await response.json();
    expect(body.keys).toEqual([
      expect.objectContaining({ id: 'k1', company: 'ElevenLabs', last4: '9f2a', lentTo: [{ universeId: 'uni1', universeName: 'Sales', ownedByYou: true, models: ['speech:flash'], bots: [] }], month: { voiceReplies: 0 }, limits: expect.any(Object) }),
    ]);
    // Named and described by the catalog, in its order, doing what the server's providers for each do
    expect(body.companies).toEqual([
      expect.objectContaining({ adapter: 'elevenlabs', label: 'ElevenLabs', recognition: true, speech: true, logo: 'elevenlabs', docs: 'https://elevenlabs.io/docs' }),
      expect.objectContaining({ adapter: 'deepgram', label: 'Deepgram', recognition: true, speech: false, logo: 'deepgram' }),
    ]);
    // Its line says only the jobs Universe runs for it
    expect(body.companies.map((entry: { benefit: string }) => entry.benefit)).toEqual(['Listens and speaks, with thousands of voices.', 'Listens. Known for fast listening.']);
    expect(JSON.stringify(body)).not.toContain('apiKeyEncrypted');
  });

  it('says whether each key works, and since when and why when it does not', async () => {
    withProviders([key(), key({ id: 'k2', downSince: new Date('2026-10-30T11:14:00Z'), downReason: 'credit' })]);
    const body = await (await list(new NextRequest('http://localhost:3333/api/x'))).json();
    expect(body.keys.map((entry: { health: unknown }) => entry.health)).toEqual([
      { status: 'working', downSince: null, downReason: null },
      { status: 'down', downSince: '2026-10-30T11:14:00.000Z', downReason: 'credit' },
    ]);
  });
});

describe('what a key paid for this month, and the bots on it', () => {
  const models = [
    { id: 'scribe', label: 'Scribe', kind: 'recognition' },
    { id: 'flash', label: 'Flash', kind: 'speech' },
  ];
  const inSales = (id: string, name: string, voiceRevision: number) => ({ id, name, voiceRevision, room: { world: { universeId: 'uni1' } } });
  const voice = (recognition: string, speech: string) => ({ recognition: { providerId: recognition, model: 'scribe' }, speech: { providerId: speech, model: 'flash' } });

  it('counts the month in the key and for each bot whose published voice names it, with the speaking model first', async () => {
    withProviders([key({ recognition: true, models, lends: [lent()] })]);
    db.voiceKeyUsage.findMany.mockResolvedValue([
      { providerId: 'k1', botId: 'b1', replies: 186 },
      { providerId: 'k1', botId: 'b-other', replies: 4 },
    ]);
    db.bot.findMany.mockResolvedValue([inSales('b1', 'Sales Researcher', 2), inSales('b2', 'Listener', 1), inSales('b3', 'On Universe AI', 1)]);
    db.botVoiceRevision.findMany.mockResolvedValue([
      { botId: 'b1', profile: voice('k1', 'k1') },
      { botId: 'b2', profile: voice('k1', 'server') },
      { botId: 'b3', profile: voice('server', 'server') },
    ]);
    const [entry] = (await (await list(new NextRequest('http://localhost:3333/api/x'))).json()).keys;
    expect(entry.month).toEqual({ voiceReplies: 190 });
    expect(entry.lentTo[0].bots).toEqual([
      { id: 'b1', name: 'Sales Researcher', model: 'Flash', voiceReplies: 186 },
      { id: 'b2', name: 'Listener', model: 'Scribe', voiceReplies: 0 },
    ]);
    // Only this month's usage, and only the bots in the universes it is lent to whose published voice is on
    expect(db.voiceKeyUsage.findMany.mock.calls[0][0].where).toMatchObject({ providerId: { in: ['k1'] }, month: expect.any(Date) });
    expect(db.bot.findMany.mock.calls[0][0].where).toEqual({ voiceRevision: { not: null }, room: { world: { universeId: { in: ['uni1'] } } } });
    expect(db.botVoiceRevision.findMany.mock.calls[0][0].where.OR).toContainEqual({ botId: 'b1', number: 2 });
  });

  it('is zero, with no bots, for a key that is lent nowhere', async () => {
    withProviders([key()]);
    const [entry] = (await (await list(new NextRequest('http://localhost:3333/api/x'))).json()).keys;
    expect(entry.month).toEqual({ voiceReplies: 0 });
    expect(entry.lentTo).toEqual([]);
    expect(db.bot.findMany).not.toHaveBeenCalled();
  });
});

describe('a key\'s limits', () => {
  const RECOMMENDED = {
    turnSeconds: { value: 180, recommended: 180, changed: false },
    replyCharacters: { value: 600, recommended: 600, changed: false },
    replySeconds: { value: 60, recommended: 60, changed: false },
    listenMinutesPerDay: { value: 60, recommended: 60, changed: false },
  };
  const listed = async () => (await (await list(new NextRequest('http://localhost:3333/api/x'))).json()).keys[0].limits;

  it('are all four, from the server\'s current voice limits when the owner changed none', async () => {
    withProviders([key()]);
    expect(await listed()).toEqual(RECOMMENDED);
    // The recommended value is the server's saved one, never a number kept here
    db.appSetting.findUnique.mockResolvedValue({ value: { revision: 3, limits: { turnSeconds: 90, replyCharacters: 450 } } });
    expect(await listed()).toMatchObject({ turnSeconds: { value: 90, recommended: 90, changed: false }, replyCharacters: { value: 450, recommended: 450 }, replySeconds: { value: 60 } });
  });

  it('say what the owner changed, and that the server\'s value moved under a value they kept', async () => {
    withProviders([key({ voiceLimits: { turnSeconds: 120, replySeconds: 30, replyCharacters: 'x', textReserveShare: 3 } })]);
    expect(await listed()).toEqual({ ...RECOMMENDED, turnSeconds: { value: 120, recommended: 180, changed: true }, replySeconds: { value: 30, recommended: 60, changed: true } });
    db.appSetting.findUnique.mockResolvedValue({ value: { limits: { turnSeconds: 120 } } });
    expect((await listed()).turnSeconds).toEqual({ value: 120, recommended: 120, changed: false });
  });

  describe('changed through PATCH', () => {
    const patchLimits = (limits: unknown) => call(patch, 'PATCH', { limits });
    const saved = () => db.voiceProvider.update.mock.calls[0][0].data;

    it('saves only what is named, on top of what the owner already changed, and answers with the key', async () => {
      db.voiceProvider.findFirst.mockResolvedValue(key({ voiceLimits: { turnSeconds: 120 } }));
      const response = await patchLimits({ replyCharacters: 900 });
      expect(response.status).toBe(200);
      expect(saved()).toEqual({ voiceLimits: { turnSeconds: 120, replyCharacters: 900 } });
      expect(db.voiceKeyLend.findMany).not.toHaveBeenCalled();
      expect((await response.json()).key.limits).toBeDefined();
    });

    it('drops a value that is the server\'s own, so it follows the server, and clears the column when none are left', async () => {
      db.voiceProvider.findFirst.mockResolvedValue(key({ voiceLimits: { turnSeconds: 120, replySeconds: 30 } }));
      await patchLimits({ turnSeconds: 180 });
      expect(saved()).toEqual({ voiceLimits: { replySeconds: 30 } });
      db.voiceProvider.update.mockClear();
      db.voiceProvider.findFirst.mockResolvedValue(key({ voiceLimits: { turnSeconds: 120 } }));
      await patchLimits({ turnSeconds: 180 });
      expect(db.voiceProvider.update.mock.calls[0][0].data.voiceLimits).toBeDefined();
      expect(JSON.stringify(db.voiceProvider.update.mock.calls[0][0].data.voiceLimits)).not.toContain('turnSeconds');
    });

    it('compares with the server\'s current value, not a number kept here', async () => {
      db.appSetting.findUnique.mockResolvedValue({ value: { limits: { turnSeconds: 90 } } });
      db.voiceProvider.findFirst.mockResolvedValue(key());
      await patchLimits({ turnSeconds: 180 });
      expect(saved()).toEqual({ voiceLimits: { turnSeconds: 180 } });
    });

    it.each([
      ['a name that is not a limit', { fast: 5 }],
      ['a server-wide limit a key does not have', { followUpSeconds: 20 }],
      ['another server-wide limit', { guestVoiceReplies: 1 }],
      ['a value below its range', { turnSeconds: 1 }],
      ['a value above its range', { replyCharacters: 20_001 }],
      ['a value that is not a whole number', { replySeconds: 30.5 }],
      ['a value that is not a number', { listenMinutesPerDay: '60' }],
    ])('turns down %s, saving nothing', async (_name, limits) => {
      db.voiceProvider.findFirst.mockResolvedValue(key());
      expect((await patchLimits(limits)).status).toBe(400);
      expect(db.voiceProvider.update).not.toHaveBeenCalled();
    });

    it('says which limit and what range when a value is turned down', async () => {
      db.voiceProvider.findFirst.mockResolvedValue(key());
      expect((await (await patchLimits({ replySeconds: 601 })).json()).error).toBe('replySeconds must be a whole number from 5 to 600');
      expect((await (await patchLimits({ followUpSeconds: 20 })).json()).error).toBe('followUpSeconds is set for all of Universe, not for a key');
    });

    it('is the owner\'s alone: someone else\'s key is not found', async () => {
      db.voiceProvider.findFirst.mockResolvedValue(null);
      expect((await patchLimits({ turnSeconds: 120 })).status).toBe(404);
      expect(db.voiceProvider.update).not.toHaveBeenCalled();
    });

    it('takes limits with a name or models in one request, and a limits value that is not an object is refused', async () => {
      db.voiceProvider.findFirst.mockResolvedValue(key());
      expect((await call(patch, 'PATCH', { name: 'Studio', limits: { turnSeconds: 120 } })).status).toBe(200);
      expect(saved()).toMatchObject({ name: 'Studio', voiceLimits: { turnSeconds: 120 } });
      expect((await patchLimits(5)).status).toBe(400);
      expect((await patchLimits([1])).status).toBe(400);
    });
  });
});

describe('changing a key', () => {
  it('is only ever the owner’s: someone else’s key is not found', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(null);
    expect((await call(patch, 'PATCH', { name: 'x' })).status).toBe(404);
    expect((await call(lend, 'POST', { universeId: 'uni1' })).status).toBe(404);
    expect(db.voiceProvider.findFirst.mock.calls.every(([arg]) => arg.where.ownerId === 'u-ana')).toBe(true);
    expect(db.voiceProvider.update).not.toHaveBeenCalled();
  });

  it('takes a new key, encrypted, and a new name', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(key());
    const response = await call(patch, 'PATCH', { name: 'Studio', apiKey: 'sk-new-key-abcd' });
    expect(response.status).toBe(200);
    const { data } = db.voiceProvider.update.mock.calls[0][0];
    expect(data).toMatchObject({ name: 'Studio', apiKeyLast4: 'abcd' });
    expect(decryptApiKey(data.apiKeyEncrypted)).toBe('sk-new-key-abcd');
    expect(db.voiceKeyLend.findMany).not.toHaveBeenCalled();
  });

  it('starts a new key clean: a Down key that gets a new key is tried at once', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(key({ downSince: new Date(), downReason: 'credit' }));
    await call(patch, 'PATCH', { apiKey: 'sk-new-key-abcd' });
    expect(db.voiceProvider.update.mock.calls[0][0].data).toMatchObject({ downSince: null, downReason: null, downPart: null, failedRecognition: 0, failedSpeech: 0, healthCheckedAt: null });
    await call(patch, 'PATCH', { name: 'Only a name' });
    expect(db.voiceProvider.update.mock.calls[1][0].data).not.toHaveProperty('downSince');
  });

  it('takes a model off every lend that named it, and a lend left with none is pulled, not widened to all', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(key());
    db.voiceKeyLend.findMany.mockResolvedValue([
      { id: 'l1', models: ['speech:flash', 'speech:turbo'] },
      { id: 'l2', models: ['speech:turbo'] },
      { id: 'l3', models: ['speech:flash'] },
    ]);
    const response = await call(patch, 'PATCH', { models: [{ id: 'flash', kind: 'speech' }] });
    expect(response.status).toBe(200);
    // l1 narrowed, l3 untouched, l2 (only a model that is gone) removed and never set to "all models"
    expect(db.voiceKeyLend.update.mock.calls.map(([arg]) => [arg.where.id, arg.data.models])).toEqual([['l1', ['speech:flash']]]);
    expect(db.voiceKeyLend.delete.mock.calls.map(([arg]) => arg.where.id)).toEqual(['l2']);
  });

  it('leaves a lend for all of the key’s models alone when a model is taken off', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(key());
    db.voiceKeyLend.findMany.mockResolvedValue([]);
    await call(patch, 'PATCH', { models: [{ id: 'flash', kind: 'speech' }] });
    // Only lends that name models are looked at: a null (all) lend is not selected
    expect(db.voiceKeyLend.findMany.mock.calls[0][0].where.models).toBeDefined();
    expect(db.voiceKeyLend.delete).not.toHaveBeenCalled();
    expect(db.voiceKeyLend.update).not.toHaveBeenCalled();
  });

  it('refuses a model for a job the key doesn’t do', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(key());
    expect((await call(patch, 'PATCH', { models: [{ id: 'a', kind: 'recognition' }] })).status).toBe(400);
    expect(db.voiceProvider.update).not.toHaveBeenCalled();
  });

  it('removes only the caller’s own key', async () => {
    db.voiceProvider.deleteMany.mockResolvedValue({ count: 1 });
    expect((await call(remove, 'DELETE')).status).toBe(200);
    expect(db.voiceProvider.deleteMany).toHaveBeenCalledWith({ where: { id: 'k1', ownerId: 'u-ana' } });
    db.voiceProvider.deleteMany.mockResolvedValue({ count: 0 });
    expect((await call(remove, 'DELETE')).status).toBe(404);
  });
});

describe('lending', () => {
  it('needs Manage bots in the universe', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(key());
    (lendAccess as jest.Mock).mockResolvedValue(null);
    const response = await call(lend, 'POST', { universeId: 'uni1' });
    expect(response.status).toBe(403);
    expect(db.voiceKeyLend.upsert).not.toHaveBeenCalled();
  });

  it('lends the key with all of its models, then answers with where it is lent', async () => {
    db.voiceProvider.findFirst.mockResolvedValueOnce(key()).mockResolvedValueOnce(key({ lends: [lent(null)] }));
    (lendAccess as jest.Mock).mockResolvedValue('owner');
    const response = await call(lend, 'POST', { universeId: 'uni1' });
    expect(response.status).toBe(200);
    expect(db.voiceKeyLend.upsert).toHaveBeenCalledWith({
      where: { providerId_universeId: { providerId: 'k1', universeId: 'uni1' } },
      create: { providerId: 'k1', universeId: 'uni1' },
      update: {},
    });
    expect((await response.json()).key.lentTo).toEqual([{ universeId: 'uni1', universeName: 'Sales', ownedByYou: true, models: null, bots: [] }]);
  });

  it('keeps only the models named, in the key’s order, each of them on the key’s list', async () => {
    db.voiceProvider.findFirst.mockResolvedValue(key());
    (lendAccess as jest.Mock).mockResolvedValue('manage');
    expect((await call(lend, 'POST', { universeId: 'uni1', models: ['speech:turbo', 'speech:flash'] })).status).toBe(200);
    expect(db.voiceKeyLend.upsert.mock.calls[0][0].create.models).toEqual(['speech:flash', 'speech:turbo']);
    db.voiceKeyLend.upsert.mockClear();
    const refused = await call(lend, 'POST', { universeId: 'uni1', models: ['speech:gone'] });
    expect(refused.status).toBe(400);
    expect(db.voiceKeyLend.upsert).not.toHaveBeenCalled();
  });

  it('asks for a universe, and a model list that is neither empty nor all', async () => {
    expect((await call(lend, 'POST', {})).status).toBe(400);
    db.voiceProvider.findFirst.mockResolvedValue(key());
    (lendAccess as jest.Mock).mockResolvedValue('owner');
    expect((await call(lend, 'POST', { universeId: 'uni1', models: [] })).status).toBe(400);
  });

  it('is pulled by the key’s owner alone', async () => {
    db.voiceKeyLend.deleteMany.mockResolvedValue({ count: 1 });
    expect((await call(pull, 'DELETE')).status).toBe(200);
    expect(db.voiceKeyLend.deleteMany).toHaveBeenCalledWith({ where: { providerId: 'k1', universeId: 'uni1', provider: { ownerId: 'u-ana' } } });
    db.voiceKeyLend.deleteMany.mockResolvedValue({ count: 0 });
    expect((await call(pull, 'DELETE')).status).toBe(404);
  });
});

describe('the server’s own voice providers', () => {
  it('never list, serve or hand out a person’s key', async () => {
    session.mockResolvedValue({ id: 'u-root', email: 'root@example.com' });
    db.voiceProvider.findMany.mockResolvedValue([]);
    await listAdmin(new NextRequest('http://localhost:3333/api/x'));
    expect(db.voiceProvider.findMany.mock.calls[0][0].where).toEqual({ ownerId: null });
    db.voiceProvider.findMany.mockClear();
    await listServed(new NextRequest('http://localhost:3333/api/x', { headers: { Authorization: 'Bearer service-secret' } }));
    expect(db.voiceProvider.findMany.mock.calls[0][0].where).toEqual({ enabled: true, ownerId: null });

    db.voiceProvider.findUnique.mockResolvedValue(key());
    const context = { params: Promise.resolve({ id: 'k1' }) };
    expect((await getAdmin(new NextRequest('http://localhost:3333/api/x'), context)).status).toBe(404);
    const served = await credentials(new NextRequest('http://localhost:3333/api/x', { headers: { Authorization: 'Bearer service-secret' } }), context);
    expect(served.status).toBe(404);
  });
});

describe('a lent key’s credentials', () => {
  const ask = (query = '') =>
    credentials(new NextRequest(`http://localhost:3333/api/voice/providers/k1/credentials${query}`, { headers: { Authorization: 'Bearer service-secret' } }), {
      params: Promise.resolve({ id: 'k1' }),
    });
  const speaking = (providerId: string, speaks = true) =>
    (effectiveBotVoice as jest.Mock).mockResolvedValue({
      speaks,
      reason: speaks ? null : 'provider',
      profile: speaks ? { recognition: { providerId: 'ears', model: 'n' }, speech: { providerId, model: 'flash', voiceId: 'v' } } : null,
    });

  beforeEach(() => db.voiceProvider.findUnique.mockResolvedValue(key()));

  it('go to the bot server for a bot that speaks with the key, still encrypted', async () => {
    speaking('k1');
    const response = await ask('?botId=bot-1');
    expect(response.status).toBe(200);
    expect(effectiveBotVoice).toHaveBeenCalledWith('bot-1', { ignoreKeyHealth: true });
    const body = await response.json();
    expect(body.apiKeyEncrypted).toBe('iv:tag:data');
    expect(body).not.toHaveProperty('ownerId');
  });

  it.each([
    ['no bot is named', '', () => speaking('k1')],
    ['the bot speaks with another provider', '?botId=bot-1', () => speaking('other')],
    ['the bot is resting in text', '?botId=bot-1', () => speaking('k1', false)],
    ['the bot is not there', '?botId=gone', () => (effectiveBotVoice as jest.Mock).mockRejectedValue(new BotSettingsError(404, 'Bot not found'))],
  ])('are not served when %s', async (_name, query, arrange) => {
    arrange();
    expect((await ask(query)).status).toBe(404);
  });
});
