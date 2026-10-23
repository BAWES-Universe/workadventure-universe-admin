/**
 * The bot server asks for a bot's AI by bot id (#374). DeepSeek on the openai type and LM Studio on local are served as
 * they always were; Universe AI follows the Default; a personal key is served only while it may run the bot.
 */
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET } from '@/app/api/bots/[id]/ai-credentials/route';
import { GET as providerCredentials } from '@/app/api/bots/ai-providers/[providerId]/credentials/route';
import { POST as trackUsage } from '@/app/api/bots/ai-usage/route';
import { checkKeyForBot } from '@/lib/ai-key-pay';
import { addNotice } from '@/lib/notices';
import { requireServiceToken } from '@/lib/service-tokens';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn(), updateMany: jest.fn() },
    botsAiProvider: { findUnique: jest.fn(), findFirst: jest.fn() },
    aiKeyLend: { findUnique: jest.fn(async () => null) },
    botsAiUsage: { create: jest.fn(async () => ({})) },
  },
}));
jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/ai-key-pay', () => ({ ...jest.requireActual('@/lib/ai-key-pay'), checkKeyForBot: jest.fn() }));
jest.mock('@/lib/notices', () => ({ addNotice: jest.fn() }));

const bot = prisma.bot as unknown as Record<'findUnique' | 'updateMany', jest.Mock>;
const provider = prisma.botsAiProvider as unknown as Record<'findUnique' | 'findFirst', jest.Mock>;
const usage = prisma.botsAiUsage as unknown as { create: jest.Mock };
const verdict = checkKeyForBot as jest.Mock;

const deepseek = {
  providerId: 'deepseek-flash', name: 'DeepSeek V4 Flash', type: 'openai', enabled: true, endpoint: 'https://api.deepseek.com',
  apiKeyEncrypted: 'enc:sk-secret', model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 500, supportsStreaming: true,
  supportsVision: null, visionModel: null, defaultVision: false, settings: {}, ownerId: null, isDefault: true,
};
const lmstudio = { ...deepseek, providerId: 'lmstudio-local', name: 'LM Studio Local', type: 'lmstudio', endpoint: 'http://localhost:1234', apiKeyEncrypted: null, model: 'qwen3-8b', isDefault: false };
const ownKey = { ...lmstudio, providerId: 'key-1', name: 'My LM Studio', endpoint: 'https://lm.example.com', ownerId: 'maker', settings: { kind: 'lmstudio' }, isDefault: false };

/** The fields the bot server was always given for a provider. */
const FIELDS = ['providerId', 'name', 'type', 'enabled', 'endpoint', 'apiKeyEncrypted', 'model', 'temperature', 'maxTokens', 'supportsStreaming', 'supportsVision', 'visionModel', 'defaultVision', 'settings'];

const botOn = (ref: string | null, over: object = {}) => ({
  id: 'b1', name: 'Sam', aiProviderRef: ref, createdById: 'maker', roomId: 'room-1',
  room: { world: { universe: { id: 'uni-1', name: 'BAWES Universe', ownerId: 'universe-owner' } } }, ...over,
});
const ask = (id = 'b1') => GET(new NextRequest(`http://localhost:3333/api/bots/${id}/ai-credentials`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  for (const fn of [...Object.values(bot), ...Object.values(provider), usage.create, verdict, addNotice as jest.Mock, requireServiceToken as jest.Mock]) fn.mockReset();
  usage.create.mockResolvedValue({});
});

