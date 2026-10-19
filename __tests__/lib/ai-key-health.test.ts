import { prisma } from '@/lib/db';
import { addNotice, clearNotices } from '@/lib/notices';
import { probeChat, probeModels } from '@/lib/ai-key-models';
import { checkAndRecord, checkKey, judgeFailedReply, markDown, markWorking, recheckIfDue, recordReply, RECHECK_MS, type KeyRow } from '@/lib/ai-key-health';

jest.mock('@/lib/db', () => ({ prisma: { botsAiProvider: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() } } }));
jest.mock('@/lib/notices', () => ({ addNotice: jest.fn(), clearNotices: jest.fn() }));
jest.mock('@/lib/ai-key-models', () => ({ ...jest.requireActual('@/lib/ai-key-models'), probeModels: jest.fn(), probeChat: jest.fn() }));
jest.mock('@/lib/encryption', () => ({ decryptApiKey: jest.fn((value: string) => value.replace('enc:', '')) }));

const db = prisma.botsAiProvider as unknown as Record<'findFirst' | 'findUnique' | 'update' | 'updateMany', jest.Mock>;
const notice = addNotice as jest.Mock;
const clear = clearNotices as jest.Mock;
const probe = probeModels as jest.Mock;
const chat = probeChat as jest.Mock;

const hosted: KeyRow = {
  providerId: 'key-1', name: 'My DeepSeek', ownerId: 'owner', endpoint: 'https://api.deepseek.com', apiKeyEncrypted: 'enc:sk-secret',
  settings: { kind: 'deepseek' }, downSince: null, ifDown: 'universe-ai', healthCheckedAt: null,
};
const own: KeyRow = { ...hosted, providerId: 'key-2', name: 'My LM Studio', endpoint: 'https://lm.example.com', apiKeyEncrypted: null, settings: { kind: 'lmstudio' } };
const downNow = (key: KeyRow, over: Partial<KeyRow> = {}): KeyRow => ({ ...key, downSince: new Date('2026-10-19T12:00:00Z'), ...over });

beforeEach(() => {
  for (const fn of [...Object.values(db), notice, clear, probe, chat]) fn.mockReset();
  db.updateMany.mockResolvedValue({ count: 1 });
  notice.mockResolvedValue(true);
});

describe('markDown', () => {
  it('flips a Working key once and tells its owner once, in the hosted wording', async () => {
    const at = new Date('2026-10-19T12:00:00Z');
    expect(await markDown(hosted, 'stopped', at)).toBe(true);
    expect(db.updateMany).toHaveBeenCalledWith({ where: { providerId: 'key-1', ownerId: { not: null }, downSince: null }, data: expect.objectContaining({ downSince: at, downReason: 'stopped' }) });
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0][0]).toMatchObject({ userId: 'owner', kind: 'ai-key-down', dedupeKey: `down:key-1:${at.toISOString()}`, title: 'My DeepSeek is down', badge: 'Down', href: '/admin/you/ai-keys' });
    expect(notice.mock.calls[0][0].body).toBe('DeepSeek stopped answering. Bots on it reply on Universe AI until it’s back. Universe checks every 5 minutes and switches back by itself.');
  });

  it('uses the own-computer wording that says conversations leave the computer', async () => {
    await markDown(own, 'stopped');
    expect(notice.mock.calls[0][0].body).toContain('so their conversations leave your computer meanwhile');
  });

  it('says the bots are resting when the owner chose Stop replying', async () => {
    await markDown({ ...own, ifDown: 'stop' }, 'stopped');
    expect(notice.mock.calls[0][0].body).toContain('Bots on it are resting until it’s back.');
    expect(notice.mock.calls[0][0].body).not.toContain('leave your computer');
  });

  it('says a rejected key was rejected', async () => {
    await markDown(hosted, 'rejected');
    expect(notice.mock.calls[0][0].body).toMatch(/^DeepSeek stopped accepting this key\./);
  });

  it('says plainly when the key is out of credit, or the provider no longer has its model', async () => {
    await markDown(hosted, 'credit');
    expect(notice.mock.calls[0][0].body).toMatch(/^DeepSeek says this key is out of credit\./);
    notice.mockClear();
    db.updateMany.mockResolvedValue({ count: 1 });
    await markDown(hosted, 'model');
    expect(notice.mock.calls[0][0].body).toMatch(/^DeepSeek no longer has the model this key uses\. Pick another model on the AI keys page\./);
  });

  it('does nothing, and tells nobody, when another request already marked it Down', async () => {
    db.updateMany.mockResolvedValue({ count: 0 });
    expect(await markDown(hosted, 'stopped')).toBe(false);
    expect(notice).not.toHaveBeenCalled();
  });

  it('never touches a server provider: only rows with an owner are matched', async () => {
    await markDown(hosted, 'stopped');
    expect(db.updateMany.mock.calls[0][0].where.ownerId).toEqual({ not: null });
  });
});

