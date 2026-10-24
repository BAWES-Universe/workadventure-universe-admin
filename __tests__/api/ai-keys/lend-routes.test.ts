import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { POST as lend } from '@/app/api/me/ai-keys/[id]/lend/route';
import { DELETE as pull } from '@/app/api/me/ai-keys/[id]/lend/[universeId]/route';
import { GET as universes } from '@/app/api/me/ai-keys/universes/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { lendAccess, lendableUniverses, moveBotsOffKey, moveBotsToAllowedModel } from '@/lib/ai-key-lend';
import { keyModels } from '@/lib/ai-key-model-list';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    botsAiProvider: { findFirst: jest.fn() },
    aiKeyLend: { upsert: jest.fn(), update: jest.fn(), findFirst: jest.fn(), deleteMany: jest.fn() },
  },
}));
jest.mock('@/lib/ai-key-lend', () => ({
  parseLendModels: jest.requireActual('@/lib/ai-key-lend').parseLendModels,
  lendAccess: jest.fn(),
  lendableUniverses: jest.fn(),
  moveBotsOffKey: jest.fn(),
  moveBotsToAllowedModel: jest.fn(),
}));
jest.mock('@/lib/ai-key-model-list', () => ({ ...jest.requireActual('@/lib/ai-key-model-list'), keyModels: jest.fn() }));

const key = prisma.botsAiProvider as unknown as { findFirst: jest.Mock };
const lends = prisma.aiKeyLend as unknown as Record<'upsert' | 'update' | 'findFirst' | 'deleteMany', jest.Mock>;
const alice = { id: 'user-a', uuid: 'uuid-a', email: 'a@example.com', name: 'Alice', tags: [], isSuperAdmin: false };

