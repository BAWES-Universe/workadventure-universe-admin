/**
 * Where a bot's images go (the Vision row): what is saved, which key models can look at images, the default when nothing is
 * picked, and who may pick what.
 */
import { prisma } from '@/lib/db';
import { checkKeyForBot } from '@/lib/ai-key-pay';
import { keepVisionPick } from '@/lib/bot-config-helpers';
import { autoVision, checkConfigVision, checkVisionPick, dropOthersVisionKey, keyVisionModels, parseVisionPick, readVisionPick, usableVisionKey } from '@/lib/bot-vision';

jest.mock('@/lib/db', () => ({ prisma: { botsAiProvider: { findUnique: jest.fn(), findFirst: jest.fn() } } }));
jest.mock('@/lib/ai-key-pay', () => ({ ...jest.requireActual('@/lib/ai-key-pay'), checkKeyForBot: jest.fn() }));

const db = prisma.botsAiProvider as unknown as Record<'findUnique' | 'findFirst', jest.Mock>;
const verdict = checkKeyForBot as jest.Mock;
const PICK = { choice: 'another', keyId: 'key-1', model: 'deepseek-v4-flash-vision-exp' } as const;
const deepseekKey = { providerId: 'key-1', name: 'My DeepSeek', ownerId: 'maker', model: 'deepseek-v4-flash', supportsVision: false, settings: { kind: 'deepseek' }, downSince: null };
const bot = { id: 'bot-1', createdById: 'maker', roomId: 'room-1' };
const ctx = (over: object = {}) => ({ current: null, actorId: 'maker', makerId: 'maker', roomId: 'room-1', botId: 'bot-1', ...over });

beforeEach(() => {
  db.findUnique.mockReset();
  db.findFirst.mockReset();
  verdict.mockReset();
  verdict.mockResolvedValue({ ok: true });
  db.findFirst.mockResolvedValue({ providerId: 'deepseek-flash', enabled: true });
});

describe('what is saved', () => {
  it('reads the three choices and nothing else', () => {
    expect(readVisionPick({ vision: { choice: 'this' } })).toEqual({ choice: 'this' });
    expect(readVisionPick({ vision: { choice: 'universe-ai', junk: 1 } })).toEqual({ choice: 'universe-ai' });
    expect(readVisionPick({ vision: PICK })).toEqual(PICK);
    for (const bad of [null, undefined, 'x', {}, { vision: null }, { vision: { choice: 'another' } }, { vision: { choice: 'another', keyId: 'k' } }, { vision: { choice: 'another', keyId: '', model: 'm' } }, { vision: { choice: 'x' } }]) {
      expect(readVisionPick(bad)).toBeNull();
    }
    expect(parseVisionPick({ choice: 'another', keyId: 'k', model: 'm', extra: true })).toEqual({ choice: 'another', keyId: 'k', model: 'm' });
  });

  it('keeps the pick when a save replaces the whole config without it, and lets an explicit value or null win', () => {
    expect(keepVisionPick({ vision: PICK, x: 1 }, { y: 2 })).toEqual({ y: 2, vision: PICK });
    expect(keepVisionPick({ vision: PICK }, { vision: { choice: 'this' } })).toEqual({ vision: { choice: 'this' } });
    expect(keepVisionPick({ vision: PICK }, { vision: null })).toEqual({ vision: null });
    expect(keepVisionPick({ x: 1 }, { y: 2 })).toEqual({ y: 2 });
    expect(keepVisionPick(null, { y: 2 })).toEqual({ y: 2 });
  });
});

describe('the models with Vision a key can look at images with', () => {
  it('names the image model DeepSeek has apart from the text one the key runs', () => {
    expect(keyVisionModels({ model: 'deepseek-v4-flash', supportsVision: false, settings: { kind: 'deepseek' } })).toEqual(['deepseek-v4-flash-vision-exp']);
    expect(keyVisionModels({ model: 'deepseek-v4-pro', supportsVision: null, settings: { kind: 'deepseek' } })).toEqual(['deepseek-v4-flash-vision-exp']);
  });

  it('lists the key’s own model first when it sees images, then what the docs name', () => {
    expect(keyVisionModels({ model: 'gemini-3-flash', supportsVision: null, settings: { kind: 'gemini' } })).toEqual(['gemini-3-flash']);
    expect(keyVisionModels({ model: 'x', supportsVision: true, settings: { kind: 'deepseek' } })).toEqual(['x', 'deepseek-v4-flash-vision-exp']);
    expect(keyVisionModels({ model: 'deepseek-v4-flash-vision-exp', supportsVision: true, settings: { kind: 'deepseek' } })).toEqual(['deepseek-v4-flash-vision-exp']);
  });

  it('has none for a model that can’t see on a provider that names none, and a forced text-only never sees', () => {
    expect(keyVisionModels({ model: 'qwen3-8b', supportsVision: null, settings: { kind: 'lmstudio' } })).toEqual([]);
    expect(keyVisionModels({ model: 'gemini-3-flash', supportsVision: false, settings: { kind: 'gemini' } })).toEqual([]);
    expect(keyVisionModels({ model: null, supportsVision: null, settings: null })).toEqual([]);
  });
});

