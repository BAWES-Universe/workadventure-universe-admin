/**
 * Models fill in on their own: each voice provider with a key reads its company's own list, and every model it lists is added.
 * Only added, never taken off; a model taken off by hand stays off. The company is a stand-in: no real call is made.
 */
import type { VoiceProvider } from '@prisma/client';
import { prisma } from '@/lib/db';
import { listCompanyModels } from '@/lib/voice-key-check';
import { DISCOVERY_REFRESH_MS, DISCOVERY_RETRY_MS, discoverVoiceModels, discoveryRetryDelay, forgetDiscovery } from '@/lib/voice-discovery';
import { modelChange, readHiddenModels } from '@/lib/voice-hidden-models';

jest.mock('@/lib/encryption', () => ({ decryptApiKey: jest.fn((value: string) => value.replace(/^enc:/, '')) }));
jest.mock('@/lib/voice-key-check', () => ({ listCompanyModels: jest.fn() }));
jest.mock('@/lib/db', () => {
  const voiceProvider = { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() };
  const $queryRaw = jest.fn(async () => [{ '?column?': 1 }]);
  return { prisma: { voiceProvider, $queryRaw, $transaction: jest.fn(async (run: (tx: unknown) => unknown) => run({ voiceProvider, $queryRaw })) } };
});

