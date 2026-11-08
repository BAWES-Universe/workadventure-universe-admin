/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** Add a key (#374, two steps since #575): pick a provider, then set it up: load its models (which proves it answers), pick one, add. */

const fetchMock = jest.fn();
const push = jest.fn();
// The speech companies the server offers for voice (#749): none unless a test sets them. Reading them is not one of the calls the tests count.
let voiceCompanies: unknown[] = [];
// How many reads of the companies fail before one answers
let voiceCompaniesFailing = 0;
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (url: string, ...rest: unknown[]) => {
    if (url !== '/api/me/voice-keys' || (rest[0] as { method?: string } | undefined)?.method) return fetchMock(url, ...rest);
    if (voiceCompaniesFailing > 0) {
      voiceCompaniesFailing -= 1;
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ keys: [], companies: voiceCompanies }) });
  },
}));
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: jest.fn() }) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push, back: jest.fn() }) }));
let inGame = false;
const openLinkInGame = jest.fn();
jest.mock('@/app/admin/components/orbit-bridge', () => ({
  useLinksOpeningInGame: (urls: string[]) => new Set(inGame ? urls : []),
  openLinkInGame: (url: string) => openLinkInGame(url),
}));

import AddAiKeyPage from '@/app/admin/you/ai-keys/new/page';

function json(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });
}

const addButton = () => screen.getByRole('button', { name: 'Add key' });
/** Step 2's Change: back to the provider list, with the pick kept. */
const change = () => fireEvent.click(screen.getByRole('button', { name: 'Change' }));

beforeEach(() => {
  fetchMock.mockReset();
  voiceCompanies = [];
  voiceCompaniesFailing = 0;
  push.mockReset();
  inGame = false;
  openLinkInGame.mockReset().mockReturnValue(true);
});

