/**
 * Bot limits (#666): a super admin's limits for all bots, a key's own reply limits set by its owner, and the values
 * that can be saved. Nothing saved reads as the recommended values.
 */
import { NextRequest } from 'next/server';
import { GET, PATCH } from '@/app/api/admin/bot-limits/route';
import { PATCH as patchKey } from '@/app/api/me/ai-keys/[id]/route';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { getUniverseAiReplyLimits } from '@/lib/bot-limits';
import { checkBotLimit, checkServerLimits, limitsForBot, readServerLimits, REPLY_LIMITS_RECOMMENDED, SERVER_LIMITS_RECOMMENDED } from '@/lib/bot-limit-values';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/db', () => {
  const appSetting = { findUnique: jest.fn(), upsert: jest.fn() };
  return {
    prisma: {
      appSetting,
      botsAiProvider: { findFirst: jest.fn(), updateMany: jest.fn() },
      $transaction: jest.fn(async (run: (tx: unknown) => unknown) => run({ appSetting })),
    },
  };
});

const settings = prisma.appSetting as unknown as Record<'findUnique' | 'upsert', jest.Mock>;
const provider = prisma.botsAiProvider as unknown as Record<'findFirst' | 'updateMany', jest.Mock>;
const admin = { id: 'admin-1', email: 'admin@example.com', name: 'Admin' };
const alice = { id: 'user-a', email: 'a@example.com', name: 'A' };

