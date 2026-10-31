/**
 * /api/bots/:id/voice, /voice/draft, /voice/publish, /voice/rollback and /voice/active (#740): voice is off until a person with
 * Manage bots turns it on, a profile is drafted, published as a revision and rolled back, and the bot server reads whether the
 * bot speaks right now. Nothing here calls a provider. The database is a small in-memory stand-in.
 */
import { NextRequest } from 'next/server';
import { GET as getVoice, PUT as putVoice } from '@/app/api/bots/[id]/voice/route';
import { PUT as putDraft } from '@/app/api/bots/[id]/voice/draft/route';
import { POST as publish } from '@/app/api/bots/[id]/voice/publish/route';
import { POST as rollback } from '@/app/api/bots/[id]/voice/rollback/route';
import { GET as getActive } from '@/app/api/bots/[id]/voice/active/route';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBotMcpServers } from '@/lib/bot-permissions';
import { lendAccess } from '@/lib/ai-key-lend';
import { prisma } from '@/lib/db';
import { POST as reportKeyCall } from '@/app/api/voice/providers/[id]/health/route';
import { GET as getCredentials } from '@/app/api/voice/providers/[id]/credentials/route';
import { matches, applyData } from '../../helpers/voice-provider-rows';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBotMcpServers: jest.fn() }));
jest.mock('@/lib/ai-key-lend', () => ({ lendAccess: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: {} }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
let bot: Row;
let universe: Row;
let draft: Row | null;
let revisions: Row[];
let providers: Row[];
let lends: Row[];

const fakeDb = () => {
  const db = {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    bot: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: Row }) => {
        if (where.id !== bot.id) return null;
        return {
          ...bot,
          room: { world: { universeId: 'uni-1', universe } },
          voiceDraft: draft,
          voiceRevisions: [...revisions].sort((a, b) => b.number - a.number),
          ...(select ? {} : {}),
        };
      },
      update: async ({ data }: { data: Row }) => Object.assign(bot, data),
    },
    botVoiceDraft: {
      findUnique: async () => draft,
      upsert: async ({ create, update }: { create: Row; update: Row }) => (draft = { ...(draft ?? create), ...update, updatedAt: new Date('2026-10-30T12:00:00Z') }),
    },
    botVoiceRevision: {
      findFirst: async () => [...revisions].sort((a, b) => b.number - a.number)[0] ?? null,
      findUnique: async ({ where }: { where: { botId_number: { number: number } } }) => revisions.find((r) => r.number === where.botId_number.number) ?? null,
      create: async ({ data }: { data: Row }) => {
        if (revisions.some((r) => r.number === data.number)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        revisions.push({ ...data, note: data.note ?? null, publishedAt: new Date('2026-10-30T12:00:00Z') });
      },
    },
    voiceProvider: {
      findFirst: async ({ where }: { where: Row }) => providers.find((p) => matches({ ownerId: null, ...p }, where)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => providers.find((p) => p.id === where.id) ?? null,
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = providers.filter((p) => matches({ ownerId: null, ...p }, where));
        for (const p of hit) applyData(p, data);
        return { count: hit.length };
      },
      findMany: async ({ where }: { where: { id?: { in: string[] }; ownerId?: string } }) =>
        providers
          .filter((p) => (where.id ? where.id.in.includes(p.id) : p.ownerId === where.ownerId))
          .map((p) => ({ ownerId: null, createdAt: new Date('2026-10-30T10:00:00Z'), adapter: 'x', apiKeyLast4: null, ...p, lends: lends.filter((l) => l.providerId === p.id && l.universeId === 'uni-1') })),
    },
  };
  Object.assign(prisma, db);
};

const provider = (changes: Row = {}): Row => ({
  id: 'ears',
  name: 'Deepgram',
  recognition: true,
  speech: false,
  enabled: true,
  apiKeyEncrypted: 'iv:tag:data',
  models: [{ id: 'nova', kind: 'recognition' }],
  ...changes,
});
const voice = (changes: Row = {}): Row => ({
  id: 'mouth',
  name: 'ElevenLabs',
  recognition: false,
  speech: true,
  enabled: true,
  apiKeyEncrypted: 'iv:tag:data',
  models: [{ id: 'v4', kind: 'speech' }],
  ...changes,
});
const FINISHED = {
  recognition: { providerId: 'ears', model: 'nova' },
  speech: { providerId: 'mouth', model: 'v4', voiceId: 'nora', voiceName: 'Nora' },
  expression: 'expressive',
  language: { mode: 'fixed', code: 'ar-KW' },
};

