/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** The AI keys page (#374): your keys, what each spent this month, and Revoke with its confirm. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: jest.fn() }) }));

import AiKeysPage from '@/app/admin/you/ai-keys/page';

const lmStudio = {
  id: 'key-1',
  name: 'My LM Studio',
  kind: 'lmstudio',
  kindLabel: 'LM Studio',
  model: 'qwen3-8b',
  address: 'lm.example.com',
  last4: null,
  month: { replies: 2310, tokens: 880_000 },
  lentTo: [] as unknown[],
  status: 'working',
  downSince: null,
  downReason: null,
  ifDown: 'universe-ai',
  createdAt: '2026-10-19T00:00:00.000Z',
};
const deepseek = {
  id: 'key-2',
  name: 'My DeepSeek',
  kind: 'deepseek',
  kindLabel: 'DeepSeek',
  model: 'deepseek-v4-flash',
  address: null,
  last4: '4f2a',
  month: { replies: 1, tokens: 1_240_000 },
  lentTo: [] as unknown[],
  status: 'working',
  downSince: null,
  downReason: null,
  ifDown: 'universe-ai',
  createdAt: '2026-10-19T00:00:00.000Z',
};

function answer(keys: unknown[]) {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(init?.method === 'DELETE' ? { status: 'revoked' } : { keys }) }),
  );
}

beforeEach(() => fetchMock.mockReset());

describe('AI keys page', () => {
  it('says what each key is and what it spent this month, never the key', async () => {
    answer([lmStudio, deepseek]);
    render(<AiKeysPage />);
    expect(await screen.findByText('LM Studio · qwen3-8b · lm.example.com')).toBeTruthy();
    expect(screen.getByText('DeepSeek · deepseek-v4-flash · ends in 4f2a')).toBeTruthy();
    expect(screen.getByText('2,310 replies · 880k tokens')).toBeTruthy();
    expect(screen.getByText('1 reply · 1.2M tokens')).toBeTruthy();
  });

  it('has an Add a key button that opens the form', async () => {
    answer([]);
    render(<AiKeysPage />);
    expect((await screen.findByRole('link', { name: /Add a key/ })).getAttribute('href')).toBe('/admin/you/ai-keys/new');
  });

  it('says so, plainly, when there are no keys', async () => {
    answer([]);
    render(<AiKeysPage />);
    expect(await screen.findByTestId('ai-keys-empty')).toBeTruthy();
    expect(screen.queryByText('Danger zone')).toBeNull();
  });

  it('says it could not load, with a way to try again, instead of showing an empty list', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    render(<AiKeysPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('ai-keys-empty')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('revokes only after the confirm, then the key is gone from the list', async () => {
    answer([lmStudio, deepseek]);
    render(<AiKeysPage />);
    await screen.findByText('My DeepSeek', { selector: 'h2' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[1]);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('key-2'), expect.anything());
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/ai-keys/key-2', { method: 'DELETE' }));
    await waitFor(() => expect(screen.queryByText('My DeepSeek', { selector: 'h2' })).toBeNull());
    expect(screen.getByText('My LM Studio', { selector: 'h2' })).toBeTruthy();
  });

  it('keeps the key and says so when revoking fails', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ keys: [lmStudio] }) }),
    );
    render(<AiKeysPage />);
    await screen.findByText('My LM Studio', { selector: 'h2' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('That didn’t work. Try again.')).toBeTruthy();
    expect(screen.getByText('My LM Studio', { selector: 'h2' })).toBeTruthy();
  });
});

const sam = { id: 'b1', name: 'Sam', replies: 1240 };
const lentKey = {
  ...deepseek,
  lentTo: [
    { universeId: 'bawes', universeName: 'BAWES Universe', ownedByYou: false, bots: [sam] },
    { universeId: 'sandbox', universeName: 'Sandbox Universe', ownedByYou: true, bots: [] },
  ],
};

/** The server's side of the sheets: the universes to lend to, and lend / pull / revoke answers. */
function serve(keys: unknown[], universes: unknown[] = []) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/me/ai-keys/universes') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ universes }) });
    if (init?.method) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: 'ok' }) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ keys }) });
  });
}
const calls = (method: string) => fetchMock.mock.calls.filter(([, init]) => init?.method === method);

