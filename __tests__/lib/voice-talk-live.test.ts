/**
 * Talking models (game #1910): one live model that listens and speaks in one, on a person's own key. A bot on one names it for
 * both listening and speaking, and its own Mind still writes every answer. Nothing here calls a company.
 */
import type { VoiceProvider } from '@prisma/client';
import { followUniverseAi, profileProblem, type VoiceProfile } from '@/lib/bot-voice';
import { modelDoes, talksLive, voiceDoesLine, voiceKeyCompanyInfo } from '@/lib/voice-key-companies';
import { voiceProviderProblem } from '@/lib/voice-providers';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/ai-key-lend', () => ({ lendAccess: jest.fn() }));
jest.mock('@/lib/db', () => ({ prisma: {} }));

const provider = (changes: Partial<VoiceProvider> & { id: string }): VoiceProvider =>
  ({
    adapter: 'openai',
    name: 'My OpenAI',
    recognition: true,
    speech: true,
    enabled: true,
    endpoint: null,
    region: null,
    apiKeyEncrypted: 'iv:tag:data',
    apiKeyLast4: '3f9a',
    models: [
      { id: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', kind: 'talk' },
      { id: 'gpt-realtime-2.1-mini', kind: 'talk' },
    ],
    defaultRecognition: false,
    defaultSpeech: false,
    defaultVoiceId: null,
    defaultVoiceName: null,
    ownerId: 'u-maker',
    downSince: null,
    downPart: null,
    ...changes,
  }) as unknown as VoiceProvider;

const live = provider({ id: 'oa' });
const ears = provider({ id: 'soniox', adapter: 'soniox', name: 'Soniox', speech: false, ownerId: null, models: [{ id: 'stt-rt-v6', kind: 'recognition' }] });
const providers = (...rows: VoiceProvider[]) => new Map(rows.map((row) => [row.id, row]));

const talking = (model = 'gpt-realtime-2.1'): VoiceProfile => ({
  recognition: { providerId: 'oa', model },
  speech: { providerId: 'oa', model, voiceId: 'marin', voiceName: 'Marin' },
  expression: 'natural',
  language: { mode: 'follow' },
});

describe('the OpenAI entry', () => {
  it('talks live only, with its realtime models and its fixed voices, ranked nowhere', () => {
    const openai = voiceKeyCompanyInfo('openai');
    expect(openai?.does).toEqual({ recognition: false, speech: false, talk: true });
    expect(openai?.models).toEqual([
      { id: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', kind: 'talk' },
      { id: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 mini', kind: 'talk' },
    ]);
    expect(openai?.jobs.talk?.fixedVoices?.map((voice) => voice.id)).toEqual(['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']);
    expect(openai?.check).toEqual({ url: 'https://api.openai.com/v1/models', header: 'Authorization', prefix: 'Bearer ', alsoAccepted: { status: 403, includes: 'api.model.read' } });
    expect(JSON.stringify(openai)).not.toMatch(/recommend/i);
  });
});

describe('the Google entry', () => {
  it('talks live only, with Gemini 3.8 Live and its 30 prebuilt voices', () => {
    const google = voiceKeyCompanyInfo('google');
    expect(google?.does).toEqual({ recognition: false, speech: false, talk: true });
    expect(google?.models).toEqual([{ id: 'gemini-3.8-live', label: 'Gemini 3.8 Live', kind: 'talk' }]);
    const voices = google?.jobs.talk?.fixedVoices ?? [];
    expect(voices).toHaveLength(30);
    expect(new Set(voices.map((voice) => voice.id)).size).toBe(30);
    expect(google?.check.header).toBe('x-goog-api-key');
    expect(google?.check.alsoRefused).toEqual({ status: 400, includes: 'API_KEY_INVALID' });
    expect(JSON.stringify(google)).not.toMatch(/recommend/i);
  });
});

describe('the Inworld entry', () => {
  it('talks live only, speaking with its TTS models and listing its voices with the key, checked for free with Basic', () => {
    const inworld = voiceKeyCompanyInfo('inworld');
    expect(inworld?.does).toEqual({ recognition: false, speech: false, talk: true });
    expect(inworld?.models).toEqual([
      { id: 'inworld-tts-2', label: 'Inworld TTS 2', kind: 'talk' },
      { id: 'inworld-tts-2-flash', label: 'Inworld TTS 2 Flash', kind: 'talk' },
    ]);
    expect(inworld?.jobs.talk?.fixedVoices).toBeUndefined();
    expect(inworld?.jobs.talk?.voices?.paging).toEqual({ kind: 'token', param: 'pageToken', next: 'nextPageToken' });
    expect(inworld?.check).toEqual({ url: 'https://api.inworld.ai/voices/v1/voices?pageSize=1', header: 'Authorization', prefix: 'Basic ' });
    expect(JSON.stringify(inworld)).not.toMatch(/recommend/i);
  });
});

describe('the Ultravox entry', () => {
  it('talks live only, with its own model, listing its voices with the key page by page, checked for free with X-API-Key', () => {
    const ultravox = voiceKeyCompanyInfo('ultravox');
    expect(ultravox?.does).toEqual({ recognition: false, speech: false, talk: true });
    expect(ultravox?.models).toEqual([{ id: 'ultravox-v0.7', label: 'Ultravox v0.7', kind: 'talk' }]);
    expect(ultravox?.jobs.talk?.voices?.paging).toEqual({ kind: 'token', param: 'cursor', next: 'next', nextIsLink: true });
    expect(ultravox?.jobs.talk?.voices?.previewNeedsKey).toBe(true);
    expect(ultravox?.check).toEqual({ url: 'https://api.ultravox.ai/api/voices?pageSize=1', header: 'X-API-Key', prefix: '' });
    expect(JSON.stringify(ultravox)).not.toMatch(/recommend/i);
  });
});

describe('the xAI entry', () => {
  it('talks live only, with its Grok Voice models and its 28 built-in voices, Eve first', () => {
    const xai = voiceKeyCompanyInfo('xai');
    expect(xai?.label).toBe('xAI');
    expect(xai?.does).toEqual({ recognition: false, speech: false, talk: true });
    expect(xai?.models).toEqual([
      { id: 'grok-voice-latest', label: 'Grok Voice (latest)', kind: 'talk' },
      { id: 'grok-voice-3.0', label: 'Grok Voice 3.0', kind: 'talk' },
    ]);
    const voices = xai?.jobs.talk?.fixedVoices ?? [];
    expect(voices).toHaveLength(28);
    expect(voices[0]).toEqual({ id: 'eve', name: 'Eve' });
    expect(new Set(voices.map((voice) => voice.id)).size).toBe(28);
    expect(xai?.check).toEqual({ url: 'https://api.x.ai/v1/tts/voices', header: 'Authorization', prefix: 'Bearer ' });
    expect(JSON.stringify(xai)).not.toMatch(/recommend/i);
  });
});

describe('what a company or key says it does', () => {
  it('names each job once, talks live last', () => {
    expect(voiceDoesLine({ recognition: false, speech: false, talk: true })).toBe('Talks live');
    expect(voiceDoesLine({ recognition: true, speech: false, talk: true })).toBe('Listens and talks live');
    expect(voiceDoesLine({ recognition: true, speech: true, talk: true })).toBe('Listens, speaks and talks live');
    expect(voiceDoesLine({ recognition: true, speech: true })).toBe('Listens and speaks');
    expect(voiceDoesLine({ recognition: true, speech: false })).toBe('Listens');
    expect(voiceDoesLine({ recognition: false, speech: true })).toBe('Speaks');
  });

  it('counts a talking model for listening and for speaking', () => {
    expect(modelDoes({ kind: 'talk' }, 'recognition')).toBe(true);
    expect(modelDoes({ kind: 'talk' }, 'speech')).toBe(true);
    expect(modelDoes({ kind: 'speech' }, 'recognition')).toBe(false);
  });
});

describe('a bot that talks live', () => {
  it('names one talking model for both parts', () => {
    expect(talksLive(talking(), live.models as never)).toBe(true);
    expect(profileProblem(talking(), providers(live))).toBeNull();
  });

  it('can’t name a talking model for one part only', () => {
    const half: VoiceProfile = { ...talking(), recognition: { providerId: 'soniox', model: 'stt-rt-v6' } };
    expect(talksLive(half, live.models as never)).toBe(false);
    expect(profileProblem(half, providers(live, ears))).toBe("My OpenAI's gpt-realtime-2.1 talks live, so it must be named for both listening and speaking");
  });

  it('can’t name two different talking models', () => {
    const mixed: VoiceProfile = { ...talking(), recognition: { providerId: 'oa', model: 'gpt-realtime-2.1-mini' } };
    expect(profileProblem(mixed, providers(live))).toBe("My OpenAI's gpt-realtime-2.1-mini talks live, so it must be named for both listening and speaking");
  });

  it('needs the lend to allow the talking model', () => {
    expect(profileProblem(talking(), providers(live), new Map([['oa', ['talk:gpt-realtime-2.1-mini']]]))).toBe("My OpenAI isn't lent to this universe for the model gpt-realtime-2.1");
    expect(profileProblem(talking(), providers(live), new Map([['oa', ['talk:gpt-realtime-2.1']]]))).toBeNull();
  });

  it('on a key keeps the model its maker picked', () => {
    expect(followUniverseAi(talking('gpt-realtime-2.1-mini'), providers(live))).toEqual(talking('gpt-realtime-2.1-mini'));
  });

  it('on a server provider follows its first talking model for both parts', () => {
    const server = provider({ id: 'oa', ownerId: null });
    const followed = followUniverseAi(talking('gpt-realtime-2.1-mini'), providers(server));
    expect(followed.recognition.model).toBe('gpt-realtime-2.1');
    expect(followed.speech).toEqual({ providerId: 'oa', model: 'gpt-realtime-2.1', voiceId: 'marin', voiceName: 'Marin' });
    expect(profileProblem(followed, providers(server))).toBeNull();
  });

  it('on a server provider moves a bot whose talking model was taken off to the talking model it lists now', () => {
    const server = provider({ id: 'oa', ownerId: null, models: [{ id: 'gpt-realtime-3', kind: 'talk' }] });
    const followed = followUniverseAi(talking('gpt-realtime-2.1-mini'), providers(server));
    expect(followed.recognition).toEqual({ providerId: 'oa', model: 'gpt-realtime-3' });
    expect(followed.speech).toEqual({ providerId: 'oa', model: 'gpt-realtime-3', voiceId: 'marin', voiceName: 'Marin' });
    expect(profileProblem(followed, providers(server))).toBeNull();
  });
});

describe('a provider with a talking model', () => {
  const draft = { enabled: true, defaultRecognition: false, defaultSpeech: false, hasKey: true, endpoint: null, defaultVoiceId: null, defaultVoiceName: null };
  it('listens and speaks with it', () => {
    expect(voiceProviderProblem({ ...draft, recognition: true, speech: true, models: [{ id: 'gpt-realtime-2.1', kind: 'talk' }] })).toBeNull();
    expect(voiceProviderProblem({ ...draft, recognition: false, speech: true, models: [{ id: 'gpt-realtime-2.1', kind: 'talk' }] })).toBe('A model can only be listed for what the provider does');
  });
});
