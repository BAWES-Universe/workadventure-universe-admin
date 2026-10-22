/**
 * What the bot server is told about where a bot's images go (the Vision row). A bot whose own model sees, a bot on Universe AI
 * and a bot pinned to a server provider are served exactly as before; a bot on a person's own key whose model can't see gets
 * the Vision model on that same key, or Universe AI, unless its owner picked something else.
 */
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { GET } from '@/app/api/bots/[id]/ai-credentials/route';
import { checkKeyForBot } from '@/lib/ai-key-pay';
import { recheckIfDue } from '@/lib/ai-key-health';
import { requireServiceToken } from '@/lib/service-tokens';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: { findUnique: jest.fn(), updateMany: jest.fn() },
    botsAiProvider: { findUnique: jest.fn(), findFirst: jest.fn() },
  },
}));
jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/ai-key-pay', () => ({ ...jest.requireActual('@/lib/ai-key-pay'), checkKeyForBot: jest.fn() }));
jest.mock('@/lib/notices', () => ({ addNotice: jest.fn() }));
jest.mock('@/lib/ai-key-health', () => ({ ...jest.requireActual('@/lib/ai-key-health'), recheckIfDue: jest.fn(async (key: unknown) => key) }));

const bot = prisma.bot as unknown as Record<'findUnique' | 'updateMany', jest.Mock>;
const provider = prisma.botsAiProvider as unknown as Record<'findUnique' | 'findFirst', jest.Mock>;
const verdict = checkKeyForBot as jest.Mock;