describe('where images go when the owner picked nothing', () => {
  it('stays on the model that sees them', () => {
    expect(autoVision({ ownKeyId: 'key-1', sees: true, sameKeyModel: 'v' })).toEqual({ choice: 'this' });
  });
  it('uses a Vision model on the same key when there is one, so images stay on the key', () => {
    expect(autoVision({ ownKeyId: 'key-1', sees: false, sameKeyModel: 'v' })).toEqual({ choice: 'another', keyId: 'key-1', model: 'v' });
  });
  it('goes to Universe AI otherwise', () => {
    expect(autoVision({ ownKeyId: 'key-1', sees: false, sameKeyModel: null })).toEqual({ choice: 'universe-ai' });
    expect(autoVision({ ownKeyId: null, sees: false, sameKeyModel: null })).toEqual({ choice: 'universe-ai' });
  });
});

describe('a key picked for images', () => {
  it('can be used while it may run the bot, lent here, running a model with Vision, and working', async () => {
    db.findUnique.mockResolvedValue(deepseekKey);
    expect(await usableVisionKey(PICK, bot)).toMatchObject({ ok: true });
    expect(verdict).toHaveBeenCalledWith({ keyId: 'key-1', keyOwnerId: 'maker', bot });
  });

  it('follows whoever’s key the bot runs on (#709): another person’s key is not used for its images', async () => {
    db.findUnique.mockResolvedValue(deepseekKey);
    expect(await usableVisionKey(PICK, bot, { mainKeyOwnerId: 'maker' })).toMatchObject({ ok: true });
    expect(await usableVisionKey(PICK, bot, { mainKeyOwnerId: 'khalid' })).toMatchObject({ ok: false, problem: 'other-owner' });
  });

  it.each([
    ['gone', null, { ok: true }],
    ['no-owner', deepseekKey, { ok: false, reason: 'no-owner' }],
    ['not-lent', deepseekKey, { ok: false, reason: 'not-lent' }],
    ['no-access', deepseekKey, { ok: false, reason: 'no-access' }],
    ['no-model', { ...deepseekKey, settings: { kind: 'lmstudio' } }, { ok: true }],
    ['down', { ...deepseekKey, downSince: new Date() }, { ok: true }],
    ['gone', { ...deepseekKey, ownerId: null }, { ok: true }],
  ])('can not be used when: %s', async (problem, key, check) => {
    db.findUnique.mockResolvedValue(key);
    verdict.mockResolvedValue(check);
    expect(await usableVisionKey(PICK, bot)).toMatchObject({ ok: false, problem });
  });
});

