import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET } from '@/app/api/me/bot-ai/route';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBots, canManageThisBot } from '@/lib/bot-permissions';
import { resolveRoomIdFromPlayUri } from '@/lib/bot-config-helpers';
import { checkKeyForBot } from '@/lib/ai-key-pay';
import { keyModels } from '@/lib/ai-key-model-list';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/bot-permissions', () => ({ canManageBots: jest.fn(), canManageThisBot: jest.fn() }));
jest.mock('@/lib/bot-config-helpers', () => ({ resolveRoomIdFromPlayUri: jest.fn() }));
jest.mock('@/lib/ai-key-pay', () => ({ ...jest.requireActual('@/lib/ai-key-pay'), checkKeyForBot: jest.fn() }));
jest.mock('@/lib/ai-key-model-list', () => ({ ...jest.requireActual('@/lib/ai-key-model-list'), keyModels: jest.fn() }));
jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn() },
    room: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    botsAiProvider: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  },
}));

const db = prisma as unknown as {
  bot: Record<'findUnique', jest.Mock>;
  room: Record<'findUnique', jest.Mock>;
  user: Record<'findUnique', jest.Mock>;
  botsAiProvider: Record<'findUnique' | 'findFirst' | 'findMany', jest.Mock>;
};
const mishari = { id: 'mishari', uuid: 'u', email: 'm@example.com', name: 'Mishari', tags: [], isSuperAdmin: false };
const sandbox = { world: { universe: { id: 'sandbox', name: 'Sandbox Universe' } } };
const get = (query: string, headers: Record<string, string> = {}) => GET(new NextRequest(`http://localhost:3333/api/me/bot-ai?${query}`, { headers }));
const myKey = { providerId: 'key-1', name: 'My DeepSeek', settings: { kind: 'deepseek' }, model: 'deepseek-v4-flash', supportsVision: false, lends: [] as { models: unknown }[] };
/** What the provider lists for the key; facts come from DeepSeek's docs (knownFacts). */
const DEEPSEEK_MODELS = [{ id: 'deepseek-v4-flash', vision: false }, { id: 'deepseek-v4-flash-vision-exp', vision: true }, { id: 'deepseek-v4-pro', vision: false }];

beforeEach(() => {
  jest.resetAllMocks();
  (getSessionUser as jest.Mock).mockResolvedValue(mishari);
  (canManageBots as jest.Mock).mockResolvedValue(true);
  (canManageThisBot as jest.Mock).mockResolvedValue(true);
  db.room.findUnique.mockResolvedValue(sandbox);
  db.user.findUnique.mockResolvedValue({ id: 'mishari', name: 'Mishari' });
  db.botsAiProvider.findFirst.mockResolvedValue({ providerId: 'deepseek-flash', enabled: true, model: 'deepseek-v4-flash', supportsVision: null });
  db.botsAiProvider.findMany.mockResolvedValue([]);
  db.botsAiProvider.findUnique.mockResolvedValue(null);
  (keyModels as jest.Mock).mockResolvedValue({ ok: true, models: DEEPSEEK_MODELS.map((model) => model.id), facts: {}, listed: true });
});