describe('markWorking', () => {
  it('brings a Down key back and clears the outage notice', async () => {
    expect(await markWorking(hosted)).toBe(true);
    expect(db.updateMany.mock.calls[0][0]).toMatchObject({ where: { providerId: 'key-1', downSince: { not: null } }, data: { downSince: null, downReason: null, failedReplies: 0 } });
    expect(clear).toHaveBeenCalledWith('owner', 'ai-key-down', 'down:key-1:');
  });

  it('clears nothing when the key was not Down', async () => {
    db.updateMany.mockResolvedValue({ count: 0 });
    expect(await markWorking(hosted)).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });
});

describe('recordReply', () => {
  const row = (over: object = {}) => ({ ...hosted, failedReplies: 0, ...over });

  it('does not mark a key Down after one failed reply', async () => {
    db.findFirst.mockResolvedValue(row());
    db.update.mockResolvedValue({ failedReplies: 1 });
    await recordReply('key-1', { ok: false });
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ data: { failedReplies: { increment: 1 } } }));
    expect(notice).not.toHaveBeenCalled();
  });

  it('marks it Down after two in a row', async () => {
    db.findFirst.mockResolvedValue(row({ failedReplies: 1 }));
    db.update.mockResolvedValue({ failedReplies: 2 });
    await recordReply('key-1', { ok: false });
    expect(notice).toHaveBeenCalledTimes(1);
    expect(db.updateMany.mock.calls[0][0].data).toMatchObject({ downReason: 'errors' });
  });

  it('marks it Down at once when the provider rejects the key', async () => {
    db.findFirst.mockResolvedValue(row());
    await recordReply('key-1', { ok: false, rejected: true });
    expect(db.updateMany.mock.calls[0][0].data).toMatchObject({ downReason: 'rejected' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'rejected'],
    [403, 'rejected'],
    [402, 'credit'],
    [404, 'model'],
  ])('a %s from the provider marks the key Down at once, as "%s"', async (status, reason) => {
    db.findFirst.mockResolvedValue(row());
    await recordReply('key-1', { ok: false, status });
    expect(db.updateMany.mock.calls[0][0].data).toMatchObject({ downReason: reason });
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([400, 413, 422, 409])('a %s says this one message was the problem, so nothing is counted against the key', async (status) => {
    db.findFirst.mockResolvedValue(row({ failedReplies: 1 }));
    await recordReply('key-1', { ok: false, status });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it.each([429, 408, 500, 503, undefined])('a %s counts, and two in a row mark the key Down', async (status) => {
    db.findFirst.mockResolvedValue(row());
    db.update.mockResolvedValueOnce({ failedReplies: 1 });
    await recordReply('key-1', { ok: false, status });
    expect(db.updateMany).not.toHaveBeenCalled();
    db.update.mockResolvedValueOnce({ failedReplies: 2 });
    await recordReply('key-1', { ok: false, status });
    expect(db.updateMany.mock.calls[0][0].data).toMatchObject({ downReason: 'errors' });
  });

  it('a good reply resets the run of failures', async () => {
    db.findFirst.mockResolvedValue(row({ failedReplies: 1 }));
    await recordReply('key-1', { ok: true });
    expect(db.updateMany).toHaveBeenCalledWith({ where: { providerId: 'key-1' }, data: { failedReplies: 0 } });
  });

  it('a good reply on a healthy key writes nothing', async () => {
    db.findFirst.mockResolvedValue(row());
    await recordReply('key-1', { ok: true });
    expect(db.updateMany).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('ignores reports for a key that is already Down, good or bad', async () => {
    db.findFirst.mockResolvedValue(row({ downSince: new Date() }));
    await recordReply('key-1', { ok: true });
    await recordReply('key-1', { ok: false });
    expect(db.updateMany).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('ignores a server provider or an id that is not a key', async () => {
    db.findFirst.mockResolvedValue(null);
    await recordReply('deepseek-flash', { ok: false, rejected: true });
    expect(db.findFirst.mock.calls[0][0].where).toEqual({ providerId: 'deepseek-flash', ownerId: { not: null } });
    expect(db.updateMany).not.toHaveBeenCalled();
  });
});

describe('judgeFailedReply', () => {
  it('keeps the old report working: a flag of "rejected" with no status is a rejection', () => {
    expect(judgeFailedReply(undefined, true)).toEqual({ counts: true, down: 'rejected' });
    expect(judgeFailedReply(undefined)).toEqual({ counts: true });
  });
});

describe('checkKey and checkAndRecord', () => {
  it('asks the provider with the saved key and the type it was added as', async () => {
    probe.mockResolvedValue({ ok: true, models: ['m'] });
    expect(await checkKey(hosted)).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledWith({ kind: 'deepseek', address: 'https://api.deepseek.com', apiKey: 'sk-secret' });
  });

  it('asks an own-computer key with no key', async () => {
    probe.mockResolvedValue({ ok: true, models: ['m'] });
    await checkKey(own);
    expect(probe).toHaveBeenCalledWith({ kind: 'lmstudio', address: 'https://lm.example.com', apiKey: undefined });
  });

  it('a rejected key is "rejected", anything else that fails is "stopped"', async () => {
    probe.mockResolvedValueOnce({ ok: false, message: 'no', reason: 'rejected' });
    expect(await checkKey(hosted)).toMatchObject({ ok: false, reason: 'rejected' });
    probe.mockResolvedValueOnce({ ok: false, message: 'no', reason: 'unreachable' });
    expect(await checkKey(hosted)).toMatchObject({ ok: false, reason: 'stopped' });
  });

  it('a provider that is only busy (429) changes nothing: not Down, not Working, only the check time moves', async () => {
    probe.mockResolvedValue({ ok: false, message: 'DeepSeek is busy right now. Try again in a moment.', reason: 'busy' });
    expect(await checkAndRecord(own)).toEqual({ ok: false, busy: true, message: 'DeepSeek is busy right now. Try again in a moment.' });
    expect(notice).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(db.updateMany).toHaveBeenCalledTimes(1);
    expect(db.updateMany).toHaveBeenCalledWith({ where: { providerId: 'key-2' }, data: { healthCheckedAt: expect.any(Date) } });
  });

  describe('a key that went Down on failed replies', () => {
    const erred = (key: KeyRow) => downNow(key, { downReason: 'errors', model: 'deepseek-v4-flash' });

    it('is trusted again only when a chat reply from its saved model works, not on the model list alone', async () => {
      probe.mockResolvedValue({ ok: true, models: ['m'] });
      chat.mockResolvedValue({ ok: false, reason: 'other', message: 'DeepSeek lists its models, but a chat call to deepseek-v4-flash failed (404). Check the model.' });
      expect(await checkAndRecord(erred(hosted))).toMatchObject({ ok: false, reason: 'stopped' });
      expect(chat).toHaveBeenCalledWith({ kind: 'deepseek', address: 'https://api.deepseek.com', apiKey: 'sk-secret', model: 'deepseek-v4-flash' });
      expect(clear).not.toHaveBeenCalled();
    });

    it('comes back when chat works', async () => {
      probe.mockResolvedValue({ ok: true, models: ['m'] });
      chat.mockResolvedValue({ ok: true });
      expect(await checkKey(erred(hosted))).toEqual({ ok: true });
    });

    it('stays as it is while chat is only busy', async () => {
      probe.mockResolvedValue({ ok: true, models: ['m'] });
      chat.mockResolvedValue({ ok: false, reason: 'busy', message: 'busy' });
      expect(await checkKey(erred(hosted))).toEqual({ ok: false, busy: true, message: 'busy' });
    });
  });

  describe('the saved model must really answer', () => {
    const withModel = (key: KeyRow, over: Partial<KeyRow> = {}): KeyRow => ({ ...key, model: 'deepseek-v4-flash', ...over });

    it('a Down key for any reason is trusted again only after a chat reply, not on the model list alone', async () => {
      probe.mockResolvedValue({ ok: true, models: ['deepseek-v4-flash'] });
      chat.mockResolvedValue({ ok: true });
      for (const downReason of ['stopped', 'errors', 'credit', 'model', null]) {
        chat.mockClear();
        expect(await checkKey(downNow(withModel(hosted), { downReason }))).toEqual({ ok: true });
        expect(chat).toHaveBeenCalledTimes(1);
      }
    });

    it('a Working key whose model is on the list is not asked to chat, so a check costs nothing', async () => {
      probe.mockResolvedValue({ ok: true, models: ['deepseek-v4-flash'] });
      expect(await checkKey(withModel(hosted))).toEqual({ ok: true });
      expect(chat).not.toHaveBeenCalled();
    });

    it.each([['a Working key whose model is off the list', null], ['a Down key', 'errors']])('%s is not failed by a probe the provider refused as a bad request (400, 413, 422)', async (_name, downReason) => {
      probe.mockResolvedValue({ ok: true, models: ['something-else'] });
      chat.mockResolvedValue({ ok: false, reason: 'request', message: 'DeepSeek lists its models, but a chat call to deepseek-v4-flash failed (400). Check the model.' });
      expect(await checkKey(downNow(withModel(hosted), { downReason }))).toEqual({ ok: true });
    });

    it('a key whose provider lists its models to anyone (Vercel AI Gateway) is asked to chat on every check', async () => {
      const vercel: KeyRow = { ...hosted, settings: { kind: 'vercel' }, endpoint: 'https://ai-gateway.vercel.sh/v1', model: 'openai/gpt-4o' };
      probe.mockResolvedValue({ ok: true, models: ['openai/gpt-4o'] });
      chat.mockResolvedValueOnce({ ok: false, reason: 'rejected', message: 'Vercel AI Gateway didn’t accept this key.' });
      expect(await checkKey(vercel)).toMatchObject({ ok: false, reason: 'rejected' });
      chat.mockResolvedValueOnce({ ok: true });
      expect(await checkKey(vercel)).toEqual({ ok: true });
      expect(chat).toHaveBeenCalledTimes(2);
    });

    it('a model that has dropped off the list is asked directly, and the answer decides', async () => {
      probe.mockResolvedValue({ ok: true, models: ['something-else'] });
      chat.mockResolvedValueOnce({ ok: true });
      expect(await checkKey(withModel(hosted))).toEqual({ ok: true });
      chat.mockResolvedValueOnce({ ok: false, reason: 'gone', message: 'DeepSeek no longer has the model deepseek-v4-flash.' });
      expect(await checkKey(withModel(hosted))).toMatchObject({ ok: false, reason: 'model' });
    });

    it('Gemini’s "models/" prefix does not make a listed model look missing', async () => {
      const gemini: KeyRow = { ...hosted, settings: { kind: 'gemini' }, endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest' };
      probe.mockResolvedValue({ ok: true, models: ['gemini-flash-latest'] });
      expect(await checkKey(gemini)).toEqual({ ok: true });
      expect(chat).not.toHaveBeenCalled();
      expect(await checkKey({ ...gemini, model: 'models/gemini-flash-latest' })).toEqual({ ok: true });
      expect(chat).not.toHaveBeenCalled();
    });

    it('no credit and a missing model each get their own reason', async () => {
      probe.mockResolvedValue({ ok: true, models: ['deepseek-v4-flash'] });
      chat.mockResolvedValueOnce({ ok: false, reason: 'credit', message: 'out of credit' });
      expect(await checkKey(downNow(withModel(hosted)))).toMatchObject({ ok: false, reason: 'credit' });
      chat.mockResolvedValueOnce({ ok: false, reason: 'rejected', message: 'no' });
      expect(await checkKey(downNow(withModel(hosted)))).toMatchObject({ ok: false, reason: 'rejected' });
    });

    it('a key with no saved model is checked by its list as before', async () => {
      probe.mockResolvedValue({ ok: true, models: ['m'] });
      expect(await checkKey(downNow(hosted))).toEqual({ ok: true });
      expect(chat).not.toHaveBeenCalled();
    });

    it('a failed check on a Down key keeps a better reason, but a rejection, no credit or a missing model replaces it', async () => {
      probe.mockResolvedValue({ ok: true, models: ['deepseek-v4-flash'] });
      db.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
      chat.mockResolvedValue({ ok: false, reason: 'other', message: 'chat failed' });
      await checkAndRecord(downNow(withModel(hosted), { downReason: 'errors' }));
      expect(db.updateMany).toHaveBeenLastCalledWith({ where: { providerId: 'key-1' }, data: { healthCheckedAt: expect.any(Date) } });
      db.updateMany.mockReset();
      db.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
      chat.mockResolvedValue({ ok: false, reason: 'gone', message: 'gone' });
      await checkAndRecord(downNow(withModel(hosted), { downReason: 'errors' }));
      expect(db.updateMany).toHaveBeenLastCalledWith({ where: { providerId: 'key-1' }, data: { healthCheckedAt: expect.any(Date), downReason: 'model' } });
    });
  });

  it('a failed check marks a Working key Down', async () => {
    probe.mockResolvedValue({ ok: false, message: 'It didn’t answer.', reason: 'unreachable' });
    expect(await checkAndRecord(own)).toMatchObject({ ok: false });
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it('a passing check brings a Down key back', async () => {
    probe.mockResolvedValue({ ok: true, models: ['m'] });
    await checkAndRecord(downNow(own));
    expect(clear).toHaveBeenCalledWith('owner', 'ai-key-down', 'down:key-2:');
  });

  it('a failed check on a key that is already Down only refreshes the check time, with no second notice', async () => {
    probe.mockResolvedValue({ ok: false, message: 'no', reason: 'unreachable' });
    db.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
    await checkAndRecord(downNow(own));
    expect(notice).not.toHaveBeenCalled();
    expect(db.updateMany).toHaveBeenLastCalledWith({ where: { providerId: 'key-2' }, data: { healthCheckedAt: expect.any(Date) } });
  });

  it('a failed check never rewrites why a Down key went Down, so a key Down on failed replies keeps needing a chat reply', async () => {
    probe.mockResolvedValue({ ok: true, models: ['m'] });
    chat.mockResolvedValue({ ok: false, reason: 'other', message: 'chat failed' });
    db.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
    const key = downNow(hosted, { downReason: 'errors', model: 'deepseek-v4-flash' });
    await checkAndRecord(key);
    // The first write is the (refused) attempt to mark it Down; what lands afterwards is only the check time
    expect(db.updateMany).toHaveBeenLastCalledWith({ where: { providerId: 'key-1' }, data: { healthCheckedAt: expect.any(Date) } });
  });

  it('a rejection on a Down key does change why', async () => {
    probe.mockResolvedValue({ ok: false, message: 'no', reason: 'rejected' });
    db.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
    await checkAndRecord(downNow(hosted, { downReason: 'errors', model: 'm' }));
    expect(db.updateMany).toHaveBeenLastCalledWith({ where: { providerId: 'key-1' }, data: { healthCheckedAt: expect.any(Date), downReason: 'rejected' } });
  });
});

describe('recheckIfDue', () => {
  const now = new Date('2026-10-19T12:10:00Z');
  const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);

  it('leaves a Working key alone', async () => {
    expect(await recheckIfDue(hosted, now)).toBe(hosted);
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it('does not check again inside 5 minutes', async () => {
    const key = downNow(own, { healthCheckedAt: minutesAgo(4) });
    expect(await recheckIfDue(key, now)).toBe(key);
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not check when another request claimed the check first', async () => {
    db.updateMany.mockResolvedValue({ count: 0 });
    const key = downNow(own, { healthCheckedAt: minutesAgo(6) });
    expect(await recheckIfDue(key, now)).toBe(key);
    expect(probe).not.toHaveBeenCalled();
  });

  it('with Stop replying it waits for the check and returns the key as it is after', async () => {
    probe.mockResolvedValue({ ok: true, models: ['m'] });
    const key = downNow(own, { ifDown: 'stop', healthCheckedAt: minutesAgo(6) });
    db.findUnique.mockResolvedValue({ ...key, downSince: null });
    const after = await recheckIfDue(key, now);
    expect(after.downSince).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('with Universe AI answering it does not make the reply wait for the check', async () => {
    let finish: (value: unknown) => void = () => {};
    probe.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const key = downNow(own, { healthCheckedAt: minutesAgo(6) });
    expect(await recheckIfDue(key, now)).toBe(key);
    finish({ ok: true, models: ['m'] });
  });

  it('the wait is five minutes', () => {
    expect(RECHECK_MS).toBe(300_000);
  });
});
