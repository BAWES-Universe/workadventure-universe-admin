/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** Voice keys on the AI keys page and the You card (#749): the same card as a text key, for what a speech company's key is. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const mockAddToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: mockAddToast }) }));

import AiKeysPage from '@/app/admin/you/ai-keys/page';
import { AiKeysCard } from '@/app/admin/components/ai-keys-card';
import { RECHECK_MINUTES } from '@/lib/key-recheck';

const models = [
  { id: 'scribe_v1', label: 'Scribe v1', kind: 'recognition' },
  { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5', kind: 'speech' },
  { id: 'eleven_v3', label: 'Eleven v3', kind: 'speech' },
];
const working = { status: 'working', downSince: null, downReason: null };
const voiceKey = {
  id: 'vk-1',
  adapter: 'elevenlabs',
  company: 'ElevenLabs',
  name: 'My ElevenLabs',
  recognition: true,
  speech: true,
  last4: '7c1d',
  models,
  lentTo: [
    {
      universeId: 'u-1',
      universeName: 'Sandbox Universe',
      ownedByYou: true,
      models: null,
      bots: [{ id: 'b1', name: 'Sales Researcher', model: 'Eleven Flash v2.5', voiceReplies: 186 }],
    },
  ],
  month: { voiceReplies: 186 },
  createdAt: '2026-10-30T10:00:00.000Z',
  health: working,
};
const down = { ...voiceKey, health: { status: 'down', downSince: '2026-10-30T11:14:00.000Z', downReason: 'credit' } };
const claude = {
  id: 'key-1',
  name: 'My Claude',
  kind: 'claude',
  kindLabel: 'Claude',
  model: null,
  modelCount: 10,
  address: null,
  last4: '4f2a',
  month: { replies: 412, tokens: 900_000 },
  lentTo: [],
  status: 'working',
  downSince: null,
  downReason: null,
  ifDown: 'universe-ai',
  limits: { reply: 32000, steps: 30, continue: 2, memory: 20, read: 50000, wait: 60, recentFiles: 5, results: 10, part: 8000, room: 80000 },
  createdAt: '2026-10-19T00:00:00.000Z',
};

type Answers = { text?: unknown[]; voice?: unknown[]; universes?: unknown[] };
function answer({ text = [], voice = [], universes = [] }: Answers) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const reply = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
    if (init?.method && init.method !== 'GET') return reply({ key: voiceKey, status: 'revoked' });
    if (url === '/api/me/voice-keys') return reply({ keys: voice, companies: [] });
    if (url === '/api/me/ai-keys') return reply({ keys: text });
    if (url === '/api/me/ai-keys/universes') return reply({ universes });
    return reply({});
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  mockAddToast.mockReset();
});

describe('a voice key on the AI keys page', () => {
  it('is the same card: what it does, its models and end, this month in voice replies, and the bots on it', async () => {
    answer({ voice: [voiceKey] });
    render(<AiKeysPage />);
    expect(await screen.findByText('ElevenLabs · Listens and speaks · 3 models · ends in 7c1d')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'My ElevenLabs' })).toBeTruthy();
    expect(screen.getAllByText('186 voice replies').length).toBe(1);
    expect(screen.getByText('Sales Researcher · Eleven Flash v2.5 · 186 voice replies')).toBeTruthy();
    expect(screen.getByTestId('ai-key-status').textContent).toBe('Working');
    // No Limits row, and "If this is down" is only a line: no picker
    expect(screen.queryByTestId('ai-key-limits')).toBeNull();
    const ifDown = screen.getByTestId('ai-key-if-down');
    expect(ifDown.textContent).toContain('Bots reply in text until it’s back. No other voice is used.');
    expect(within(ifDown).queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByTestId('ai-keys-empty')).toBeNull();
  });

  it('says Listens or Speaks for a key that does one thing, and a singular voice reply', async () => {
    answer({ voice: [{ ...voiceKey, recognition: false, models: [models[1]], month: { voiceReplies: 1 }, lentTo: [] }] });
    render(<AiKeysPage />);
    expect(await screen.findByText('ElevenLabs · Speaks · 1 model · ends in 7c1d')).toBeTruthy();
    expect(screen.getByText('1 voice reply')).toBeTruthy();
  });

  it('sits among the text keys, in the order they were added', async () => {
    answer({ text: [claude], voice: [voiceKey] });
    render(<AiKeysPage />);
    await screen.findByText('My ElevenLabs', { selector: 'h2' });
    expect(screen.getAllByTestId('ai-key').map((card) => card.querySelector('h2')?.textContent)).toEqual(['My Claude', 'My ElevenLabs']);
    // Only the text key has Limits
    expect(screen.getAllByTestId('ai-key-limits')).toHaveLength(1);
  });

  it('when down says since when, why, that its bots reply in text, and the wait from the shared setting', async () => {
    answer({ voice: [down] });
    render(<AiKeysPage />);
    const text = (await screen.findByTestId('ai-key-down-text')).textContent ?? '';
    expect(text).toMatch(/^Down since .*: ElevenLabs is out of credit\. Sales Researcher replies in text until it’s back\./);
    expect(text).toContain(`Universe checks again, at most every ${RECHECK_MINUTES} minutes, whenever a bot needs it, and switches back as soon as the key answers.`);
    expect(screen.getByTestId('ai-key-status').textContent).toBe('Down');
  });

  it('"Check now" asks the voice key route, and only a Down key has it', async () => {
    answer({ voice: [down] });
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/voice-keys/vk-1/check', { method: 'POST' }));
  });

  it('has no Check now while it works', async () => {
    answer({ voice: [voiceKey] });
    render(<AiKeysPage />);
    await screen.findByText('My ElevenLabs', { selector: 'h2' });
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });

  it('is renamed through the voice key route', async () => {
    answer({ voice: [voiceKey] });
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename My ElevenLabs' }));
    expect(screen.getByTestId('ai-key-rename-note').textContent).toBe('Shown on this card, under Voice and when you revoke it.');
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Studio' } });
    fireEvent.click(screen.getByTestId('ai-key-rename-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/voice-keys/vk-1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Studio' }) })));
    expect(await screen.findByRole('heading', { name: 'Studio' })).toBeTruthy();
  });

  it('is revoked through the voice key route, saying the bots carry on in text', async () => {
    answer({ voice: [voiceKey] });
    render(<AiKeysPage />);
    await screen.findByText('My ElevenLabs', { selector: 'h2' });
    expect(screen.getByText('Deletes it everywhere. Its bot replies in text.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Sales Researcher in Sandbox Universe replies in text.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/voice-keys/vk-1', { method: 'DELETE' }));
    await waitFor(() => expect(screen.queryByText('My ElevenLabs', { selector: 'h2' })).toBeNull());
  });

  it('pulls a lend through the voice key route after saying what the bots do', async () => {
    answer({ voice: [voiceKey] });
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pull My ElevenLabs from Sandbox Universe' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Sales Researcher replies in text until the key is lent to Sandbox Universe again.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pull' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/voice-keys/vk-1/lend/u-1', { method: 'DELETE' }));
  });

  it('shows one failed list as a failure, not an empty page', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url === '/api/me/voice-keys' ? { ok: false, status: 500, json: () => Promise.resolve({}) } : { ok: true, status: 200, json: () => Promise.resolve({ keys: [] }) }),
    );
    render(<AiKeysPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('ai-keys-empty')).toBeNull();
  });
});