const db = (prisma as unknown as { voiceProvider: { findUnique: jest.Mock; update: jest.Mock } }).voiceProvider;
const lock = (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw;
/** Lets the asking that carries on after the wait finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const list = listCompanyModels as jest.Mock;

const provider = (over: Partial<VoiceProvider> = {}): VoiceProvider =>
  ({
    id: 'p-eleven',
    adapter: 'elevenlabs',
    name: 'ElevenLabs',
    ownerId: null,
    enabled: true,
    recognition: false,
    speech: true,
    endpoint: null,
    apiKeyEncrypted: 'enc:sk-eleven',
    models: [{ id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo', kind: 'speech' }],
    hiddenModels: null,
    ...over,
  }) as unknown as VoiceProvider;

const companyList = [
  { id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo', kind: 'speech', note: 'Fast' },
  { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5', kind: 'speech', note: 'Cheap' },
  { id: 'eleven_v3', label: 'Eleven v3', kind: 'speech' },
];

let saved: VoiceProvider;
beforeEach(() => {
  jest.clearAllMocks();
  forgetDiscovery();
  saved = provider();
  db.findUnique.mockImplementation(async () => saved);
  db.update.mockImplementation(async ({ data }: { data: Partial<VoiceProvider> }) => (saved = { ...saved, ...data } as VoiceProvider));
  list.mockResolvedValue(companyList);
});

describe('voice models fill in on their own', () => {
  it('adds every model the company lists that the provider does not have, without its note', async () => {
    await discoverVoiceModels([saved]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ adapter: 'elevenlabs' }), 'sk-eleven', 'speech');
    expect(saved.models).toEqual([
      { id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo', kind: 'speech' },
      { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5', kind: 'speech' },
      { id: 'eleven_v3', label: 'Eleven v3', kind: 'speech' },
    ]);
  });

  it('never takes a model off when the company stops listing it or cannot be reached', async () => {
    saved = provider({ models: [{ id: 'eleven_v4_turbo', kind: 'speech' }, { id: 'old_model', kind: 'speech' }] as never });
    list.mockResolvedValue([{ id: 'eleven_v3', kind: 'speech' }]);
    await discoverVoiceModels([saved]);
    expect((saved.models as { id: string }[]).map((m) => m.id)).toEqual(['eleven_v4_turbo', 'old_model', 'eleven_v3']);

    forgetDiscovery();
    list.mockResolvedValue(null);
    db.update.mockClear();
    await discoverVoiceModels([saved]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('keeps a model taken off by hand off', async () => {
    saved = provider({ hiddenModels: ['speech:eleven_v3'] as never });
    await discoverVoiceModels([saved]);
    expect((saved.models as { id: string }[]).map((m) => m.id)).toEqual(['eleven_v4_turbo', 'eleven_flash_v2_5']);
  });

  it('asks each provider at most once every 10 minutes after its list was read', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await discoverVoiceModels([saved]);
    await discoverVoiceModels([saved]);
    expect(list).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + DISCOVERY_REFRESH_MS - 1);
    await discoverVoiceModels([saved]);
    expect(list).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + DISCOVERY_REFRESH_MS);
    await discoverVoiceModels([saved]);
    expect(list).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('asks again soon after a list that could not be read, waiting longer after each failure in a row, never past 10 minutes', async () => {
    let clock = 1_000_000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    list.mockResolvedValue(null);
    const waits: number[] = [];
    for (let failure = 1; failure <= 7; failure += 1) {
      const before = list.mock.calls.length;
      await discoverVoiceModels([saved]);
      await settle();
      expect(list).toHaveBeenCalledTimes(before + 1);
      const wait = discoveryRetryDelay(failure);
      waits.push(wait);
      // Not before its wait is up, and at once when it is
      clock += wait - 1;
      await discoverVoiceModels([saved]);
      expect(list).toHaveBeenCalledTimes(before + 1);
      clock += 1;
    }
    expect(waits[0]).toBe(DISCOVERY_RETRY_MS);
    expect(waits[1]).toBe(DISCOVERY_RETRY_MS * 2);
    expect(waits.every((wait, i) => i === 0 || wait >= waits[i - 1])).toBe(true);
    expect(Math.max(...waits)).toBe(DISCOVERY_REFRESH_MS);
    expect(db.update).not.toHaveBeenCalled();

    // The company is back: its models are saved, and it is asked every 10 minutes again
    list.mockResolvedValue(companyList);
    await discoverVoiceModels([saved]);
    await settle();
    expect((saved.models as unknown[]).length).toBe(3);
    const calls = list.mock.calls.length;
    clock += DISCOVERY_RETRY_MS;
    await discoverVoiceModels([saved]);
    expect(list).toHaveBeenCalledTimes(calls);
    clock += DISCOVERY_REFRESH_MS - DISCOVERY_RETRY_MS;
    await discoverVoiceModels([saved]);
    expect(list).toHaveBeenCalledTimes(calls + 1);
    now.mockRestore();
  });

  it('asks again soon after the save fails, not on every read', async () => {
    let clock = 1_000_000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    db.findUnique.mockRejectedValueOnce(new Error('db down'));
    await discoverVoiceModels([saved]);
    await settle();
    await discoverVoiceModels([saved]);
    expect(list).toHaveBeenCalledTimes(1);
    clock += DISCOVERY_RETRY_MS;
    await discoverVoiceModels([saved]);
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect((saved.models as unknown[]).length).toBe(3);
    now.mockRestore();
  });

  it('saves the lists that were read when another of the same key could not be, and asks again soon', async () => {
    let clock = 1_000_000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    saved = provider({ adapter: 'cartesia', recognition: true, speech: true, models: [] as never });
    list.mockImplementation(async (_company: unknown, _key: string, job: string) => (job === 'speech' ? [{ id: 'sonic-3', kind: 'speech' }] : null));
    await discoverVoiceModels([saved]);
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(saved.models).toEqual([{ id: 'sonic-3', kind: 'speech' }]);
    clock += DISCOVERY_RETRY_MS;
    list.mockImplementation(async (_company: unknown, _key: string, job: string) => [{ id: job === 'speech' ? 'sonic-3' : 'ink-whisper', kind: job }]);
    await discoverVoiceModels([saved]);
    await settle();
    expect(saved.models).toEqual([
      { id: 'sonic-3', kind: 'speech' },
      { id: 'ink-whisper', kind: 'recognition' },
    ]);
    now.mockRestore();
  });

  it('asks a new key at once even when the old key was still being asked', async () => {
    let finish: (value: unknown) => void = () => undefined;
    list.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await discoverVoiceModels([saved], 10);
    forgetDiscovery(saved.id);
    finish(null);
    await settle();
    await discoverVoiceModels([saved]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no key', { apiKeyEncrypted: null }],
    ['its own address', { endpoint: 'https://speech.example.com' }],
    ['a company with no list (Fish Audio)', { adapter: 'fish' }],
    ['a typed model (Azure)', { adapter: 'azure' }],
  ])('leaves a provider with %s as it is', async (_why, over) => {
    await discoverVoiceModels([provider(over as Partial<VoiceProvider>)]);
    expect(list).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('saves nothing when the key or company changed while it was asked', async () => {
    const asked = saved;
    saved = provider({ apiKeyEncrypted: 'enc:sk-new' });
    await discoverVoiceModels([asked]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it.each([
    ['an address was typed', { endpoint: 'https://speech.example.com' }],
    ['speaking was switched off', { speech: false }],
  ])('saves nothing when %s while it was asked', async (_why, over) => {
    const asked = saved;
    saved = provider(over as Partial<VoiceProvider>);
    await discoverVoiceModels([asked]);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('holds the provider row before reading the models it saves over, as a change by hand does', async () => {
    await discoverVoiceModels([saved]);
    expect(lock).toHaveBeenCalledTimes(1);
    const [sql, id] = lock.mock.calls[0] as [TemplateStringsArray, string];
    expect(sql.join('?')).toMatch(/FROM "voice_providers" WHERE "id" = \? FOR UPDATE/);
    expect(id).toBe('p-eleven');
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(db.findUnique.mock.invocationCallOrder[0]);
    expect(db.findUnique.mock.invocationCallOrder[0]).toBeLessThan(db.update.mock.invocationCallOrder[0]);
  });

  it('answers after the wait while a slow company is still asked, and saves what comes later', async () => {
    let finish: (value: unknown) => void = () => undefined;
    list.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await discoverVoiceModels([saved], 10);
    expect(db.update).not.toHaveBeenCalled();
    finish(companyList);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((saved.models as unknown[]).length).toBe(3);
  });
});

describe('models taken off by hand', () => {
  const before = [
    { id: 'a', kind: 'speech' as const },
    { id: 'b', kind: 'speech' as const },
  ];
  it('keeps a model taken off off, and forgets it when it is added back', () => {
    expect(modelChange(before, [before[0]], ['speech:b'], null)).toEqual({ models: [before[0]], hidden: ['speech:b'] });
    expect(modelChange([before[0]], before, [], ['speech:b'])).toEqual({ models: before, hidden: null });
    expect(modelChange(before, before, [], ['speech:c']).hidden).toEqual(['speech:c']);
  });
  it('keeps a model the company added while the page was open, instead of taking it off', () => {
    // The page showed a and b; the company's list added c meanwhile; b is taken off on the page
    const now = [...before, { id: 'c', kind: 'speech' as const }];
    expect(modelChange(now, [before[0]], ['speech:b'], null)).toEqual({ models: [before[0], { id: 'c', kind: 'speech' }], hidden: ['speech:b'] });
  });
  it('without the ones taken off named, replaces the models and keeps nothing new off', () => {
    expect(modelChange(before, [before[0]], undefined, null)).toEqual({ models: [before[0]], hidden: null });
  });
  it('reads only text entries', () => {
    expect(readHiddenModels(['speech:a', 3, null])).toEqual(['speech:a']);
    expect(readHiddenModels('nope')).toEqual([]);
  });
});
