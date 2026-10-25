/** @jest-environment jsdom */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * You after Orbit #606: the profile, AI keys, the passport and your latest activity. Get started, your universes,
 * memberships and stars are on Orbit. You has no Settings heading: AI keys is a card under the profile (#605), and
 * Appearance, Sharing and Sign out moved to the Orbit menu.
 */

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock('@/app/admin/components/profile-card', () => ({ ProfileCard: () => null }));
const activityProps = jest.fn();
jest.mock('@/app/admin/components/passport', () => ({
  PassportSection: () => null,
  ActivitySection: (props: { limit?: number }) => {
    activityProps(props);
    return <section data-testid="activity" />;
  },
}));
jest.mock('@/app/admin/admin-bootstrap-context', () => ({
  useAdminBootstrap: () => ({ user: { id: 'u', uuid: 'u', name: 'Me', email: null, tags: [], isSuperAdmin: false }, mine: null }),
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

import YouPage from '@/app/admin/you/page';

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ preferences: { 'guidance.dismissed.getStarted': { hidden: true } } }) }),
  );
  activityProps.mockReset();
});

describe('You after the move to Orbit', () => {
  it('shows the latest three activities, with View all for the rest', async () => {
    render(<YouPage />);
    await screen.findByTestId('activity');
    expect(activityProps).toHaveBeenCalledWith({ limit: 3 });
  });

  it('carries no Get started, and no row to bring it back: both are on Orbit', async () => {
    render(<YouPage />);
    await screen.findByTestId('activity');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Get started')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('guidance.dismissed.getStarted'))).toBe(false);
  });

  it('carries no universes, memberships or stars', async () => {
    render(<YouPage />);
    await screen.findByTestId('activity');
    expect(screen.queryByText('Your universes')).toBeNull();
    expect(screen.queryByText('Memberships')).toBeNull();
    expect(screen.queryByText('Stars')).toBeNull();
  });

  it('no longer carries Appearance, Sharing or Sign out: they live in the Orbit menu', async () => {
    render(<YouPage />);
    await screen.findByTestId('activity');
    expect(screen.queryByText('Appearance')).toBeNull();
    expect(screen.queryByText('Sharing')).toBeNull();
    expect(screen.queryByText('Account')).toBeNull();
    expect(screen.queryByRole('button', { name: /Sign out/ })).toBeNull();
  });

  it('has no Settings heading: AI keys is a card that opens the AI keys page', async () => {
    render(<YouPage />);
    await waitFor(() => expect(screen.getByTestId('ai-keys-card').getAttribute('href')).toBe('/admin/you/ai-keys'));
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
  });
});