const request = (url: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://localhost:3333${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const env = process.env.SUPER_ADMINS;
beforeAll(() => {
  process.env.SUPER_ADMINS = admin.email;
});
afterAll(() => {
  process.env.SUPER_ADMINS = env;
});
beforeEach(() => {
  jest.clearAllMocks();
  settings.findUnique.mockResolvedValue(null);
  (getSessionUser as jest.Mock).mockResolvedValue(admin);
});

describe('the values', () => {
  it('reads nothing saved as the recommended values', () => {
    expect(readServerLimits(null)).toEqual(SERVER_LIMITS_RECOMMENDED);
    expect(SERVER_LIMITS_RECOMMENDED).toEqual({
      universeAi: { reply: 32000, steps: 30, continue: 2, memory: 20, read: 50000, wait: 60, recentFiles: 5, results: 10, part: 8000, room: 80000 },
      artifacts: { size: 2, versions: 0, save: 30 },
      guard: true,
      fairUsage: { signedIn: 30, guest: 10, guestPool: 200 },
      files: { text: 2_000_000, findable: 0, guestDays: 1 },
    });
  });

  it('starts "Reads from an earlier file" at "Reads from a page or file" when that one was saved lower (#1508)', () => {
    expect(readServerLimits({ universeAi: { read: 4000 } }).universeAi).toMatchObject({ read: 4000, part: 4000 });
    // One that was saved is kept as saved, so a bad pair is seen and turned down, never cut
    expect(readServerLimits({ universeAi: { read: 4000, part: 6000 } }).universeAi).toMatchObject({ read: 4000, part: 6000 });
  });

  it('keeps a saved value only when it can be saved, the recommended one otherwise', () => {
    const read = readServerLimits({ universeAi: { reply: 16000, steps: 0, wait: 'x' }, artifacts: { size: 0.5 }, guard: false });
    expect(read.universeAi).toEqual({ ...REPLY_LIMITS_RECOMMENDED, reply: 16000 });
    expect(read.artifacts.size).toBe(0.5);
    expect(read.guard).toBe(false);
  });

  it('turns down unknown names and values outside what can be saved, saying which', () => {
    expect(checkServerLimits({ universeAi: { reply: 0 } })).toMatchObject({ ok: false, error: expect.stringContaining('universeAi.reply') });
    expect(checkServerLimits({ universeAi: { steps: 2.5 } })).toMatchObject({ ok: false });
    expect(checkServerLimits({ artifacts: { colour: 1 } })).toMatchObject({ ok: false, error: 'Unknown limit: artifacts.colour' });
    // Names every object has are not limits, and answer as unknown rather than failing
    expect(checkServerLimits({ universeAi: { constructor: 1 } })).toMatchObject({ ok: false, error: 'Unknown limit: universeAi.constructor' });
    expect(checkServerLimits({ fairUsage: { toString: 1 } })).toMatchObject({ ok: false, error: 'Unknown limit: fairUsage.toString' });
    expect(checkServerLimits({ guard: 'yes' })).toMatchObject({ ok: false });
    expect(checkServerLimits({ universeAi: { continue: 0 }, artifacts: { versions: 0, size: 0.5 } })).toEqual({ ok: true, value: { universeAi: { continue: 0 }, artifacts: { versions: 0, size: 0.5 } } });
  });

  it('lets a bot lower its key’s longest reply and steps, never raise them', () => {
    expect(limitsForBot(REPLY_LIMITS_RECOMMENDED, { maxReplyTokens: 8000, maxSteps: 100 })).toMatchObject({ reply: 8000, steps: 30 });
    expect(limitsForBot(REPLY_LIMITS_RECOMMENDED, { maxReplyTokens: null })).toMatchObject({ reply: 32000 });
    expect(checkBotLimit(null, 'reply')).toEqual({ ok: true, value: null });
    expect(checkBotLimit(10, 'reply')).toMatchObject({ ok: false });
  });

  it('gives fair usage with its 5-hour window to the reply checks', async () => {
    expect(await getUniverseAiReplyLimits()).toEqual({ signedIn: 30, guest: 10, guestPool: 200, windowHours: 5 });
    settings.findUnique.mockResolvedValue({ key: 'bot-limits', value: { fairUsage: { guest: 20 } } });
    expect(await getUniverseAiReplyLimits()).toEqual({ signedIn: 30, guest: 20, guestPool: 200, windowHours: 5 });
  });

  it('reads the recommended values when the saved ones can’t be read, so a reply never fails over them', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    settings.findUnique.mockRejectedValue(new Error('down'));
    expect(await getUniverseAiReplyLimits()).toMatchObject({ signedIn: 30 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('/api/admin/bot-limits', () => {
  it('is for super admins only', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(alice);
    expect((await GET(request('/api/admin/bot-limits'))).status).toBe(403);
    expect((await PATCH(request('/api/admin/bot-limits', 'PATCH', { guard: false }))).status).toBe(403);
    expect(settings.upsert).not.toHaveBeenCalled();
  });

  it('lists the limits, recommended until changed', async () => {
    const body = await (await GET(request('/api/admin/bot-limits'))).json();
    expect(body.limits).toEqual(SERVER_LIMITS_RECOMMENDED);
  });

  it('saves only what changed on top of what is saved, and answers with all of them', async () => {
    settings.findUnique.mockResolvedValue({ key: 'bot-limits', value: { universeAi: { reply: 16000 }, fairUsage: { signedIn: 60 } } });
    const response = await PATCH(request('/api/admin/bot-limits', 'PATCH', { universeAi: { steps: 50 }, guard: false }));
    expect(response.status).toBe(200);
    const saved = settings.upsert.mock.calls[0][0];
    expect(saved.where).toEqual({ key: 'bot-limits' });
    expect(saved.update.updatedById).toBe('admin-1');
    expect(saved.update.value).toMatchObject({ universeAi: { reply: 16000, steps: 50 }, guard: false, fairUsage: { signedIn: 60 } });
    expect((await response.json()).limits.universeAi).toMatchObject({ reply: 16000, steps: 50, wait: 60 });
  });

  it('turns down a value that can’t be saved, and saves nothing', async () => {
    const response = await PATCH(request('/api/admin/bot-limits', 'PATCH', { artifacts: { size: 0 } }));
    expect(response.status).toBe(400);
    expect(settings.upsert).not.toHaveBeenCalled();
  });

  it('saves what bots keep of the files in their chats (#1508)', async () => {
    const response = await PATCH(request('/api/admin/bot-limits', 'PATCH', { files: { guestDays: 7, findable: 365 } }));
    expect(response.status).toBe(200);
    expect((await response.json()).limits.files).toEqual({ text: 2_000_000, findable: 365, guestDays: 7 });
    expect((await PATCH(request('/api/admin/bot-limits', 'PATCH', { files: { guestDays: 0 } }))).status).toBe(400);
  });

  it('turns down "Reads from an earlier file" above "Reads from a page or file", saying why, and saves nothing', async () => {
    const above = await PATCH(request('/api/admin/bot-limits', 'PATCH', { universeAi: { part: 60000 } }));
    expect(above.status).toBe(400);
    expect((await above.json()).error).toBe("Reads from an earlier file can't be more than Reads from a page or file (50,000 characters).");
    const below = await PATCH(request('/api/admin/bot-limits', 'PATCH', { universeAi: { read: 5000 } }));
    expect(below.status).toBe(400);
    expect((await below.json()).error).toBe("Reads from a page or file can't be less than Reads from an earlier file (8,000 characters). Lower that one first.");
    expect(settings.upsert).not.toHaveBeenCalled();
    // Both together, in the right order, are fine
    expect((await PATCH(request('/api/admin/bot-limits', 'PATCH', { universeAi: { read: 5000, part: 4000 } }))).status).toBe(200);
  });
});

describe('PATCH /api/me/ai-keys/:id { limits }', () => {
  const save = (id: string, body: unknown) => patchKey(request(`/api/me/ai-keys/${id}`, 'PATCH', body), { params: Promise.resolve({ id }) });

  beforeEach(() => {
    (getSessionUser as jest.Mock).mockResolvedValue(alice);
    provider.updateMany.mockResolvedValue({ count: 1 });
  });

  it('keeps what the owner changed and answers with all six', async () => {
    provider.findFirst.mockResolvedValue({ replyLimits: { wait: 120 } });
    const response = await save('key-1', { limits: { reply: 64000 } });
    expect(response.status).toBe(200);
    expect(provider.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { providerId: 'key-1', ownerId: 'user-a' } }));
    expect(provider.updateMany).toHaveBeenCalledWith({ where: { providerId: 'key-1', ownerId: 'user-a' }, data: { replyLimits: { wait: 120, reply: 64000 } } });
    expect((await response.json()).limits).toEqual({ ...REPLY_LIMITS_RECOMMENDED, reply: 64000, wait: 120 });
  });

  it('says "not found" for a key that isn’t yours', async () => {
    provider.findFirst.mockResolvedValue(null);
    expect((await save('key-2', { limits: { steps: 10 } })).status).toBe(404);
    expect(provider.updateMany).not.toHaveBeenCalled();
  });

  it('turns down "Reads from an earlier file" above the key\'s "Reads from a page or file", and saves nothing', async () => {
    provider.findFirst.mockResolvedValue({ replyLimits: { read: 10000 } });
    const response = await save('key-1', { limits: { part: 20000 } });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Reads from an earlier file can't be more than Reads from a page or file (10,000 characters).");
    expect(provider.updateMany).not.toHaveBeenCalled();
    // Lowering "Reads from a page or file" carries an earlier file's reads along while they were never set
    provider.findFirst.mockResolvedValue({ replyLimits: {} });
    expect((await (await save('key-1', { limits: { read: 4000 } })).json()).limits).toMatchObject({ read: 4000, part: 4000 });
  });

  it('saves nothing else either when the limits are turned down with a new name or if-down', async () => {
    provider.findFirst.mockResolvedValue({ replyLimits: { read: 10000 } });
    const response = await save('key-1', { name: 'New name', ifDown: 'stop', limits: { part: 20000 } });
    expect(response.status).toBe(400);
    expect(provider.updateMany).not.toHaveBeenCalled();
  });

  it('turns down a value that can’t be saved', async () => {
    expect((await save('key-1', { limits: { steps: -1 } })).status).toBe(400);
    expect((await save('key-1', { limits: { colour: 1 } })).status).toBe(400);
    expect(provider.updateMany).not.toHaveBeenCalled();
  });
});
