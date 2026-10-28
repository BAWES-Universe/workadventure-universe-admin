/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** Renaming a key from its card (#633): a pencil by the name, edited in place, the name changes and nothing else. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
const mockAddToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: mockAddToast }) }));

import AiKeysPage from '@/app/admin/you/ai-keys/page';

const openRouter = {
  id: 'key-1',
  name: 'Opus 5.5',
  kind: 'openrouter',
  kindLabel: 'OpenRouter',
  model: 'anthropic/claude-haiku-5-5',
  modelCount: 452,
  address: null,
  last4: '5d76',
  month: { replies: 4, tokens: 28_000 },
  lentTo: [] as unknown[],
  status: 'working',
  downSince: null,
  downReason: null,
  ifDown: 'universe-ai',
  createdAt: '2026-10-19T00:00:00.000Z',
  limits: { reply: 32000, steps: 30, continue: 2, memory: 20, read: 50000, wait: 60 },
};

/** The list answers GET; a PATCH answers with `patched` (the response the route would give). */
function serve(patched: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { status: 'saved', name: 'x' } }) {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    init?.method === 'PATCH'
      ? Promise.resolve({ ok: patched.ok, status: patched.status, json: () => Promise.resolve(patched.body) })
      : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ keys: [openRouter] }) }),
  );
}
const patches = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');

async function openEditor() {
  render(<AiKeysPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Rename Opus 5.5' }));
  return screen.getByLabelText('Key name') as HTMLInputElement;
}

beforeEach(() => {
  fetchMock.mockReset();
  mockAddToast.mockReset();
});

describe('Rename a key', () => {
  it('shows a pencil by the name, and opens the name for editing with the hint and count', async () => {
    serve();
    const input = await openEditor();
    expect(input.value).toBe('Opus 5.5');
    expect(screen.getByTestId('ai-key-rename-note').textContent).toBe('Shown on this card, in Runs on and when you revoke it.');
    expect(screen.getByText('8/60')).toBeTruthy();
    // The heading and the pencil give way to the editor
    expect(screen.queryByRole('heading', { name: 'Opus 5.5' })).toBeNull();
    expect(input.maxLength).toBe(60);
  });

  it('saves the trimmed name with one PATCH of the name alone, shows it on the card and says so', async () => {
    serve();
    const input = await openEditor();
    fireEvent.change(input, { target: { value: '  OpenRouter · work  ' } });
    fireEvent.click(screen.getByTestId('ai-key-rename-save'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'OpenRouter · work' })).toBeTruthy());
    expect(patches()).toHaveLength(1);
    const [url, init] = patches()[0] as [string, RequestInit];
    expect(url).toBe('/api/me/ai-keys/key-1');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'OpenRouter · work' });
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ description: 'Renamed to OpenRouter · work', variant: 'success' }));
    // The Revoke button reads the new name too
    expect(screen.getByRole('button', { name: 'Rename OpenRouter · work' })).toBeTruthy();
  });

  it('keeps Save off for an empty name and says why', async () => {
    serve();
    const input = await openEditor();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByTestId('ai-key-rename-note').textContent).toBe('Give the key a name.');
    expect((screen.getByTestId('ai-key-rename-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByTestId('ai-key-rename-form'));
    expect(patches()).toHaveLength(0);
  });

  it('Cancel, and Escape, put the old name back and ask for nothing', async () => {
    serve();
    const input = await openEditor();
    fireEvent.change(input, { target: { value: 'Something else' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'Opus 5.5' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Opus 5.5' }));
    fireEvent.keyDown(screen.getByLabelText('Key name'), { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'Opus 5.5' })).toBeTruthy();
    expect(patches()).toHaveLength(0);
  });

  it('stays open on Escape while the name is saving, then shows the saved name', async () => {
    let answer: (value: unknown) => void = () => undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? new Promise((resolve) => (answer = resolve))
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ keys: [openRouter] }) }),
    );
    const input = await openEditor();
    fireEvent.change(input, { target: { value: 'Work' } });
    fireEvent.click(screen.getByTestId('ai-key-rename-save'));
    await waitFor(() => expect(patches()).toHaveLength(1));
    fireEvent.keyDown(screen.getByLabelText('Key name'), { key: 'Escape' });
    expect(screen.getByTestId('ai-key-rename-form')).toBeTruthy();
    answer({ ok: true, status: 200, json: () => Promise.resolve({ status: 'saved', name: 'Work' }) });
    expect(await screen.findByRole('heading', { name: 'Work' })).toBeTruthy();
  });

  it('keeps another key’s editor open when this key’s name is saved after it was opened', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const other = { ...openRouter, id: 'key-2', name: 'Groq' };
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? new Promise((resolve) => (answer = resolve))
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ keys: [openRouter, other] }) }),
    );
    const input = await openEditor();
    fireEvent.change(input, { target: { value: 'Work' } });
    fireEvent.click(screen.getByTestId('ai-key-rename-save'));
    await waitFor(() => expect(patches()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Rename Groq' }));
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Groq · fast' } });
    answer({ ok: true, status: 200, json: () => Promise.resolve({ status: 'saved', name: 'Work' }) });
    await waitFor(() => expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ description: 'Renamed to Work' })));
    expect(screen.getByRole('heading', { name: 'Work' })).toBeTruthy();
    expect((screen.getByLabelText('Key name') as HTMLInputElement).value).toBe('Groq · fast');
  });

  it('closes without a request when the name is unchanged', async () => {
    serve();
    await openEditor();
    fireEvent.click(screen.getByTestId('ai-key-rename-save'));
    expect(screen.getByRole('heading', { name: 'Opus 5.5' })).toBeTruthy();
    expect(patches()).toHaveLength(0);
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('keeps the editor open with the route’s own sentence when it refuses, and never shows server words', async () => {
    serve({ ok: false, status: 400, body: { error: 'Keep the name under 60 characters.' } });
    const input = await openEditor();
    fireEvent.change(input, { target: { value: 'Work' } });
    fireEvent.click(screen.getByTestId('ai-key-rename-save'));
    await waitFor(() => expect(screen.getByTestId('ai-key-rename-note').textContent).toBe('Keep the name under 60 characters.'));
    expect((screen.getByLabelText('Key name') as HTMLInputElement).value).toBe('Work');

    serve({ ok: false, status: 500, body: { error: 'Internal server error' } });
    fireEvent.click(screen.getByTestId('ai-key-rename-save'));
    await waitFor(() => expect(screen.getByTestId('ai-key-rename-note').textContent).toBe('Something went wrong on our side. Try again.'));
    expect(screen.queryByText(/Internal server error/)).toBeNull();
  });

  it('says the key isn’t there when it was revoked elsewhere', async () => {
    serve({ ok: false, status: 404, body: { error: 'Key not found' } });
    const input = await openEditor();
    fireEvent.change(input, { target: { value: 'Work' } });
    fireEvent.click(screen.getByTestId('ai-key-rename-save'));
    await waitFor(() => expect(screen.getByTestId('ai-key-rename-note').textContent).toMatch(/isn’t there any more/));
  });

  it('puts the new name on the Revoke sheet', async () => {
    serve();
    const input = await openEditor();
    fireEvent.change(input, { target: { value: 'OpenRouter · work' } });
    fireEvent.click(screen.getByTestId('ai-key-rename-save'));
    await screen.findByRole('heading', { name: 'OpenRouter · work' });
    expect(screen.getByText('Revoke OpenRouter · work')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(within(await screen.findByRole('dialog')).getByText('Revoke OpenRouter · work?')).toBeTruthy();
  });
});