describe('GET /api/bots/:id/ai-credentials', () => {
  it('needs the bot server’s service token', async () => {
    (requireServiceToken as jest.Mock).mockImplementation(() => {
      throw new Error('Unauthorized: Invalid service token');
    });
    expect((await ask()).status).toBe(401);
    expect(bot.findUnique).not.toHaveBeenCalled();
  });

  it('serves a bot pinned to DeepSeek on the openai type exactly the fields it always got, plus where it came from', async () => {
    bot.findUnique.mockResolvedValue(botOn('deepseek-flash'));
    provider.findUnique.mockResolvedValue(deepseek);
    const body = await (await ask()).json();
    expect(Object.keys(body).sort()).toEqual([...FIELDS, 'source'].sort());
    expect(body).toMatchObject({ providerId: 'deepseek-flash', type: 'openai', endpoint: 'https://api.deepseek.com', apiKeyEncrypted: 'enc:sk-secret', source: 'provider' });
  });

  it('serves a bot pinned to LM Studio on local the same way, with no key', async () => {
    bot.findUnique.mockResolvedValue(botOn('lmstudio-local'));
    provider.findUnique.mockResolvedValue(lmstudio);
    expect(await (await ask()).json()).toMatchObject({ providerId: 'lmstudio-local', type: 'lmstudio', apiKeyEncrypted: null, source: 'provider' });
  });

  it('is told a pinned provider is switched off, as before (400), never given it', async () => {
    bot.findUnique.mockResolvedValue(botOn('deepseek-flash'));
    provider.findUnique.mockResolvedValue({ ...deepseek, enabled: false });
    expect((await ask()).status).toBe(400);
  });

  it('serves a bot on Universe AI whatever the Default is right now, under that provider’s own id', async () => {
    bot.findUnique.mockResolvedValue(botOn('universe-ai'));
    provider.findFirst.mockResolvedValueOnce(lmstudio);
    expect(await (await ask()).json()).toMatchObject({ providerId: 'lmstudio-local', source: 'universe-ai' });
    provider.findFirst.mockResolvedValueOnce(deepseek);
    expect(await (await ask()).json()).toMatchObject({ providerId: 'deepseek-flash', source: 'universe-ai' });
  });

  it('says Universe AI is unavailable (503) when no provider is enabled', async () => {
    bot.findUnique.mockResolvedValue(botOn('universe-ai'));
    provider.findFirst.mockResolvedValue(null);
    expect((await ask()).status).toBe(503);
  });

  it('serves a personal key to the bot it may run: its maker’s, lent here', async () => {
    bot.findUnique.mockResolvedValue(botOn('key-1'));
    provider.findUnique.mockResolvedValue(ownKey);
    verdict.mockResolvedValue({ ok: true });
    const body = await (await ask()).json();
    expect(verdict).toHaveBeenCalledWith({ keyId: 'key-1', keyOwnerId: 'maker', makerId: 'maker', roomId: 'room-1' });
    expect(body).toMatchObject({ providerId: 'key-1', source: 'own-key', keyOwnerId: 'maker', keyKind: 'lmstudio', keyGroup: 'own-computer', keyAddressTyped: true, endpoint: 'https://lm.example.com' });
    expect(bot.updateMany).not.toHaveBeenCalled();
  });

  it('serves the bot’s own model on the key, with what the provider said about it, and only the bot sees it (#575)', async () => {
    const claude = { ...ownKey, type: 'anthropic', model: 'claude-sonnet-5-5', supportsVision: true, settings: { kind: 'claude', caps: { vision: true }, modelFacts: { 'claude-haiku-5-5': { vision: true }, 'claude-text-1': { vision: false } } } };
    provider.findUnique.mockResolvedValue(claude);
    verdict.mockResolvedValue({ ok: true, lendModels: null });
    bot.findUnique.mockResolvedValue(botOn('key-1', { aiModel: 'claude-text-1' }));
    let body = await (await ask()).json();
    expect(body).toMatchObject({ source: 'own-key', providerId: 'key-1', model: 'claude-text-1', supportsVision: false });
    // The facts about every model stay in Orbit, and the bot is told its own model's, not the check model's
    expect(body.settings).toEqual({ kind: 'claude', caps: { vision: false } });
    // No model of its own: the key's check model, exactly as before
    bot.findUnique.mockResolvedValue(botOn('key-1', { aiModel: null }));
    body = await (await ask()).json();
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', supportsVision: true });
    expect(body.settings).toEqual({ kind: 'claude', caps: { vision: true } });
    // A model the provider said nothing about: no facts, rather than the check model's
    bot.findUnique.mockResolvedValue(botOn('key-1', { aiModel: 'claude-new-1' }));
    body = await (await ask()).json();
    expect(body.settings).toEqual({ kind: 'claude' });
  });

  it('never serves a model the lend leaves out: the first one it allows', async () => {
    provider.findUnique.mockResolvedValue({ ...ownKey, model: 'qwen3-8b' });
    verdict.mockResolvedValue({ ok: true, lendModels: ['gemma-3-12b-it'] });
    bot.findUnique.mockResolvedValue(botOn('key-1', { aiModel: 'qwen3-8b' }));
    expect(await (await ask()).json()).toMatchObject({ source: 'own-key', model: 'gemma-3-12b-it' });
  });

  it('says a hosted key at its provider’s own base is not a typed address, and your own NIM address is', async () => {
    const hosted = { ...ownKey, providerId: 'key-2', type: 'openai', endpoint: 'https://api.deepseek.com', settings: { kind: 'deepseek' } };
    bot.findUnique.mockResolvedValue(botOn('key-2'));
    verdict.mockResolvedValue({ ok: true });
    provider.findUnique.mockResolvedValue(hosted);
    expect(await (await ask()).json()).toMatchObject({ keyGroup: 'hosted', keyAddressTyped: false });
    provider.findUnique.mockResolvedValue({ ...hosted, endpoint: 'https://nim.example.com/v1', settings: { kind: 'nim' } });
    expect(await (await ask()).json()).toMatchObject({ keyKind: 'nim', keyAddressTyped: true });
  });

  it.each([
    ['not-lent', /no longer lent to this universe/],
    ['no-access', /maker can no longer manage bots here/],
    ['not-maker', /isn’t its maker’s/],
  ])('when the key may no longer run the bot (%s): moves it to Universe AI, tells the universe owner once, serves Universe AI', async (reason, text) => {
    bot.findUnique.mockResolvedValue(botOn('key-1'));
    provider.findUnique.mockResolvedValue(ownKey);
    provider.findFirst.mockResolvedValue(deepseek);
    verdict.mockResolvedValue({ ok: false, reason });
    bot.updateMany.mockResolvedValue({ count: 1 });
    const body = await (await ask()).json();
    expect(bot.updateMany).toHaveBeenCalledWith({ where: { id: 'b1', aiProviderRef: 'key-1' }, data: { aiProviderRef: 'universe-ai', aiModel: null } });
    expect(addNotice).toHaveBeenCalledTimes(1);
    const notice = (addNotice as jest.Mock).mock.calls[0][0];
    expect(notice).toMatchObject({ userId: 'universe-owner', kind: 'ai-key-moved', dedupeKey: expect.stringMatching(/^moved:key-1:b1:\d{4}-/), title: 'Sam moved to Universe AI', href: '/admin/universes/uni-1' });
    expect(notice.body).toMatch(text);
    expect(body).toMatchObject({ providerId: 'deepseek-flash', source: 'universe-ai', movedFromKey: 'key-1' });
    // The key itself never goes out
    expect(JSON.stringify(body)).not.toContain('lm.example.com');
  });

  it('tells nobody when another request already moved the bot, and still serves Universe AI', async () => {
    bot.findUnique.mockResolvedValue(botOn('key-1'));
    provider.findUnique.mockResolvedValue(ownKey);
    provider.findFirst.mockResolvedValue(deepseek);
    verdict.mockResolvedValue({ ok: false, reason: 'not-lent' });
    bot.updateMany.mockResolvedValue({ count: 0 });
    const body = await (await ask()).json();
    expect(addNotice).not.toHaveBeenCalled();
    expect(body).toMatchObject({ source: 'universe-ai', movedFromKey: 'key-1' });
  });

  it('gives each move its own notice key, so a dismissed notice never hides a later move of the same bot off the same key', async () => {
    bot.findUnique.mockResolvedValue(botOn('key-1'));
    provider.findUnique.mockResolvedValue(ownKey);
    provider.findFirst.mockResolvedValue(deepseek);
    verdict.mockResolvedValue({ ok: false, reason: 'not-lent' });
    bot.updateMany.mockResolvedValue({ count: 1 });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout'] });
    try {
      jest.setSystemTime(new Date('2026-10-19T12:00:00Z'));
      await ask();
      jest.setSystemTime(new Date('2026-10-20T12:00:00Z'));
      await ask();
    } finally {
      jest.useRealTimers();
    }
    const keys = (addNotice as jest.Mock).mock.calls.map((call) => call[0].dedupeKey);
    expect(keys).toEqual(['moved:key-1:b1:2026-10-19T12:00:00.000Z', 'moved:key-1:b1:2026-10-20T12:00:00.000Z']);
  });

  it('still answers on Universe AI when the notice can’t be saved, and logs it', async () => {
    bot.findUnique.mockResolvedValue(botOn('key-1'));
    provider.findUnique.mockResolvedValue(ownKey);
    provider.findFirst.mockResolvedValue(deepseek);
    verdict.mockResolvedValue({ ok: false, reason: 'not-lent' });
    bot.updateMany.mockResolvedValue({ count: 1 });
    (addNotice as jest.Mock).mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await ask()).status).toBe(200);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('moves a bot whose personal key is gone to Universe AI and tells the universe owner, instead of leaving it quiet', async () => {
    bot.findUnique.mockResolvedValue(botOn('key-1'));
    provider.findUnique.mockResolvedValue(null);
    provider.findFirst.mockResolvedValue(deepseek);
    bot.updateMany.mockResolvedValue({ count: 1 });
    const body = await (await ask()).json();
    expect(bot.updateMany).toHaveBeenCalledWith({ where: { id: 'b1', aiProviderRef: 'key-1' }, data: { aiProviderRef: 'universe-ai', aiModel: null } });
    expect(addNotice).toHaveBeenCalledTimes(1);
    expect((addNotice as jest.Mock).mock.calls[0][0]).toMatchObject({ userId: 'universe-owner', title: 'Sam moved to Universe AI', body: expect.stringMatching(/was removed/) });
    expect(body).toMatchObject({ providerId: 'deepseek-flash', source: 'universe-ai', movedFromKey: 'key-1' });
    expect(verdict).not.toHaveBeenCalled();
  });

  it('says plainly when there is no bot, no provider on it, or the provider is gone', async () => {
    bot.findUnique.mockResolvedValue(null);
    expect((await ask()).status).toBe(404);
    bot.findUnique.mockResolvedValue(botOn(null));
    expect((await ask()).status).toBe(404);
    bot.findUnique.mockResolvedValue(botOn('deleted'));
    provider.findUnique.mockResolvedValue(null);
    expect((await ask()).status).toBe(404);
  });
});

