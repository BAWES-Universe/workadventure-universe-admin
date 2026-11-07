/**
 * A bot on Universe AI speaks with the models Universe AI uses now (voice setup, second decision): the server's own provider's
 * first model for the job, not the one the bot was turned on with. A bot on a person's lent key keeps the model its maker
 * picked. Nothing here calls a provider.
 */
import type { VoiceProvider } from '@prisma/client';
import { borrowUniverseAi, effectiveBotVoice, followUniverseAi, profileProblem, publishVoiceDraft, rollBackVoice, type VoiceProfile } from '@/lib/bot-voice';
import { prisma } from '@/lib/db';
import { lendAccess } from '@/lib/ai-key-lend';
import { BotSettingsError } from '@/lib/bot-access-settings';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/ai-key-lend', () => ({ lendAccess: jest.fn() }));
jest.mock('@/lib/voice-limits', () => ({
  getVoiceLimits: jest.fn().mockResolvedValue({ limits: { turnSeconds: 180, replyCharacters: 600, replySeconds: 60, listenMinutesPerDay: 60 } }),
  servedVoiceLimits: jest.fn(),
}));
jest.mock('@/lib/db', () => ({
  prisma: {
    $transaction: jest.fn(),
    bot: { findUnique: jest.fn(), update: jest.fn() },
    botVoiceRevision: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    botVoiceDraft: { findUnique: jest.fn() },
    voiceProvider: { findMany: jest.fn() },
  },
}));

type Mocks = Record<string, jest.Mock>;
const db = prisma as unknown as { $transaction: jest.Mock; bot: Mocks; botVoiceRevision: Mocks; botVoiceDraft: Mocks; voiceProvider: Mocks };

const provider = (changes: Partial<VoiceProvider> & { id: string }): VoiceProvider =>
  ({
    adapter: 'elevenlabs',
    name: 'ElevenLabs',
    recognition: false,
    speech: true,
    enabled: true,
    endpoint: null,
    region: null,
    apiKeyEncrypted: 'iv:tag:data',
    apiKeyLast4: '9f2a',
    models: [],
    defaultRecognition: false,
    defaultSpeech: false,
    defaultVoiceId: null,
    defaultVoiceName: null,
    ownerId: null,
    downSince: null,
    downPart: null,
    ...changes,
  }) as unknown as VoiceProvider;

