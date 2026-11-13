/**
 * What a bot hears voice notes with (game: every bot hears voice notes): GET /api/bots/:id/voice/hearing, GET
 * /api/guest-brick/hearing and GET /api/voice-notes/capabilities. Hearing a note is apart from talking live: the Voice switch, the
 * universe's "Allow voice bots" and a broken speaking provider never stop it. A working key of the maker's is heard with and the
 * maker pays; otherwise Universe AI hears; nothing hears only when Universe AI has no listening the bot server can use. Nothing
 * here calls a provider. The database is a small in-memory stand-in.
 */
import { NextRequest } from 'next/server';
import { GET as getHearing } from '@/app/api/bots/[id]/voice/hearing/route';
import { GET as getGuestHearing } from '@/app/api/guest-brick/hearing/route';
import { GET as getCapabilities } from '@/app/api/voice-notes/capabilities/route';
import { GET as getActive } from '@/app/api/bots/[id]/voice/active/route';
import { lendAccess } from '@/lib/ai-key-lend';
import { prisma } from '@/lib/db';
import { matches } from '../../helpers/voice-provider-rows';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/ai-key-lend', () => ({ lendAccess: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: {} }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
let bot: Row;
let universe: Row;
let revisions: Row[];
let providers: Row[];
let lends: Row[];

const fakeDb = () => {
  Object.assign(prisma, {
    bot: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === bot.id ? { ...bot, room: bot.roomId ? { world: { universeId: 'uni-1', universe } } : null } : null,
    },
    appSetting: { findUnique: async () => null },
    botVoiceRevision: {
      findUnique: async ({ where }: { where: { botId_number: { number: number } } }) => revisions.find((r) => r.number === where.botId_number.number) ?? null,
    },
    voiceProvider: {
      findUnique: async ({ where }: { where: { id: string } }) => providers.find((p) => p.id === where.id) ?? null,
      findMany: async ({ where }: { where: Row }) =>
        providers
          .filter((p) => (where.id ? where.id.in.includes(p.id) : matches({ ownerId: null, ...p }, where)))
          .map((p) => ({ ownerId: null, downSince: null, downPart: null, endpoint: null, region: null, ...p, lends: lends.filter((l) => l.providerId === p.id && l.universeId === 'uni-1') })),
    },
  });
};

/** Universe AI's listening: Soniox, the default for listening. */
const soniox = (changes: Row = {}): Row => ({
  id: 'ua-soniox',
  name: 'Soniox',
  adapter: 'soniox',
  recognition: true,
  speech: false,
  enabled: true,
  defaultRecognition: true,
  apiKeyEncrypted: 'iv:tag:ua',
  models: [{ id: 'stt-rt-v3', kind: 'recognition' }],
  ...changes,
});
/** Universe AI's speaking. */
const eleven = (changes: Row = {}): Row => ({
  id: 'ua-eleven',
  name: 'ElevenLabs',
  adapter: 'elevenlabs',
  recognition: false,
  speech: true,
  enabled: true,
  defaultSpeech: true,
  apiKeyEncrypted: 'iv:tag:ua-speak',
  models: [{ id: 'v4', kind: 'speech' }],
  ...changes,
});
/** The maker's own Soniox key, lent to the bot's universe. */
const ownKey = (changes: Row = {}): Row => soniox({ id: 'key-soniox', name: 'My Soniox', ownerId: 'u-maker', defaultRecognition: false, apiKeyEncrypted: 'iv:tag:own', ...changes });

const profile = (recognitionId: string, model = 'stt-rt-v3', language: Row = { mode: 'follow' }) => ({
  recognition: { providerId: recognitionId, model },
  speech: { providerId: 'ua-eleven', model: 'v4', voiceId: 'nora' },
  expression: 'natural',
  language,
});
const publish = (value: Row) => {
  revisions = [{ botId: 'bot-1', number: 1, profile: value }];
  bot.voiceRevision = 1;
};

const TOKEN = 'service-secret';
const asBotServer = { authorization: `Bearer ${TOKEN}` };
const hearing = async (adapters: string | null = 'soniox', headers: Record<string, string> = asBotServer) => {
  const query = adapters === null ? '' : `?adapters=${adapters}`;
  return getHearing(new NextRequest(`http://localhost:3333/api/bots/bot-1/voice/hearing${query}`, { headers }), { params: Promise.resolve({ id: 'bot-1' }) });
};
const heard = async (adapters?: string) => (await hearing(adapters)).json();

