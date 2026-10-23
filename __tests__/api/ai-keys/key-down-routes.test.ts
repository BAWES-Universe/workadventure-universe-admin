/**
 * A key that is down (#374, part 7): what the bot server is served, how it reports replies, and the owner's Check now
 * and "If this is down" controls.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { GET as credentials } from '@/app/api/bots/[id]/ai-credentials/route';
import { POST as report } from '@/app/api/bots/[id]/ai-health/route';
import { POST as checkNow } from '@/app/api/me/ai-keys/[id]/check/route';
import { PATCH as setIfDown } from '@/app/api/me/ai-keys/[id]/route';
import { checkKeyForBot } from '@/lib/ai-key-pay';
import { checkAndRecord, recordReply, recheckIfDue, RESTING_LINE } from '@/lib/ai-key-health';
import { resolveUniverseAiProvider } from '@/lib/universe-ai';
import { requireServiceToken } from '@/lib/service-tokens';

jest.mock('@/lib/db', () => ({
  prisma: { bot: { findUnique: jest.fn(), updateMany: jest.fn() }, botsAiProvider: { findUnique: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() }, aiKeyLend: { findUnique: jest.fn(async () => null) } },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/ai-key-pay', () => ({ ...jest.requireActual('@/lib/ai-key-pay'), checkKeyForBot: jest.fn() }));
jest.mock('@/lib/notices', () => ({ addNotice: jest.fn() }));
jest.mock('@/lib/universe-ai', () => ({ ...jest.requireActual('@/lib/universe-ai'), resolveUniverseAiProvider: jest.fn() }));
jest.mock('@/lib/ai-key-models', () => ({ ...jest.requireActual('@/lib/ai-key-models'), allowKeyAttempt: jest.fn(() => true) }));
jest.mock('@/lib/ai-key-health', () => ({
  ...jest.requireActual('@/lib/ai-key-health'),
  recheckIfDue: jest.fn(async (key: unknown) => key),
  checkAndRecord: jest.fn(),
  recordReply: jest.fn(),
}));

const db = prisma as unknown as {
  bot: Record<'findUnique' | 'updateMany', jest.Mock>;
  botsAiProvider: Record<'findUnique' | 'findFirst' | 'updateMany', jest.Mock>;
};
const alice = { id: 'maker', uuid: 'uuid-a', email: 'a@example.com', name: 'A', tags: [], isSuperAdmin: false };

const deepseek = {
  providerId: 'deepseek-flash', name: 'DeepSeek V4 Flash', type: 'openai', enabled: true, endpoint: 'https://api.deepseek.com',
  apiKeyEncrypted: 'enc:sk-secret', model: 'deepseek-v4-flash', temperature: 0.7, maxTokens: 500, supportsStreaming: true,
  supportsVision: null, visionModel: null, defaultVision: false, settings: {}, ownerId: null, isDefault: true,
};
const ownKey = {
  ...deepseek, providerId: 'key-1', name: 'My LM Studio', type: 'lmstudio', endpoint: 'https://lm.example.com', apiKeyEncrypted: null,
  ownerId: 'maker', settings: { kind: 'lmstudio' }, isDefault: false, downSince: null, ifDown: 'universe-ai', healthCheckedAt: null,
};
const down = (over: object = {}) => ({ ...ownKey, downSince: new Date('2026-10-19T12:00:00Z'), ...over });

const botOn = (ref: string) => ({
  id: 'b1', name: 'Sam', aiProviderRef: ref, createdById: 'maker', roomId: 'room-1',
  room: { world: { universe: { id: 'uni-1', name: 'BAWES Universe', ownerId: 'universe-owner' } } },
});
const ask = () => credentials(new NextRequest('http://localhost:3333/api/bots/b1/ai-credentials'), { params: Promise.resolve({ id: 'b1' }) });
const json = (method: string, url: string, body: unknown) => new NextRequest(`http://localhost:3333${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  jest.clearAllMocks();
  (requireServiceToken as jest.Mock).mockImplementation(() => undefined);
  (getSessionUser as jest.Mock).mockResolvedValue(alice);
  (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: true });
  (resolveUniverseAiProvider as jest.Mock).mockResolvedValue(deepseek);
  (recheckIfDue as jest.Mock).mockImplementation(async (key: unknown) => key);
  db.bot.findUnique.mockResolvedValue(botOn('key-1'));
});

describe('GET /api/bots/:id/ai-credentials with a key that may be down', () => {
  it('serves a Working key as before', async () => {
    db.botsAiProvider.findUnique.mockResolvedValue(ownKey);
    const body = await (await ask()).json();
    expect(body).toMatchObject({ source: 'own-key', providerId: 'key-1', keyOwnerId: 'maker' });
    expect(body.restingLine).toBeUndefined();
  });

  it('serves Universe AI while the key is down and the owner chose Use Universe AI, and says which key it stands in for', async () => {
    db.botsAiProvider.findUnique.mockResolvedValue(down());
    const body = await (await ask()).json();
    expect(body).toMatchObject({ source: 'universe-ai', providerId: 'deepseek-flash', standingInFor: 'key-1' });
    // The bot stays pointed at its key, so it goes back by itself
    expect(db.bot.updateMany).not.toHaveBeenCalled();
  });

  it('serves no provider at all while the key is down and the owner chose Stop replying: only the resting line', async () => {
    db.botsAiProvider.findUnique.mockResolvedValue(down({ ifDown: 'stop' }));
    const body = await (await ask()).json();
    expect(body).toEqual({ source: 'resting', keyOwnerId: 'maker', restingLine: RESTING_LINE });
    expect(resolveUniverseAiProvider).not.toHaveBeenCalled();
  });

  it('rechecks a down key before deciding, and serves it again if the check brought it back', async () => {
    db.botsAiProvider.findUnique.mockResolvedValue(down({ ifDown: 'stop' }));
    (recheckIfDue as jest.Mock).mockResolvedValue({ ...down({ ifDown: 'stop' }), downSince: null });
    const body = await (await ask()).json();
    expect(recheckIfDue).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ source: 'own-key', providerId: 'key-1' });
  });

  it('does not ask about a key that may not run the bot: that bot moves to Universe AI as before', async () => {
    db.botsAiProvider.findUnique.mockResolvedValue(down());
    (checkKeyForBot as jest.Mock).mockResolvedValue({ ok: false, reason: 'not-lent' });
    db.bot.updateMany.mockResolvedValue({ count: 1 });
    const body = await (await ask()).json();
    expect(recheckIfDue).not.toHaveBeenCalled();
    expect(body).toMatchObject({ source: 'universe-ai', movedFromKey: 'key-1' });
  });

  it('never makes a server provider look down', async () => {
    db.bot.findUnique.mockResolvedValue(botOn('deepseek-flash'));
    db.botsAiProvider.findUnique.mockResolvedValue(deepseek);
    expect(await (await ask()).json()).toMatchObject({ source: 'provider', providerId: 'deepseek-flash' });
    expect(recheckIfDue).not.toHaveBeenCalled();
  });
});

describe('POST /api/bots/:id/ai-health', () => {
  const post = (body: unknown) => report(json('POST', '/api/bots/b1/ai-health', body), idParams('b1'));

  it('needs the service token', async () => {
    (requireServiceToken as jest.Mock).mockImplementation(() => {
      throw new Error('Unauthorized: Invalid service token');
    });
    expect((await post({ ok: true })).status).toBe(401);
    expect(recordReply).not.toHaveBeenCalled();
  });

  it('counts a failed reply against the key the bot runs on, never one named in the request', async () => {
    const response = await post({ ok: false, providerId: 'someone-elses-key' });
    expect(response.status).toBe(204);
    // The bot's id goes along, so a missing model moves only that bot (#575)
    expect(recordReply).toHaveBeenCalledWith('key-1', { ok: false, rejected: false, status: undefined }, 'b1');
  });

  it('passes a rejection and a good reply through', async () => {
    await post({ ok: false, rejected: true });
    await post({ ok: true });
    expect((recordReply as jest.Mock).mock.calls).toEqual([['key-1', { ok: false, rejected: true, status: undefined }, 'b1'], ['key-1', { ok: true }, 'b1']]);
  });

  it('passes the provider’s HTTP status along when it is a real one, and drops anything else', async () => {
    await post({ ok: false, status: 429 });
    await post({ ok: false, status: 'boom' });
    await post({ ok: false, status: 99999 });
    await post({ ok: false, status: 4.5 });
    expect((recordReply as jest.Mock).mock.calls.map((call) => call[1].status)).toEqual([429, undefined, undefined, undefined]);
  });

  it('answers at once, without waiting for the report to be recorded, and a failure there is only logged', async () => {
    let finish: (() => void) | undefined;
    (recordReply as jest.Mock).mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    expect((await post({ ok: false, status: 404 })).status).toBe(204);
    finish?.();
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    (recordReply as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    expect((await post({ ok: false })).status).toBe(204);
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toHaveBeenCalledWith('[BotAi] Health report failed:', 'db down');
    log.mockRestore();
  });

  it('refuses a body without ok', async () => {
    expect((await post({ rejected: true })).status).toBe(400);
    expect(recordReply).not.toHaveBeenCalled();
  });

  it('answers 204 and does nothing for a bot with no provider or no bot', async () => {
    db.bot.findUnique.mockResolvedValue({ aiProviderRef: null });
    expect((await post({ ok: false })).status).toBe(204);
    db.bot.findUnique.mockResolvedValue(null);
    expect((await post({ ok: false })).status).toBe(204);
    expect(recordReply).not.toHaveBeenCalled();
  });
});

describe('POST /api/me/ai-keys/:id/check (Check now)', () => {
  const run = (id = 'key-1') => checkNow(json('POST', `/api/me/ai-keys/${id}/check`, {}), idParams(id));

  it('needs a signed-in user', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await run()).status).toBe(401);
  });

  it('says not found for a key that is not the caller’s, and checks nothing', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue(null);
    expect((await run('key-9')).status).toBe(404);
    expect(db.botsAiProvider.findFirst.mock.calls[0][0].where).toEqual({ providerId: 'key-9', ownerId: 'maker' });
    expect(checkAndRecord).not.toHaveBeenCalled();
  });

  it('says working when the check passes', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue(ownKey);
    (checkAndRecord as jest.Mock).mockResolvedValue({ ok: true });
    expect(await (await run()).json()).toEqual({ status: 'working' });
  });

  it('says down, with the reason in plain words, when it fails', async () => {
    db.botsAiProvider.findFirst.mockResolvedValue(ownKey);
    (checkAndRecord as jest.Mock).mockResolvedValue({ ok: false, reason: 'stopped', message: 'It didn’t answer. Is the server running and the tunnel up?' });
    expect(await (await run()).json()).toEqual({ status: 'down', message: 'It didn’t answer. Is the server running and the tunnel up?' });
  });
});

describe('PATCH /api/me/ai-keys/:id (If this is down)', () => {
  const patch = (body: unknown, id = 'key-1') => setIfDown(json('PATCH', `/api/me/ai-keys/${id}`, body), idParams(id));

  it('saves either choice for the owner', async () => {
    db.botsAiProvider.updateMany.mockResolvedValue({ count: 1 });
    expect(await (await patch({ ifDown: 'stop' })).json()).toEqual({ status: 'saved', ifDown: 'stop' });
    expect(db.botsAiProvider.updateMany).toHaveBeenCalledWith({ where: { providerId: 'key-1', ownerId: 'maker' }, data: { ifDown: 'stop' } });
    expect((await patch({ ifDown: 'universe-ai' })).status).toBe(200);
  });

  it('refuses anything else, and changes nothing', async () => {
    for (const body of [{}, { ifDown: 'other' }, { ifDown: 1 }, { name: 'x' }]) expect((await patch(body)).status).toBe(400);
    expect(db.botsAiProvider.updateMany).not.toHaveBeenCalled();
  });

  it('says not found for someone else’s key or a server provider', async () => {
    db.botsAiProvider.updateMany.mockResolvedValue({ count: 0 });
    expect((await patch({ ifDown: 'stop' }, 'deepseek-flash')).status).toBe(404);
  });

  it('needs a signed-in user', async () => {
    (getSessionUser as jest.Mock).mockResolvedValue(null);
    expect((await patch({ ifDown: 'stop' })).status).toBe(401);
  });
});