const post = (body: unknown, id = 'key-1', headers: Record<string, string> = {}) =>
  lend(new NextRequest(`http://localhost:3333/api/me/ai-keys/${id}/lend`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const del = (id = 'key-1', universeId = 'uni-1') =>
  pull(new NextRequest(`http://localhost:3333/api/me/ai-keys/${id}/lend/${universeId}`, { method: 'DELETE' }), { params: Promise.resolve({ id, universeId }) });

beforeEach(() => {
  jest.resetAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue(alice);
});

describe('POST /api/me/ai-keys/:id/lend', () => {
  it('needs a signed-in user and an allowed origin', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await post({ universeId: 'uni-1' })).status).toBe(401);
    expect((await post({ universeId: 'uni-1' }, 'key-1', { origin: 'https://evil.example.com' })).status).toBe(403);
    expect(lends.upsert).not.toHaveBeenCalled();
  });

  it('asks for a universe, and refuses a body that is not JSON', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post('nope')).status).toBe(400);
  });

  it('is "not found" for someone else’s key and for a server provider: lookup is by owner', async () => {
    key.findFirst.mockResolvedValue(null);
    expect((await post({ universeId: 'uni-1' }, 'deepseek-flash')).status).toBe(404);
    expect(key.findFirst).toHaveBeenCalledWith({ where: { providerId: 'deepseek-flash', ownerId: 'user-a' }, select: { providerId: true, endpoint: true, apiKeyEncrypted: true, settings: true, model: true } });
    expect(lends.upsert).not.toHaveBeenCalled();
  });

  it('refuses a universe where they have no Manage bots, and says what is needed', async () => {
    key.findFirst.mockResolvedValue({ providerId: 'key-1' });
    (lendAccess as jest.Mock).mockResolvedValue(null);
    const response = await post({ universeId: 'uni-1' });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/Manage bots/);
    expect(lends.upsert).not.toHaveBeenCalled();
  });

  it('lends it, and lending again changes nothing', async () => {
    key.findFirst.mockResolvedValue({ providerId: 'key-1' });
    (lendAccess as jest.Mock).mockResolvedValue('manage');
    lends.upsert.mockResolvedValue({ models: null });
    const response = await post({ universeId: 'uni-1' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'lent', models: null, moved: 0 });
    expect(lends.upsert).toHaveBeenCalledWith({ where: { providerId_universeId: { providerId: 'key-1', universeId: 'uni-1' } }, create: { providerId: 'key-1', universeId: 'uni-1', models: Prisma.DbNull }, update: {}, select: { models: true } });
    expect(lendAccess).toHaveBeenCalledWith('user-a', 'uni-1');
    // All models: nothing is asked of the provider and no bot moves
    expect(keyModels).not.toHaveBeenCalled();
    expect(moveBotsToAllowedModel).not.toHaveBeenCalled();
  });

  it('changes a lend without lending again when it was removed meanwhile (existing)', async () => {
    key.findFirst.mockResolvedValue({ providerId: 'key-1' });
    (lendAccess as jest.Mock).mockResolvedValue('manage');
    lends.update.mockResolvedValue({ models: null });
    expect((await post({ universeId: 'uni-1', models: null, existing: true })).status).toBe(200);
    expect(lends.update).toHaveBeenCalledWith({ where: { providerId_universeId: { providerId: 'key-1', universeId: 'uni-1' } }, data: { models: Prisma.DbNull }, select: { models: true } });

    lends.update.mockRejectedValue(Object.assign(new Error('Record to update not found.'), { code: 'P2025' }));
    const gone = await post({ universeId: 'uni-1', models: null, existing: true });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual({ error: 'This key isn’t lent to that universe any more. Reload the page to see where it’s lent.' });
    expect(lends.upsert).not.toHaveBeenCalled();
  });

  describe('which models bots there may use (#575)', () => {
    const LIST = { ok: true, models: ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'], facts: {}, listed: true };
    beforeEach(() => {
      key.findFirst.mockResolvedValue({ providerId: 'key-1', model: 'claude-sonnet-5-5' });
      (lendAccess as jest.Mock).mockResolvedValue('owner');
      (keyModels as jest.Mock).mockResolvedValue(LIST);
      (moveBotsToAllowedModel as jest.Mock).mockResolvedValue({ count: 1 });
    });

    it('saves Only these in the provider’s order, and moves the bots on a model taken out to the first kept one', async () => {
      lends.upsert.mockResolvedValue({ models: ['claude-haiku-5-5', 'claude-opus-5-5'] });
      const response = await post({ universeId: 'uni-1', models: ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'] });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'lent', models: ['claude-haiku-5-5', 'claude-opus-5-5'], moved: 1 });
      expect(keyModels).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'key-1' }), { fresh: true });
      const saved = { models: ['claude-haiku-5-5', 'claude-opus-5-5'] };
      expect(lends.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { providerId: 'key-1', universeId: 'uni-1', ...saved }, update: saved }));
      expect(moveBotsToAllowedModel).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'key-1' }), {
        universeId: 'uni-1',
        allowed: ['claude-haiku-5-5', 'claude-opus-5-5'],
        firstAllowed: 'claude-haiku-5-5',
        actor: { id: 'user-a', name: 'Alice' },
      });
    });

    it('goes back to All models with null, and moves nobody', async () => {
      lends.upsert.mockResolvedValue({ models: null });
      expect(await (await post({ universeId: 'uni-1', models: null })).json()).toEqual({ status: 'lent', models: null, moved: 0 });
      expect(lends.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { models: Prisma.DbNull } }));
      expect(moveBotsToAllowedModel).not.toHaveBeenCalled();
    });

    it('refuses a model the key doesn’t have, an empty list, and a list it can’t read, saving nothing', async () => {
      const missing = await post({ universeId: 'uni-1', models: ['gpt-5'] });
      expect(missing.status).toBe(400);
      expect((await missing.json()).error).toMatch(/gpt-5 isn’t on this key’s list/);
      expect((await post({ universeId: 'uni-1', models: [] })).status).toBe(400);
      expect((await post({ universeId: 'uni-1', models: [42] })).status).toBe(400);
      expect((await post({ universeId: 'uni-1', models: 'claude-opus-5-5' })).status).toBe(400);
      expect(lends.upsert).not.toHaveBeenCalled();
    });

    it('says why when the key’s models can’t be loaded, and saves nothing', async () => {
      (keyModels as jest.Mock).mockResolvedValue({ ok: false, message: 'Claude didn’t accept this key.' });
      const response = await post({ universeId: 'uni-1', models: ['claude-haiku-5-5'] });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('Claude didn’t accept this key.');
      expect(lends.upsert).not.toHaveBeenCalled();
    });
  });

  it('is "not found", not a 500, when the key or universe went away between the checks and the save', async () => {
    key.findFirst.mockResolvedValue({ providerId: 'key-1' });
    (lendAccess as jest.Mock).mockResolvedValue('manage');
    lends.upsert.mockRejectedValue(Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' }));
    expect((await post({ universeId: 'uni-1' })).status).toBe(404);
  });

  it('says so with a 500 when it can’t save', async () => {
    key.findFirst.mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await post({ universeId: 'uni-1' })).status).toBe(500);
    spy.mockRestore();
  });
});