describe('the old by-provider route is unchanged', () => {
  const call = (id: string) => providerCredentials(new NextRequest(`http://localhost:3333/api/bots/ai-providers/${id}/credentials`), { params: Promise.resolve({ providerId: id }) });

  it('still serves DeepSeek with exactly its fields, and still refuses a personal key by its id', async () => {
    provider.findUnique.mockResolvedValue(deepseek);
    const body = await (await call('deepseek-flash')).json();
    expect(Object.keys(body).sort()).toEqual([...FIELDS].sort());
    provider.findUnique.mockResolvedValue(ownKey);
    expect((await call('key-1')).status).toBe(404);
  });
});

describe('usage rows say who talked and whose key paid', () => {
  const track = (body: object) => trackUsage(new NextRequest('http://localhost:3333/api/bots/ai-usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

  it('records who talked, and the key’s owner from the provider row, never from the request', async () => {
    provider.findUnique.mockResolvedValue(ownKey);
    await track({ botId: 'b1', providerId: 'key-1', tokensUsed: 10, userId: 'chatter-1', keyOwnerId: 'liar' });
    expect(usage.create.mock.calls[0][0].data).toMatchObject({ botId: 'b1', providerId: 'key-1', talkedUserId: 'chatter-1', keyOwnerId: 'maker' });
  });

  it('records nothing about a key for the server’s own providers, and nothing about who when not told', async () => {
    provider.findUnique.mockResolvedValue(deepseek);
    await track({ botId: 'b1', providerId: 'deepseek-flash' });
    expect(usage.create.mock.calls[0][0].data).toMatchObject({ talkedUserId: null, keyOwnerId: null });
  });
});

describe('migration: two empty columns', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../../prisma/migrations/20261019170000_ai_usage_who/migration.sql'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  it('only adds two columns to usage, rewriting nothing', () => {
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(2);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP|INSERT)\b/im);
    expect(sql).not.toMatch(/NOT NULL/i);
  });
});
