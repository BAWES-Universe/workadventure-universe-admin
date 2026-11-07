/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The Voice part of the Universe AI page (#792, design A): what Universe AI listens and speaks with, the voice providers, and the
 * companies people can add a key for. Every call goes through a fake `authenticatedFetch`, so no company is called.
 */

type Row = Record<string, unknown>;
const calls: { method: string; url: string; body: Row | null }[] = [];
let providers: Row[];
let voicesAnswer: { ok: boolean; status?: number; body: unknown };
let patchAnswer: { ok: boolean; body: unknown };
// When set, reading the list never answers: the moment after a save, before the list that follows it arrives
let holdList = false;
let checkAnswer: { ok: boolean; body: unknown };
const push = jest.fn();

jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : null });
    const answer = (ok: boolean, body: unknown, status = ok ? 200 : 400) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
    if (url === '/api/admin/voice-providers' && method === 'GET') return holdList ? new Promise(() => {}) : answer(true, { providers });
    if (url.endsWith('/voices')) return answer(voicesAnswer.ok, voicesAnswer.body, voicesAnswer.status);
    if (method === 'PATCH') return answer(patchAnswer.ok, patchAnswer.body);
    if (url === '/api/admin/voice-providers/check') return answer(checkAnswer.ok, checkAnswer.body);
    if (url === '/api/admin/voice-providers' && method === 'POST') return answer(true, { provider: {} }, 201);
    return answer(true, {});
  },
}));
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: jest.fn() }) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push, back: jest.fn() }) }));
jest.mock('@/app/admin/orbit-frame-context', () => ({ ...jest.requireActual('@/app/admin/orbit-frame-context'), useReplacePage: () => jest.fn() }));

import { VoiceSection } from '@/app/admin/ai-providers/voice-section';
import NewVoiceProviderPage from '@/app/admin/ai-providers/voice/new/page';
import VoiceProviderPage from '@/app/admin/ai-providers/voice/[id]/page';
import { voiceServerLimits } from '@/app/admin/components/limits';
import { defaultChangeLine, withStartingModel } from '@/app/admin/ai-providers/voice/voice-shared';
import { VOICE_LIMITS_RECOMMENDED } from '@/lib/voice-limit-values';

const provider = (changes: Row): Row => ({ region: null, endpoint: null, hasKey: true, defaultRecognition: false, defaultSpeech: false, defaultVoiceId: null, defaultVoiceName: null, bots: { recognition: 0, speech: 0, total: 0 }, ...changes });
const soniox = () => provider({ id: 'v-soniox', adapter: 'soniox', name: 'Soniox', recognition: true, speech: false, enabled: true, apiKeyLast4: '9f3c', models: [{ id: 'stt-rt-v6', label: 'Real-time v3', kind: 'recognition' }], defaultRecognition: true, bots: { recognition: 14, speech: 0, total: 14 } });
const eleven = () =>
  provider({ id: 'v-eleven', adapter: 'elevenlabs', name: 'ElevenLabs', recognition: false, speech: true, enabled: true, apiKeyLast4: 'a1b2', models: [{ id: 'eleven_flash_v2_5', label: 'Flash v2.5', kind: 'speech' }, { id: 'eleven_multilingual_v2', label: 'Multilingual v2', kind: 'speech' }], defaultSpeech: true, defaultVoiceId: 'aria', defaultVoiceName: 'Aria', bots: { recognition: 0, speech: 12, total: 12 } });
const cartesia = () => provider({ id: 'v-cartesia', adapter: 'cartesia', name: 'Cartesia', recognition: false, speech: true, enabled: true, apiKeyLast4: '77de', models: [{ id: 'sonic-3', label: 'Sonic 3', kind: 'speech' }], bots: { recognition: 0, speech: 2, total: 2 } });
const deepgram = () => provider({ id: 'v-deepgram', adapter: 'deepgram', name: 'Deepgram', recognition: true, speech: false, enabled: false, apiKeyLast4: 'c044', models: [{ id: 'nova-3', label: 'Nova 3', kind: 'recognition' }] });
const VOICES = [
  { voiceId: 'aria', name: 'Aria', description: 'Calm and clear.', languages: ['en', 'ar'], previewUrl: 'https://x.test/a.mp3' },
  { voiceId: 'sarah', name: 'Sarah', description: 'Soft and warm.', languages: ['en'], previewUrl: null },
];

beforeEach(() => {
  calls.length = 0;
  providers = [soniox(), eleven(), cartesia(), deepgram()];
  voicesAnswer = { ok: true, body: { voices: VOICES } };
  patchAnswer = { ok: true, body: { provider: {} } };
  holdList = false;
  checkAnswer = { ok: true, body: { ok: true } };
  push.mockReset();
});

const patches = () => calls.filter((call) => call.method === 'PATCH');
// The models on a provider's list (the ticks Universe offers are model rows too)
const listedRows = () => screen.queryAllByTestId('model-row').filter((row) => row.tagName === 'LI');