describe('DELETE /api/me/ai-keys/:id/lend/:universeId', () => {
  it('needs a signed-in user', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await del()).status).toBe(401);
  });

  it('is "not found" when it isn’t lent there, or isn’t theirs: lookup goes through the key’s owner', async () => {
    lends.findFirst.mockResolvedValue(null);
    expect((await del()).status).toBe(404);
    expect(lends.findFirst).toHaveBeenCalledWith({ where: { providerId: 'key-1', universeId: 'uni-1', provider: { ownerId: 'user-a' } }, select: { id: true } });
    expect(moveBotsOffKey).not.toHaveBeenCalled();
    expect(lends.deleteMany).not.toHaveBeenCalled();
  });

  it('moves that universe’s bots to Universe AI first, then pulls the key', async () => {
    lends.findFirst.mockResolvedValue({ id: 'lend-1' });
    const order: string[] = [];
    (moveBotsOffKey as jest.Mock).mockImplementation(async () => {
      order.push('moved');
      return { count: 1, universes: [] };
    });
    lends.deleteMany.mockImplementation(async () => {
      order.push('pulled');
      return { count: 1 };
    });
    const response = await del();
    expect(await response.json()).toEqual({ status: 'pulled', moved: 1 });
    expect(order).toEqual(['moved', 'pulled']);
    expect(moveBotsOffKey).toHaveBeenCalledWith('key-1', { universeId: 'uni-1', actor: { id: 'user-a', name: 'Alice' }, why: 'pulled' });
    expect(lends.deleteMany).toHaveBeenCalledWith({ where: { id: 'lend-1' } });
  });
});

describe('GET /api/me/ai-keys/universes', () => {
  it('lists where the caller may lend, and needs a signed-in user', async () => {
    (lendableUniverses as jest.Mock).mockResolvedValue([{ id: 'uni-1', name: 'uniboz', access: 'manage' }]);
    const response = await universes(new NextRequest('http://localhost:3333/api/me/ai-keys/universes'));
    expect(await response.json()).toEqual({ universes: [{ id: 'uni-1', name: 'uniboz', access: 'manage' }] });
    expect(lendableUniverses).toHaveBeenCalledWith('user-a');
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await universes(new NextRequest('http://localhost:3333/api/me/ai-keys/universes'))).status).toBe(401);
  });
});

describe('migration: a new table and nothing else', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../../prisma/migrations/20261019160000_ai_key_lends/migration.sql'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  it('only creates ai_key_lends with its indexes and foreign keys', () => {
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|DROP|INSERT)\b/im);
    expect(sql).not.toMatch(/ALTER TABLE "(?!ai_key_lends")/);
    expect(sql).toMatch(/UNIQUE INDEX "ai_key_lends_provider_id_universe_id_key"/);
    expect(sql.match(/ON DELETE CASCADE/g)).toHaveLength(2);
  });
});