describe('Lent to', () => {
  it('names each universe a key is lent to, the bots on it there and their replies', async () => {
    serve([lentKey]);
    render(<AiKeysPage />);
    expect(await screen.findByText('BAWES Universe')).toBeTruthy();
    expect(screen.getByText('Sam · 1,240 replies')).toBeTruthy();
    expect(screen.getByText('Sandbox Universe')).toBeTruthy();
    expect(screen.queryByText('No universe yet. Only you can see this key.')).toBeNull();
  });

  it('says plainly when a key is lent nowhere, and offers Lend to a universe', async () => {
    serve([deepseek]);
    render(<AiKeysPage />);
    expect(await screen.findByText('No universe yet. Only you can see this key.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Lend to a universe' })).toBeTruthy();
  });

  it('describes in the Danger zone what revoking does: bots move and owners are told, or no bot runs on it', async () => {
    serve([lentKey, lmStudio]);
    render(<AiKeysPage />);
    await screen.findByText('Revoke My DeepSeek');
    expect(screen.getByText('Deletes it everywhere. Its bot moves to Universe AI and each universe owner is told.')).toBeTruthy();
    expect(screen.getByText('Deletes it everywhere. No bot runs on it now.')).toBeTruthy();
  });

  it('does not say an owner is told when the bots are in the key owner’s own universe', async () => {
    serve([{ ...deepseek, lentTo: [{ universeId: 'sandbox', universeName: 'Sandbox Universe', ownedByYou: true, bots: [sam] }] }]);
    render(<AiKeysPage />);
    expect(await screen.findByText('Deletes it everywhere. Its bot moves to Universe AI.')).toBeTruthy();
  });

  it('says in the revoke confirm who moves, who is told, and that adding it again won’t move them back', async () => {
    serve([lentKey]);
    render(<AiKeysPage />);
    await screen.findByText('Revoke My DeepSeek');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Sam in BAWES Universe moves to Universe AI, and the owner of BAWES Universe is told\. Adding the key again later does not move Sam back\./)).toBeTruthy();
  });
});

describe('Lend sheet', () => {
  const universes = [
    { id: 'uniboz', name: 'uniboz', access: 'manage' },
    { id: 'bawes', name: 'BAWES Universe', access: 'manage' },
    { id: 'sandbox', name: 'Sandbox Universe', access: 'owner' },
  ];

  it('lists universes where you can manage bots, with why, and "Already lent" for the ones that are', async () => {
    serve([lentKey], universes);
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Lend to a universe' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('You have Manage bots here')).toBeTruthy();
    expect(within(dialog).getAllByText('Already lent')).toHaveLength(2);
    expect(within(dialog).getByText(/Lending moves no bot/)).toBeTruthy();
    const radios = within(dialog).getAllByRole('radio');
    expect(radios.map((radio) => (radio as HTMLButtonElement).disabled)).toEqual([false, true, true]);
    // The first one still free is picked
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
  });

  it('lends to the picked universe, then shows the list again', async () => {
    serve([deepseek], universes);
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Lend to a universe' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('You own it');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Sandbox Universe/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lend' }));
    await waitFor(() => expect(calls('POST')).toHaveLength(1));
    const [url, init] = calls('POST')[0];
    expect(url).toBe('/api/me/ai-keys/key-2/lend');
    expect(JSON.parse(init.body)).toEqual({ universeId: 'sandbox' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says so, and offers nothing to lend to, when you can’t manage bots anywhere', async () => {
    serve([deepseek], []);
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Lend to a universe' }));
    expect(await screen.findByTestId('lend-none')).toBeTruthy();
    expect((within(await screen.findByRole('dialog')).getByRole('button', { name: 'Lend' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the server’s reason when it refuses, and keeps the sheet open', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/me/ai-keys/universes') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ universes }) });
      if (init?.method === 'POST') return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: 'You need Manage bots in that universe to lend a key to it.' }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ keys: [deepseek] }) });
    });
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Lend to a universe' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('You own it');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lend' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/Manage bots in that universe/);
  });
});

describe('Pulling a key from a universe', () => {
  it('asks first when bots would move, and says who moves and who is told', async () => {
    serve([lentKey]);
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pull My DeepSeek from BAWES Universe' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Sam moves to Universe AI, and the owner of BAWES Universe is told/)).toBeTruthy();
    expect(calls('DELETE')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pull' }));
    await waitFor(() => expect(calls('DELETE')).toHaveLength(1));
    expect(calls('DELETE')[0][0]).toBe('/api/me/ai-keys/key-2/lend/bawes');
  });

  it('pulls at once, with nothing to confirm, when no bot is on the key there', async () => {
    serve([lentKey]);
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pull My DeepSeek from Sandbox Universe' }));
    await waitFor(() => expect(calls('DELETE')).toHaveLength(1));
    expect(calls('DELETE')[0][0]).toBe('/api/me/ai-keys/key-2/lend/sandbox');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Working, Down and "If this is down"', () => {
  const downLm = {
    ...lmStudio,
    status: 'down',
    downSince: new Date(Date.now() - 60_000).toISOString(),
    downReason: 'stopped',
    lentTo: [{ universeId: 'u1', universeName: 'Sandbox Universe', ownedByYou: true, bots: [{ id: 'b1', name: 'Guide', replies: 5 }, { id: 'b2', name: 'Nora', replies: 3 }] }],
  };

  it('shows Working on a healthy key and nothing about being down', async () => {
    answer([deepseek]);
    render(<AiKeysPage />);
    expect((await screen.findByTestId('ai-key-status')).textContent).toBe('Working');
    expect(screen.queryByTestId('ai-key-down-text')).toBeNull();
    expect(screen.queryByRole('button', { name: /Check now/ })).toBeNull();
    expect(screen.getByTestId('ai-key-if-down-help').textContent).toBe('Bots keep replying on Universe AI until it’s back.');
  });

  it('says a key is down: why, what its bots do meanwhile (own-computer wording), and the 5-minute recheck', async () => {
    answer([downLm]);
    render(<AiKeysPage />);
    expect((await screen.findByTestId('ai-key-status')).textContent).toBe('Down');
    const text = screen.getByTestId('ai-key-down-text').textContent ?? '';
    expect(text).toMatch(/^Down since .+: lm\.example\.com stopped answering\./);
    expect(text).toContain('Guide and Nora reply on Universe AI until it’s back, so their conversations leave your computer meanwhile.');
    expect(text).toContain('Universe checks every 5 minutes and switches back by itself.');
    expect(screen.getByRole('button', { name: /Check now/ })).toBeTruthy();
  });

  it('says the bots rest when the owner chose Stop replying', async () => {
    answer([{ ...downLm, ifDown: 'stop' }]);
    render(<AiKeysPage />);
    expect((await screen.findByTestId('ai-key-down-text')).textContent).toContain('Guide and Nora rest until it’s back.');
    expect(screen.getByRole('radio', { name: 'Stop replying' }).getAttribute('aria-checked')).toBe('true');
  });

  it('saves the other choice, and puts the old one back when saving fails', async () => {
    answer([deepseek]);
    render(<AiKeysPage />);
    const stop = await screen.findByRole('radio', { name: 'Stop replying' });
    expect(screen.getByRole('radio', { name: 'Use Universe AI' }).getAttribute('aria-checked')).toBe('true');
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    fireEvent.click(stop);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/me/ai-keys/key-2' && init?.method === 'PATCH' && init.body === JSON.stringify({ ifDown: 'stop' }))).toBe(true));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Use Universe AI' }).getAttribute('aria-checked')).toBe('true'));
  });

  it('Check now asks the server and reloads the list', async () => {
    answer([downLm]);
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Check now/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/me/ai-keys/key-1/check' && init?.method === 'POST')).toBe(true));
  });
});