describe('the Voice part', () => {
  it('says what Universe AI listens and speaks with, lists the providers with their bots, and names the companies people can add keys for', async () => {
    render(<VoiceSection />);
    const listen = await screen.findByTestId('default-listen');
    expect(within(listen).getByText('Soniox · Real-time v3')).toBeTruthy();
    expect(within(screen.getByTestId('default-speak')).getByText('Aria · ElevenLabs · Flash v2.5')).toBeTruthy();
    expect(screen.getByText('Default for listening')).toBeTruthy();
    expect(screen.getByText('Default for speaking')).toBeTruthy();
    expect(screen.getByText(/Listens · Real-time v3 · key ••••9f3c · 14 bots/)).toBeTruthy();
    expect(screen.getByTestId('people-line').textContent).toContain('Soniox, ElevenLabs, Cartesia');
    expect(screen.getByTestId('people-line').textContent).not.toContain('Deepgram');
    // A default has no Disable; one that isn't the default has Disable (on) or Enable (off)
    expect(screen.queryByRole('button', { name: 'Disable Soniox' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disable Cartesia' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable Deepgram' })).toBeTruthy();
  });

  it('says there is no voice yet, for bots and for people\'s own keys, when no provider is set up', async () => {
    providers = [];
    render(<VoiceSection />);
    const empty = await screen.findByTestId('voice-empty');
    expect(empty.textContent).toContain('Universe AI has no voice yet');
    expect(empty.textContent).toContain('nobody can add a voice key of their own');
  });

  it('switches a company on with one tap', async () => {
    render(<VoiceSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable Deepgram' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toMatchObject({ url: '/api/admin/voice-providers/v-deepgram', body: { enabled: true } });
  });

  it('asks before switching a company off, and says its bots speak as Universe AI\'s current voice while it is off', async () => {
    render(<VoiceSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable Cartesia' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'Disable Cartesia?' })).toBeTruthy();
    const speak = within(sheet).getByTestId('off-speech');
    expect(speak.textContent).toContain('They speak as Aria on ElevenLabs');
    expect(speak.textContent).toContain('What Universe AI speaks with now');
    expect(speak.textContent).toContain(
      '2 bots speak with Cartesia. While it’s off, they speak as Aria on ElevenLabs, so none goes quiet. Turn Cartesia on again and they get their own voices back. A maker can pick another voice any time.'
    );
    expect(within(sheet).queryByTestId('off-recognition')).toBeNull();
    expect(sheet.textContent).toContain('People can’t add a Cartesia key while no Cartesia provider is on.');
    expect(patches()).toHaveLength(0);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body).toEqual({ enabled: false });
  });

  it('says the bots answer in text when Universe AI has no starting voice to lend them', async () => {
    providers = [soniox(), { ...eleven(), defaultVoiceId: null, defaultVoiceName: null }, cartesia(), deepgram()];
    render(<VoiceSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable Cartesia' }));
    const speak = within(await screen.findByRole('dialog')).getByTestId('off-speech');
    expect(speak.textContent).toBe('2 bots speak with Cartesia. They answer in text until it’s on again, or until their makers pick another voice.');
  });

  it('says a listening company\'s bot listens with Universe AI\'s current company while it is off', async () => {
    providers = [soniox(), eleven(), cartesia(), { ...deepgram(), enabled: true, bots: { recognition: 1, speech: 0, total: 1 } }];
    render(<VoiceSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable Deepgram' }));
    const listen = within(await screen.findByRole('dialog')).getByTestId('off-recognition');
    expect(listen.textContent).toContain('It listens with Soniox');
    expect(listen.textContent).toContain('1 bot listens with Deepgram. While it’s off, it listens with Soniox. Turn Deepgram on again and it listens with it again.');
  });

  it('doesn\'t say people lose a company\'s key when another provider of it is still on', async () => {
    providers = [soniox(), eleven(), cartesia(), { ...cartesia(), id: 'v-cartesia-2', name: 'Cartesia EU' }];
    render(<VoiceSection />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Disable Cartesia' }))[0]);
    expect((await screen.findByRole('dialog')).textContent).not.toContain('People can’t add');
  });
});

describe('Change what Universe AI listens with', () => {
  it('shows a disabled company but won\'t pick it, and keeps Save off until something changes', async () => {
    render(<VoiceSection />);
    fireEvent.click(within(await screen.findByTestId('default-listen')).getByRole('button', { name: 'Change' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'Universe AI listens with' })).toBeTruthy();
    const deepgramCard = within(sheet).getByRole('radio', { name: /Deepgram/ });
    expect(deepgramCard.hasAttribute('disabled')).toBe(true);
    expect(deepgramCard.textContent).toContain('Disabled. Enable it to pick it.');
    expect((within(sheet).getByRole('radio', { name: /Soniox/ }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
    expect(within(sheet).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    // Nothing changes yet, and no bot listens with another company, so the line names only new bots
    expect(screen.getByTestId('default-listen').textContent).toContain('A bot that turns voice on starts with this. Bots on Soniox listen with this model too.');
    expect(screen.getByTestId('default-speak').textContent).toContain('A bot that turns voice on starts with this voice. Bots on ElevenLabs speak with this model too, in their own voices.');
    expect(within(sheet).getByTestId('listen-change-line').textContent).toBe('Bots that turn voice on from now listen with it.');
    // Every company that can listen is offered the same way: none is marked Recommended
    expect(within(sheet).queryByText('Recommended')).toBeNull();
  });

  it('makes a company the default for listening with the model it starts on, first in its list', async () => {
    providers = [soniox(), eleven(), cartesia(), { ...deepgram(), enabled: true }];
    render(<VoiceSection />);
    fireEvent.click(within(await screen.findByTestId('default-listen')).getByRole('button', { name: 'Change' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('radio', { name: /Deepgram/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toMatchObject({ url: '/api/admin/voice-providers/v-deepgram', body: { defaultRecognition: true, models: [{ id: 'nova-3', label: 'Nova 3', kind: 'recognition' }] } });
  });
});

describe('Change what Universe AI speaks with', () => {
  it('opens on the default company, model and voice, with the company\'s free voices and samples', async () => {
    render(<VoiceSection />);
    fireEvent.click(within(await screen.findByTestId('default-speak')).getByRole('button', { name: 'Change' }));
    const sheet = await screen.findByRole('dialog');
    const list = await within(sheet).findByTestId('voice-list');
    expect(calls.some((call) => call.url === '/api/admin/voice-providers/v-eleven/voices')).toBe(true);
    expect(within(sheet).getByText('Samples come from ElevenLabs, free.')).toBeTruthy();
    expect(within(sheet).getByRole('searchbox', { name: 'Search voices' }).getAttribute('placeholder')).toBe('Search 2 voices');
    expect(within(list).getByRole('radio', { name: /Aria/ }).getAttribute('aria-checked')).toBe('true');
    // A voice with a sample has a Play button; one without has none
    expect(within(list).getByRole('button', { name: 'Play Aria' })).toBeTruthy();
    expect(within(list).queryByRole('button', { name: 'Play Sarah' })).toBeNull();
    expect(within(sheet).getByTestId('speak-change-line').textContent).toBe('Bots that turn voice on from now start with it. The 2 bots speaking with Cartesia stay on Cartesia.');
    expect(within(sheet).queryByText('Recommended')).toBeNull();
  });

  it('says that bots on the company it moves away from stay there', async () => {
    render(<VoiceSection />);
    fireEvent.click(within(await screen.findByTestId('default-speak')).getByRole('button', { name: 'Change' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('radio', { name: /Cartesia/ }));
    expect(within(sheet).getByTestId('speak-change-line').textContent).toBe('Bots that turn voice on from now start with it. The 12 bots speaking with ElevenLabs stay on ElevenLabs.');
  });

  it('saves a new starting voice with its name, and only then', async () => {
    render(<VoiceSection />);
    fireEvent.click(within(await screen.findByTestId('default-speak')).getByRole('button', { name: 'Change' }));
    const sheet = await screen.findByRole('dialog');
    const list = await within(sheet).findByTestId('voice-list');
    const save = within(sheet).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(list).getByRole('radio', { name: /Sarah/ }));
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toMatchObject({ url: '/api/admin/voice-providers/v-eleven', body: { defaultSpeech: true, defaultVoiceId: 'sarah', defaultVoiceName: 'Sarah' } });
  });

  it('searches the voices and says so when none match', async () => {
    render(<VoiceSection />);
    fireEvent.click(within(await screen.findByTestId('default-speak')).getByRole('button', { name: 'Change' }));
    const sheet = await screen.findByRole('dialog');
    const list = await within(sheet).findByTestId('voice-list');
    fireEvent.change(within(sheet).getByRole('searchbox', { name: 'Search voices' }), { target: { value: 'warm' } });
    // The voice that is picked stays on screen however the list is searched
    expect(within(list).getByRole('radio', { name: /Sarah/ })).toBeTruthy();
    expect(within(list).getByRole('radio', { name: /Aria/ })).toBeTruthy();
    fireEvent.change(within(sheet).getByRole('searchbox', { name: 'Search voices' }), { target: { value: 'zzz' } });
    expect(within(list).getByText('No voice matches that.')).toBeTruthy();
  });

  it('can still save a company when its voices can\'t be listed, and says which voice bots then start with', async () => {
    voicesAnswer = { ok: false, status: 502, body: { error: 'Couldn’t reach Cartesia. Try again in a moment.' } };
    render(<VoiceSection />);
    fireEvent.click(within(await screen.findByTestId('default-speak')).getByRole('button', { name: 'Change' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('radio', { name: /Cartesia/ }));
    await waitFor(() => expect(sheet.textContent).toContain('Couldn’t reach Cartesia. Try again in a moment.'));
    expect(sheet.textContent).toContain('bots start with the first voice Cartesia lists');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].url).toBe('/api/admin/voice-providers/v-cartesia');
    expect(patches()[0].body).toEqual({ defaultSpeech: true, models: [{ id: 'sonic-3', label: 'Sonic 3', kind: 'speech' }] });
  });

  it('keeps the sheet open and says why when the server turns the change down', async () => {
    patchAnswer = { ok: false, body: { error: 'The default for speaking must be on' } };
    render(<VoiceSection />);
    fireEvent.click(within(await screen.findByTestId('default-speak')).getByRole('button', { name: 'Change' }));
    const sheet = await screen.findByRole('dialog');
    const list = await within(sheet).findByTestId('voice-list');
    fireEvent.click(within(list).getByRole('radio', { name: /Sarah/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByRole('alert')).toBeTruthy();
    expect(within(sheet).getByRole('alert').textContent).toBe('The default for speaking must be on');
  });
});

describe('what a change of Universe AI\u2019s company or model does to bots', () => {
  type Counted = Parameters<typeof defaultChangeLine>[1] & object;
  const as = (row: Row) => row as unknown as Counted;
  const rows = [soniox(), { ...deepgram(), bots: { recognition: 3, speech: 0, total: 3 } }, eleven(), cartesia()].map(as);
  it('moves the bots already on the picked provider to a new model, and says they keep their voices', () => {
    expect(defaultChangeLine(rows, as(eleven()), 'speech', true)).toBe(
      'Bots that turn voice on from now start with it. The 12 bots speaking with ElevenLabs move to this model and keep their voices. The 2 bots speaking with Cartesia stay on Cartesia.'
    );
    expect(defaultChangeLine(rows, as(soniox()), 'recognition', true)).toBe('Bots that turn voice on from now listen with it. The 14 bots listening with Soniox move to this model. The 3 bots listening with Deepgram stay on Deepgram.');
  });
  it('says nothing moves when the model stays, and counts one bot as a bot', () => {
    expect(defaultChangeLine(rows, as(eleven()), 'speech', false)).toBe('Bots that turn voice on from now start with it. The 2 bots speaking with Cartesia stay on Cartesia.');
    expect(defaultChangeLine([as({ ...cartesia(), bots: { recognition: 0, speech: 1, total: 1 } })], as(eleven()), 'speech', false)).toBe('Bots that turn voice on from now start with it. The 1 bot speaking with Cartesia stays on Cartesia.');
  });
});

describe('the model Universe AI starts a bot on', () => {
  it('is the first one the provider lists for the job, so picking one moves it to the front of its own job only', () => {
    const models = [
      { id: 'l1', kind: 'recognition' as const },
      { id: 's1', kind: 'speech' as const },
      { id: 's2', kind: 'speech' as const },
      { id: 's3', kind: 'speech' as const },
    ];
    expect(withStartingModel(models, 'speech', 's3').map((model) => model.id)).toEqual(['l1', 's3', 's1', 's2']);
    expect(withStartingModel(models, 'speech', 's1')).toEqual(models);
    expect(withStartingModel(models, 'speech', 'nope')).toEqual(models);
  });
});

describe('New voice provider', () => {
  it('groups the four companies by what they do, then keeps Add provider off until the key is checked and a model is listed', async () => {
    render(<NewVoiceProviderPage />);
    expect(screen.getByRole('heading', { name: 'Pick a company' })).toBeTruthy();
    const listens = screen.getByRole('radiogroup', { name: 'Listens' });
    const speaks = screen.getByRole('radiogroup', { name: 'Speaks' });
    expect(['Soniox', 'Deepgram'].every((name) => within(listens).getByRole('radio', { name: new RegExp(`^${name}`) }))).toBe(true);
    expect(['ElevenLabs', 'Cartesia'].every((name) => within(speaks).getByRole('radio', { name: new RegExp(`^${name}`) }))).toBe(true);
    // Every company is offered the same way, in alphabetical order, with the same neutral line: none is marked Recommended or praised
    // A company that listens and speaks is under both, with the same line (#844)
    expect(within(listens).getAllByRole('radio').map((card) => card.textContent)).toEqual([
      'AssemblyAIListens. Uses your account at assemblyai.com.',
      'CartesiaListens and speaks. Uses your account at cartesia.ai.',
      'DeepgramListens and speaks. Uses your account at deepgram.com.',
      'ElevenLabsListens and speaks. Uses your account at elevenlabs.io.',
      'falListens. Uses your account at fal.ai.',
      'GladiaListens. Uses your account at gladia.io.',
      'GradiumListens and speaks. Uses your account at gradium.ai.',
      'GroqListens and speaks. Uses your account at groq.com.',
      'MetaListens. Uses your account at dev.meta.ai.',
      'MistralListens and speaks. Uses your account at mistral.ai.',
      'NVIDIAListens and speaks. Uses your account at build.nvidia.com.',
      'Sarvam AIListens and speaks. Uses your account at sarvam.ai.',
      'Smallest AIListens and speaks. Uses your account at smallest.ai.',
      'SonioxListens and speaks. Uses your account at soniox.com.',
      'SpeechmaticsListens and speaks. Uses your account at speechmatics.com.',
      'Together AIListens and speaks. Uses your account at together.ai.',
    ]);
    expect(within(speaks).getAllByRole('radio').map((card) => card.textContent?.split('.')[0])).toEqual(['AsyncSpeaks', 'BlandSpeaks', 'CAMB', 'CartesiaListens and speaks', 'DeepgramListens and speaks', 'ElevenLabsListens and speaks', 'Fish AudioSpeaks', 'GradiumListens and speaks', 'GroqListens and speaks', 'HumeSpeaks', 'MistralListens and speaks', 'NeuphonicSpeaks', 'NVIDIAListens and speaks', 'Resemble AISpeaks', 'RimeSpeaks', 'Sarvam AIListens and speaks', 'Smallest AIListens and speaks', 'SonioxListens and speaks', 'SpeechifySpeaks', 'SpeechmaticsListens and speaks', 'Together AIListens and speaks']);
    expect(screen.queryByText('Recommended')).toBeNull();
    fireEvent.click(within(speaks).getByRole('radio', { name: /^ElevenLabs/ }));
    expect(screen.getByRole('heading', { name: 'Set up ElevenLabs' })).toBeTruthy();
    const add = screen.getByRole('button', { name: 'Add provider' });
    expect(add.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk_0000000000000000a1b2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));
    expect(await screen.findByText('ElevenLabs knows this key. Nothing was spoken, so nothing was paid.')).toBeTruthy();
    // The key is checked, but no model is listed yet
    expect(add.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'eleven_flash_v2_5' } });
    fireEvent.change(screen.getByLabelText('Name people see (optional)'), { target: { value: 'Flash v2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    expect(listedRows()).toHaveLength(1);
    expect(add.hasAttribute('disabled')).toBe(false);
    // A key changed after the check has to be checked again
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk_0000000000000000zzzz' } });
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(calls.filter((call) => call.method === 'POST' && call.url === '/api/admin/voice-providers/check')).toHaveLength(1);
  });

  it('adds the provider on, with its key, its models and the job its company does', async () => {
    render(<NewVoiceProviderPage />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Listens' })).getByRole('radio', { name: /^Soniox/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'soniox-key-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));
    await screen.findByText('Soniox knows this key. Nothing was spoken, so nothing was paid.');
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'stt-rt-v6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    // Soniox listens on a websocket address, which is allowed here
    fireEvent.click(screen.getByRole('button', { name: 'Its own address' }));
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'http://nope.example.com' } });
    expect(screen.getByRole('alert').textContent).toBe('The address must start with https:// or wss://.');
    expect(screen.getByRole('button', { name: 'Add provider' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'wss://stt-rt.soniox.com/transcribe-websocket' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/ai-providers'));
    const post = calls.find((call) => call.method === 'POST' && call.url === '/api/admin/voice-providers');
    expect(post?.body).toEqual({
      adapter: 'soniox',
      name: 'Soniox',
      recognition: true,
      speech: false,
      enabled: true,
      apiKey: 'soniox-key-1234',
      models: [{ id: 'stt-rt-v6', kind: 'recognition' }],
      endpoint: 'wss://stt-rt.soniox.com/transcribe-websocket',
    });
  });

  it('sets up the job picked for a company that listens and speaks, asking it for that job\'s models (#844)', async () => {
    render(<NewVoiceProviderPage />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Listens' })).getByRole('radio', { name: /^Cartesia/ }));
    expect(screen.getByRole('heading', { name: 'Set up Cartesia' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk_car_0000000000001234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));
    await screen.findByText('Cartesia knows this key. Nothing was spoken, so nothing was paid.');
    expect(calls.find((call) => call.url === '/api/admin/voice-providers/check')?.body).toMatchObject({ adapter: 'cartesia', job: 'recognition' });
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'ink-whisper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/ai-providers'));
    expect(calls.find((call) => call.method === 'POST' && call.url === '/api/admin/voice-providers')?.body).toMatchObject({
      adapter: 'cartesia',
      recognition: true,
      speech: false,
      models: [{ id: 'ink-whisper', kind: 'recognition' }],
    });
  });
});

describe('New voice provider, models the company lists (#840)', () => {
  it('lists the company\'s models after Check key to tick, each with what the company says, one that works ticked already', async () => {
    checkAnswer = {
      ok: true,
      body: { ok: true, models: [{ id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5', kind: 'speech', note: '2 languages · Fast.' }, { id: 'eleven_v3', label: 'Eleven v3', kind: 'speech' }] },
    };
    render(<NewVoiceProviderPage />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Speaks' })).getByRole('radio', { name: /^ElevenLabs/ }));
    expect(screen.getByText('Check the key and ElevenLabs’s models show here to tick.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk_0000000000000000a1b2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));
    expect(await screen.findByText('ElevenLabs knows this key and lists 2 models for it. Nothing was spoken, so nothing was paid.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a model' })).toBeNull();
    const add = screen.getByRole('button', { name: 'Add provider' });
    // The models Universe starts ElevenLabs keys on come first, the first one ticked already, so it can be added as it is
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((box) => box.textContent)).toEqual([
      'Eleven v4 Turboeleven_v4_turbo',
      'Eleven Flash v2.5eleven_flash_v2_5 · 2 languages · Fast.',
      'Eleven v3eleven_v3',
    ]);
    expect(boxes[0].getAttribute('aria-checked')).toBe('true');
    expect(add.hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Eleven v3/ }));
    fireEvent.click(add);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/ai-providers'));
    const post = calls.find((call) => call.method === 'POST' && call.url === '/api/admin/voice-providers');
    // Only the model is saved, never the company's line about it
    expect(post?.body?.models).toEqual([
      { id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo', kind: 'speech' },
      { id: 'eleven_v3', label: 'Eleven v3', kind: 'speech' },
    ]);
  });

  it('offers the models Universe knows to tick, or one to type, for a company that shares no list', async () => {
    render(<NewVoiceProviderPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Fish Audio/ }));
    expect(screen.getByText(/Fish Audio doesn’t share a list of its models\. Tick the ones Universe knows for it, or type one as Fish Audio writes it\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'S2.1 Pro' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 's2-pro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'S2.1 Pro (free)' }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'fish-key-12345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));
    await screen.findByText('Fish Audio knows this key. Nothing was spoken, so nothing was paid.');
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/ai-providers'));
    const post = calls.find((call) => call.method === 'POST' && call.url === '/api/admin/voice-providers');
    expect(post?.body?.models).toEqual([
      { id: 's2.1-pro', label: 'S2.1 Pro', kind: 'speech' },
      { id: 's2-pro', kind: 'speech' },
      { id: 's2.1-pro-free', label: 'S2.1 Pro (free)', kind: 'speech' },
    ]);
  });
});

describe('New voice provider, Enter in a model field', () => {
  it('adds the model being typed and does not submit the form', async () => {
    render(<NewVoiceProviderPage />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Listens' })).getByRole('radio', { name: /^Soniox/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'soniox-key-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));
    await screen.findByText('Soniox knows this key. Nothing was spoken, so nothing was paid.');
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'stt-rt-v6' } });
    fireEvent.keyDown(screen.getByLabelText('Model id'), { key: 'Enter' });
    await waitFor(() => expect(listedRows()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'second' } });
    fireEvent.keyDown(screen.getByLabelText('Name people see (optional)'), { key: 'Enter' });
    await waitFor(() => expect(listedRows()).toHaveLength(2));
    expect(calls.some((call) => call.method === 'POST' && call.url === '/api/admin/voice-providers')).toBe(false);
  });
});

describe('New voice provider, a key the company turns away', () => {
  async function setUp(address: string | null) {
    checkAnswer = { ok: false, body: { error: 'Deepgram turned this key away. Check that you copied all of it.' } };
    render(<NewVoiceProviderPage />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Listens' })).getByRole('radio', { name: /^Deepgram/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'regional-key-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));
    await screen.findByText('Deepgram turned this key away. Check that you copied all of it.');
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'nova-3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    if (address !== null) {
      fireEvent.click(screen.getByRole('button', { name: 'Its own address' }));
      fireEvent.change(screen.getByLabelText('Address'), { target: { value: address } });
    }
  }

  it('can still be added when an address is typed under Its own address, and says why', async () => {
    await setUp('https://api.eu.deepgram.com');
    expect(screen.getByText(/You can still add it\./)).toBeTruthy();
    const add = screen.getByRole('button', { name: 'Add provider' });
    expect(add.hasAttribute('disabled')).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/ai-providers'));
    const post = calls.find((call) => call.method === 'POST' && call.url === '/api/admin/voice-providers');
    expect(post?.body).toMatchObject({ adapter: 'deepgram', apiKey: 'regional-key-1234', endpoint: 'https://api.eu.deepgram.com' });
  });

  it('stays off when no address is typed, or the typed address is not allowed, or the key changes after the check', async () => {
    await setUp(null);
    const add = screen.getByRole('button', { name: 'Add provider' });
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(/You can still add it\./)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Its own address' }));
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'http://nope.example.com' } });
    expect(add.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://api.eu.deepgram.com' } });
    expect(add.hasAttribute('disabled')).toBe(false);
    // A key changed after the check has to be checked again, address or not
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'another-key-5678' } });
    expect(add.hasAttribute('disabled')).toBe(true);
  });
});

describe('a voice provider\u2019s page, after CodeRabbit\u2019s findings on the voice screens', () => {
  const open = async (id: string) => {
    const params = Object.assign(Promise.resolve({ id }), { status: 'fulfilled', value: { id } });
    render(<VoiceProviderPage params={params} />);
    return screen.findByRole('button', { name: 'Add a model' });
  };
  const addModel = async (id: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: id } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
  };

  it('keeps the saved model list on the page, so a second quick edit builds on the first and not on the old list', async () => {
    await open('v-cartesia');
    // The list that follows each save has not arrived yet
    holdList = true;
    await addModel('sonic-4');
    await waitFor(() => expect(patches()).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId('model-row')).toHaveLength(2));
    await addModel('sonic-5');
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect((patches()[1].body as { models: { id: string }[] }).models.map((model) => model.id)).toEqual(['sonic-3', 'sonic-4', 'sonic-5']);
  });

  it('keeps what was typed for a model when it could not be saved, and closes the form once it is', async () => {
    await open('v-cartesia');
    patchAnswer = { ok: false, body: { error: 'Cartesia is not reachable right now.' } };
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'sonic-4' } });
    fireEvent.change(screen.getByLabelText('Name people see (optional)'), { target: { value: 'Sonic 4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    expect(await screen.findByText('Cartesia is not reachable right now.')).toBeTruthy();
    expect((screen.getByLabelText('Model id') as HTMLInputElement).value).toBe('sonic-4');
    expect((screen.getByLabelText('Name people see (optional)') as HTMLInputElement).value).toBe('Sonic 4');
    expect(screen.getAllByTestId('model-row')).toHaveLength(1);
    patchAnswer = { ok: true, body: { provider: {} } };
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    await waitFor(() => expect(screen.queryByLabelText('Model id')).toBeNull());
    expect(patches().at(-1)?.body).toEqual({ models: [{ id: 'sonic-3', label: 'Sonic 3', kind: 'speech' }, { id: 'sonic-4', label: 'Sonic 4', kind: 'speech' }] });
  });

  it('checks the default\u2019s last model against the list just saved, not the one from before it', async () => {
    // ElevenLabs is the default for speaking, so it keeps a speaking model
    await open('v-eleven');
    holdList = true;
    fireEvent.click(screen.getByRole('button', { name: 'Take Flash v2.5 off' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId('model-row')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Take Multilingual v2 off' }));
    expect(await screen.findByText(/keeps a speaking model/)).toBeTruthy();
    expect(patches()).toHaveLength(1);
  });

  it('warns that people can\u2019t add a company key before turning off the last provider of it, and turns it off only on Disable', async () => {
    await open('v-cartesia');
    fireEvent.click(screen.getByRole('switch', { name: 'On' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'Disable Cartesia?' })).toBeTruthy();
    expect(sheet.textContent).toContain('2 bots use Cartesia. They answer in text');
    expect(sheet.textContent).toContain('People can\u2019t add a Cartesia key while no Cartesia provider is on.');
    expect(patches()).toHaveLength(0);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(patches()).toHaveLength(0);
    fireEvent.click(screen.getByRole('switch', { name: 'On' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toMatchObject({ url: '/api/admin/voice-providers/v-cartesia', body: { enabled: false } });
  });

  it('turns off at once when another provider of the company is still on', async () => {
    providers = [soniox(), eleven(), cartesia(), { ...cartesia(), id: 'v-cartesia-2', name: 'Cartesia EU' }];
    await open('v-cartesia');
    fireEvent.click(screen.getByRole('switch', { name: 'On' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(patches()[0].body).toEqual({ enabled: false });
  });
});

describe('the Change buttons for what Universe AI listens and speaks with', () => {
  it('wait for the list that follows a save, so a sheet opened again can\u2019t save the old default back', async () => {
    providers = [soniox(), eleven(), cartesia(), { ...deepgram(), enabled: true }];
    render(<VoiceSection />);
    const listen = await screen.findByTestId('default-listen');
    await waitFor(() => expect((within(listen).getByRole('button', { name: 'Change' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(listen).getByRole('button', { name: 'Change' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('radio', { name: /Deepgram/ }));
    holdList = true;
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((within(screen.getByTestId('default-listen')).getByRole('button', { name: 'Change' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(screen.getByTestId('default-speak')).getByRole('button', { name: 'Change' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the voice limits', () => {
  it('offers Never for listening a day, which the range allows, and saves it as 0', () => {
    const rows = voiceServerLimits({ ...VOICE_LIMITS_RECOMMENDED }, { signedIn: 30, guest: 10 });
    const listening = rows.find((row) => row.id === 'listenMinutesPerDay')!;
    expect(listening.range?.min).toBe(0);
    expect(listening.options[0]).toMatchObject({ value: 0, label: 'Never' });
    expect(listening.options.map((option) => option.value)).toEqual([0, 15, 30, 60, 120, 240]);
  });

  it('say what 5 guest replies is from the voice replies a guest really has, after the replies kept for text', () => {
    const meaning = (guest: number, textReserveShare = VOICE_LIMITS_RECOMMENDED.textReserveShare) =>
      voiceServerLimits({ ...VOICE_LIMITS_RECOMMENDED, textReserveShare }, { signedIn: 30, guest }).find((row) => row.id === 'guestVoiceReplies')!.options.find((option) => option.value === 5)!.meaning;
    // 1 in 6 kept: 10 replies keep 2, 20 keep 4, 8 keep 2
    expect(meaning(10)).toBe('5 of the 8 voice replies a guest has.');
    expect(meaning(20)).toBe('5 of the 16 voice replies a guest has.');
    expect(meaning(8)).toBe('5 of the 6 voice replies a guest has.');
    // 5 replies keep 1 for text, so only 4 are left for voice
    expect(meaning(5)).toBe('All 4 voice replies a guest has.');
    // 1 in 2 kept: 8 replies keep 4, so 4 are left
    expect(meaning(8, 2)).toBe('All 4 voice replies a guest has.');
    expect(meaning(2)).toBe('The only voice reply a guest has.');
    expect(meaning(1)).toBe('Guests get text only.');
  });

  it('are the 7 from #740, the four a key can change first, each with its recommended value', () => {
    const rows = voiceServerLimits({ ...VOICE_LIMITS_RECOMMENDED }, { signedIn: 30, guest: 10 });
    expect(rows.map((row) => row.id)).toEqual(['turnSeconds', 'replyCharacters', 'replySeconds', 'listenMinutesPerDay', 'followUpSeconds', 'voicesShownFirst', 'textReserveShare', 'guestVoiceReplies']);
    for (const row of rows) {
      expect(row.value).toBe(row.recommended);
      expect(row.options.some((option) => option.value === row.value)).toBe(true);
    }
    const reserve = rows.find((row) => row.id === 'textReserveShare')!;
    expect(reserve.hint).toContain('30 replies keep 5 for text.');
    expect(rows.find((row) => row.id === 'guestVoiceReplies')!.hint).toContain('from their 10 replies');
  });

  it('show a value a super admin set that is not one of the steps, and keep the recommended one beside it', () => {
    const rows = voiceServerLimits({ ...VOICE_LIMITS_RECOMMENDED, textReserveShare: 8, replyCharacters: 900 }, { signedIn: 30, guest: 10 });
    const reserve = rows.find((row) => row.id === 'textReserveShare')!;
    expect(reserve.options.map((option) => option.value)).toEqual([3, 6, 8, 10]);
    expect(reserve.recommended).toBe(6);
    expect(rows.find((row) => row.id === 'replyCharacters')!.value).toBe(900);
  });
});

describe('A voice provider\u2019s key', () => {
  const open = async (id: string) => {
    // Already settled, so React's use() reads it without suspending
    const params = Object.assign(Promise.resolve({ id }), { status: 'fulfilled', value: { id } });
    render(<VoiceProviderPage params={params} />);
    return screen.findByRole('button', { name: 'Replace' });
  };
  const checks = () => calls.filter((call) => call.method === 'POST' && call.url === '/api/admin/voice-providers/check');
  const saves = () => calls.filter((call) => call.method === 'PATCH');

  it('is asked about at the company before it replaces the saved one, and a refused key is not saved', async () => {
    fireEvent.click(await open('v-eleven'));
    checkAnswer = { ok: false, body: { error: 'ElevenLabs doesn\u2019t know this key.' } };
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'sk_new_key_0000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and replace' }));
    expect(await screen.findByText('ElevenLabs doesn\u2019t know this key.')).toBeTruthy();
    expect(checks()).toHaveLength(1);
    expect(checks()[0].body).toEqual({ adapter: 'elevenlabs', apiKey: 'sk_new_key_0000' });
    expect(saves()).toHaveLength(0);
    checkAnswer = { ok: true, body: { ok: true } };
    fireEvent.click(screen.getByRole('button', { name: 'Check and replace' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0].body).toEqual({ apiKey: 'sk_new_key_0000' });
  });

  it('is replaced without asking the company when the provider has its own address, which the company can\u2019t vouch for', async () => {
    providers = [soniox(), provider({ ...eleven(), endpoint: 'https://eleven.example.com' })];
    fireEvent.click(await open('v-eleven'));
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'sk_custom_host_0000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0].body).toEqual({ apiKey: 'sk_custom_host_0000' });
    expect(checks()).toHaveLength(0);
  });

  it('says the company can\u2019t check it when the provider has its own address, instead of a refusal', async () => {
    providers = [soniox(), provider({ ...eleven(), endpoint: 'https://eleven.example.com' })];
    await open('v-eleven');
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));
    expect(await screen.findByText('This provider uses its own address, so ElevenLabs can\u2019t check its key.')).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith('/check'))).toBe(false);
  });
});
