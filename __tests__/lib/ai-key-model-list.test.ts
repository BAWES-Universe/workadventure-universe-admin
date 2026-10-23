import { prisma } from '@/lib/db';
import { probeModels } from '@/lib/ai-key-models';
import { allowedModels, forgetKeyModels, keyModels, lendModels, modelFactsOf, modelSupportsVision, servedModel, MODEL_LIST_TTL_MS } from '@/lib/ai-key-model-list';
import { providerPayload } from '@/lib/ai-provider-payload';

/** A bot picks its own model on a key, and a lend can allow only some (#575). */

jest.mock('@/lib/db', () => ({ prisma: { botsAiProvider: { findUnique: jest.fn(), updateMany: jest.fn() } } }));
jest.mock('@/lib/ai-key-models', () => ({ ...jest.requireActual('@/lib/ai-key-models'), probeModels: jest.fn() }));
jest.mock('@/lib/encryption', () => ({ decryptApiKey: jest.fn((value: string) => value.replace('enc:', '')) }));

const db = prisma.botsAiProvider as unknown as Record<'findUnique' | 'updateMany', jest.Mock>;
const probe = probeModels as jest.Mock;

let n = 0;
/** Each test gets its own key id, so the list kept for one never answers another. */
const claudeKey = (over: object = {}) => ({
  providerId: `key-${++n}`, endpoint: 'https://api.anthropic.com/v1', apiKeyEncrypted: 'enc:sk-ant', settings: { kind: 'claude' } as unknown, model: 'claude-sonnet-5-5', supportsVision: true, ...over,
});
const LIST = { ok: true, models: ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'], facts: { 'claude-haiku-5-5': { vision: true, tools: true, context: 200000 } } };

beforeEach(() => {
  for (const fn of [...Object.values(db), probe]) fn.mockReset();
  db.updateMany.mockResolvedValue({ count: 1 });
});

describe('the model a bot replies with', () => {
  it('is its own pick, else the key’s check model, so a bot with none replies exactly as before', () => {
    expect(servedModel({ aiModel: 'claude-haiku-5-5' }, { model: 'claude-sonnet-5-5' }, null)).toBe('claude-haiku-5-5');
    expect(servedModel({ aiModel: null }, { model: 'claude-sonnet-5-5' }, null)).toBe('claude-sonnet-5-5');
  });

  it('is never one the lend leaves out: the first one it allows instead', () => {
    expect(servedModel({ aiModel: 'claude-opus-5-5' }, { model: 'claude-sonnet-5-5' }, ['claude-haiku-5-5'])).toBe('claude-haiku-5-5');
    expect(servedModel({ aiModel: null }, { model: 'claude-sonnet-5-5' }, ['claude-haiku-5-5', 'claude-sonnet-5-5'])).toBe('claude-sonnet-5-5');
  });

  it('sees images by what the provider said about that model; the check model keeps what was saved with the key', () => {
    const key = { settings: { kind: 'deepseek', modelFacts: { 'deepseek-v4-pro': { vision: false } } }, model: 'deepseek-v4-flash', supportsVision: null };
    expect(modelSupportsVision(key, 'deepseek-v4-flash')).toBeNull();
    expect(modelSupportsVision(key, 'deepseek-v4-pro')).toBe(false);
    // Not listed with facts: DeepSeek's own docs say so
    expect(modelSupportsVision(key, 'deepseek-v4-flash-vision-exp')).toBe(true);
    // Nothing known: left to the bot server's guess, as for any key
    expect(modelSupportsVision(key, 'deepseek-unknown')).toBeNull();
  });
});

describe('a lend’s models', () => {
  it('reads null, an empty list and junk as all models', () => {
    expect(lendModels(null)).toBeNull();
    expect(lendModels([])).toBeNull();
    expect(lendModels('claude-haiku-5-5')).toBeNull();
    expect(lendModels(['claude-haiku-5-5', 4, ''])).toEqual(['claude-haiku-5-5']);
  });

  it('keeps the provider’s order and drops what the provider no longer lists', () => {
    expect(allowedModels(LIST.models, ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-gone'])).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(allowedModels(LIST.models, null)).toEqual(LIST.models);
  });
});

describe('keyModels', () => {
  it('asks the provider with the saved key at the saved address, and keeps the answer a few minutes', async () => {
    probe.mockResolvedValue(LIST);
    const key = claudeKey();
    expect(await keyModels(key)).toEqual({ ok: true, models: LIST.models, facts: LIST.facts, listed: true });
    expect(probe).toHaveBeenCalledWith({ kind: 'claude', address: 'https://api.anthropic.com/v1', apiKey: 'sk-ant' });
    await keyModels(key);
    expect(probe).toHaveBeenCalledTimes(1);
    await keyModels(key, { now: Date.now() + MODEL_LIST_TTL_MS + 1 });
    expect(probe).toHaveBeenCalledTimes(2);
    await keyModels(key, { fresh: true });
    expect(probe).toHaveBeenCalledTimes(3);
    forgetKeyModels(key.providerId);
    await keyModels(key);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('keeps what the provider said about each model on the key, Tools, Vision and how much it reads, once', async () => {
    probe.mockResolvedValue(LIST);
    const key = claudeKey();
    db.findUnique.mockResolvedValue({ settings: { kind: 'claude', caps: { vision: true } } });
    await keyModels(key);
    expect(db.updateMany).toHaveBeenCalledWith({
      where: { providerId: key.providerId, ownerId: { not: null } },
      data: { settings: { kind: 'claude', caps: { vision: true }, modelFacts: { 'claude-haiku-5-5': { vision: true, tools: true, context: 200000 } } } },
    });
    db.updateMany.mockClear();
    await keyModels(key, { fresh: true });
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it('doesn’t save again when the saved facts only differ in key order (Postgres reorders a jsonb)', async () => {
    probe.mockResolvedValue(LIST);
    const key = claudeKey({ settings: { kind: 'claude', modelFacts: { 'claude-haiku-5-5': { context: 200000, tools: true, vision: true } } } });
    await keyModels(key, { fresh: true });
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it('gives a caller that joined a request already running the same facts', async () => {
    let answer: ((value: unknown) => void) | undefined;
    probe.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    db.findUnique.mockResolvedValue({ settings: { kind: 'claude' } });
    const first = claudeKey();
    const joiner = { ...first, settings: { kind: 'claude' } };
    const asks = [keyModels(first, { fresh: true }), keyModels(joiner)];
    answer?.(LIST);
    await Promise.all(asks);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(modelFactsOf(joiner, 'claude-haiku-5-5')).toEqual({ vision: true, tools: true, context: 200000 });
  });

  it('gives a provider with no model list its one typed model', async () => {
    probe.mockResolvedValue({ ok: false, noList: true, message: 'Groq doesn’t share a list of its models.', reason: 'other' });
    expect(await keyModels(claudeKey({ settings: { kind: 'groq' }, model: 'llama-3.3-70b' }))).toEqual({ ok: true, models: ['llama-3.3-70b'], facts: {}, listed: false });
  });

  it('says why when the list can’t be loaded, and keeps nothing', async () => {
    probe.mockResolvedValue({ ok: false, message: 'Claude didn’t accept this key.', reason: 'rejected' });
    const key = claudeKey();
    expect(await keyModels(key)).toEqual({ ok: false, message: 'Claude didn’t accept this key.' });
    await keyModels(key);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('asks once for two calls at the same time', async () => {
    let answer: (value: unknown) => void = () => undefined;
    probe.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const key = claudeKey();
    const both = Promise.all([keyModels(key), keyModels(key)]);
    answer(LIST);
    await both;
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('what the bot server is given', () => {
  it('never carries the facts about every model on the key', () => {
    const payload = providerPayload({ ...claudeKey(), name: 'k', type: 'anthropic', enabled: true, temperature: null, maxTokens: 500, supportsStreaming: true, visionModel: null, defaultVision: false, settings: { kind: 'claude', caps: { vision: true }, modelFacts: { a: { vision: true } } } } as never);
    expect(payload.settings).toEqual({ kind: 'claude', caps: { vision: true } });
  });
});