describe('GET /api/me/bot-ai', () => {
  it('needs a signed-in user, an allowed origin, and a bot or room', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await get('botId=b1')).status).toBe(401);
    (getSessionUser as jest.Mock).mockResolvedValue(mishari);
    expect((await get('botId=b1', { origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await get('')).status).toBe(400);
  });

  it('offers a new bot’s maker Universe AI and only their own keys lent to that universe', async () => {
    db.botsAiProvider.findMany.mockResolvedValueOnce([myKey]);
    const response = await get('roomId=11111111-1111-1111-1111-111111111111');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      current: null,
      currentModel: null,
      universeAi: { available: true, model: 'deepseek-v4-flash', supportsVision: null },
      maker: { id: 'mishari', name: 'Mishari' },
      viewerIsMaker: true,
      keys: [{ id: 'key-1', name: 'My DeepSeek', kind: 'deepseek', kindLabel: 'DeepSeek', group: 'hosted', universeName: 'Sandbox Universe', status: 'working', ifDown: 'universe-ai', model: 'deepseek-v4-flash', supportsVision: false, visionModels: ['deepseek-v4-flash-vision-exp'], models: DEEPSEEK_MODELS, modelsProblem: null, limited: false }],
      currentKey: null,
      vision: { saved: null, savedKey: null },
      providers: null,
    });
    expect(db.botsAiProvider.findMany.mock.calls[0][0].where).toEqual({ ownerId: 'mishari', lends: { some: { universeId: 'sandbox' } } });
  });

  it('resolves a play address to the room', async () => {
    (resolveRoomIdFromPlayUri as jest.Mock).mockResolvedValue('room-9');
    await get(`roomId=${encodeURIComponent('http://play.example.com/@/u/w/r')}`);
    expect(db.room.findUnique.mock.calls[0][0].where).toEqual({ id: 'room-9' });
    (resolveRoomIdFromPlayUri as jest.Mock).mockRejectedValue(new Error('Room not found'));
    expect((await get(`roomId=${encodeURIComponent('http://play.example.com/@/u/x/y')}`)).status).toBe(404);
  });

  it('shows someone else’s bot on its maker’s key as it is, with none of the viewer’s keys, only Universe AI to switch to', async () => {
    db.bot.findUnique.mockResolvedValue({ id: 'sam', roomId: 'room-1', aiProviderRef: 'key-m', createdBy: { id: 'maker', name: 'Mishari' } });
    (getSessionUser as jest.Mock).mockResolvedValue({ ...mishari, id: 'a-manager', name: 'Nora' });
    db.user.findUnique.mockResolvedValue({ id: 'a-manager', name: 'Nora' });
    db.botsAiProvider.findUnique.mockResolvedValue({ providerId: 'key-m', name: 'Mishari’s Claude', ownerId: 'maker', lends: [] });
    const body = await (await get('botId=sam')).json();
    expect(body).toMatchObject({
      current: 'key-m', viewerIsMaker: false, keys: [],
      maker: { id: 'maker', name: 'Mishari' },
      currentKey: { id: 'key-m', name: 'Mishari’s Claude', ownerName: 'Mishari', mine: false },
      universeAi: { available: true, model: 'deepseek-v4-flash', supportsVision: null },
    });
    // The manager's own keys were never even looked up
    expect(db.botsAiProvider.findMany).not.toHaveBeenCalled();
  });

  it('says the key is the viewer’s when it is, for the maker’s own bot', async () => {
    db.bot.findUnique.mockResolvedValue({ id: 'guide', roomId: 'room-1', aiProviderRef: 'key-1', createdBy: { id: 'mishari', name: 'Mishari' } });
    db.botsAiProvider.findUnique.mockResolvedValue({ providerId: 'key-1', name: 'My DeepSeek', ownerId: 'mishari', settings: { kind: 'deepseek' }, model: 'deepseek-v4-flash', supportsVision: false, lends: [] });
    db.botsAiProvider.findMany.mockResolvedValueOnce([myKey]);
    const body = await (await get('botId=guide')).json();
    expect(body.currentKey).toEqual({ id: 'key-1', name: 'My DeepSeek', ownerName: 'Mishari', mine: true, status: 'working', ifDown: 'universe-ai', group: 'hosted', model: 'deepseek-v4-flash', supportsVision: false, visionModels: ['deepseek-v4-flash-vision-exp'] });
    expect(body.viewerIsMaker).toBe(true);
  });

  it('lists the key’s check model among its Vision models for a bot on another model, as the server uses it for images (#575)', async () => {
    // The check model sees; the bot runs on one that doesn't, so images go to the check model on the same key
    db.bot.findUnique.mockResolvedValue({ id: 'guide', roomId: 'room-1', aiProviderRef: 'key-1', aiModel: 'text-only', createdBy: { id: 'mishari', name: 'Mishari' } });
    db.botsAiProvider.findUnique.mockResolvedValue({ providerId: 'key-1', name: 'My LM Studio', ownerId: 'mishari', settings: { kind: 'lmstudio', modelFacts: { 'text-only': { vision: false } } }, model: 'sees-all', supportsVision: true, lends: [] });
    const body = await (await get('botId=guide')).json();
    expect(body.currentKey).toMatchObject({ model: 'text-only', supportsVision: false, visionModels: ['sees-all'] });
  });

  it('says when the key is down and what its bots do meanwhile, so the picker can say Universe AI answers', async () => {
    db.bot.findUnique.mockResolvedValue({ id: 'guide', roomId: 'room-1', aiProviderRef: 'key-1', createdBy: { id: 'mishari', name: 'Mishari' } });
    db.botsAiProvider.findUnique.mockResolvedValue({ providerId: 'key-1', name: 'My DeepSeek', ownerId: 'mishari', downSince: new Date(), ifDown: 'stop', lends: [] });
    db.botsAiProvider.findMany.mockResolvedValueOnce([{ ...myKey, downSince: new Date(), ifDown: 'universe-ai' }]);
    const body = await (await get('botId=guide')).json();
    expect(body.currentKey).toMatchObject({ status: 'down', ifDown: 'stop' });
    expect(body.keys[0]).toMatchObject({ status: 'down', ifDown: 'universe-ai' });
  });

  it('keeps the server’s providers to super admins, who may still pin a bot to one', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue({ ...mishari, isSuperAdmin: true });
    db.botsAiProvider.findMany
      .mockResolvedValueOnce([]) // their keys
      .mockResolvedValueOnce([{ providerId: 'deepseek-flash', name: 'DeepSeek V4 Flash', type: 'openai', model: 'deepseek-v4-flash', enabled: true }]);
    const body = await (await get('roomId=11111111-1111-1111-1111-111111111111')).json();
    expect(body.providers).toEqual([{ id: 'deepseek-flash', name: 'DeepSeek V4 Flash', type: 'openai', model: 'deepseek-v4-flash', enabled: true }]);
    expect(db.botsAiProvider.findMany.mock.calls[1][0].where).toEqual({ ownerId: null });
  });

  it('refuses someone who cannot manage bots in the room, and says Universe AI is unavailable when it is', async () => {
    (canManageBots as jest.Mock).mockResolvedValue(false);
    expect((await get('roomId=11111111-1111-1111-1111-111111111111')).status).toBe(403);
    (canManageBots as jest.Mock).mockResolvedValue(true);
    db.botsAiProvider.findFirst.mockResolvedValue(null);
    expect((await (await get('roomId=11111111-1111-1111-1111-111111111111')).json()).universeAi).toEqual({ available: false, model: null, supportsVision: null });
  });

  it('holds a bot to its own Manage rules: room-level Manage bots alone does not show whose key it runs on', async () => {
    db.bot.findUnique.mockResolvedValue({ id: 'sam', roomId: 'room-1', aiProviderRef: 'key-m', createdById: 'maker', createdBy: { id: 'maker', name: 'Mishari' } });
    db.botsAiProvider.findUnique.mockResolvedValue({ providerId: 'key-m', name: 'Mishari’s Claude', ownerId: 'maker', lends: [] });
    (canManageThisBot as jest.Mock).mockResolvedValue(false);
    const response = await get('botId=sam');
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain('Claude');
    expect(canManageThisBot).toHaveBeenCalledWith('mishari', null, { id: 'sam', createdById: 'maker', roomId: 'room-1' }, { creatorPasses: false });
    expect(db.botsAiProvider.findUnique).not.toHaveBeenCalled();
  });

  it('is "not found" for a bot or room that is not there', async () => {
    db.bot.findUnique.mockResolvedValue(null);
    expect((await get('botId=nope')).status).toBe(404);
    db.room.findUnique.mockResolvedValue(null);
    expect((await get('roomId=11111111-1111-1111-1111-111111111111')).status).toBe(404);
  });
});

