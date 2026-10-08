/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Get started, once hidden, can be shown again from You's settings, while any of its steps is left. That row is
 * all Settings holds now: Appearance, Sharing and Sign out moved to the Orbit menu.
 */

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock('@/app/admin/components/profile-card', () => ({ ProfileCard: () => null }));
jest.mock('@/app/admin/components/passport', () => ({ PassportSection: () => null, ActivitySection: () => null }));
jest.mock('@/app/admin/admin-bootstrap-context', () => ({
  useAdminBootstrap: () => ({ user: { id: 'u', uuid: 'u', name: 'Me', email: null, tags: [], isSuperAdmin: false }, mine: null }),
}));

// Stands in for What's yours: the card and its Hide, as Yours draws them from what You hands down.
let allDone = false;
jest.mock('@/app/admin/components/yours', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useEffect } = require('react') as typeof import('react');
  function MockYours({ getStarted }: { getStarted: { hidden: boolean | null; hide: () => void; onAllDone?: (done: boolean) => void } }) {
    useEffect(() => getStarted.onAllDone?.(allDone), [getStarted]);
    return getStarted.hidden === false && !allDone ? (
      <section data-testid="get-started">
        <h2 id="get-started-heading">Get started</h2>
        <button type="button" onClick={getStarted.hide}>
          Hide
        </button>
      </section>
    ) : null;
  }
  return { __esModule: true, default: MockYours };
});

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

import YouPage from '@/app/admin/you/page';

function stored(hidden: boolean) {
  fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(init?.method === 'PUT' ? {} : { preferences: { 'guidance.dismissed.getStarted': { hidden } } }),
    }),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  allDone = false;
  Element.prototype.scrollIntoView = jest.fn();
});

describe('You: Get started comes back', () => {
  it('offers nothing in settings while Get started shows', async () => {
    stored(false);
    render(<YouPage />);
    await screen.findByTestId('get-started');
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
  });

  it('after Hide, Settings shows it again, saved for every device, and scrolls up to it', async () => {
    stored(false);
    render(<YouPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide' }));
    expect(screen.queryByTestId('get-started')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Show' }));
    await screen.findByTestId('get-started');
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/me/preferences', {
      method: 'PUT',
      body: JSON.stringify({ key: 'guidance.dismissed.getStarted', value: { hidden: false } }),
    });
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it('shows the way back on a later visit too, when it was hidden before', async () => {
    stored(true);
    render(<YouPage />);
    expect(await screen.findByRole('button', { name: 'Show' })).toBeTruthy();
    expect(screen.getByText('Get started')).toBeTruthy();
  });

  it('no longer carries Appearance, Sharing or Sign out: they live in the Orbit menu', async () => {
    stored(true);
    render(<YouPage />);
    await screen.findByRole('button', { name: 'Show' });
    expect(screen.queryByText('Appearance')).toBeNull();
    expect(screen.queryByText('Sharing')).toBeNull();
    expect(screen.queryByText('Account')).toBeNull();
    expect(screen.queryByRole('button', { name: /Sign out/ })).toBeNull();
  });

  it('has no Settings at all while Get started shows', async () => {
    stored(false);
    render(<YouPage />);
    await screen.findByTestId('get-started');
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
  });

  it('offers nothing once every step is done', async () => {
    stored(true);
    allDone = true;
    render(<YouPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
  });
});