beforeEach(() => {
  process.env.BOT_SERVICE_TOKEN = TOKEN;
  bot = { id: 'bot-1', createdById: 'u-maker', ownerId: null, roomId: 'room-1', deletedAt: null, voiceEnabled: false, voiceRevision: null };
  universe = { allowVoiceBots: true };
  revisions = [];
  providers = [soniox(), eleven()];
  lends = [];
  fakeDb();
  (lendAccess as jest.Mock).mockReset().mockResolvedValue('manage');
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('who may ask', () => {
  it('is the bot server only', async () => {
    expect((await hearing('soniox', {})).status).toBe(401);
    expect((await hearing('soniox', { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await getGuestHearing(new NextRequest('http://localhost:3333/api/guest-brick/hearing?adapters=soniox'))).status).toBe(401);
    expect((await getCapabilities(new NextRequest('http://localhost:3333/api/voice-notes/capabilities'))).status).toBe(401);
  });

  it('must say which providers it can send a file to', async () => {
    expect((await hearing(null)).status).toBe(400);
  });

  it('is told a bot that is not there is not there', async () => {
    bot.id = 'other';
    expect((await hearing()).status).toBe(404);
  });
});

describe('a bot with no voice of its own', () => {
  it('hears with Universe AI, with voice off and no profile, and Universe AI pays', async () => {
    expect(await heard()).toEqual({
      v: 1,
      route: 'universe-ai',
      reason: null,
      payer: 'universe-ai',
      provider: { id: 'ua-soniox', adapter: 'soniox', name: 'Soniox', endpoint: null, region: null, apiKeyEncrypted: 'iv:tag:ua' },
      model: 'stt-rt-v3',
      language: null,
    });
  });

  it('still hears when its universe does not allow voice bots, while it still does not talk live', async () => {
    universe.allowVoiceBots = false;
    bot.voiceEnabled = true;
    publish(profile('ua-soniox'));
    expect(await heard()).toMatchObject({ route: 'universe-ai', payer: 'universe-ai' });
    const active = await (await getActive(new NextRequest('http://localhost:3333/x', { headers: asBotServer }), { params: Promise.resolve({ id: 'bot-1' }) })).json();
    expect(active).toMatchObject({ speaks: false, reason: 'universe' });
  });

  it('hears nothing when Universe AI has no listening that is on, with a key and a listening model', async () => {
    for (const change of [{ enabled: false }, { apiKeyEncrypted: null }, { models: [] }, { defaultRecognition: false }]) {
      providers = [soniox(change), eleven()];
      expect(await heard()).toEqual({ v: 1, route: 'none', reason: 'universe-ai-off', payer: null, provider: null, model: null, language: null });
    }
  });

  it('hears nothing when the bot server cannot send Universe AI\'s listening provider a file', async () => {
    expect(await heard('deepgram')).toMatchObject({ route: 'none', reason: 'no-file-hearer', provider: null });
  });
});

describe('a bot on Universe AI\'s voice', () => {
  it('hears with the language its maker fixed, voice switch off', async () => {
    publish(profile('ua-soniox', 'stt-rt-v3', { mode: 'fixed', code: 'ar-KW' }));
    expect(await heard()).toMatchObject({ route: 'universe-ai', language: 'ar-KW', model: 'stt-rt-v3' });
  });

  it('follows Universe AI\'s current listening model, as live voice does', async () => {
    publish(profile('ua-soniox', 'stt-rt-v2'));
    providers = [soniox({ models: [{ id: 'stt-rt-v4', kind: 'recognition' }] }), eleven()];
    expect(await heard()).toMatchObject({ route: 'universe-ai', model: 'stt-rt-v4' });
  });

  it('hears with Universe AI\'s default when its speaking provider is broken', async () => {
    publish(profile('ua-soniox'));
    providers = [soniox(), eleven({ apiKeyEncrypted: null })];
    expect(await heard()).toMatchObject({ route: 'universe-ai', provider: { id: 'ua-soniox' } });
  });

  it('hears with the default when the server provider it names cannot read a file', async () => {
    providers = [soniox(), eleven(), soniox({ id: 'ua-deepgram', name: 'Deepgram', adapter: 'deepgram', defaultRecognition: false, models: [{ id: 'nova', kind: 'recognition' }] })];
    publish(profile('ua-deepgram', 'nova'));
    expect(await heard()).toMatchObject({ route: 'universe-ai', provider: { id: 'ua-soniox' }, model: 'stt-rt-v3' });
  });
});

describe('a bot whose maker lent their own listening key', () => {
  beforeEach(() => {
    providers = [soniox(), eleven(), ownKey()];
    lends = [{ providerId: 'key-soniox', universeId: 'uni-1', models: null }];
    publish(profile('key-soniox'));
  });

  it('hears with the key and the maker pays, with voice off', async () => {
    expect(await heard()).toEqual({
      v: 1,
      route: 'owner-key',
      reason: null,
      payer: 'owner',
      provider: { id: 'key-soniox', adapter: 'soniox', name: 'My Soniox', endpoint: null, region: null, apiKeyEncrypted: 'iv:tag:own' },
      model: 'stt-rt-v3',
      language: null,
    });
  });

  it('hears with the key when Universe AI\'s listening is off', async () => {
    providers = [soniox({ enabled: false }), eleven(), ownKey()];
    expect(await heard()).toMatchObject({ route: 'owner-key', payer: 'owner' });
  });

  it('hears with the key when its universe does not allow voice bots', async () => {
    universe.allowVoiceBots = false;
    expect(await heard()).toMatchObject({ route: 'owner-key' });
  });

  it.each([
    ['is Down for listening', () => Object.assign(providers[2], { downSince: new Date(), downPart: 'recognition' })],
    ['is Down for every job', () => Object.assign(providers[2], { downSince: new Date(), downPart: null })],
    ['is off', () => Object.assign(providers[2], { enabled: false })],
    ['has no key any more', () => Object.assign(providers[2], { apiKeyEncrypted: null })],
    ['no longer lists the model', () => Object.assign(providers[2], { models: [{ id: 'stt-rt-v9', kind: 'recognition' }] })],
    ['is lent without the model', () => (lends = [{ providerId: 'key-soniox', universeId: 'uni-1', models: ['recognition:other'] }])],
  ])('never uses a key that %s: Universe AI hears instead', async (_name, arrange) => {
    arrange();
    expect(await heard()).toMatchObject({ route: 'universe-ai', reason: 'own-key-unusable', payer: 'universe-ai', provider: { id: 'ua-soniox', apiKeyEncrypted: 'iv:tag:ua' } });
  });

  it('uses a key that is Down only for speaking', async () => {
    Object.assign(providers[2], { downSince: new Date(), downPart: 'speech' });
    expect(await heard()).toMatchObject({ route: 'owner-key' });
  });

  it('never uses a key the bot server cannot send a file to: Universe AI hears instead', async () => {
    expect(await heard('soniox')).toMatchObject({ route: 'owner-key' });
    providers[2].adapter = 'deepgram';
    expect(await heard('soniox')).toMatchObject({ route: 'universe-ai', reason: 'own-key-unusable' });
  });

  it.each([
    ['pulled from the universe', () => (lends = [])],
    ['lent by someone who can no longer manage bots there', () => (lendAccess as jest.Mock).mockResolvedValue(null)],
    ['someone else\'s', () => (providers[2].ownerId = 'u-other')],
  ])('never uses a key that is %s', async (_name, arrange) => {
    arrange();
    const answer = await heard();
    expect(answer).toMatchObject({ route: 'universe-ai', payer: 'universe-ai', provider: { id: 'ua-soniox' } });
    expect(JSON.stringify(answer)).not.toContain('iv:tag:own');
  });

  it('hears nothing when the key can\'t be used and Universe AI is off', async () => {
    providers = [soniox({ enabled: false }), eleven(), ownKey({ enabled: false })];
    expect(await heard()).toMatchObject({ route: 'none', reason: 'universe-ai-off', provider: null });
  });
});

describe('a Brick', () => {
  beforeEach(() => {
    bot = { id: 'bot-1', createdById: 'u-someone', ownerId: 'u-owner', roomId: null, deletedAt: null, voiceEnabled: false, voiceRevision: null };
  });

  it('hears with its owner\'s own key, lent nowhere', async () => {
    providers = [soniox(), eleven(), ownKey({ ownerId: 'u-owner' })];
    publish(profile('key-soniox'));
    expect(await heard()).toMatchObject({ route: 'owner-key', payer: 'owner', provider: { id: 'key-soniox' } });
  });

  it('hears with Universe AI when it has no voice', async () => {
    expect(await heard()).toMatchObject({ route: 'universe-ai' });
  });

  it('is not there once deleted', async () => {
    bot.deletedAt = new Date();
    expect((await hearing()).status).toBe(404);
  });
});

describe('the Brick for guests', () => {
  const guestHearing = async (query = '?adapters=soniox') =>
    getGuestHearing(new NextRequest(`http://localhost:3333/api/guest-brick/hearing${query}`, { headers: asBotServer }));

  it('hears with Universe AI only', async () => {
    expect(await (await guestHearing()).json()).toMatchObject({ route: 'universe-ai', payer: 'universe-ai', provider: { id: 'ua-soniox' }, model: 'stt-rt-v3' });
  });

  it('hears nothing when Universe AI\'s listening is off', async () => {
    providers = [soniox({ enabled: false })];
    expect(await (await guestHearing()).json()).toMatchObject({ route: 'none', reason: 'universe-ai-off' });
  });

  it('must say which providers it can send a file to', async () => {
    expect((await guestHearing('')).status).toBe(400);
  });
});

describe('what this Orbit can do for voice notes', () => {
  it('says which parts are here and which are still to come', async () => {
    const response = await getCapabilities(new NextRequest('http://localhost:3333/api/voice-notes/capabilities', { headers: asBotServer }));
    expect(await response.json()).toEqual({ voiceNotes: { v: 1, hearing: true, reservations: true, turns: true, receipts: false, carry: false } });
  });
});
