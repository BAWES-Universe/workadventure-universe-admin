/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** Add a key (#374, two steps since #575): pick a provider, then set it up: load its models (which proves it answers), pick one, add. */

const fetchMock = jest.fn();
const push = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: jest.fn() }) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push, back: jest.fn() }) }));

import AddAiKeyPage from '@/app/admin/you/ai-keys/new/page';

function json(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });
}

const addButton = () => screen.getByRole('button', { name: 'Add key' });
/** Step 2's Change: back to the provider list, with the pick kept. */
const change = () => fireEvent.click(screen.getByRole('button', { name: 'Change' }));

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
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
    ['Get your Claude key', 'Paste your key', 'Pick a model', 'Name it'].forEach((part, index) => {
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

  it('keeps Add key off until the models loaded and one is picked, then adds and goes back to the list', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/models') ? json({ ok: true, models: ['gemma-3-12b', 'qwen3-8b'] }) : json({ id: 'key-new' }),
    );
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /LM Studio/ }));
    expect((screen.getByRole('button', { name: /Load models/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://lm.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered. LM Studio has 2 models./);
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'qwen3-8b' }));
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/you/ai-keys'));
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(init.body)).toEqual({ kind: 'lmstudio', address: 'https://lm.example.com', apiKey: '', model: 'qwen3-8b', name: 'My LM Studio' });
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

  it('forgets the loaded models, and the model picked, as soon as the key or address changes', async () => {
    fetchMock.mockImplementation(() => json({ ok: true, models: ['gemini-flash-latest', 'gemini-pro-latest'] }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /Gemini/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'AIza-first' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'gemini-flash-latest' }));
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'AIza-second' } });
    expect(screen.queryByRole('radio', { name: 'gemini-flash-latest' })).toBeNull();
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('searches a long list of models', async () => {
    const many = Array.from({ length: 40 }, (_, index) => `model-${String(index).padStart(2, '0')}`);
    fetchMock.mockImplementation(() => json({ ok: true, models: many }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /OpenRouter/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-or-123' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByLabelText('Search models');
    expect(within(screen.getByRole('radiogroup', { name: 'Model' })).getAllByRole('radio')).toHaveLength(30);
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'model-3' } });
    expect(within(screen.getByRole('radiogroup', { name: 'Model' })).getAllByRole('radio')).toHaveLength(10);
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

describe('Add a key: a model that cannot use bot tools', () => {
  it('warns once such a model is picked, and not for one the provider said nothing about', async () => {
    fetchMock.mockImplementation(() => json({ ok: true, models: ['big-model', 'tiny-chat'], facts: { 'tiny-chat': { tools: false } } }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^LM Studio/ }));
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://lm.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered/);
    fireEvent.click(screen.getByRole('radio', { name: 'big-model' }));
    expect(screen.queryByTestId('no-tools-warning')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'tiny-chat' }));
    expect(screen.getByTestId('no-tools-warning').textContent).toBe('This model has no Tools. Bots on it can still chat.');
    // The warning does not stop Add key
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
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ kind: 'nebius', apiKey: 'sk-1', model: 'm-1' });
  });
});

describe('Add a key: DeepSeek shows which model has Vision', () => {
  it('starts on deepseek-v4-flash, shows Vision only next to the image model, and adds the key on it', async () => {
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
    expect((screen.getByRole('radio', { name: 'deepseek-v4-flash' }) as HTMLElement).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /^deepseek-v4-flash-vision-exp/ }).textContent).toContain('Vision');
    expect(screen.getByRole('radio', { name: 'deepseek-v4-flash' }).textContent).not.toContain('Vision');
    expect(screen.getByRole('radio', { name: /^deepseek-v4-pro/ }).textContent).not.toContain('Vision');
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalled());
    const add = fetchMock.mock.calls.find((call) => !String(call[0]).endsWith('/models'))!;
    expect(JSON.parse(add[1].body)).toMatchObject({ kind: 'deepseek', model: 'deepseek-v4-flash' });
  });

  it('picks nothing when the list does not hold the suggested model', async () => {
    fetchMock.mockImplementation(() => json({ ok: true, models: ['deepseek-v4-pro', 'deepseek-chat'] }));
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^DeepSeek/ }));
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered/);
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
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

  it('loads Claude’s models, sending the kind and key, and adds the one picked', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/models') ? json({ ok: true, models: ['claude-haiku-4-5', 'claude-opus-5-5'], facts: {} }) : json({ id: 'key-new' }),
    );
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /^Claude/ }));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-api03-abcd' } });
    fireEvent.click(screen.getByRole('button', { name: /Load models/ }));
    await screen.findByText(/It answered. Claude has 2 models./);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ kind: 'claude', apiKey: 'sk-ant-api03-abcd' });
    fireEvent.click(screen.getByRole('radio', { name: 'claude-haiku-4-5' }));
    fireEvent.click(addButton());
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ kind: 'claude', model: 'claude-haiku-4-5' });
  });
});
