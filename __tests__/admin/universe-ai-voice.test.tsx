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
const push = jest.fn();

jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : null });
    const answer = (ok: boolean, body: unknown, status = ok ? 200 : 400) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
    if (url === '/api/admin/voice-providers' && method === 'GET') return answer(true, { providers });
    if (url.endsWith('/voices')) return answer(voicesAnswer.ok, voicesAnswer.body, voicesAnswer.status);
    if (method === 'PATCH') return answer(patchAnswer.ok, patchAnswer.body);
    if (url === '/api/admin/voice-providers/check') return answer(true, { ok: true });
    if (url === '/api/admin/voice-providers' && method === 'POST') return answer(true, { provider: {} }, 201);
    return answer(true, {});
  },
}));
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: jest.fn() }) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push, back: jest.fn() }) }));

import { VoiceSection } from '@/app/admin/ai-providers/voice-section';
import NewVoiceProviderPage from '@/app/admin/ai-providers/voice/new/page';
import { voiceServerLimits } from '@/app/admin/components/limits';
import { withStartingModel } from '@/app/admin/ai-providers/voice/voice-shared';
import { VOICE_LIMITS_RECOMMENDED } from '@/lib/voice-limit-values';

const provider = (changes: Row): Row => ({ region: null, endpoint: null, hasKey: true, defaultRecognition: false, defaultSpeech: false, defaultVoiceId: null, defaultVoiceName: null, bots: { recognition: 0, speech: 0, total: 0 }, ...changes });
const soniox = () => provider({ id: 'v-soniox', adapter: 'soniox', name: 'Soniox', recognition: true, speech: false, enabled: true, apiKeyLast4: '9f3c', models: [{ id: 'stt-rt-v3', label: 'Real-time v3', kind: 'recognition' }], defaultRecognition: true, bots: { recognition: 14, speech: 0, total: 14 } });
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
  push.mockReset();
});

const patches = () => calls.filter((call) => call.method === 'PATCH');

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

  it('asks before switching a company off, and says how many bots go to text', async () => {
    render(<VoiceSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable Cartesia' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'Disable Cartesia?' })).toBeTruthy();
    expect(sheet.textContent).toContain('2 bots use Cartesia. They answer in text');
    expect(sheet.textContent).toContain('People can’t add a Cartesia key while no Cartesia provider is on.');
    expect(patches()).toHaveLength(0);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body).toEqual({ enabled: false });
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
    expect(sheet.textContent).toContain('The 14 bots that already listen keep what they have.');
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
    expect(sheet.textContent).toContain('The 14 bots that already speak keep the voice they have.');
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
    expect(screen.getAllByTestId('model-row')).toHaveLength(1);
    expect(add.hasAttribute('disabled')).toBe(false);
    // A key changed after the check has to be checked again
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk_0000000000000000zzzz' } });
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(calls.filter((call) => call.method === 'POST' && call.url === '/api/admin/voice-providers/check')).toHaveLength(1);
  });

  it('adds the provider on, with its key, its models and the job its company does', async () => {
    render(<NewVoiceProviderPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Soniox/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'soniox-key-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));
    await screen.findByText('Soniox knows this key. Nothing was spoken, so nothing was paid.');
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'stt-rt-v3' } });
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
      models: [{ id: 'stt-rt-v3', kind: 'recognition' }],
      endpoint: 'wss://stt-rt.soniox.com/transcribe-websocket',
    });
  });
});

describe('the voice limits', () => {
  it('are the 7 from #740, the four a key can change first, each with its recommended value', () => {
    const rows = voiceServerLimits({ ...VOICE_LIMITS_RECOMMENDED }, { signedIn: 30, guest: 10 });
    expect(rows.map((row) => row.id)).toEqual(['turnSeconds', 'replyCharacters', 'replySeconds', 'listenMinutesPerDay', 'followUpSeconds', 'textReserveShare', 'guestVoiceReplies']);
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
