/** @jest-environment jsdom */

import React from 'react';
import { render, screen, within } from '@testing-library/react';

/** AI keys on You (#605): one card under the profile, one tap to the AI keys page, saying how the keys are doing. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

import { AiKeysCard } from '@/app/admin/components/ai-keys-card';

const bot = (name: string) => ({ id: `bot-${name}`, name, replies: 3, model: null });
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
  lentTo: [
    { universeId: 'u-1', universeName: 'Sandbox Universe', ownedByYou: true, models: null, bots: [bot('Guide'), bot('Nora')] },
    { universeId: 'u-2', universeName: 'BAWES Universe', ownedByYou: true, models: null, bots: [bot('Sam')] },
  ],
  status: 'working',
  downSince: null,
  downReason: null,
  ifDown: 'universe-ai',
  createdAt: '2026-10-19T00:00:00.000Z',
};
const router = { ...claude, id: 'key-2', name: 'OpenRouter', kind: 'openrouter', kindLabel: 'OpenRouter', month: { replies: 96, tokens: 0 }, lentTo: [] };

function answer(response: { ok: boolean; keys?: unknown[] }) {
  fetchMock.mockResolvedValue({ ok: response.ok, status: response.ok ? 200 : 500, json: () => Promise.resolve({ keys: response.keys }) });
}

beforeEach(() => fetchMock.mockReset());

describe('AI keys card', () => {
  it('with no key yet says what a key does and shows what you can bring, and the card opens the AI keys page', async () => {
    answer({ ok: true, keys: [] });
    render(<AiKeysCard />);
    expect(await screen.findByText(/Bots you make run on Universe AI/)).toBeTruthy();
    const card = screen.getByTestId('ai-keys-card');
    expect(card.getAttribute('href')).toBe('/admin/you/ai-keys');
    expect(within(screen.getByTestId('ai-keys-card-logos')).getAllByTestId('provider-logo')).toHaveLength(6);
    // One tap: nothing inside the card is a button or another link.
    expect(within(card).queryByRole('button')).toBeNull();
    expect(card.querySelectorAll('a')).toHaveLength(0);
  });

  it('with working keys says All working, where each is lent and the month’s replies', async () => {
    answer({ ok: true, keys: [claude, router] });
    render(<AiKeysCard />);
    expect((await screen.findByTestId('ai-keys-card-status')).textContent).toBe('All working');
    const [first, second] = screen.getAllByTestId('ai-keys-card-key');
    expect(first.textContent).toContain('Lent to Sandbox Universe and BAWES Universe · 3 bots');
    expect(second.textContent).toContain('Not lent to a universe yet');
    expect(screen.getByText('508 replies on your keys this month')).toBeTruthy();
    expect(screen.getByRole('heading').textContent).toBe('AI keys 2');
  });

  it('says Working for one key, and counts the keys past three', async () => {
    answer({ ok: true, keys: [claude] });
    const { unmount } = render(<AiKeysCard />);
    expect((await screen.findByTestId('ai-keys-card-status')).textContent).toBe('Working');
    unmount();
    answer({ ok: true, keys: [claude, router, { ...router, id: 'k3' }, { ...router, id: 'k4' }, { ...router, id: 'k5' }] });
    render(<AiKeysCard />);
    await screen.findByTestId('ai-keys-card-status');
    expect(screen.getAllByTestId('ai-keys-card-key')).toHaveLength(3);
    expect(screen.getByText(/^2 more · /)).toBeTruthy();
  });

  it('with a key down says what happened and what its bots do meanwhile', async () => {
    const since = new Date();
    since.setHours(14, 14, 0, 0);
    answer({ ok: true, keys: [{ ...claude, status: 'down', downReason: 'credit', downSince: since.toISOString() }, router] });
    render(<AiKeysCard />);
    expect((await screen.findByTestId('ai-keys-card-status')).textContent).toBe('1 down');
    const line = screen.getAllByTestId('ai-keys-card-key')[0].textContent ?? '';
    expect(line).toContain('Down');
    expect(line).toMatch(/Out of credit since 2:14\sPM\. Guide, Nora and Sam reply on Universe AI until it’s back\./);
  });

  it('lists a down key first, even when it comes after the first three', async () => {
    const working = (id: string) => ({ ...router, id, name: `Key ${id}` });
    answer({ ok: true, keys: [working('a'), working('b'), working('c'), { ...router, id: 'd', name: 'Late key', status: 'down', downReason: 'errors', downSince: new Date().toISOString() }] });
    render(<AiKeysCard />);
    expect((await screen.findByTestId('ai-keys-card-status')).textContent).toBe('1 down');
    const rows = screen.getAllByTestId('ai-keys-card-key');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Late key');
    expect(rows[0].textContent).toContain('Kept failing since');
  });

  it('says the bots rest when the key is set to stop replying', async () => {
    answer({ ok: true, keys: [{ ...claude, status: 'down', downReason: 'rejected', downSince: new Date().toISOString(), ifDown: 'stop' }] });
    render(<AiKeysCard />);
    await screen.findByTestId('ai-keys-card-status');
    expect(screen.getByText(/Didn’t accept the key since .*\. Guide, Nora and Sam rest until it’s back\./)).toBeTruthy();
  });

  it('still leads to the AI keys page when the keys can’t be read', async () => {
    answer({ ok: false });
    render(<AiKeysCard />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId('ai-keys-card').getAttribute('href')).toBe('/admin/you/ai-keys');
    expect(screen.queryByTestId('ai-keys-card-status')).toBeNull();
  });

  it('names the card link from its whole content, so a screen reader hears how the keys are doing', async () => {
    answer({ ok: true, keys: [claude, { ...router, status: 'down', downSince: '2026-10-25T10:00:00.000Z' }] });
    render(<AiKeysCard />);
    const card = await screen.findByTestId('ai-keys-card');
    expect(card.getAttribute('aria-labelledby')).toBeNull();
    expect(card.textContent).toMatch(/AI keys\s*2/);
    expect(card.textContent).toContain('1 down');
  });
});