describe('Change address and Change model', () => {
  function serveEdit(keys: unknown[], over: { models?: unknown; patch?: unknown; patchStatus?: number } = {}) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(over.models ?? { ok: true, models: ['qwen3-8b', 'llama-3.1-8b'] }) });
      if (init?.method === 'PATCH') return Promise.resolve({ ok: (over.patchStatus ?? 200) < 400, status: over.patchStatus ?? 200, json: () => Promise.resolve(over.patch ?? { status: 'saved' }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ keys }) });
    });
  }

  it('offers Change address only on a key with an address of its own, and Change model on every key', async () => {
    serveEdit([lmStudio, deepseek]);
    render(<AiKeysPage />);
    await screen.findByText('My DeepSeek', { selector: 'h2' });
    expect(screen.getAllByRole('button', { name: 'Change address' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Change model' })).toHaveLength(2);
  });

  it('saves a new address with a PATCH, shows the key’s current address, and closes', async () => {
    serveEdit([lmStudio]);
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change address' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Now: lm\.example\.com/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('New address'), { target: { value: 'https://new.trycloudflare.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PATCH')).toHaveLength(1));
    const [url, init] = calls('PATCH')[0];
    expect(url).toBe('/api/me/ai-keys/key-1');
    expect(JSON.parse(init.body)).toEqual({ address: 'https://new.trycloudflare.com' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers the models the new address has when it does not have the saved one, and saves both together', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, models: ['mistral-7b', 'llama-3.1-8b'] }) });
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        return body.model
          ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: 'saved' }) })
          : Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'That address doesn’t have qwen3-8b. Pick a model it has.', code: 'model-missing' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ keys: [lmStudio] }) });
    });
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change address' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('New address'), { target: { value: 'https://new.trycloudflare.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/doesn’t have qwen3-8b/);
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'mistral-7b' }));
    // The models were asked of the NEW address
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/models') && init?.body === JSON.stringify({ address: 'https://new.trycloudflare.com' }))).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PATCH')).toHaveLength(2));
    expect(JSON.parse(calls('PATCH')[1][1].body)).toEqual({ address: 'https://new.trycloudflare.com', model: 'mistral-7b' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the sheet open and shows the reason when the new address does not answer', async () => {
    serveEdit([lmStudio], { patchStatus: 400, patch: { error: 'It didn’t answer. Is the server running and the tunnel up?' } });
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change address' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('New address'), { target: { value: 'https://dead.trycloudflare.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/tunnel up/);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('loads the models with no key sent, and saves the one picked', async () => {
    serveEdit([lmStudio]);
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change model' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'llama-3.1-8b' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PATCH')).toHaveLength(1));
    expect(JSON.parse(calls('PATCH')[0][1].body)).toEqual({ model: 'llama-3.1-8b' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('will not save until a different model is picked', async () => {
    serveEdit([lmStudio]);
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change model' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'qwen3-8b' }));
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says why when the models could not be loaded', async () => {
    serveEdit([lmStudio], { models: { ok: false, message: 'It didn’t answer. Is the server running and the tunnel up?' } });
    render(<AiKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change model' }));
    expect((await within(await screen.findByRole('dialog')).findByRole('alert')).textContent).toMatch(/tunnel up/);
  });
});
