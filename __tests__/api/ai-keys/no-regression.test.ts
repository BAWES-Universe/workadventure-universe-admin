/**
 * No-regression checks for personal AI keys (#374, part 1). Every row of the PR's no-regression list is one block here.
 * What must not change: the server's own providers (DeepSeek on the openai type, LM Studio on local), what is saved
 * for them, the bots that use them, the super admin's provider pages, usage tracking and the Test button.
 */
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET as adminList, POST as adminCreate } from '@/app/api/admin/ai-providers/route';
import { GET as adminGet, DELETE as adminDelete } from '@/app/api/admin/ai-providers/[id]/route';
import { POST as adminTest } from '@/app/api/admin/ai-providers/[id]/test/route';
import { GET as adminUsage } from '@/app/api/admin/ai-providers/usage/route';
import { GET as botList } from '@/app/api/bots/ai-providers/route';
import { GET as botCredentials } from '@/app/api/bots/ai-providers/[providerId]/credentials/route';
import { POST as trackUsage } from '@/app/api/bots/ai-usage/route';

jest.mock('@/lib/db', () => ({
  prisma: {
    botsAiProvider: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), delete: jest.fn(), create: jest.fn() },
    botsAiUsage: { findMany: jest.fn(async () => []), create: jest.fn(async () => ({})) },
    bot: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []), count: jest.fn(async () => 0) },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => ({ id: 'admin-1', email: 'admin@bawes.net' })) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn(() => true) }));
jest.mock('@/lib/service-tokens', () => ({ validateServiceToken: jest.fn(() => true), requireServiceToken: jest.fn() }));
jest.mock('@/lib/encryption', () => ({ decryptApiKey: jest.fn((value: string) => value.replace('enc:', '')) }));

const provider = prisma.botsAiProvider as unknown as Record<'findUnique' | 'findFirst' | 'findMany' | 'update' | 'delete' | 'create', jest.Mock>;
const usage = prisma.botsAiUsage as unknown as Record<'findMany' | 'create', jest.Mock>;

const deepseek = {
  providerId: 'deepseek-flash', name: 'DeepSeek V4 Flash', type: 'openai', enabled: true, endpoint: 'https://api.deepseek.com',
  apiKeyEncrypted: 'enc:sk-secret', model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 500, supportsStreaming: true,
  supportsVision: null, visionModel: null, defaultVision: false, settings: {}, ownerId: null,
};
const lmstudio = { ...deepseek, providerId: 'lmstudio-local', name: 'LM Studio Local', type: 'lmstudio', endpoint: 'http://localhost:1234', apiKeyEncrypted: null, model: 'qwen3-8b' };
const someonesKey = { ...deepseek, providerId: 'key-abc', name: 'My DeepSeek', ownerId: 'user-a' };