describe('Add a key', () => {
  it('starts on step 1: the types in two groups, none picked, and nothing to fill in yet', () => {
    render(<AddAiKeyPage />);
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Pick a provider' })).toBeTruthy();
    expect(screen.getByText('On your own computer')).toBeTruthy();
    expect(screen.getByText('Hosted, with an API key')).toBeTruthy();
    for (const label of ['LM Studio', 'Ollama or llama.cpp', 'OpenRouter', 'Gemini', 'NVIDIA NIM', 'OpenAI', 'DeepSeek']) {
      expect(screen.getByRole('radio', { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
    expect(screen.queryByLabelText('Address')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add key' })).toBeNull();
  });

  it('goes to step 2 once a provider is picked, with the picked row and its numbered parts', () => {
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Claude/ }));
    expect(screen.getByText('Step 2 of 2')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Set up Claude' })).toBeTruthy();
    expect(within(screen.getByTestId('picked-provider')).getByText('Claude')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^Gemini/ })).toBeNull();
    ['Get your Claude key', 'Paste your key', 'Its models', 'Name it'].forEach((part, index) => {
      expect(screen.getByRole('heading', { name: part }).textContent).toBe(`${index + 1}${part}`);
    });
    // Read about sits inside the setup card, never outside it
    expect(within(screen.getByTestId('setup-card')).getByRole('link', { name: /Read about Claude/ })).toBeTruthy();
    change();
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^Claude/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('moves between the steps the same way both ways: back to the top, with focus on the step’s heading', () => {
    const scroll = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Claude/ }));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Set up Claude' }));
    change();
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Pick a provider' }));
    scroll.mockRestore();
  });

  it('clears the typed key and address when another provider is picked, and keeps them for the same one', () => {
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^LM Studio/ }));
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://lm.example.com' } });
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'lm-secret' } });
    change();
    fireEvent.click(screen.getByRole('radio', { name: /^LM Studio/ }));
    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe('https://lm.example.com');
    expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe('lm-secret');
    change();
    fireEvent.click(screen.getByRole('radio', { name: /^Ollama/ }));
    expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe('');
  });

  it('opens the setup steps of the picked type, with the command to copy', () => {
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /LM Studio/ }));
    expect(screen.getByText('cloudflared tunnel --url http://localhost:1234')).toBeTruthy();
    expect(screen.getByLabelText('Address')).toBeTruthy();
    expect(screen.getByLabelText('API key, if your server asks for one')).toBeTruthy();
    change();
    fireEvent.click(screen.getByRole('radio', { name: /Gemini/ }));
    expect(screen.queryByText(/cloudflared/)).toBeNull();
    expect(screen.queryByLabelText('Address')).toBeNull();
    expect(screen.getByText('On aistudio.google.com, choose Get API key.')).toBeTruthy();
  });

  it('keeps Add key off until the models loaded, then adds with no model picked and goes back to the list (#575)', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/models') ? json({ ok: true, models: ['gemma-3-12b', 'qwen3-8b'] }) : json({ id: 'key-new' }),
    );
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /LM Studio/ }));
    expect((screen.getByRole('button', { name: /Load models/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://lm.example.com' } });
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered. LM Studio has 2 models./);
    // The list is to look at: nothing to pick
    expect(screen.getAllByTestId('model-row').map((row) => row.textContent)).toEqual(['gemma-3-12b', 'qwen3-8b']);
    expect(screen.queryByRole('radio', { name: 'qwen3-8b' })).toBeNull();
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/you/ai-keys'));
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(init.body)).toEqual({ kind: 'lmstudio', address: 'https://lm.example.com', apiKey: '', name: 'My LM Studio' });
  });

  it('asks for the model name when the provider has no model list, and adds it as typed (#456)', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/models') ? json({ ok: false, noList: true, message: 'Groq doesn’t share a list of its models. Type the model name.' }) : json({ id: 'key-new' }),
    );
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /Groq/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'gsk-1234' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    const field = await screen.findByLabelText('Model name');
    expect(screen.queryByRole('alert')).toBeNull();
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: ' llama-3.3-70b ' } });
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/you/ai-keys'));
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ kind: 'groq', apiKey: 'gsk-1234', model: 'llama-3.3-70b' });
  });

  it('drops a slow answer for a provider that was switched away from', async () => {
    let answerGroq: (value: unknown) => void = () => undefined;
    fetchMock.mockImplementation((_url: string, init: { body: string }) =>
      JSON.parse(init.body).kind === 'groq' ? new Promise((resolve) => { answerGroq = resolve; }) : json({ ok: true, models: ['a', 'b'] }),
    );
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /Groq/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'gsk-1234' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    change();
    fireEvent.click(screen.getByRole('radio', { name: /Gemini/ }));
    answerGroq(await json({ ok: false, noList: true, message: 'x' }));
    await waitFor(() => expect(screen.queryByLabelText('Model name')).toBeNull());
    expect(screen.queryByText(/It answered/)).toBeNull();
  });

  it('shows no model name field for a provider that has a list', async () => {
    fetchMock.mockImplementation(() => json({ ok: true, models: ['a', 'b'] }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /Gemini/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'k-1234' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered/);
    expect(screen.queryByLabelText('Model name')).toBeNull();
  });

  it('says why the models did not load, and keeps Add key off', async () => {
    fetchMock.mockImplementation(() => json({ ok: false, message: 'That address points to a private network, so Universe can’t reach it.' }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /Ollama/ }));
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://nas.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/private network/);
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('forgets the loaded models as soon as the key or address changes', async () => {
    fetchMock.mockImplementation(() => json({ ok: true, models: ['gemini-flash-latest', 'gemini-pro-latest'] }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /Gemini/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'AIza-first' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered/);
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'AIza-second' } });
    expect(screen.queryByTestId('model-picker')).toBeNull();
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('searches a long list of models', async () => {
    const many = Array.from({ length: 40 }, (_, index) => `model-${String(index).padStart(2, '0')}`);
    fetchMock.mockImplementation(() => json({ ok: true, models: many }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /OpenRouter/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-or-123' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    const search = await screen.findByLabelText('Search OpenRouter models');
    expect(screen.getAllByTestId('model-row')).toHaveLength(40);
    fireEvent.change(search, { target: { value: 'model-3' } });
    expect(screen.getAllByTestId('model-row')).toHaveLength(10);
    expect(screen.getByText('10 models')).toBeTruthy();
  });

  it('finds a maker’s models by its name, also ones whose id doesn’t carry it', async () => {
    const fillers = Array.from({ length: 30 }, (_, index) => `acme/model-${index}`);
    fetchMock.mockImplementation(() => json({ ok: true, models: ['gpt-5-mini', 'o4-mini', 'llama-3.3-70b', 'nousresearch/hermes-4-70b', 'mystery-7b', ...fillers] }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /OpenRouter/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-or-123' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    const search = await screen.findByLabelText('Search OpenRouter models');
    fireEvent.change(search, { target: { value: 'meta' } });
    expect(screen.getAllByTestId('model-row').map((row) => row.textContent)).toEqual(['llama-3.3-70b']);
    fireEvent.change(search, { target: { value: 'nous research' } });
    expect(screen.getAllByTestId('model-row').map((row) => row.textContent)).toEqual(['hermes-4-70b']);
    // A model with no known maker isn't found by "other"
    fireEvent.change(search, { target: { value: 'other' } });
    expect(screen.queryAllByTestId('model-row')).toHaveLength(0);
  });

  it('groups a list from many makers, folded, with the biggest makers first and the rest behind Show all', async () => {
    const makers = ['openai', 'google', 'meta-llama', 'mistralai', 'qwen', 'deepseek', 'moonshotai', 'x-ai', 'z-ai', 'nvidia'];
    const many = makers.flatMap((maker, index) => Array.from({ length: makers.length - index }, (_, n) => `${maker}/model-${n}`));
    fetchMock.mockImplementation(() => json({ ok: true, models: many }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /OpenRouter/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-or-123' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(`It answered. OpenRouter has ${many.length} models from 10 makers.`);
    const makerRows = screen.getAllByTestId('maker-row');
    expect(makerRows).toHaveLength(8);
    expect(makerRows[0].textContent).toContain('OpenAI');
    expect(makerRows[0].textContent).toContain('10 models');
    expect(screen.queryAllByTestId('model-row')).toHaveLength(0);
    fireEvent.click(makerRows[0]);
    expect(screen.getAllByTestId('model-row').map((row) => row.textContent)[0]).toBe('model-0');
    fireEvent.click(screen.getByRole('button', { name: 'Show all 10 makers' }));
    expect(screen.getAllByTestId('maker-row')).toHaveLength(10);
    // A search shows what matches, makers and all
    fireEvent.change(screen.getByLabelText('Search OpenRouter models'), { target: { value: 'nvidia' } });
    expect(screen.getAllByTestId('model-row')).toHaveLength(1);
  });

  it('shows what the server said when adding fails, and stays here', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/models') ? json({ ok: true, models: ['gemini-flash-latest'] }) : json({ error: 'You can have up to 10 keys. Revoke one you don’t use.' }, false),
    );
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /Gemini/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'AIza-x' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered/);
    // One model: it is the picked one already.
    fireEvent.click(addButton());
    expect(await screen.findByText('You can have up to 10 keys. Revoke one you don’t use.')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('Add a key: more providers, regions and search', () => {
  it('lists the added providers, and filters them as you type, keeping the picked one on screen', () => {
    render(<AddAiKeyPage />);
    for (const label of ['vLLM', 'Any OpenAI-compatible server', 'Qwen', 'Kimi', 'GLM \\(Z.ai\\)', 'xAI', 'Mistral', 'Groq', 'Together AI', 'Fireworks AI', 'DeepInfra', 'Cerebras', 'Hugging Face', 'Vercel AI Gateway']) {
      expect(screen.getByRole('radio', { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('radio', { name: /^Groq/ }));
    change();
    fireEvent.change(screen.getByLabelText('Search providers'), { target: { value: 'mistral' } });
    expect(screen.getByRole('radio', { name: /^Mistral/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^Groq/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^Cerebras/ })).toBeNull();
  });

  it('puts a logo or icon slot before every provider, with the radio at the end of the row', () => {
    render(<AddAiKeyPage />);
    for (const radio of screen.getAllByRole('radio')) {
      expect(within(radio).getAllByTestId('provider-logo')).toHaveLength(1);
      expect(radio.firstElementChild?.getAttribute('data-testid')).toBe('provider-logo');
    }
  });

  it('shows the line from the models.dev numbers under a More provider and never says it is untried', () => {
    render(<AddAiKeyPage />);
    fireEvent.change(screen.getByLabelText('Search providers'), { target: { value: 'baseten' } });
    const card = screen.getByRole('radio', { name: /^Baseten/ });
    expect(within(card).getByText('26 models, all open.')).toBeTruthy();
    fireEvent.click(card);
    expect(screen.queryByText(/tried/)).toBeNull();
  });

  it('numbers the steps only when there are two or more', () => {
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Gemini/ }));
    expect(screen.getByText('On aistudio.google.com, choose Get API key.')).toBeTruthy();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    change();
    fireEvent.click(screen.getByRole('radio', { name: /^Claude/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    change();
    fireEvent.change(screen.getByLabelText('Search providers'), { target: { value: 'baseten' } });
    fireEvent.click(screen.getByRole('radio', { name: /^Baseten/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('says so, and points to Any OpenAI-compatible, when nothing matches', () => {
    render(<AddAiKeyPage />);
    fireEvent.change(screen.getByLabelText('Search providers'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No provider matches that/)).toBeTruthy();
  });

  it('asks for a region on Qwen, Kimi and GLM, keeps Load models off until one is picked, and sends it', async () => {
    fetchMock.mockImplementation(() => json({ ok: true, models: ['kimi-k2'] }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Kimi/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-1' } });
    expect((screen.getByRole('button', { name: /Load models/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /^China/ }));
    expect(screen.getByText('A key only works in the region it was made in.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ kind: 'kimi', region: 'china' });
  });

  it('forgets the region when another type is picked', () => {
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Qwen/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Global/ }));
    change();
    fireEvent.click(screen.getByRole('radio', { name: /^Kimi/ }));
    expect(screen.getByRole('radio', { name: /^Global/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('keeps the region when the picked type is clicked again', () => {
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Qwen/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Global/ }));
    change();
    fireEvent.click(screen.getByRole('radio', { name: /^Qwen/ }));
    expect(screen.getByRole('radio', { name: /^Global/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the loaded models when the picked region is clicked again', async () => {
    fetchMock.mockImplementation(() => json({ ok: true, models: ['qwen-plus', 'qwen-max'] }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Qwen/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Global/ }));
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered/);
    fireEvent.click(screen.getByRole('radio', { name: /^Global/ }));
    expect(screen.getByText(/It answered/)).toBeTruthy();
  });

  it('shows no region for a provider that has one address', () => {
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Mistral/ }));
    expect(screen.queryByRole('radiogroup', { name: 'Region' })).toBeNull();
  });
});

describe('Add a key: a model with no Tools', () => {
  it('marks a model the provider says has no Tools, and nothing for one it said nothing about', async () => {
    fetchMock.mockImplementation(() => json({ ok: true, models: ['big-model', 'tiny-chat'], facts: { 'tiny-chat': { tools: false } } }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^LM Studio/ }));
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://lm.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered/);
    const [big, tiny] = screen.getAllByTestId('model-row');
    expect(big.textContent).toBe('big-model');
    expect(tiny.textContent).toBe('tiny-chatNo tools');
    // The mark does not stop Add key
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('Add a key: More providers', () => {
  it('keeps the long tail out of sight until asked for, with a count', () => {
    render(<AddAiKeyPage />);
    expect(screen.queryByText('More providers', { selector: 'h3' })).toBeNull();
    expect(screen.queryByRole('radio', { name: /^Nebius/ })).toBeNull();
    const button = screen.getByRole('button', { name: /^More providers \(\d+\)$/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(screen.getByText('More providers', { selector: 'h3' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^Nebius/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show fewer providers' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('finds one by searching, without opening the list, and shows how to get a key and where to read more', () => {
    render(<AddAiKeyPage />);
    fireEvent.change(screen.getByLabelText('Search providers'), { target: { value: 'nebius' } });
    fireEvent.click(screen.getByRole('radio', { name: /^Nebius/ }));
    expect(screen.getByText(/^Open Nebius.* dashboard and sign in\.$/)).toBeTruthy();
    const docs = screen.getByRole('link', { name: /Read about Nebius/ });
    expect(docs.getAttribute('href')).toMatch(/^https:\/\//);
    expect(docs.getAttribute('rel')).toContain('noreferrer');
    // The link sits in step 2's setup card, never in the picked provider's row
    expect(screen.getByTestId('setup-card').contains(docs)).toBe(true);
    expect(screen.getByTestId('picked-provider').contains(docs)).toBe(false);
  });

  it('opens "Read about" in the game window on a plain click when the game can show it, and drops the new-tab icon (#571)', () => {
    inGame = true;
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Claude/ }));
    const docs = screen.getByTestId('read-about');
    expect(docs.querySelector('svg')).toBeNull();
    fireEvent.click(docs);
    expect(openLinkInGame).toHaveBeenCalledWith(docs.getAttribute('href'));
    // a Ctrl, Cmd, Shift or middle click still gets its own tab
    fireEvent.click(docs, { ctrlKey: true });
    fireEvent.click(docs, { metaKey: true });
    fireEvent.click(docs, { shiftKey: true });
    fireEvent.click(docs, { button: 1 });
    expect(openLinkInGame).toHaveBeenCalledTimes(1);
  });

  it('keeps "Read about" as a new tab, with its icon, outside the game', () => {
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Claude/ }));
    const docs = screen.getByTestId('read-about');
    expect(docs.querySelector('svg')).not.toBeNull();
    expect(docs.getAttribute('target')).toBe('_blank');
    fireEvent.click(docs);
    expect(openLinkInGame).not.toHaveBeenCalled();
  });

  it('searches the line under a long-tail provider as well as its name', () => {
    render(<AddAiKeyPage />);
    fireEvent.change(screen.getByLabelText('Search providers'), { target: { value: 'its own' } });
    expect(screen.getByRole('radio', { name: /^Morph/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /^Nebius/ })).toBeNull();
  });

  it('adds one of them like any other: same request, its own kind', async () => {
    fetchMock.mockImplementation((url: string) => (url.endsWith('/models') ? json({ ok: true, models: ['m-1'], facts: {} }) : json({ id: 'key-new' })));
    render(<AddAiKeyPage />);
    fireEvent.change(screen.getByLabelText('Search providers'), { target: { value: 'nebius' } });
    fireEvent.click(screen.getByRole('radio', { name: /^Nebius/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered/);
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/you/ai-keys'));
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toEqual({ kind: 'nebius', address: '', apiKey: 'sk-1', name: 'My Nebius Token Factory' });
  });
});

describe('Add a key: what the models can do', () => {
  it('shows Vision only next to the image model, and adds the key with no model picked', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/models')
        ? json({ ok: true, models: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'], facts: { 'deepseek-v4-flash': { vision: false }, 'deepseek-v4-flash-vision-exp': { vision: true }, 'deepseek-v4-pro': { vision: false } } })
        : json({ id: 'key-new' }),
    );
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^DeepSeek/ }));
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered/);
    expect(screen.getAllByTestId('model-row').map((row) => row.textContent)).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash-vision-expVision', 'deepseek-v4-pro']);
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalled());
    const add = fetchMock.mock.calls.find((call) => !String(call[0]).endsWith('/models'))!;
    expect(JSON.parse(add[1].body)).not.toHaveProperty('model');
  });

  it('says once what every model has, instead of on each row', async () => {
    fetchMock.mockImplementation(() => json({ ok: true, models: ['claude-haiku-5-5', 'claude-opus-5-5'], facts: { 'claude-haiku-5-5': { vision: true }, 'claude-opus-5-5': { vision: true } } }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Claude/ }));
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-ant-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered/);
    expect(screen.getByText(/All 2 have/).textContent).toBe('All 2 have Vision');
    expect(screen.getAllByTestId('model-row').map((row) => row.textContent)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
  });

  it('says nothing more on a maker’s row when the whole list already said it', async () => {
    const models = ['openai/gpt-5', 'openai/gpt-5-mini', 'google/gemini-3-pro'];
    fetchMock.mockImplementation(() => json({ ok: true, models, facts: Object.fromEntries(models.map((id) => [id, { vision: true }])) }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /OpenRouter/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-or-123' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered/);
    expect(screen.getByText(/All 3 have/).textContent).toBe('All 3 have Vision');
    expect(screen.getAllByTestId('maker-row').map((row) => row.textContent)).toEqual(['OpenAI2 models', 'Google1 model']);
  });
});

describe('Add a key: Claude', () => {
  it('is one of the hosted types, with its steps, a key box and no address', () => {
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Claude/ }));
    expect(screen.getByText('On console.anthropic.com, open API keys and create a key.')).toBeTruthy();
    expect(screen.getByText('Add some credit to the account first: a key with no credit can’t reply.')).toBeTruthy();
    expect(screen.queryByLabelText('Address')).toBeNull();
    expect(screen.getByLabelText('API key')).toBeTruthy();
  });

  it('loads Claude’s models, sending the kind and key, and adds the key', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/models') ? json({ ok: true, models: ['claude-haiku-4-5', 'claude-opus-5-5'], facts: {} }) : json({ id: 'key-new' }),
    );
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Claude/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-api03-abcd' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered. Claude has 2 models./);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ kind: 'claude', apiKey: 'sk-ant-api03-abcd' });
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ kind: 'claude', address: '', apiKey: 'sk-ant-api03-abcd', name: 'My Claude' });
  });
});

describe('Add a key for voice', () => {
  const company = (adapter: string, label: string, extra: Record<string, unknown> = {}) => ({
    adapter,
    label,
    recognition: true,
    speech: true,
    logo: null,
    benefit: `Listens and speaks. About ${label}.`,
    step: `On ${adapter}.example.com, create a key.`,
    docs: `https://${adapter}.example.com/docs`,
    ...extra,
  });
  const models = [
    { id: 'scribe_v1', label: 'Scribe v1', kind: 'recognition' },
    { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5', kind: 'speech' },
    { id: 'eleven_v3', kind: 'speech' },
  ];

  it('lists the companies under their own heading below the hosted providers, with their logos, and the heading is hidden when there are none', async () => {
    voiceCompanies = [company('elevenlabs', 'ElevenLabs', { logo: 'elevenlabs' }), company('cartesia', 'Cartesia')];
    const { unmount } = render(<AddAiKeyPage />);
    const group = await screen.findByTestId('kinds-voice');
    expect(within(group).getByRole('heading', { name: 'For voice, with an API key' })).toBeTruthy();
    expect(within(group).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      expect.stringContaining('ElevenLabs'),
      expect.stringContaining('Cartesia'),
    ]);
    expect(within(group).getAllByTestId('provider-logo')).toHaveLength(2);
    // One line on how many keys a bot's voice needs (#1911)
    expect(within(group).getByTestId('voice-one-key-hint').textContent).toBe(
      'A company that listens and speaks needs one key for a bot’s whole voice. You can also mix: one company listens, another speaks.',
    );
    const hosted = screen.getByText('Hosted, with an API key');
    expect(hosted.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
    voiceCompanies = [];
    render(<AddAiKeyPage />);
    await waitFor(() => expect(screen.queryByTestId('kinds-voice')).toBeNull());
    expect(screen.queryByText('For voice, with an API key')).toBeNull();
  });

  it('says the voice companies could not be loaded, with the same Try again as the keys page, and lists them once it works', async () => {
    voiceCompanies = [company('elevenlabs', 'ElevenLabs')];
    voiceCompaniesFailing = 1;
    render(<AddAiKeyPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('We couldn’t load the voice companies.');
    // The providers are still there to pick while the voice companies are missing
    expect(screen.getByRole('radio', { name: /^Claude/ })).toBeTruthy();
    expect(screen.queryByTestId('kinds-voice')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(await screen.findByTestId('kinds-voice')).findByRole('radio', { name: /^ElevenLabs/ })).toBeTruthy();
    expect(screen.queryByText(/We couldn’t load the voice companies/)).toBeNull();
  });

  it('sets a company up like a provider: get the key, paste it, load models, see what it listens and speaks, name it', async () => {
    voiceCompanies = [company('elevenlabs', 'ElevenLabs')];
    render(<AddAiKeyPage />);
    fireEvent.click(await screen.findByRole('radio', { name: /^ElevenLabs/ }));
    expect(screen.getByRole('heading', { name: 'Set up ElevenLabs' })).toBeTruthy();
    ['Get your ElevenLabs key', 'Paste your key', 'Its models', 'Name it'].forEach((part, index) => {
      expect(screen.getByRole('heading', { name: part }).textContent).toBe(`${index + 1}${part}`);
    });
    const card = screen.getByTestId('setup-card');
    expect(card.textContent).toContain('On elevenlabs.example.com, create a key.');
    expect(within(card).getByRole('link', { name: /Read about ElevenLabs/ }).getAttribute('href')).toBe('https://elevenlabs.example.com/docs');
    // No address, no regions
    expect(screen.queryByLabelText('Address')).toBeNull();
    expect((screen.getByRole('button', { name: 'Load models' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-elevenlabs-key' } });
    fetchMock.mockImplementation(() => json({ ok: true, models }));
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    expect(await screen.findByText(/It answered\. ElevenLabs has 3 models\./)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/me/voice-keys/check', expect.objectContaining({ method: 'POST', body: JSON.stringify({ adapter: 'elevenlabs', apiKey: 'sk-elevenlabs-key' }) }));
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/me/ai-keys/models')).toBe(false);
    expect(screen.getByText(/Nothing to pick here\. Each bot picks one of these on its own page/)).toBeTruthy();
    // A key that listens and speaks is all a bot needs, and it can still be split on the bot (#1911)
    expect(screen.getByTestId('voice-one-key').textContent).toBe(
      'This key listens and speaks, so it’s all a bot needs. On a bot’s Voice row you can still split: listen with one company, speak with another.',
    );
    expect(within(screen.getByTestId('voice-models-recognition')).getByText('Scribe v1')).toBeTruthy();
    // A model with no label is shown by its id
    expect(within(screen.getByTestId('voice-models-speech')).getAllByTestId('model-row').map((row) => row.textContent)).toEqual(['Eleven Flash v2.5', 'eleven_v3']);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My ElevenLabs');
    expect(screen.getByText('Shown here, and under Voice for the bots that use it.')).toBeTruthy();
  });

  it('asks an Azure key for its endpoint, checks the key there, then takes the deployment name as its one talking model', async () => {
    const account = {
      address: { label: 'Endpoint', example: 'https://your-resource.openai.azure.com', hint: 'From Keys and Endpoint on your resource.' },
      typedModel: { title: 'Name its deployment', label: 'Deployment name', hint: 'The name you gave the gpt-realtime deployment.', kind: 'talk' },
    };
    voiceCompanies = [company('azure', 'Azure OpenAI', { recognition: false, speech: false, talk: true, account })];
    render(<AddAiKeyPage />);
    fireEvent.click(await screen.findByRole('radio', { name: /^Azure OpenAI/ }));
    const endpoint = screen.getByLabelText('Endpoint') as HTMLInputElement;
    expect(endpoint.placeholder).toBe('https://your-resource.openai.azure.com');
    expect(screen.getByText('From Keys and Endpoint on your resource.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'azure-key-123456' } });
    // No check without the endpoint
    expect((screen.getByRole('button', { name: 'Check key' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(endpoint, { target: { value: 'https://my-res.openai.azure.com' } });
    fetchMock.mockImplementation((url: string) => (url === '/api/me/voice-keys/check' ? json({ ok: true, models: [], typed: true }) : json({ key: { id: 'vk-new' } })));
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }));
    expect(await screen.findByText(/It answered\. Azure OpenAI took the key\./)).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ adapter: 'azure', apiKey: 'azure-key-123456', address: 'https://my-res.openai.azure.com' });
    expect(screen.getByRole('heading', { name: /Name its deployment/ })).toBeTruthy();
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Deployment name'), { target: { value: 'realtime-prod' } });
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/you/ai-keys'));
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('/api/me/voice-keys');
    expect(JSON.parse(init.body)).toEqual({
      adapter: 'azure',
      name: 'My Azure OpenAI',
      apiKey: 'azure-key-123456',
      endpoint: 'https://my-res.openai.azure.com',
      recognition: true,
      speech: true,
      models: [{ id: 'realtime-prod', label: 'realtime-prod', kind: 'talk' }],
    });
  });

  it('asks an AWS key for its region, its access key ID and its secret, and sends the key as one, in that region', async () => {
    const account = {
      regions: [
        { id: 'us-east-1', label: 'US East (N. Virginia)', host: 'bedrock-runtime.us-east-1.amazonaws.com' },
        { id: 'eu-north-1', label: 'Europe (Stockholm)', host: 'bedrock-runtime.eu-north-1.amazonaws.com' },
      ],
      keyId: { label: 'Access key ID', example: 'AKIA…', hint: 'It starts with AKIA.' },
      keyLabel: 'Secret access key',
    };
    const nova = [{ id: 'amazon.nova-2-sonic-v1:0', label: 'Nova 2 Sonic', kind: 'talk' }];
    voiceCompanies = [company('aws', 'AWS', { recognition: false, speech: false, talk: true, account })];
    render(<AddAiKeyPage />);
    fireEvent.click(await screen.findByRole('radio', { name: /^AWS/ }));
    expect(screen.getByRole('heading', { name: /Pick the region/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Paste your access key/ })).toBeTruthy();
    expect((screen.getByLabelText('Access key ID') as HTMLInputElement).placeholder).toBe('AKIA…');
    fireEvent.change(screen.getByLabelText('Access key ID'), { target: { value: ' AKIAIOSFODNN7EXAMPLE ' } });
    fireEvent.change(screen.getByLabelText('Secret access key'), { target: { value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' } });
    // No check without the region
    expect((screen.getByRole('button', { name: 'Load models' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Europe \(Stockholm\)/ }));
    fetchMock.mockImplementation((url: string) => (url === '/api/me/voice-keys/check' ? json({ ok: true, models: nova }) : json({ key: { id: 'vk-new' } })));
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await screen.findByText(/It answered/);
    // A talking model can't be split between two companies on a bot, so the page doesn't offer that
    expect(screen.getByTestId('voice-one-key').textContent).toBe('This key talks live, so it’s all a bot needs. A bot on it listens and speaks with the same model.');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ adapter: 'aws', apiKey: 'AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'eu-north-1' });
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/you/ai-keys'));
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('/api/me/voice-keys');
    expect(JSON.parse(init.body)).toEqual({
      adapter: 'aws',
      name: 'My AWS',
      apiKey: 'AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      recognition: true,
      speech: true,
      models: nova,
      region: 'eu-north-1',
    });
  });

  it('asks an Azure AI Speech key for the region its resource is in, says why, and checks the key there (#1875)', async () => {
    const account = {
      regions: [
        { id: 'eastus', label: 'East US', host: 'eastus.tts.speech.microsoft.com' },
        { id: 'uaenorth', label: 'UAE North', host: 'uaenorth.tts.speech.microsoft.com' },
      ],
      regionHint: 'Pick the region your Speech resource is in. Azure shows it as Location/Region next to the key, and the key only works there.',
    };
    const speech = [{ id: 'azure-stt', label: 'Real-time speech to text', kind: 'recognition' }, { id: 'azure-tts', label: 'Text to speech', kind: 'speech' }];
    voiceCompanies = [company('azure-speech', 'Azure AI Speech', { account })];
    render(<AddAiKeyPage />);
    fireEvent.click(await screen.findByRole('radio', { name: /^Azure AI Speech/ }));
    expect(screen.getByRole('heading', { name: /Pick the region/ })).toBeTruthy();
    expect(screen.getByText(account.regionHint)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'azure-speech-key-123456' } });
    expect((screen.getByRole('button', { name: 'Load models' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /UAE North/ }));
    fetchMock.mockImplementation((url: string) => (url === '/api/me/voice-keys/check' ? json({ ok: true, models: speech }) : json({ key: { id: 'vk-new' } })));
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await screen.findByText(/It answered/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ adapter: 'azure-speech', apiKey: 'azure-speech-key-123456', region: 'uaenorth' });
  });

  it('adds a voice key with what it listens and speaks, then goes back to the AI keys page', async () => {
    voiceCompanies = [company('elevenlabs', 'ElevenLabs')];
    render(<AddAiKeyPage />);
    fireEvent.click(await screen.findByRole('radio', { name: /^ElevenLabs/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-elevenlabs-key' } });
    fetchMock.mockImplementation((url: string) => (url === '/api/me/voice-keys/check' ? json({ ok: true, models }) : json({ key: { id: 'vk-new' } })));
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await screen.findByText(/It answered/);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Studio voice' } });
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/you/ai-keys'));
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('/api/me/voice-keys');
    expect(JSON.parse(init.body)).toEqual({ adapter: 'elevenlabs', name: 'Studio voice', apiKey: 'sk-elevenlabs-key', recognition: true, speech: true, models });
  });

  it('sets only the job the models listed (a company that only listens)', async () => {
    voiceCompanies = [company('soniox', 'Soniox', { speech: false })];
    render(<AddAiKeyPage />);
    fireEvent.click(await screen.findByRole('radio', { name: /^Soniox/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'soniox-key-12345' } });
    fetchMock.mockImplementation((url: string) => (url === '/api/me/voice-keys/check' ? json({ ok: true, models: [models[0]] }) : json({ key: { id: 'vk-new' } })));
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    expect(await screen.findByText(/It answered\. Soniox has 1 model\./)).toBeTruthy();
    expect(screen.queryByTestId('voice-models-speech')).toBeNull();
    expect(screen.queryByTestId('voice-one-key')).toBeNull();
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ adapter: 'soniox', recognition: true, speech: false });
  });

  it('says plainly when the company refuses the key or can’t be reached, and keeps Add key off', async () => {
    voiceCompanies = [company('deepgram', 'Deepgram')];
    render(<AddAiKeyPage />);
    fireEvent.click(await screen.findByRole('radio', { name: /^Deepgram/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'dg-key-123456' } });
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 422, json: () => Promise.resolve({ error: 'Deepgram didn’t accept that key. Check it and paste it again.' }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Deepgram didn’t accept that key. Check it and paste it again.');
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ error: 'Couldn’t reach Deepgram. Try again in a moment.' }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Couldn’t reach Deepgram. Try again in a moment.'));
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('forgets the loaded models when the key changes, and never sends a key typed for another provider', async () => {
    voiceCompanies = [company('elevenlabs', 'ElevenLabs')];
    render(<AddAiKeyPage />);
    fireEvent.click(await screen.findByRole('radio', { name: /^ElevenLabs/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-elevenlabs-key' } });
    fetchMock.mockImplementation(() => json({ ok: true, models }));
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await screen.findByText(/It answered/);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-another-key' } });
    expect(screen.queryByText(/It answered/)).toBeNull();
    expect(screen.queryByTestId('voice-models-speech')).toBeNull();
    change();
    fireEvent.click(screen.getByRole('radio', { name: /^Claude/ }));
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
  });
});

describe('Add a key for your own speech server', () => {
  const own = {
    adapter: 'openai-compatible',
    label: 'Any OpenAI-compatible speech server',
    recognition: true,
    speech: true,
    logo: null,
    benefit: 'Speaches, Kokoro-FastAPI, your own Whisper: anything that answers /v1/audio.',
    step: '',
    docs: '',
    ownServer: {
      steps: [
        { text: 'Start the server. Speaches listens and speaks (port 8000); Kokoro-FastAPI speaks (port 8880). For Speaches:', code: 'docker run -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu' },
        { text: 'Make it reachable from the web. Run (use 8880 for Kokoro-FastAPI):', code: 'cloudflared tunnel --url http://localhost:8000' },
        { text: 'Paste the https address it prints below, and a key if the server asks for one.' },
      ],
    },
  };
  const hosted = { adapter: 'elevenlabs', label: 'ElevenLabs', recognition: true, speech: true, logo: null, benefit: 'Listens and speaks. About ElevenLabs.', step: 'On elevenlabs.example.com, create a key.', docs: 'https://elevenlabs.example.com/docs' };
  const pickOwn = async () => {
    voiceCompanies = [hosted, own];
    render(<AddAiKeyPage />);
    fireEvent.click(await screen.findByRole('radio', { name: /^Any OpenAI-compatible speech server/ }));
  };
  const load = async (answer: unknown, ok = true) => {
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://speech.example.com' } });
    fetchMock.mockImplementation((url: string) => (url === '/api/me/voice-keys/check' ? json(answer, ok) : json({ key: { id: 'vk-new' } })));
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
  };

  it('has its own group above the voice companies, and it is not listed among them', async () => {
    voiceCompanies = [hosted, own];
    render(<AddAiKeyPage />);
    const group = await screen.findByTestId('kinds-own-speech');
    expect(within(group).getByRole('heading', { name: 'For voice, on your own computer' })).toBeTruthy();
    expect(within(group).getAllByRole('radio')).toHaveLength(1);
    expect(within(screen.getByTestId('kinds-voice')).queryByRole('radio', { name: /OpenAI-compatible/ })).toBeNull();
    expect(group.compareDocumentPosition(screen.getByTestId('kinds-voice')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing recommends it
    expect(screen.queryByText(/Recommended/i)).toBeNull();
  });

  it('is set up like a chat server: its commands, an https address, an optional key, and a default name', async () => {
    await pickOwn();
    expect(screen.getByRole('heading', { name: 'Start your server' })).toBeTruthy();
    expect(screen.getByText('docker run -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu')).toBeTruthy();
    expect(screen.getByText('cloudflared tunnel --url http://localhost:8000')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Paste its address' })).toBeTruthy();
    expect((screen.getByLabelText('Address') as HTMLInputElement).placeholder).toBe('https://speech.example.com');
    expect(screen.getByLabelText('API key, if your server asks for one')).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My speech server');
    expect((screen.getByRole('button', { name: 'Load models' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('loads what the server does, says it hears after a pause and how many voices it lists, and adds it with its address and no key', async () => {
    await pickOwn();
    const models = [{ id: 'whisper-small', kind: 'recognition' }, { id: 'kokoro', kind: 'speech' }];
    await load({ ok: true, models, unsure: [], voices: 67 });
    expect(await screen.findByText(/It answered\. Your server has 2 models\./)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'What it does' })).toBeTruthy();
    expect(screen.getByTestId('own-speech-pause').textContent).toBe('It hears a person once they pause, so no words show while they talk.');
    expect(screen.getByTestId('own-speech-voices').textContent).toBe('67 voices from your server. Each bot picks one on its Voice row.');
    expect(screen.getByTestId('voice-one-key').textContent).toContain('This server listens and speaks');
    expect(fetchMock).toHaveBeenCalledWith('/api/me/voice-keys/check', expect.objectContaining({ body: JSON.stringify({ adapter: 'openai-compatible', apiKey: '', address: 'https://speech.example.com' }) }));
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toEqual({ adapter: 'openai-compatible', name: 'My speech server', address: 'https://speech.example.com', recognition: true, speech: true, models });
  });

  it('says when the server lists no voices', async () => {
    await pickOwn();
    await load({ ok: true, models: [{ id: 'kokoro', kind: 'speech' }], unsure: [], voices: null });
    expect((await screen.findByTestId('own-speech-voices')).textContent).toBe('Your server doesn’t list its voices. Each bot types its voice’s name on its Voice row.');
    expect(screen.queryByTestId('own-speech-pause')).toBeNull();
  });

  it('asks which job each model does when the server doesn’t say, and keeps Add key off until every one has a pick', async () => {
    await pickOwn();
    await load({ ok: true, models: [], unsure: ['tts-1', 'whisper-1'], voices: null });
    const unsure = await screen.findByTestId('own-speech-unsure');
    expect(within(unsure).getByRole('heading', { name: 'Listens or speaks?' })).toBeTruthy();
    expect(within(unsure).getAllByTestId('unsure-row')).toHaveLength(2);
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(within(unsure).getAllByTestId('unsure-row')[0]).getByRole('radio', { name: 'Speaks' }));
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(within(unsure).getAllByTestId('unsure-row')[1]).getByRole('radio', { name: 'Listens' }));
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({
      recognition: true,
      speech: true,
      models: [{ id: 'tts-1', kind: 'speech' }, { id: 'whisper-1', kind: 'recognition' }],
    });
  });

  it('forgets the picks when the address changes', async () => {
    await pickOwn();
    await load({ ok: true, models: [], unsure: ['tts-1'], voices: null });
    await screen.findByTestId('own-speech-unsure');
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://other.example.com' } });
    expect(screen.queryByTestId('own-speech-unsure')).toBeNull();
  });

  it('shows what is wrong in the words the server gave, and keeps Add key off', async () => {
    await pickOwn();
    await load({ error: 'That address points to a private network, so Universe can’t reach it.' }, false);
    expect((await screen.findByRole('alert')).textContent).toBe('That address points to a private network, so Universe can’t reach it.');
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
  });
});