describe('GET /api/me/bot-ai: where the bot’s images go', () => {
  const botWith = (behaviorConfig: unknown) => ({ id: 'guide', roomId: 'room-1', aiProviderRef: 'key-1', behaviorConfig, createdById: 'mishari', createdBy: { id: 'mishari', name: 'Mishari' } });

  it('says nothing is picked when nothing is saved', async () => {
    db.bot.findUnique.mockResolvedValue(botWith({ behaviorType: 'idle' }));
    expect((await (await get('botId=guide')).json()).vision).toEqual({ saved: null, savedKey: null });
  });

  it('gives what is saved, and for Another model the key’s name and that it can be used', async () => {
    db.bot.findUnique.mockResolvedValue(botWith({ vision: { choice: 'another', keyId: 'key-1', model: 'deepseek-v4-flash-vision-exp' } }));
    db.botsAiProvider.findUnique.mockResolvedValue({ ...myKey, ownerId: 'mishari', downSince: null, ifDown: 'universe-ai' });
    (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: true });
    const body = await (await get('botId=guide')).json();
    expect(body.vision).toEqual({ saved: { choice: 'another', keyId: 'key-1', model: 'deepseek-v4-flash-vision-exp' }, savedKey: { name: 'My DeepSeek', problem: null } });
  });

  it('says why the key picked for images can’t be used: Down, or taken away', async () => {
    const pick = { vision: { choice: 'another', keyId: 'key-1', model: 'deepseek-v4-flash-vision-exp' } };
    (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: true });
    db.bot.findUnique.mockResolvedValue(botWith(pick));
    db.botsAiProvider.findUnique.mockResolvedValue({ ...myKey, ownerId: 'mishari', downSince: new Date(), ifDown: 'universe-ai' });
    expect((await (await get('botId=guide')).json()).vision.savedKey).toEqual({ name: 'My DeepSeek', problem: 'down' });
    db.botsAiProvider.findUnique.mockResolvedValue(null);
    expect((await (await get('botId=guide')).json()).vision.savedKey).toEqual({ name: 'A key that was removed', problem: 'gone' });
  });

  it('ignores a saved pick it can’t read', async () => {
    db.bot.findUnique.mockResolvedValue(botWith({ vision: { choice: 'another' } }));
    expect((await (await get('botId=guide')).json()).vision).toEqual({ saved: null, savedKey: null });
  });
});