const base = {
  name: 'k', type: 'openai', enabled: true, endpoint: 'https://api.deepseek.com', apiKeyEncrypted: 'enc:sk-own', model: 'deepseek-v4-flash',
  temperature: 0.7, maxTokens: 500, supportsStreaming: true, supportsVision: false as boolean | null, visionModel: null, defaultVision: false,
  isDefault: false, downSince: null, ifDown: 'universe-ai', healthCheckedAt: null, downReason: null, failedReplies: 0, settings: {},
};
const universeAiProvider = { ...base, providerId: 'deepseek-flash', name: 'DeepSeek V4 Flash', ownerId: null, supportsVision: null, isDefault: true, apiKeyEncrypted: 'enc:sk-server' };
const deepseekKey = { ...base, providerId: 'key-1', name: 'My DeepSeek', ownerId: 'maker', settings: { kind: 'deepseek' } };
const lmStudioKey = { ...base, providerId: 'key-2', name: 'My LM Studio', ownerId: 'maker', type: 'lmstudio', endpoint: 'https://lm.example.com', model: 'qwen3-8b', supportsVision: null, apiKeyEncrypted: null, settings: { kind: 'lmstudio' } };
const geminiKey = { ...base, providerId: 'key-3', name: 'My Gemini', ownerId: 'maker', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3-flash', supportsVision: true, settings: { kind: 'gemini' } };
const pinned = { ...universeAiProvider, providerId: 'lmstudio-local', isDefault: false };

const botOn = (ref: string | null, behaviorConfig: object | null = null) => ({
  id: 'b1', name: 'Sam', aiProviderRef: ref, behaviorConfig, createdById: 'maker', roomId: 'room-1',
  room: { world: { universe: { id: 'uni-1', name: 'BAWES Universe', ownerId: 'universe-owner' } } },
});
const ask = async () => (await GET(new NextRequest('http://localhost:3333/api/bots/b1/ai-credentials'), { params: Promise.resolve({ id: 'b1' }) })).json();
const rows: Record<string, unknown> = {};
const setRows = (...list: Array<{ providerId: string } & Record<string, unknown>>) => {
  for (const key of Object.keys(rows)) delete rows[key];
  for (const row of list) rows[row.providerId] = row;
};

beforeEach(() => {
  (recheckIfDue as jest.Mock).mockClear();
  bot.findUnique.mockReset();
  provider.findUnique.mockReset();
  provider.findFirst.mockReset();
  verdict.mockReset();
  verdict.mockResolvedValue({ ok: true });
  (requireServiceToken as jest.Mock).mockReset();
  setRows(universeAiProvider, deepseekKey, lmStudioKey, geminiKey, pinned);
  provider.findUnique.mockImplementation(async ({ where }: { where: { providerId: string } }) => rows[where.providerId] ?? null);
  provider.findFirst.mockResolvedValue(universeAiProvider);
});

describe('nothing picked', () => {
  it('uses the Vision model on the same key for a text model, so images stay on the key', async () => {
    bot.findUnique.mockResolvedValue(botOn('key-1'));
    const body = await ask();
    expect(body).toMatchObject({ source: 'own-key', providerId: 'key-1', model: 'deepseek-v4-flash' });
    expect(body.vision).toMatchObject({
      choice: 'another',
      credentials: { providerId: 'key-1', model: 'deepseek-v4-flash-vision-exp', supportsVision: true, apiKeyEncrypted: 'enc:sk-own', keyOwnerId: 'maker', keyKind: 'deepseek', keyGroup: 'hosted', keyAddressTyped: false },
    });
  });

  it('uses Universe AI when the key has no Vision model to offer', async () => {
    bot.findUnique.mockResolvedValue(botOn('key-2'));
    expect((await ask()).vision).toEqual({ choice: 'universe-ai' });
  });

  it('says nothing for a model that sees images itself', async () => {
    bot.findUnique.mockResolvedValue(botOn('key-3'));
    expect('vision' in (await ask())).toBe(false);
  });

  it('says nothing for a bot on Universe AI, which behaves as it always did', async () => {
    bot.findUnique.mockResolvedValue(botOn('universe-ai'));
    const body = await ask();
    expect(body.source).toBe('universe-ai');
    expect('vision' in body).toBe(false);
  });

  it('says nothing for a bot pinned to a server provider', async () => {
    bot.findUnique.mockResolvedValue(botOn('lmstudio-local'));
    const body = await ask();
    expect(body.source).toBe('provider');
    expect('vision' in body).toBe(false);
  });
});

describe('the owner picked', () => {
  it('"This model": the bot’s own model, even when it can’t see', async () => {
    bot.findUnique.mockResolvedValue(botOn('key-2', { vision: { choice: 'this' } }));
    expect((await ask()).vision).toEqual({ choice: 'this' });
  });

  it('"Universe AI", on a key, on Universe AI itself, and with a model that sees', async () => {
    for (const ref of ['key-2', 'key-3', 'universe-ai']) {
      bot.findUnique.mockResolvedValue(botOn(ref, { vision: { choice: 'universe-ai' } }));
      expect((await ask()).vision).toEqual({ choice: 'universe-ai' });
    }
  });

  it('"Another model" on another key, with that key’s credentials and the picked model', async () => {
    bot.findUnique.mockResolvedValue(botOn('key-2', { vision: { choice: 'another', keyId: 'key-1', model: 'deepseek-v4-flash-vision-exp' } }));
    const body = await ask();
    expect(body).toMatchObject({ source: 'own-key', providerId: 'key-2' });
    expect(body.vision.credentials).toMatchObject({ providerId: 'key-1', model: 'deepseek-v4-flash-vision-exp', apiKeyEncrypted: 'enc:sk-own', supportsVision: true });
  });

  it('"Another model" on a bot that runs on Universe AI', async () => {
    bot.findUnique.mockResolvedValue(botOn('universe-ai', { vision: { choice: 'another', keyId: 'key-3', model: 'gemini-3-flash' } }));
    const body = await ask();
    expect(body.source).toBe('universe-ai');
    expect(body.vision.credentials).toMatchObject({ providerId: 'key-3', model: 'gemini-3-flash', visionModel: null, supportsVision: true });
  });

  it('leaves the images to the bot’s own model when the key picked can’t be used, never to Universe AI', async () => {
    const pick = { vision: { choice: 'another', keyId: 'key-1', model: 'deepseek-v4-flash-vision-exp' } };
    // the key was taken away, is no longer lent, is Down, or no longer runs a model with Vision
    const cases: Array<[string, () => void]> = [
      ['removed', () => setRows(universeAiProvider, lmStudioKey)],
      ['unlent', () => verdict.mockImplementation(async ({ keyId }: { keyId: string }) => (keyId === 'key-1' ? { ok: false, reason: 'not-lent' } : { ok: true }))],
      ['down', () => setRows(universeAiProvider, { ...deepseekKey, downSince: new Date() }, lmStudioKey)],
      ['changed', () => setRows(universeAiProvider, { ...deepseekKey, settings: { kind: 'lmstudio' } }, lmStudioKey)],
    ];
    for (const [, arrange] of cases) {
      setRows(universeAiProvider, deepseekKey, lmStudioKey);
      verdict.mockReset();
      verdict.mockResolvedValue({ ok: true });
      arrange();
      bot.findUnique.mockResolvedValue(botOn('key-2', pick));
      expect((await ask()).vision).toEqual({ choice: 'this', problem: 'key' });
    }
  });

  it('asks a Down key picked only for images to check itself again, without making the reply wait for it', async () => {
    const pick = { vision: { choice: 'another', keyId: 'key-1', model: 'deepseek-v4-flash-vision-exp' } };
    const down = { ...deepseekKey, downSince: new Date(), ifDown: 'stop' };
    setRows(universeAiProvider, down, lmStudioKey);
    bot.findUnique.mockResolvedValue(botOn('key-2', pick));
    expect((await ask()).vision).toEqual({ choice: 'this', problem: 'key' });
    // the recheck is asked as a Universe-AI-meanwhile key, so it is never awaited
    expect(recheckIfDue).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'key-1', ifDown: 'universe-ai' }));
  });

  it('a recheck that fails never escapes as an unhandled rejection, and the reply still comes', async () => {
    const pick = { vision: { choice: 'another', keyId: 'key-1', model: 'deepseek-v4-flash-vision-exp' } };
    const down = { ...deepseekKey, downSince: new Date(), ifDown: 'stop' };
    setRows(universeAiProvider, down, lmStudioKey);
    bot.findUnique.mockResolvedValue(botOn('key-2', pick));
    const failing = Promise.reject(new Error('database is down'));
    const caught = jest.spyOn(failing, 'catch');
    // only the images-only key's check fails; the bot's main key is asked first and answers as usual
    (recheckIfDue as jest.Mock).mockImplementationOnce(async (key: unknown) => key).mockReturnValueOnce(failing);
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await ask()).vision).toEqual({ choice: 'this', problem: 'key' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(caught).toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith('[AiKeys] Recheck of a vision key failed:', 'database is down');
    logged.mockRestore();
  });

  it('does not ask a working key to check itself', async () => {
    const pick = { vision: { choice: 'another', keyId: 'key-1', model: 'deepseek-v4-flash-vision-exp' } };
    bot.findUnique.mockResolvedValue(botOn('key-2', pick));
    await ask();
    expect(recheckIfDue).not.toHaveBeenCalledWith(expect.objectContaining({ providerId: 'key-1' }));
  });

  it('ignores a saved pick it can’t read, as if nothing were picked', async () => {
    bot.findUnique.mockResolvedValue(botOn('key-2', { vision: { choice: 'another' } }));
    expect((await ask()).vision).toEqual({ choice: 'universe-ai' });
  });
});
