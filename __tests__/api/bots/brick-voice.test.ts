/**
 * A Brick's voice (game Slice 13): its owner turns it on, drafts and publishes a profile, and it speaks on Universe AI's providers
 * or on the owner's OWN voice keys, all of each key's models. It stands in no universe, so nothing is lent anywhere and no
 * universe's switch is asked. Nobody else gets to it. The database is a small in-memory stand-in.
 */
import { NextRequest } from 'next/server';
import { GET as getVoice, PUT as putVoice } from '@/app/api/bots/[id]/voice/route';
import { PUT as putDraft } from '@/app/api/bots/[id]/voice/draft/route';
import { POST as publish } from '@/app/api/bots/[id]/voice/publish/route';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBotMcpServers } from '@/lib/bot-permissions';
import { lendAccess } from '@/lib/ai-key-lend';
import { prisma } from '@/lib/db';
import { effectiveBotVoice } from '@/lib/bot-voice';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBotMcpServers: jest.fn() }));
jest.mock('@/lib/ai-key-lend', () => ({ lendAccess: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: {} }));
// A key's company is asked for its models: not here
jest.mock('@/lib/voice-discovery', () => ({ discoverVoiceModels: jest.fn(async () => undefined) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
let bot: Row;
let draft: Row | null;
let revisions: Row[];
let providers: Row[];

const fakeDb = () => {
  const db = {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    bot: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === bot.id ? { ...bot, room: null, voiceDraft: draft, voiceRevisions: [...revisions].sort((a, b) => b.number - a.number) } : null,
      update: async ({ data }: { data: Row }) => Object.assign(bot, data),
    },
    appSetting: { findUnique: async () => null },
    voiceKeyUsage: { findMany: async () => [] },
    botVoiceDraft: {
      findUnique: async () => draft,
      upsert: async ({ create, update }: { create: Row; update: Row }) => (draft = { ...(draft ?? create), ...update, updatedAt: new Date('2026-11-12T12:00:00Z') }),
    },
    botVoiceRevision: {
      findFirst: async () => [...revisions].sort((a, b) => b.number - a.number)[0] ?? null,
      findUnique: async ({ where }: { where: { botId_number: { number: number } } }) => revisions.find((r) => r.number === where.botId_number.number) ?? null,
      create: async ({ data }: { data: Row }) => {
        revisions.push({ ...data, note: data.note ?? null, publishedAt: new Date('2026-11-12T12:00:00Z') });
      },
    },
    voiceProvider: {
      findFirst: async () => null,
      findMany: async ({ where }: { where: Row }) => {
        const withLends = (list: Row[]) => list.map((p) => ({ createdAt: new Date('2026-11-12T10:00:00Z'), adapter: 'x', apiKeyLast4: null, ownerId: null, ...p, lends: [] }));
        // By id (the providers a profile names), then the owner's own keys; a lend filter would find nothing for a Brick
        if (where.id) return withLends(providers.filter((p) => where.id.in.includes(p.id)));
        if (where.lends) return [];
        return withLends(providers.filter((p) => p.ownerId === where.ownerId));
      },
    },
  };
  Object.assign(prisma, db);
};

const ears = (changes: Row = {}): Row => ({ id: 'my-ears', name: 'My Deepgram', ownerId: 'u-sara', recognition: true, speech: false, enabled: true, apiKeyEncrypted: 'iv:tag:data', models: [{ id: 'nova', kind: 'recognition' }, { id: 'nova-2', kind: 'recognition' }], ...changes });
const mouth = (changes: Row = {}): Row => ({ id: 'my-mouth', name: 'My ElevenLabs', ownerId: 'u-sara', recognition: false, speech: true, enabled: true, apiKeyEncrypted: 'iv:tag:data', models: [{ id: 'v4', kind: 'speech' }], ...changes });
const FINISHED = {
  recognition: { providerId: 'my-ears', model: 'nova-2' },
  speech: { providerId: 'my-mouth', model: 'v4', voiceId: 'nora', voiceName: 'Nora' },
  expression: 'natural',
  language: { mode: 'follow' },
};

const ctx = { params: Promise.resolve({ id: 'brick-1' }) };
type Handler = (r: NextRequest, c: typeof ctx) => Promise<Response>;
const call = (handler: Handler, method: string, body?: unknown) =>
  handler(new NextRequest('http://localhost:3333/api/bots/brick-1/voice', { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), ctx);

beforeEach(() => {
  bot = { id: 'brick-1', createdById: 'u-sara', ownerId: 'u-sara', roomId: null, deletedAt: null, voiceEnabled: false, voiceRevision: null };
  draft = null;
  revisions = [];
  providers = [ears(), mouth()];
  fakeDb();
  (getSessionUser as jest.Mock).mockReset().mockResolvedValue({ id: 'u-sara', email: 'sara@example.com' });
  (canManageBotMcpServers as jest.Mock).mockReset().mockResolvedValue(true);
  (lendAccess as jest.Mock).mockReset().mockResolvedValue('manage');
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('a Brick’s voice settings', () => {
  it('are there for its owner: off, allowed (no universe to forbid it), and the owner’s own keys with every model', async () => {
    const response = await call(getVoice, 'GET');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ enabled: false, universeAllows: true, revision: null, revisions: [] });
    expect(body.lentKeys.map((key: Row) => key.id)).toEqual(['my-ears', 'my-mouth']);
    expect(body.lentKeys[0].models.map((model: Row) => model.id)).toEqual(['nova', 'nova-2']);
    // Nothing is lent to a universe, so no universe's lend is looked up
    expect(lendAccess).not.toHaveBeenCalled();
  });

  it('are never someone else’s keys: another person’s key is not listed', async () => {
    providers = [ears({ ownerId: 'u-omar' }), mouth()];
    const body = await (await call(getVoice, 'GET')).json();
    expect(body.lentKeys.map((key: Row) => key.id)).toEqual(['my-mouth']);
  });

  it('answer "not found" for a Brick that waits deleted, and for one that does not exist', async () => {
    bot.deletedAt = new Date('2026-11-12T09:00:00Z');
    const gone = await call(getVoice, 'GET');
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'Bot not found' });
    expect((await call(putDraft, 'PUT', FINISHED)).status).toBe(404);
    expect((await call(putVoice, 'PUT', { enabled: true })).status).toBe(404);
    expect(draft).toBeNull();
    expect(bot.voiceEnabled).toBe(false);
  });
});

describe('giving a Brick a voice', () => {
  it('drafts and publishes a profile on the owner’s own keys, then turns voice on: it speaks', async () => {
    expect((await call(putDraft, 'PUT', FINISHED)).status).toBe(200);
    const published = await call(publish, 'POST', { note: 'First' });
    expect(published.status).toBe(200);
    expect(revisions).toHaveLength(1);
    expect(bot.voiceRevision).toBe(1);
    const on = await call(putVoice, 'PUT', { enabled: true });
    expect(on.status).toBe(200);
    expect(bot.voiceEnabled).toBe(true);
    const speaks = await effectiveBotVoice('brick-1');
    expect(speaks).toMatchObject({ speaks: true, reason: null, paidBy: 'owner', parts: { recognition: 'owner', speech: 'owner' } });
    expect(speaks.profile).toMatchObject({ recognition: { providerId: 'my-ears', model: 'nova-2' }, speech: { providerId: 'my-mouth' } });
    expect(lendAccess).not.toHaveBeenCalled();
  });

  it('will not publish a profile that names someone else’s key', async () => {
    providers = [ears({ ownerId: 'u-omar' }), mouth()];
    await call(putDraft, 'PUT', FINISHED);
    const refused = await call(publish, 'POST', {});
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain("doesn't exist");
    expect(revisions).toHaveLength(0);
  });

  it('will not turn voice on before a profile is published, and says so', async () => {
    const refused = await call(putVoice, 'PUT', { enabled: true });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe('Publish a voice profile first');
    expect(bot.voiceEnabled).toBe(false);
  });

  it('is silent while voice is off, and is not held back by any universe’s switch', async () => {
    await call(putDraft, 'PUT', FINISHED);
    await call(publish, 'POST', {});
    expect(await effectiveBotVoice('brick-1')).toMatchObject({ speaks: false, reason: 'off' });
    bot.voiceEnabled = true;
    expect(await effectiveBotVoice('brick-1')).toMatchObject({ speaks: true, reason: null });
    bot.deletedAt = new Date('2026-11-12T09:00:00Z');
    expect(await effectiveBotVoice('brick-1')).toMatchObject({ speaks: false, reason: 'off' });
  });
});