const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost:3333${url}`, init);
const params = <T extends object>(value: T) => ({ params: Promise.resolve(value) });

beforeEach(() => {
  jest.clearAllMocks();
  usage.findMany.mockResolvedValue([]);
});

describe('migration: nothing existing is rewritten', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../../prisma/migrations/20261019130000_ai_keys_owner/migration.sql'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  it('only adds two empty columns, one index and one foreign key', () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP|INSERT)\b/im);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
    expect(sql.match(/ADD COLUMN/gi)).toHaveLength(2);
  });

  it('touches no bot: every bot keeps the provider it has', () => {
    expect(sql).not.toMatch(/"bots"/);
    expect(sql).not.toMatch(/ai_provider_ref/);
  });
});

describe('the super admin provider pages still work, and never show a personal key', () => {
  it('lists only the server providers, in the same order, with the same fields', async () => {
    provider.findMany.mockResolvedValue([deepseek, lmstudio]);
    provider.findFirst.mockResolvedValue(deepseek);
    const response = await adminList(req('/api/admin/ai-providers'));
    expect(provider.findMany).toHaveBeenCalledWith({ where: { ownerId: null }, orderBy: { name: 'asc' } });
    // Every field it had is still there, unchanged; Universe AI (#374) only adds isDefault and the two bot counts
    const rows = await response.json();
    expect(rows).toEqual(
      JSON.parse(JSON.stringify([deepseek, lmstudio])).map((row: object, index: number) => ({
        ...row,
        isDefault: index === 0,
        pinnedBots: 0,
        universeAiBots: 0,
      }))
    );
  });

  it('shows one server provider as before', async () => {
    provider.findUnique.mockResolvedValue(deepseek);
    const response = await adminGet(req('/api/admin/ai-providers/deepseek-flash'), params({ id: 'deepseek-flash' }));
    expect(response.status).toBe(200);
  });

  it('says "not found" for a personal key: no super admin can open it', async () => {
    provider.findUnique.mockResolvedValue(someonesKey);
    const response = await adminGet(req('/api/admin/ai-providers/key-abc'), params({ id: 'key-abc' }));
    expect(response.status).toBe(404);
  });

  it('cannot delete a personal key from the provider page', async () => {
    provider.findUnique.mockResolvedValue(someonesKey);
    const response = await adminDelete(req('/api/admin/ai-providers/key-abc', { method: 'DELETE' }), params({ id: 'key-abc' }));
    expect(response.status).toBe(404);
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it('keeps the usage page to the server providers', async () => {
    await adminUsage(req('/api/admin/ai-providers/usage'));
    expect(usage.findMany.mock.calls[0][0].where.provider).toEqual({ ownerId: null });
  });
});

describe('the New provider form of the super admin is unchanged', () => {
  it('still creates a server provider, and a body that names an owner cannot make it someone’s key', async () => {
    provider.findUnique.mockResolvedValue(null);
    provider.create.mockResolvedValue({ providerId: 'x' });
    const response = await adminCreate(req('/api/admin/ai-providers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'x', name: 'X', type: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', ownerId: 'user-a' }),
    }));
    expect(response.status).toBe(201);
    expect(provider.create.mock.calls[0][0].data).not.toHaveProperty('ownerId');
  });
});

describe('the Test button is unchanged for server providers and refuses a personal key', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('DeepSeek on the openai type: the same request goes out and the result is saved', async () => {
    provider.findUnique.mockResolvedValue(deepseek);
    global.fetch = jest.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    const response = await adminTest(req('/api/admin/ai-providers/deepseek-flash/test', { method: 'POST' }), params({ id: 'deepseek-flash' }));
    expect(await response.json()).toEqual({ success: true });
    expect(global.fetch).toHaveBeenCalledWith('https://api.deepseek.com/v1/models', expect.objectContaining({
      method: 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-secret' },
    }));
    expect(provider.update).toHaveBeenCalledWith(expect.objectContaining({ where: { providerId: 'deepseek-flash' }, data: expect.objectContaining({ tested: true }) }));
  });

  it('LM Studio on local: the same request goes out, with no key', async () => {
    provider.findUnique.mockResolvedValue(lmstudio);
    global.fetch = jest.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    const response = await adminTest(req('/api/admin/ai-providers/lmstudio-local/test', { method: 'POST' }), params({ id: 'lmstudio-local' }));
    expect(await response.json()).toEqual({ success: true });
    expect(global.fetch).toHaveBeenCalledWith('http://localhost:1234/v1/models', expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }));
  });

  it('never sends anything to the address of a personal key', async () => {
    provider.findUnique.mockResolvedValue(someonesKey);
    global.fetch = jest.fn() as unknown as typeof fetch;
    const response = await adminTest(req('/api/admin/ai-providers/key-abc/test', { method: 'POST' }), params({ id: 'key-abc' }));
    expect(response.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('the bot server sees the same providers as before', () => {
  it('lists only server providers, and keeps the enabled and type filters', async () => {
    provider.findMany.mockResolvedValue([]);
    await botList(req('/api/bots/ai-providers?enabled=true&type=openai'));
    expect(provider.findMany.mock.calls[0][0].where).toEqual({ ownerId: null, enabled: true, type: 'openai' });
  });

  it.each([
    ['DeepSeek V4 Flash on the openai type', deepseek],
    ['LM Studio on local', lmstudio],
  ])('serves %s with exactly the fields it served before', async (_name, row) => {
    provider.findUnique.mockResolvedValue(row);
    const response = await botCredentials(req(`/api/bots/ai-providers/${row.providerId}/credentials`), params({ providerId: row.providerId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providerId: row.providerId, name: row.name, type: row.type, enabled: true, endpoint: row.endpoint,
      apiKeyEncrypted: row.apiKeyEncrypted, model: row.model, temperature: 0.7, maxTokens: 500, supportsStreaming: true,
      supportsVision: null, visionModel: null, defaultVision: false, settings: {},
    });
  });

  it('does not serve a personal key by its id alone', async () => {
    provider.findUnique.mockResolvedValue(someonesKey);
    const response = await botCredentials(req('/api/bots/ai-providers/key-abc/credentials'), params({ providerId: 'key-abc' }));
    expect(response.status).toBe(404);
  });
});

describe('usage tracking is unchanged', () => {
  it('still records a reply on a server provider', async () => {
    provider.findUnique.mockResolvedValue(deepseek);
    usage.create.mockResolvedValue({});
    const response = await trackUsage(req('/api/bots/ai-usage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: 'bot-1', providerId: 'deepseek-flash', tokensUsed: 120 }),
    }));
    expect(await response.json()).toEqual({ status: 'tracked' });
    expect(usage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ botId: 'bot-1', providerId: 'deepseek-flash', tokensUsed: 120, apiCalls: 1 }) });
  });
});
