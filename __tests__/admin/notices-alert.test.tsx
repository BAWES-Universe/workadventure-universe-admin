/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/** Notices on Orbit home (#374): what Orbit told you, until you dismiss it. */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

import { NoticesAlert } from '@/app/admin/components/notices-alert';
import { ATTENTION_CHANGED_EVENT } from '@/app/admin/components/shell/attention-badge';

const down = { id: 'n1', kind: 'ai-key-down', title: 'My LM Studio is down', body: 'Since 2:14 PM. Guide and Nora reply on Universe AI until it’s back.', badge: 'Down', href: '/admin/you/ai-keys' };
const moved = { id: 'n2', kind: 'ai-key-moved', title: 'Sam’s bot moved to Universe AI', body: 'Its key was revoked.', badge: null, href: null };

function answer(notices: unknown[], dismiss: { ok: boolean; status?: number } = { ok: true, status: 200 }) {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    init?.method === 'DELETE'
      ? Promise.resolve({ ok: dismiss.ok, status: dismiss.status ?? 500, json: () => Promise.resolve({}) })
      : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ notices }) }));
}

beforeEach(() => fetchMock.mockReset());

describe('NoticesAlert', () => {
  it('shows nothing when nothing waits, and nothing when it cannot load', async () => {
    answer([]);
    const { container, rerender } = render(<NoticesAlert />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
    fetchMock.mockRejectedValue(new Error('offline'));
    rerender(<NoticesAlert key="again" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(container.innerHTML).toBe('');
  });

  it('shows each notice with its state pill and a way to the page that explains it', async () => {
    answer([down, moved]);
    render(<NoticesAlert />);
    expect(await screen.findByText('My LM Studio is down')).toBeTruthy();
    expect(screen.getByText('Down')).toBeTruthy();
    expect(screen.getByText(/Guide and Nora reply on Universe AI/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /My LM Studio is down/ }).getAttribute('href')).toBe('/admin/you/ai-keys');
    expect(screen.getByText('Sam’s bot moved to Universe AI')).toBeTruthy();
    expect(screen.getAllByTestId('notice')).toHaveLength(2);
  });

  it('dismisses one, tells the count to follow, and keeps the other', async () => {
    answer([down, moved]);
    const changed = jest.fn();
    window.addEventListener(ATTENTION_CHANGED_EVENT, changed);
    render(<NoticesAlert />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss: My LM Studio is down' }));
    await waitFor(() => expect(screen.queryByText('My LM Studio is down')).toBeNull());
    expect(screen.getByText('Sam’s bot moved to Universe AI')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/me/notices/n1', { method: 'DELETE' });
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(ATTENTION_CHANGED_EVENT, changed);
  });

  it('keeps the notice and says so when the dismiss did not work', async () => {
    answer([down], { ok: false, status: 500 });
    render(<NoticesAlert />);
    fireEvent.click(await screen.findByRole('button', { name: /Dismiss/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/didn’t work/);
    expect(screen.getByText('My LM Studio is down')).toBeTruthy();
  });

  it('drops a notice already dismissed on another device (404) without complaint', async () => {
    answer([down], { ok: false, status: 404 });
    render(<NoticesAlert />);
    fireEvent.click(await screen.findByRole('button', { name: /Dismiss/ }));
    await waitFor(() => expect(screen.queryByText('My LM Studio is down')).toBeNull());
  });
});