const ears = provider({
  id: 'soniox',
  adapter: 'soniox',
  name: 'Soniox',
  recognition: true,
  speech: false,
  models: [
    { id: 'stt-rt-v6', kind: 'recognition' },
    { id: 'stt-rt-v5', kind: 'recognition' },
  ],
});
const mouth = provider({
  id: 'eleven',
  models: [
    { id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo', kind: 'speech' },
    { id: 'eleven_flash_v2_5', kind: 'speech' },
  ],
});
const theirKey = provider({
  id: 'k1',
  ownerId: 'u-ana',
  models: [
    { id: 'eleven_flash_v2_5', kind: 'speech' },
    { id: 'eleven_v4_turbo', kind: 'speech' },
  ],
});
const providers = (...rows: VoiceProvider[]) => new Map(rows.map((row) => [row.id, row]));

const profile = (changes: Partial<VoiceProfile> = {}): VoiceProfile => ({
  recognition: { providerId: 'soniox', model: 'stt-rt-v5' },
  speech: { providerId: 'eleven', model: 'eleven_flash_v2_5', voiceId: 'sarah', voiceName: 'Sarah' },
  expression: 'natural',
  language: { mode: 'follow' },
  ...changes,
});

describe('followUniverseAi', () => {
  it('moves each part on the server provider to the first model it lists for the job, and keeps the voice', () => {
    const followed = followUniverseAi(profile(), providers(ears, mouth));
    expect(followed.recognition).toEqual({ providerId: 'soniox', model: 'stt-rt-v6' });
    expect(followed.speech).toEqual({ providerId: 'eleven', model: 'eleven_v4_turbo', voiceId: 'sarah', voiceName: 'Sarah' });
    expect(followed.expression).toBe('natural');
    expect(followed.language).toEqual({ mode: 'follow' });
  });

  it('returns the same profile when every part already runs on the current model', () => {
    const current = profile({ recognition: { providerId: 'soniox', model: 'stt-rt-v6' }, speech: { providerId: 'eleven', model: 'eleven_v4_turbo', voiceId: 'sarah' } });
    expect(followUniverseAi(current, providers(ears, mouth))).toBe(current);
  });

  it('leaves a part on a lent key with the model its maker picked', () => {
    const own = profile({ speech: { providerId: 'k1', model: 'eleven_v4_turbo', voiceId: 'sarah' } });
    expect(followUniverseAi(own, providers(ears, theirKey)).speech.model).toBe('eleven_v4_turbo');
    const first = profile({ speech: { providerId: 'k1', model: 'eleven_flash_v2_5', voiceId: 'sarah' } });
    expect(followUniverseAi(first, providers(ears, theirKey)).speech.model).toBe('eleven_flash_v2_5');
  });

  it('follows only the part that is on the server provider when the other is on a key', () => {
    const mixed = profile({ speech: { providerId: 'k1', model: 'eleven_flash_v2_5', voiceId: 'sarah' } });
    const followed = followUniverseAi(mixed, providers(ears, theirKey));
    expect(followed.recognition.model).toBe('stt-rt-v6');
    expect(followed.speech.model).toBe('eleven_flash_v2_5');
  });

  it('keeps the published model when the provider lists none for the job, so the profile still reads as broken', () => {
    const empty = provider({ id: 'eleven', models: [] });
    const followed = followUniverseAi(profile(), providers(ears, empty));
    expect(followed.speech.model).toBe('eleven_flash_v2_5');
    expect(profileProblem(followed, providers(ears, empty))).toBe("ElevenLabs doesn't list the model eleven_flash_v2_5 for speaking");
  });

  it('lets a bot whose model was taken off the provider speak with the one it lists now', () => {
    const published = profile({ recognition: { providerId: 'soniox', model: 'stt-rt-v4' } });
    expect(profileProblem(published, providers(ears, mouth))).toBe("Soniox doesn't list the model stt-rt-v4 for listening");
    expect(profileProblem(followUniverseAi(published, providers(ears, mouth)), providers(ears, mouth))).toBeNull();
  });

  it('keeps a Polly voice on the engine it was published on, since each voice speaks with some engines only', () => {
    const polly = provider({ id: 'polly', adapter: 'aws', name: 'AWS', models: [{ id: 'generative', kind: 'speech' }, { id: 'neural', kind: 'speech' }] });
    const hala = profile({ speech: { providerId: 'polly', model: 'neural', voiceId: 'Hala' } });
    expect(followUniverseAi(hala, providers(ears, polly)).speech).toBe(hala.speech);
    const generativeOnly = provider({ ...polly, models: [{ id: 'generative', kind: 'speech' }] });
    expect(profileProblem(followUniverseAi(hala, providers(ears, generativeOnly)), providers(ears, generativeOnly))).toBe("AWS doesn't list the model neural for speaking");
  });

  it('leaves a provider that is missing to profileProblem', () => {
    expect(followUniverseAi(profile(), providers(ears))).toEqual(profile({ recognition: { providerId: 'soniox', model: 'stt-rt-v6' } }));
    expect(profileProblem(followUniverseAi(profile(), providers(ears)), providers(ears))).toBe("The provider chosen for speaking doesn't exist");
  });
});

describe('borrowUniverseAi (#840)', () => {
  const cartesia = provider({ id: 'cart', adapter: 'cartesia', name: 'Cartesia', enabled: false, models: [{ id: 'sonic-3', kind: 'speech' }] });
  const deepgram = provider({ id: 'dg', adapter: 'deepgram', name: 'Deepgram', recognition: true, speech: false, enabled: false, models: [{ id: 'nova-3', kind: 'recognition' }] });
  const defaultEars = provider({ ...ears, defaultRecognition: true });
  const defaultMouth = provider({ ...mouth, defaultSpeech: true, defaultVoiceId: 'aria', defaultVoiceName: 'Aria' });
  const onCartesia = profile({ speech: { providerId: 'cart', model: 'sonic-3', voiceId: 'katie', voiceName: 'Katie' } });

  it('lets a part on a company that is off speak as Universe AI\'s current voice, on its starting model', () => {
    const borrowed = borrowUniverseAi(onCartesia, providers(defaultEars, defaultMouth, cartesia));
    expect(borrowed.speech).toEqual({ providerId: 'eleven', model: 'eleven_v4_turbo', voiceId: 'aria', voiceName: 'Aria' });
    expect(borrowed.recognition).toBe(onCartesia.recognition);
    expect(borrowed.expression).toBe('natural');
  });

  it('lets a listening part on a company that is off listen with Universe AI\'s current company', () => {
    const onDeepgram = profile({ recognition: { providerId: 'dg', model: 'nova-3' } });
    expect(borrowUniverseAi(onDeepgram, providers(defaultEars, defaultMouth, deepgram)).recognition).toEqual({ providerId: 'soniox', model: 'stt-rt-v6' });
  });

  it('gives the bot its own voice back once the company is on again: nothing was saved', () => {
    const on = provider({ ...cartesia, enabled: true });
    expect(borrowUniverseAi(onCartesia, providers(defaultEars, defaultMouth, on))).toBe(onCartesia);
  });

  it('borrows nothing when Universe AI has no starting voice, so the bot stays in text', () => {
    const noVoice = provider({ ...defaultMouth, defaultVoiceId: null, defaultVoiceName: null });
    expect(borrowUniverseAi(onCartesia, providers(defaultEars, noVoice, cartesia))).toBe(onCartesia);
  });

  it('borrows nothing when no provider is the default for the job', () => {
    expect(borrowUniverseAi(onCartesia, providers(defaultEars, mouth, cartesia))).toBe(onCartesia);
  });

  it('never moves a part on a person\'s lent key, even when that key is off', () => {
    const offKey = provider({ ...theirKey, enabled: false });
    const own = profile({ speech: { providerId: 'k1', model: 'eleven_flash_v2_5', voiceId: 'sarah' } });
    expect(borrowUniverseAi(own, providers(defaultEars, defaultMouth, offKey))).toBe(own);
  });
});

describe('what the bot server and the publish and roll back routes see', () => {
  const bot = (changes: Record<string, unknown> = {}) => ({
    voiceEnabled: true,
    voiceRevision: 1,
    createdById: 'u-ana',
    room: { world: { universeId: 'uni1', universe: { allowVoiceBots: true } } },
    ...changes,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (lendAccess as jest.Mock).mockResolvedValue(true);
    db.bot.findUnique.mockResolvedValue(bot());
    db.$transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run(db));
  });

  const rows = (...list: VoiceProvider[]) =>
    db.voiceProvider.findMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) => {
      const ids = args?.where?.id?.in;
      return list.filter((row) => !ids || ids.includes(row.id)).map((row) => ({ ...row, lends: row.ownerId ? [{ models: null }] : [] }));
    });

  it('serves a bot on Universe AI with the current models, though it was published on older ones', async () => {
    db.botVoiceRevision.findUnique.mockResolvedValue({ number: 1, profile: profile() });
    rows(ears, mouth);
    const active = await effectiveBotVoice('b1');
    expect(active.speaks).toBe(true);
    expect(active.reason).toBeNull();
    expect(active.profile?.recognition.model).toBe('stt-rt-v6');
    expect(active.profile?.speech).toEqual({ providerId: 'eleven', model: 'eleven_v4_turbo', voiceId: 'sarah', voiceName: 'Sarah' });
  });

  it('keeps a bot speaking when the model it was published on was taken off', async () => {
    db.botVoiceRevision.findUnique.mockResolvedValue({ number: 1, profile: profile({ recognition: { providerId: 'soniox', model: 'stt-rt-v4' } }) });
    rows(ears, mouth);
    const active = await effectiveBotVoice('b1');
    expect(active.reason).toBeNull();
    expect(active.profile?.recognition.model).toBe('stt-rt-v6');
  });

  it('serves a bot on a lent key with the model its maker picked, even when the key lists others first', async () => {
    const own = profile({ speech: { providerId: 'k1', model: 'eleven_v4_turbo', voiceId: 'sarah' } });
    db.botVoiceRevision.findUnique.mockResolvedValue({ number: 1, profile: own });
    rows(ears, theirKey);
    const active = await effectiveBotVoice('b1');
    expect(active.reason).toBeNull();
    expect(active.profile?.speech.model).toBe('eleven_v4_turbo');
    expect(active.parts.speech).toBe('owner');
  });

  it('serves a bot on a company that is off with Universe AI\'s current voice, and Universe AI pays', async () => {
    const off = provider({ id: 'cart', adapter: 'cartesia', name: 'Cartesia', enabled: false, models: [{ id: 'sonic-3', kind: 'speech' }] });
    const now = provider({ ...mouth, defaultSpeech: true, defaultVoiceId: 'aria', defaultVoiceName: 'Aria' });
    db.botVoiceRevision.findUnique.mockResolvedValue({ number: 1, profile: profile({ speech: { providerId: 'cart', model: 'sonic-3', voiceId: 'katie' } }) });
    rows(ears, now, off);
    const active = await effectiveBotVoice('b1');
    expect(active.speaks).toBe(true);
    expect(active.reason).toBeNull();
    expect(active.profile?.speech).toEqual({ providerId: 'eleven', model: 'eleven_v4_turbo', voiceId: 'aria', voiceName: 'Aria' });
    expect(active.parts.speech).toBe('universe-ai');
  });

  it('keeps a bot on a company that is off in text when Universe AI has no starting voice', async () => {
    const off = provider({ id: 'cart', adapter: 'cartesia', name: 'Cartesia', enabled: false, models: [{ id: 'sonic-3', kind: 'speech' }] });
    db.botVoiceRevision.findUnique.mockResolvedValue({ number: 1, profile: profile({ speech: { providerId: 'cart', model: 'sonic-3', voiceId: 'katie' } }) });
    rows(ears, provider({ ...mouth, defaultSpeech: true }), off);
    expect((await effectiveBotVoice('b1')).reason).toBe('provider');
  });

  it('still says "provider" when a provider lists no model for the job', async () => {
    db.botVoiceRevision.findUnique.mockResolvedValue({ number: 1, profile: profile() });
    rows(ears, provider({ id: 'eleven', models: [] }));
    expect((await effectiveBotVoice('b1')).reason).toBe('provider');
  });

  it('publishes a draft that names an older model on Universe AI, and stores it as it was made', async () => {
    db.botVoiceDraft.findUnique.mockResolvedValue({ profile: profile() });
    db.botVoiceRevision.findFirst.mockResolvedValue({ number: 1 });
    db.botVoiceRevision.create.mockResolvedValue({});
    db.bot.update.mockResolvedValue({});
    rows(ears, mouth);
    // reading the answer afterwards needs more of the database than this test mocks; what is stored is what counts
    await publishVoiceDraft('b1', null, 'u-ana').catch(() => undefined);
    expect(db.botVoiceRevision.create).toHaveBeenCalledWith({ data: expect.objectContaining({ number: 2, profile: profile() }) });
  });

  it('rolls back to a version published on a model that is gone from Universe AI', async () => {
    db.botVoiceRevision.findUnique.mockResolvedValue({ number: 1, profile: profile({ recognition: { providerId: 'soniox', model: 'stt-rt-v4' } }) });
    db.bot.update.mockResolvedValue({});
    rows(ears, mouth);
    await rollBackVoice('b1', 1).catch((error) => {
      // reading the answer afterwards needs more of the database than this test mocks; the roll back itself must not refuse
      expect(error).not.toBeInstanceOf(BotSettingsError);
    });
    expect(db.bot.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { voiceRevision: 1 } });
  });
});