describe('saving a pick', () => {
  it('lets nothing, a clear and "This model" through for anyone who may save the bot', async () => {
    expect(await checkVisionPick(undefined, ctx({ actorId: null }))).toBeNull();
    expect(await checkVisionPick(null, ctx({ actorId: null }))).toBeNull();
    expect(await checkVisionPick({ choice: 'this' }, ctx({ actorId: 'manager' }))).toBeNull();
  });

  it('lets Universe AI through while it has a provider, and says so when it has none', async () => {
    expect(await checkVisionPick({ choice: 'universe-ai' }, ctx({ actorId: 'manager' }))).toBeNull();
    db.findFirst.mockResolvedValue(null);
    expect(await checkVisionPick({ choice: 'universe-ai' }, ctx({ actorId: 'manager' }))).toMatch(/Universe AI has no enabled provider/);
  });

  it('refuses a choice it does not know', async () => {
    expect(await checkVisionPick({ choice: 'sideways' }, ctx())).toBe('Pick where images go: This model, Another model or Universe AI.');
    expect(await checkVisionPick('this', ctx())).toBe('Pick where images go: This model, Another model or Universe AI.');
  });

  it('lets the maker pick a Vision model on their own key lent here', async () => {
    db.findUnique.mockResolvedValue(deepseekKey);
    expect(await checkVisionPick(PICK, ctx())).toBeNull();
  });

  it('never lets someone pick a key that is not theirs, and says it is not there', async () => {
    db.findUnique.mockResolvedValue(deepseekKey);
    expect(await checkVisionPick(PICK, ctx({ actorId: 'manager' }))).toBe('That key isn’t there.');
    expect(await checkVisionPick(PICK, ctx({ actorId: null }))).toBe('That key isn’t there.');
    db.findUnique.mockResolvedValue(null);
    expect(await checkVisionPick(PICK, ctx())).toBe('That key isn’t there.');
  });

  it('lets anyone who manages the bot pick their own key for it (#709), not only its maker', async () => {
    db.findUnique.mockResolvedValue({ ...deepseekKey, ownerId: 'khalid' });
    expect(await checkVisionPick(PICK, ctx({ actorId: 'khalid', makerId: 'maker' }))).toBeNull();
    expect(verdict).toHaveBeenCalledWith({ keyId: 'key-1', keyOwnerId: 'khalid', bot: { id: 'bot-1', createdById: 'maker', roomId: 'room-1' } });
  });

  it('keeps images off your key while the bot runs on someone else’s key', async () => {
    const mine = { ...deepseekKey, ownerId: 'khalid' };
    db.findUnique.mockResolvedValueOnce(mine).mockResolvedValueOnce({ ownerId: 'sara' });
    expect(await checkVisionPick(PICK, ctx({ actorId: 'khalid', mainRef: 'sara-key' }))).toBe(
      'This bot runs on someone else’s key, so its images can’t go to your key. Move it to your key first.',
    );
    // On your own key, Universe AI or a server provider, your key is fine
    db.findUnique.mockResolvedValueOnce(mine).mockResolvedValueOnce({ ownerId: 'khalid' }).mockResolvedValue(mine);
    expect(await checkVisionPick(PICK, ctx({ actorId: 'khalid', mainRef: 'khalid-key' }))).toBeNull();
    db.findUnique.mockResolvedValueOnce(mine).mockResolvedValueOnce(null).mockResolvedValue(mine);
    expect(await checkVisionPick(PICK, ctx({ actorId: 'khalid', mainRef: 'universe-ai' }))).toBeNull();
  });

  it('says why a key can not look at images', async () => {
    db.findUnique.mockResolvedValue({ ...deepseekKey, settings: { kind: 'lmstudio' } });
    expect(await checkVisionPick(PICK, ctx())).toBe('That model can’t look at images on this key.');
    db.findUnique.mockResolvedValue({ ...deepseekKey, downSince: new Date() });
    expect(await checkVisionPick(PICK, ctx())).toBe('That key is down right now. Pick it again when it’s back.');
    db.findUnique.mockResolvedValue(deepseekKey);
    verdict.mockResolvedValue({ ok: false, reason: 'not-lent' });
    expect(await checkVisionPick(PICK, ctx())).toBe('That key isn’t lent to this bot’s universe. Lend it from AI keys first.');
  });

  it('lets a save carry the pick the bot already has without asking about the key again', async () => {
    expect(await checkVisionPick(PICK, ctx({ actorId: 'manager', current: PICK }))).toBeNull();
    expect(db.findUnique).not.toHaveBeenCalled();
  });

  it('judges only a vision key in a whole config', async () => {
    const base = { storedConfig: { vision: PICK }, actorId: 'manager', makerId: 'maker', roomId: 'room-1', botId: 'bot-1' };
    expect(await checkConfigVision({ walkSpeed: 2 }, base)).toBeNull();
    expect(await checkConfigVision(undefined, base)).toBeNull();
    expect(await checkConfigVision({ vision: PICK }, base)).toBeNull();
    expect(await checkConfigVision({ vision: { choice: 'this' } }, base)).toBeNull();
    expect(await checkConfigVision({ vision: { ...PICK, model: 'other' } }, base)).toBe('That key isn’t there.');
  });
});

describe('moving a bot off a key (#709)', () => {
  it('drops a pick on someone else’s key, keeping the rest of the config', async () => {
    db.findUnique.mockResolvedValue({ ownerId: 'sara' });
    expect(await dropOthersVisionKey({ vision: PICK, walkSpeed: 2 }, 'khalid')).toEqual({ walkSpeed: 2 });
    db.findUnique.mockResolvedValue(null);
    expect(await dropOthersVisionKey({ vision: PICK }, 'khalid')).toEqual({});
  });

  it('keeps a pick on the mover’s own key, and any pick that is not a key', async () => {
    db.findUnique.mockResolvedValue({ ownerId: 'khalid' });
    expect(await dropOthersVisionKey({ vision: PICK }, 'khalid')).toBeNull();
    expect(await dropOthersVisionKey({ vision: { choice: 'universe-ai' } }, 'khalid')).toBeNull();
    expect(await dropOthersVisionKey({ walkSpeed: 2 }, 'khalid')).toBeNull();
    expect(await dropOthersVisionKey(null, 'khalid')).toBeNull();
  });
});