describe('lending a voice key', () => {
  const universes = [
    { id: 'u-1', name: 'Sandbox Universe', access: 'owner' },
    { id: 'u-2', name: 'Plugn', access: 'manage' },
  ];

  it('says bots you made there use it under Voice, asks the company nothing, and lends through the voice key route', async () => {
    answer({ voice: [voiceKey], universes });
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Lend to a universe' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Universes where you can manage bots. Lending moves no bot: in a bot you made there, pick this key under Voice.');
    expect(await within(dialog).findByText('Plugn')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lend' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/voice-keys/vk-1/lend', expect.objectContaining({ method: 'POST', body: JSON.stringify({ universeId: 'u-2' }) })));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/models'))).toBe(false);
  });

  it('groups the key’s models under Listens and Speaks and lends only the ticked ones as "kind:id"', async () => {
    answer({ voice: [voiceKey], universes });
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Lend to a universe' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Plugn');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Only these' }));
    expect(within(within(dialog).getByTestId('voice-models-recognition')).getByText('Scribe v1')).toBeTruthy();
    expect(within(within(dialog).getByTestId('voice-models-speech')).getAllByTestId('model-row')).toHaveLength(2);
    // Nothing ticked yet: no lend
    expect((within(dialog).getByRole('button', { name: 'Lend' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Eleven v3' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Scribe v1' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lend' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/me/voice-keys/vk-1/lend', expect.objectContaining({ body: JSON.stringify({ universeId: 'u-2', models: ['speech:eleven_v3', 'recognition:scribe_v1'] }) })),
    );
  });

  it('changes the models of a lend, shown as their names', async () => {
    const limited = { ...voiceKey, lentTo: [{ ...voiceKey.lentTo[0], models: ['speech:eleven_flash_v2_5', 'recognition:scribe_v1'] }] };
    answer({ voice: [limited] });
    render(<AiKeysPage />);
    expect((await screen.findByTestId('lent-models')).textContent).toContain('Only Eleven Flash v2.5, Scribe v1');
    fireEvent.click(screen.getByTestId('lent-edit-models'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: 'Scribe v1' }).getAttribute('aria-checked')).toBe('true');
    expect(within(dialog).getByRole('checkbox', { name: 'Eleven v3' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/me/voice-keys/vk-1/lend', expect.objectContaining({ body: JSON.stringify({ universeId: 'u-1', models: ['speech:eleven_flash_v2_5', 'recognition:scribe_v1'], existing: true }) })),
    );
  });
});

describe('the You card', () => {
  it('counts voice keys too, and their voice replies in the month', async () => {
    answer({ text: [claude], voice: [voiceKey] });
    render(<AiKeysCard />);
    const status = await screen.findByTestId('ai-keys-card-status');
    expect(status.textContent).toBe('All working');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('2');
    expect(screen.getByText('598 replies on your keys this month')).toBeTruthy();
    expect(within(screen.getAllByTestId('ai-keys-card-key')[1]).getByText('Lent to Sandbox Universe · 1 bot')).toBeTruthy();
  });

  it('turns amber and says what the bots do when a voice key is down', async () => {
    answer({ text: [claude], voice: [down] });
    render(<AiKeysCard />);
    expect((await screen.findByTestId('ai-keys-card-status')).textContent).toBe('1 down');
    expect(screen.getByTestId('ai-keys-card').className).toContain('border-[rgb(245_196_81/0.55)]');
    const [first] = screen.getAllByTestId('ai-keys-card-key');
    expect(first.textContent).toContain('My ElevenLabs');
    expect(first.textContent).toMatch(/Out of credit since .*\. Sales Researcher replies in text until it’s back\./);
  });

  it('shows a voice key alone: the count and the logo slot', async () => {
    answer({ voice: [voiceKey] });
    render(<AiKeysCard />);
    expect((await screen.findByTestId('ai-keys-card-status')).textContent).toBe('Working');
    expect(screen.getAllByTestId('provider-logo')).toHaveLength(1);
  });
});