const ctx = { params: Promise.resolve({ id: 'bot-1' }) };
type Handler = (r: NextRequest, c: typeof ctx) => Promise<Response>;
const call = (handler: Handler, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  handler(new NextRequest('http://localhost:3333/api/bots/bot-1/voice', { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), ctx);
const asGame = { Authorization: 'Bearer service-secret' };

beforeEach(() => {
  process.env.BOT_SERVICE_TOKEN = 'service-secret';
  bot = { id: 'bot-1', createdById: 'u-maker', roomId: 'room-1', voiceEnabled: false, voiceRevision: null };
  universe = { allowVoiceBots: true };
  draft = null;
  revisions = [];
  providers = [provider(), voice()];
  lends = [];
  fakeDb();
  (getSessionUser as jest.Mock).mockReset().mockResolvedValue({ id: 'u-sara', email: 'sara@example.com' });
  (canManageBotMcpServers as jest.Mock).mockReset().mockResolvedValue(true);
  (lendAccess as jest.Mock).mockReset().mockResolvedValue('manage');
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const saveAndPublish = async () => {
  await call(putDraft, 'PUT', FINISHED);
  return call(publish, 'POST', { note: 'First' });
};

describe('who may', () => {
  it('read and change a bot\'s voice: people with Manage bots, nobody else', async () => {
    (canManageBotMcpServers as jest.Mock).mockResolvedValue(false);
    for (const response of [await call(getVoice, 'GET'), await call(putVoice, 'PUT', { enabled: true }), await call(putDraft, 'PUT', FINISHED), await call(publish, 'POST'), await call(rollback, 'POST', { number: 1 })]) {
      expect(response.status).toBe(403);
    }
    expect(draft).toBeNull();
    expect(bot.voiceEnabled).toBe(false);
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await call(getVoice, 'GET')).status).toBe(401);
  });

  it('read whether it speaks: the bot server only', async () => {
    expect((await call(getActive, 'GET')).status).toBe(401);
    expect((await call(getActive, 'GET', undefined, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call(getActive, 'GET', undefined, asGame)).status).toBe(200);
  });
});

describe('a bot that has never had voice', () => {
  it('has it off, no draft and no revision, and the universe\'s answer', async () => {
    const body = await (await call(getVoice, 'GET')).json();
    expect(body).toEqual({
      enabled: false,
      universeAllows: true,
      paidBy: 'universe-ai',
      parts: { recognition: 'universe-ai', speech: 'universe-ai' },
      revision: null,
      draft: { profile: {}, updatedAt: null },
      revisions: [],
      lentKeys: [],
    });
  });

  it('does not speak, because voice is off', async () => {
    expect(await (await call(getActive, 'GET', undefined, asGame)).json()).toEqual({ speaks: false, reason: 'off', paidBy: 'universe-ai', parts: { recognition: 'universe-ai', speech: 'universe-ai' }, revision: null, profile: null, down: null });
  });

  it('can\'t be switched on until a profile is published', async () => {
    const response = await call(putVoice, 'PUT', { enabled: true });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('Publish a voice profile first');
    expect(bot.voiceEnabled).toBe(false);
  });
});

describe('the draft', () => {
  it('is saved a part at a time and comes back', async () => {
    const response = await call(putDraft, 'PUT', { speech: { providerId: 'mouth', model: 'v4' }, expression: 'restrained' });
    expect(response.status).toBe(200);
    expect((await response.json()).draft.profile).toEqual({ speech: { providerId: 'mouth', model: 'v4' }, expression: 'restrained' });
  });

  it('turns down what isn\'t a voice profile', async () => {
    for (const body of [{ expression: 'loud' }, { speech: { voiceId: 'x', extra: 1 } }, { language: { mode: 'fixed' } }, { language: { mode: 'fixed', code: 'not a code!' } }, { colour: 'red' }, 'text']) {
      expect((await call(putDraft, 'PUT', body)).status).toBe(400);
    }
    expect(draft).toBeNull();
  });
});

describe('publishing', () => {
  it('needs a finished draft, and says which part is missing', async () => {
    await call(putDraft, 'PUT', { recognition: FINISHED.recognition });
    const response = await call(publish, 'POST');
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('The voice profile isn\'t finished: speech is missing');
    expect(revisions).toHaveLength(0);
  });

  it('makes revision 1 that the bot speaks with, and the draft stays', async () => {
    const response = await saveAndPublish();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.revision).toBe(1);
    expect(body.revisions).toHaveLength(1);
    expect(body.revisions[0]).toMatchObject({ number: 1, note: 'First', publishedById: 'u-sara', profile: FINISHED });
    expect(body.draft.profile).toEqual(FINISHED);
    expect(bot.voiceRevision).toBe(1);
  });

  it('fills in Natural and Follow the person when the draft leaves them out', async () => {
    await call(putDraft, 'PUT', { recognition: FINISHED.recognition, speech: FINISHED.speech });
    await call(publish, 'POST');
    expect(revisions[0].profile).toMatchObject({ expression: 'natural', language: { mode: 'follow' } });
  });

  it.each([
    ['a provider that doesn\'t exist', () => providers.splice(0, 1), 'The provider chosen for listening doesn\'t exist'],
    ['a provider that is off', () => (providers[0].enabled = false), 'Deepgram is off'],
    ['a provider without its key', () => (providers[1].apiKeyEncrypted = null), 'ElevenLabs has no key'],
    ['a provider that doesn\'t do that job', () => (providers[1].speech = false), 'ElevenLabs doesn\'t do speaking'],
    ['a model the provider doesn\'t list', () => (providers[0].models = []), 'Deepgram doesn\'t list the model nova for listening'],
  ])('is refused for %s', async (_name, change, line) => {
    change();
    const response = await saveAndPublish();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(line);
    expect(revisions).toHaveLength(0);
    expect(bot.voiceRevision).toBeNull();
  });

  it('counts up with each publish and never changes an earlier revision', async () => {
    await saveAndPublish();
    await call(putDraft, 'PUT', { ...FINISHED, expression: 'restrained' });
    const body = await (await call(publish, 'POST')).json();
    expect(body.revision).toBe(2);
    expect(revisions.map((r) => [r.number, r.profile.expression])).toEqual([[1, 'expressive'], [2, 'restrained']]);
  });

  it('says so when someone published at the same moment', async () => {
    await call(putDraft, 'PUT', FINISHED);
    const revisionTable = (prisma as unknown as { botVoiceRevision: { findFirst: () => Promise<unknown> } }).botVoiceRevision;
    const original = revisionTable.findFirst;
    revisionTable.findFirst = async () => null;
    revisions.push({ botId: 'bot-1', number: 1, profile: FINISHED, note: null, publishedAt: new Date() });
    const response = await call(publish, 'POST');
    revisionTable.findFirst = original;
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('Someone else just published. Look again and try again');
  });
});

describe('turning voice on and off', () => {
  it('works once a profile is published, and the bot then speaks with it', async () => {
    await saveAndPublish();
    const on = await call(putVoice, 'PUT', { enabled: true });
    expect(on.status).toBe(200);
    expect((await on.json()).enabled).toBe(true);
    expect(await (await call(getActive, 'GET', undefined, asGame)).json()).toEqual({ speaks: true, reason: null, paidBy: 'universe-ai', parts: { recognition: 'universe-ai', speech: 'universe-ai' }, revision: 1, profile: FINISHED, down: null });
  });

  it('is refused when the universe doesn\'t allow voice bots, and off always works', async () => {
    await saveAndPublish();
    universe.allowVoiceBots = false;
    const refused = await call(putVoice, 'PUT', { enabled: true });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe('This universe doesn\'t allow voice bots');
    bot.voiceEnabled = true;
    expect((await call(putVoice, 'PUT', { enabled: false })).status).toBe(200);
    expect(bot.voiceEnabled).toBe(false);
  });

  it('wants true or false', async () => {
    expect((await call(putVoice, 'PUT', { enabled: 'yes' })).status).toBe(400);
    expect((await call(putVoice, 'PUT', { enabled: true, extra: 1 })).status).toBe(400);
  });

  it('stops at once when the universe turns voice bots off or a provider goes off', async () => {
    await saveAndPublish();
    await call(putVoice, 'PUT', { enabled: true });
    const reason = async () => (await (await call(getActive, 'GET', undefined, asGame)).json()).reason;
    expect(await reason()).toBeNull();
    universe.allowVoiceBots = false;
    expect(await reason()).toBe('universe');
    universe.allowVoiceBots = true;
    providers[1].enabled = false;
    expect(await reason()).toBe('provider');
    providers[1].enabled = true;
    expect(await reason()).toBeNull();
  });
});

describe('rolling back', () => {
  it('names an earlier revision again, and leaves the draft alone', async () => {
    await saveAndPublish();
    await call(putDraft, 'PUT', { ...FINISHED, expression: 'restrained' });
    await call(publish, 'POST');
    expect(bot.voiceRevision).toBe(2);
    const response = await call(rollback, 'POST', { number: 1 });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.revision).toBe(1);
    expect(body.revisions).toHaveLength(2);
    expect(body.draft.profile.expression).toBe('restrained');
  });

  it('is refused for a revision that isn\'t there and for one whose providers don\'t work now', async () => {
    await saveAndPublish();
    expect((await call(rollback, 'POST', { number: 9 })).status).toBe(404);
    expect((await call(rollback, 'POST', { number: 0 })).status).toBe(400);
    expect((await call(rollback, 'POST', { number: 2_147_483_648 })).status).toBe(400);
    expect((await call(rollback, 'POST', { number: 1.5 })).status).toBe(400);
    providers[0].enabled = false;
    const response = await call(rollback, 'POST', { number: 1 });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('Deepgram is off');
  });
});

describe('a bot that isn\'t there', () => {
  it('is a 404 for the bot server', async () => {
    const response = await getActive(new NextRequest('http://localhost:3333/x', { headers: asGame }), { params: Promise.resolve({ id: 'nope' }) });
    expect(response.status).toBe(404);
  });
});

describe('a bot that speaks on a key its maker lent', () => {
  const key = (changes: Row = {}): Row => voice({ ownerId: 'u-maker', ...changes });
  const lend = (models: string[] | null = null): Row => ({ providerId: 'mouth', universeId: 'uni-1', models });
  const lentVoice = () => {
    providers = [provider(), key()];
    lends = [lend()];
  };

  it('publishes, speaks, and says the key\'s owner pays for the speaking', async () => {
    lentVoice();
    expect((await saveAndPublish()).status).toBe(200);
    await call(putVoice, 'PUT', { enabled: true });
    expect(await (await call(getActive, 'GET', undefined, asGame)).json()).toMatchObject({
      speaks: true,
      reason: null,
      paidBy: 'mixed',
      parts: { recognition: 'universe-ai', speech: 'owner' },
    });
    expect((await (await call(getVoice, 'GET')).json()).paidBy).toBe('mixed');
  });

  it('says the owner pays for both when both parts are on lent keys', async () => {
    providers = [provider({ ownerId: 'u-maker' }), key()];
    lends = [{ providerId: 'ears', universeId: 'uni-1', models: null }, lend()];
    await saveAndPublish();
    await call(putVoice, 'PUT', { enabled: true });
    expect(await (await call(getActive, 'GET', undefined, asGame)).json()).toMatchObject({ paidBy: 'owner', parts: { recognition: 'owner', speech: 'owner' } });
  });

  it.each([
    ['isn\'t lent to this universe', () => { lends = []; }],
    ['was lent to another universe', () => { lends = [{ providerId: 'mouth', universeId: 'uni-2', models: null }]; }],
    ['belongs to someone who didn\'t make the bot', () => { providers = [provider(), key({ ownerId: 'u-other' })]; }],
    ['belongs to a bot with no maker', () => { bot.createdById = null; }],
    ['is lent by a maker who can no longer manage bots there', () => { (lendAccess as jest.Mock).mockResolvedValue(null); }],
    ['is lent without the model the profile names', () => { lends = [lend(['speech:other'])]; }],
  ])('refuses to publish with a key that %s', async (_name, arrange) => {
    lentVoice();
    arrange();
    const response = await saveAndPublish();
    expect(response.status).toBe(409);
    expect(revisions).toHaveLength(0);
    expect(bot.voiceRevision).toBeNull();
  });

  it('publishes with a model the lend names', async () => {
    lentVoice();
    lends = [lend(['speech:v4'])];
    expect((await saveAndPublish()).status).toBe(200);
  });

  it('carries on in text the moment the key is pulled, deleted, or its model taken off, and speaks again when it is back', async () => {
    lentVoice();
    await saveAndPublish();
    await call(putVoice, 'PUT', { enabled: true });
    const active = async () => (await call(getActive, 'GET', undefined, asGame)).json();
    expect(await active()).toMatchObject({ speaks: true });
    const kept = lends;
    lends = [];
    expect(await active()).toMatchObject({ speaks: false, reason: 'provider', profile: null });
    lends = kept;
    providers = [provider()];
    expect(await active()).toMatchObject({ speaks: false, reason: 'provider' });
    providers = [provider(), key()];
    lends = [lend(['speech:other'])];
    expect(await active()).toMatchObject({ speaks: false, reason: 'provider' });
    lends = kept;
    expect(await active()).toMatchObject({ speaks: true });
    expect(bot.voiceEnabled).toBe(true);
  });

  it('lists to the bot\'s managers only the keys its maker lent here, with only the models the lend allows', async () => {
    providers = [provider(), key({ models: [{ id: 'v4', kind: 'speech' }, { id: 'v5', kind: 'speech' }], apiKeyLast4: '9f2a' }), key({ id: 'elsewhere', ownerId: 'u-other' })];
    lends = [lend(['speech:v4']), { providerId: 'elsewhere', universeId: 'uni-1', models: null }];
    const body = await (await call(getVoice, 'GET')).json();
    expect(body.lentKeys).toEqual([{ id: 'mouth', adapter: 'x', name: 'ElevenLabs', recognition: false, speech: true, last4: '9f2a', models: [{ id: 'v4', kind: 'speech' }] }]);
    expect(JSON.stringify(body)).not.toContain('iv:tag:data');
    (lendAccess as jest.Mock).mockResolvedValue(null);
    expect((await (await call(getVoice, 'GET')).json()).lentKeys).toEqual([]);
  });
});

describe('a bot whose key stopped working', () => {
  const lent = (changes: Row = {}): Row => voice({ ownerId: 'u-maker', ...changes });
  const lend = (): Row => ({ providerId: 'mouth', universeId: 'uni-1', models: null });
  const NOW = new Date('2026-10-30T11:00:00Z');
  const down = (since = new Date('2026-10-30T10:30:00Z'), checked: Date | null = since): Row => ({ downSince: since, downReason: 'credit', healthCheckedAt: checked });
  const active = async () => (await call(getActive, 'GET', undefined, asGame)).json();
  const report = (id: string, body: unknown) =>
    reportKeyCall(new NextRequest('http://localhost:3333/x', { method: 'POST', headers: { 'Content-Type': 'application/json', ...asGame }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

  beforeEach(async () => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'] });
    providers = [provider(), lent()];
    lends = [lend()];
    await saveAndPublish();
    await call(putVoice, 'PUT', { enabled: true });
  });
  afterEach(() => jest.useRealTimers());

  it('replies in text, with since when and why, and keeps voice turned on', async () => {
    expect(await active()).toMatchObject({ speaks: true, down: null });
    await report('mouth', { part: 'speech', ok: false, status: 402 });
    expect(await active()).toMatchObject({ speaks: false, reason: 'key-down', profile: null, down: { since: NOW.toISOString(), reason: 'credit' } });
    expect(bot.voiceEnabled).toBe(true);
    expect(bot.voiceRevision).toBe(1);
  });

  it('lets one turn through to try the key every 5 minutes, and the others stay in text', async () => {
    Object.assign(providers[1], down(new Date('2026-10-30T10:30:00Z'), new Date('2026-10-30T10:58:00Z')));
    expect(await active()).toMatchObject({ speaks: false, reason: 'key-down' });
    providers[1].healthCheckedAt = new Date('2026-10-30T10:54:00Z');
    expect(await active()).toMatchObject({ speaks: true, reason: null });
    expect(providers[1].healthCheckedAt).toEqual(NOW);
    expect(await active()).toMatchObject({ speaks: false, reason: 'key-down' });
  });

  it('is told the way back the moment the try works, and stays in text when the try fails', async () => {
    Object.assign(providers[1], down(undefined, new Date('2026-10-30T10:50:00Z')));
    expect(await active()).toMatchObject({ speaks: true });
    await report('mouth', { part: 'speech', ok: false, status: 402 });
    expect(await active()).toMatchObject({ speaks: false, reason: 'key-down' });
    providers[1].healthCheckedAt = null;
    expect(await active()).toMatchObject({ speaks: true });
    await report('mouth', { part: 'speech', ok: true });
    expect(await active()).toMatchObject({ speaks: true, reason: null, down: null });
    expect(providers[1].downSince).toBeNull();
  });

  it('serves the key to the turn that was let through, and to nobody for a bot that isn\'t using it', async () => {
    Object.assign(providers[1], down(undefined, new Date('2026-10-30T10:50:00Z')));
    expect(await active()).toMatchObject({ speaks: true });
    const fetchKey = (botId?: string) =>
      getCredentials(new NextRequest(`http://localhost:3333/x${botId ? `?botId=${botId}` : ''}`, { headers: asGame }), { params: Promise.resolve({ id: 'mouth' }) });
    expect((await fetchKey('bot-1')).status).toBe(200);
    expect((await fetchKey()).status).toBe(404);
  });

  it('can still be turned on while the key is down', async () => {
    await call(putVoice, 'PUT', { enabled: false });
    Object.assign(providers[1], down());
    const response = await call(putVoice, 'PUT', { enabled: true });
    expect(response.status).toBe(200);
    expect(bot.voiceEnabled).toBe(true);
  });

  it('is not held by a server provider\'s health, which has none', async () => {
    providers = [provider({ downSince: NOW }), lent()];
    expect(await active()).toMatchObject({ speaks: true });
  });
});
