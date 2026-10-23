/**
 * Universe AI (#374, part 3): bots on "universe-ai" run on whichever server provider is the Default right now. Bots
 * pinned to a provider by its id, and the DeepSeek and LM Studio providers themselves, must be served exactly as before.
 */
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { checkAiProviderRef } from '@/lib/ai-provider-ref';
import { UNIVERSE_AI_REF, resolveUniverseAiProvider } from '@/lib/universe-ai';
import { GET as adminList } from '@/app/api/admin/ai-providers/route';
import { PATCH as adminPatch, DELETE as adminDelete } from '@/app/api/admin/ai-providers/[id]/route';
import { GET as botCredentials } from '@/app/api/bots/ai-providers/[providerId]/credentials/route';
import { POST as trackUsage } from '@/app/api/bots/ai-usage/route';

jest.mock('@/lib/db', () => ({
  prisma: {
    botsAiProvider: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
    botsAiUsage: { create: jest.fn(async () => ({})) },
    bot: { groupBy: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(async (operations: unknown[]) => Promise.all(operations)),
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => ({ id: 'admin-1', email: 'admin@bawes.net' })) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn(() => true) }));
jest.mock('@/lib/service-tokens', () => ({ validateServiceToken: jest.fn(() => true), requireServiceToken: jest.fn() }));

const provider = prisma.botsAiProvider as unknown as Record<'findUnique' | 'findFirst' | 'findMany' | 'update' | 'updateMany' | 'delete', jest.Mock>;
const bot = prisma.bot as unknown as Record<'groupBy' | 'count', jest.Mock>;
const usage = prisma.botsAiUsage as unknown as { create: jest.Mock };

const deepseek = {
  providerId: 'deepseek-flash', name: 'DeepSeek V4 Flash', type: 'openai', enabled: true, endpoint: 'https://api.deepseek.com',
  apiKeyEncrypted: 'enc:sk-secret', model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 500, supportsStreaming: true,
  supportsVision: null, visionModel: null, defaultVision: false, settings: {}, ownerId: null, isDefault: true,
};
const lmstudio = { ...deepseek, providerId: 'lmstudio-local', name: 'LM Studio Local', type: 'lmstudio', endpoint: 'http://localhost:1234', apiKeyEncrypted: null, model: 'qwen3-8b', isDefault: false };
const disabled = { ...deepseek, providerId: 'openai-vision', name: 'OpenAI vision', enabled: false, isDefault: false };

const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost:3333${url}`, init);
const patch = (body: unknown) => req('/api/admin/ai-providers/x', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const params = <T extends object>(value: T) => ({ params: Promise.resolve(value) });

beforeEach(() => {
  for (const fn of [...Object.values(provider), ...Object.values(bot), usage.create]) fn.mockReset();
  usage.create.mockResolvedValue({});
  bot.groupBy.mockResolvedValue([]);
  bot.count.mockResolvedValue(0);
});

describe('migration: only a new flag, on one provider', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../../prisma/migrations/20261019140000_universe_ai_default/migration.sql'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  it('adds one column, off for everyone', () => {
    expect(sql.match(/ADD COLUMN/gi)).toHaveLength(1);
    expect(sql).toMatch(/"is_default" BOOLEAN NOT NULL DEFAULT false/);
  });

  it('only ever sets is_default, and only on the first enabled server provider by name', () => {
    const updates = sql.match(/UPDATE[\s\S]*?;/gi) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/SET "is_default" = true/);
    expect(updates[0]).not.toMatch(/SET[^;]*,/); // no second column is set
    expect(updates[0]).toMatch(/"owner_id" IS NULL AND "enabled" = true\s+ORDER BY "name" ASC\s+LIMIT 1/);
  });

  it('touches no bot, no setting and no usage row', () => {
    expect(sql).not.toMatch(/"bots"|"bots_ai_usage"|ai_provider_ref|DELETE|DROP/i);
  });
});

describe('which provider Universe AI runs on', () => {
  it('is the one marked Default while it is enabled', async () => {
    provider.findFirst.mockResolvedValueOnce(lmstudio);
    expect((await resolveUniverseAiProvider())?.providerId).toBe('lmstudio-local');
    expect(provider.findFirst).toHaveBeenCalledWith({ where: { ownerId: null, isDefault: true } });
  });

  it('falls back to the first enabled server provider by name when the marked one is off or gone', async () => {
    provider.findFirst.mockResolvedValueOnce({ ...lmstudio, enabled: false }).mockResolvedValueOnce(deepseek);
    expect((await resolveUniverseAiProvider())?.providerId).toBe('deepseek-flash');
    expect(provider.findFirst).toHaveBeenLastCalledWith({ where: { ownerId: null, enabled: true }, orderBy: { name: 'asc' } });
  });

  it('is nothing when no server provider is enabled', async () => {
    provider.findFirst.mockResolvedValue(null);
    expect(await resolveUniverseAiProvider()).toBeNull();
  });
});

describe('saving a bot on Universe AI', () => {
  it('accepts "universe-ai" while there is a provider to run on', async () => {
    provider.findFirst.mockResolvedValue(deepseek);
    expect(await checkAiProviderRef(UNIVERSE_AI_REF)).toBeNull();
  });

  it('says so, plainly, when there is none', async () => {
    provider.findFirst.mockResolvedValue(null);
    expect(await checkAiProviderRef(UNIVERSE_AI_REF)).toMatch(/no enabled provider/);
  });

  it('still checks a pinned provider as before, and still lets an empty ref and an unchanged ref through', async () => {
    provider.findUnique.mockResolvedValue(lmstudio);
    expect(await checkAiProviderRef('lmstudio-local')).toBeNull();
    provider.findUnique.mockResolvedValue(null);
    expect(await checkAiProviderRef('gone')).toBe('AI provider "gone" does not exist');
    expect(await checkAiProviderRef('')).toBeNull();
    expect(await checkAiProviderRef('gone', 'gone')).toBeNull();
    expect(provider.findFirst).not.toHaveBeenCalled();
  });
});

describe('the bot server asks for the key of a bot on Universe AI', () => {
  it('gets the Default, under its own id, with the same fields as always', async () => {
    provider.findFirst.mockResolvedValue(deepseek);
    const response = await botCredentials(req('/api/bots/ai-providers/universe-ai/credentials'), params({ providerId: UNIVERSE_AI_REF }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providerId: 'deepseek-flash', name: 'DeepSeek V4 Flash', type: 'openai', enabled: true, endpoint: 'https://api.deepseek.com',
      apiKeyEncrypted: 'enc:sk-secret', model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 500, supportsStreaming: true,
      supportsVision: null, visionModel: null, defaultVision: false, settings: {},
    });
  });

  it('follows the Default the next time it asks', async () => {
    provider.findFirst.mockResolvedValueOnce(deepseek).mockResolvedValueOnce(lmstudio);
    const first = await botCredentials(req('/x'), params({ providerId: UNIVERSE_AI_REF }));
    const second = await botCredentials(req('/x'), params({ providerId: UNIVERSE_AI_REF }));
    expect([(await first.json()).providerId, (await second.json()).providerId]).toEqual(['deepseek-flash', 'lmstudio-local']);
  });

  it('is told it is unavailable (503), never given someone else’s key, when no provider is enabled', async () => {
    provider.findFirst.mockResolvedValue(null);
    const response = await botCredentials(req('/x'), params({ providerId: UNIVERSE_AI_REF }));
    expect(response.status).toBe(503);
    expect(provider.findUnique).not.toHaveBeenCalled();
  });

  it('a bot pinned to a provider is served that provider, whatever the Default is', async () => {
    provider.findUnique.mockResolvedValue(lmstudio);
    const response = await botCredentials(req('/x'), params({ providerId: 'lmstudio-local' }));
    expect((await response.json()).providerId).toBe('lmstudio-local');
    expect(provider.findFirst).not.toHaveBeenCalled();
  });
});

describe('usage of a bot on Universe AI', () => {
  const body = (providerId: string) => req('/api/bots/ai-usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: 'b1', providerId, tokensUsed: 10 }) });

  it('is recorded on the provider that answered', async () => {
    provider.findFirst.mockResolvedValue(deepseek);
    provider.findUnique.mockResolvedValue(deepseek);
    const response = await trackUsage(body(UNIVERSE_AI_REF));
    expect(response.status).toBe(200);
    expect(usage.create.mock.calls[0][0].data.providerId).toBe('deepseek-flash');
  });

  it('is refused plainly when there is no provider to record it on', async () => {
    provider.findFirst.mockResolvedValue(null);
    expect((await trackUsage(body(UNIVERSE_AI_REF))).status).toBe(400);
    expect(usage.create).not.toHaveBeenCalled();
  });

  it('is recorded on a pinned provider as before', async () => {
    provider.findUnique.mockResolvedValue(lmstudio);
    await trackUsage(body('lmstudio-local'));
    expect(usage.create.mock.calls[0][0].data.providerId).toBe('lmstudio-local');
  });
});

describe('the Universe AI page’s list', () => {
  it('marks the Default and counts bots: pinned on each, and Universe AI’s on the Default', async () => {
    provider.findMany.mockResolvedValue([deepseek, lmstudio, disabled]);
    provider.findFirst.mockResolvedValue(deepseek);
    bot.groupBy.mockResolvedValue([
      { aiProviderRef: 'universe-ai', _count: { _all: 29 } },
      { aiProviderRef: 'deepseek-flash', _count: { _all: 2 } },
      { aiProviderRef: 'lmstudio-local', _count: { _all: 2 } },
      { aiProviderRef: null, _count: { _all: 9 } },
    ]);
    const rows = await (await adminList(req('/api/admin/ai-providers'))).json();
    expect(rows.map((row: { providerId: string; isDefault: boolean; pinnedBots: number; universeAiBots: number }) => [row.providerId, row.isDefault, row.pinnedBots, row.universeAiBots])).toEqual([
      ['deepseek-flash', true, 2, 29],
      ['lmstudio-local', false, 2, 0],
      ['openai-vision', false, 0, 0],
    ]);
  });
});

describe('making a provider the Default', () => {
  it('clears the others and sets this one in one transaction', async () => {
    provider.findUnique.mockResolvedValue(lmstudio);
    provider.update.mockResolvedValue({ ...lmstudio, isDefault: true });
    const response = await adminPatch(patch({ isDefault: true }), params({ id: 'lmstudio-local' }));
    expect(response.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(provider.updateMany).toHaveBeenCalledWith({ where: { ownerId: null, isDefault: true, NOT: { providerId: 'lmstudio-local' } }, data: { isDefault: false } });
    expect(provider.update.mock.calls[0][0].data.isDefault).toBe(true);
  });

  it('refuses a provider that is off', async () => {
    provider.findUnique.mockResolvedValue(disabled);
    const response = await adminPatch(patch({ isDefault: true }), params({ id: 'openai-vision' }));
    expect(response.status).toBe(400);
    expect(provider.update).not.toHaveBeenCalled();
  });

  it('refuses to un-make the Default: Universe AI always has one', async () => {
    provider.findUnique.mockResolvedValue(deepseek);
    const response = await adminPatch(patch({ isDefault: false }), params({ id: 'deepseek-flash' }));
    expect(response.status).toBe(400);
    expect(provider.update).not.toHaveBeenCalled();
  });

  it('refuses a flag that is not true or false', async () => {
    provider.findUnique.mockResolvedValue(lmstudio);
    expect((await adminPatch(patch({ isDefault: 'yes' }), params({ id: 'lmstudio-local' }))).status).toBe(400);
  });

  it('refuses to disable the Default, and says what to do', async () => {
    provider.findUnique.mockResolvedValue(deepseek);
    provider.findFirst.mockResolvedValue(deepseek);
    const response = await adminPatch(patch({ enabled: false }), params({ id: 'deepseek-flash' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Make another provider the default first/);
    expect(provider.update).not.toHaveBeenCalled();
  });

  it('still disables any other provider as before', async () => {
    provider.findUnique.mockResolvedValue(lmstudio);
    provider.findFirst.mockResolvedValue(deepseek);
    provider.update.mockResolvedValue({ ...lmstudio, enabled: false });
    const response = await adminPatch(patch({ enabled: false }), params({ id: 'lmstudio-local' }));
    expect(response.status).toBe(200);
    expect(provider.update.mock.calls[0][0].data).toEqual({ enabled: false });
  });

  it('an ordinary edit of the Default (a new model, say) works as before', async () => {
    provider.findUnique.mockResolvedValue(deepseek);
    provider.update.mockResolvedValue(deepseek);
    const response = await adminPatch(patch({ model: 'deepseek-v4-pro' }), params({ id: 'deepseek-flash' }));
    expect(response.status).toBe(200);
    expect(provider.findFirst).not.toHaveBeenCalled();
    expect(provider.update.mock.calls[0][0].data).toEqual({ model: 'deepseek-v4-pro' });
  });
});

describe('deleting a provider', () => {
  const del = (id: string) => adminDelete(req(`/api/admin/ai-providers/${id}`, { method: 'DELETE' }), params({ id }));

  it('refuses the Default while bots run on Universe AI', async () => {
    provider.findUnique.mockResolvedValue(deepseek);
    provider.findFirst.mockResolvedValue(deepseek);
    bot.count.mockResolvedValue(29);
    const response = await del('deepseek-flash');
    expect(response.status).toBe(400);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(bot.count).toHaveBeenCalledWith({ where: { aiProviderRef: 'universe-ai' } });
  });

  it('deletes the Default as before when no bot runs on Universe AI', async () => {
    provider.findUnique.mockResolvedValue(deepseek);
    provider.findFirst.mockResolvedValue(deepseek);
    expect((await del('deepseek-flash')).status).toBe(200);
    expect(provider.delete).toHaveBeenCalled();
  });

  it('deletes any other provider as before', async () => {
    provider.findUnique.mockResolvedValue(lmstudio);
    provider.findFirst.mockResolvedValue(deepseek);
    bot.count.mockResolvedValue(29);
    expect((await del('lmstudio-local')).status).toBe(200);
  });
});
