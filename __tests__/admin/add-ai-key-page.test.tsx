/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** Add a key (#374): pick a type, load its models (which proves it answers), pick one, add. */

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

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
});

describe('Add a key', () => {
  it('shows the types in two groups, none picked, and nothing to fill in yet', () => {
    render(<AddAiKeyPage />);
    expect(screen.getByText('On your own computer')).toBeTruthy();
    expect(screen.getByText('Hosted, with an API key')).toBeTruthy();
    for (const label of ['LM Studio', 'Ollama or llama.cpp', 'OpenRouter', 'Gemini', 'NVIDIA NIM', 'OpenAI', 'DeepSeek']) {
      expect(screen.getByRole('radio', { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.queryByLabelText('Address')).toBeNull();
    expect((addButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the setup steps of the picked type, with the command to copy', () => {
    render(<AddAiKeyPage />);
    fireEvent.click(screen.getByRole('radio', { name: /LM Studio/ }));
    expect(screen.getByText('cloudflared tunnel --url http://localhost:1234')).toBeTruthy();
    expect(screen.getByLabelText('Address')).toBeTruthy();
    expect(screen.getByLabelText('API key, if your server asks for one')).toBeTruthy();
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
