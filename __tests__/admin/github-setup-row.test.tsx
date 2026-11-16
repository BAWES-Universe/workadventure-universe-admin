/** @jest-environment jsdom */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * "GitHub for Universe" on Orbit home (game #2041): the one-time GitHub App setup page had no link anywhere, and opened outside
 * Orbit it only says Orbit runs inside Universe. Super admins get a row that opens it inside Orbit, with whether it is set up.
 */

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { GitHubSetupRow, useGitHubSetup } from '@/app/admin/components/github-setup-row';
import { AdminBootstrapProvider, type AdminBootstrap } from '@/app/admin/admin-bootstrap-context';
import { ROUTES } from '@/app/admin/config/routes';
import AdminDashboard from '@/app/admin/page';

jest.mock('@/app/admin/hooks/use-live', () => ({ useLive: () => null }));
jest.mock('@/app/admin/components/here-panel', () => ({ __esModule: true, default: () => null }));
jest.mock('@/app/admin/components/pending-invitations-alert', () => ({ __esModule: true, default: () => null }));
jest.mock('@/app/admin/components/live/live-now', () => ({ LiveStrip: () => null }));
jest.mock('@/app/admin/components/orbit/get-started-on-orbit', () => ({ useGetStartedOnOrbit: () => ({ guide: null, comesBack: null }) }));
jest.mock('@/app/admin/components/orbit/rows', () => ({
  MembershipsRow: () => <div data-testid="memberships-row" />,
  StarsRow: () => <div data-testid="stars-row" />,
  UniversesRow: () => <div data-testid="universes-row" />,
}));
jest.mock('@/app/admin/components/world-safety', () => ({ ReportsAlert: () => null }));
jest.mock('@/app/admin/components/notices-alert', () => ({ NoticesAlert: () => null }));

function answer(body: unknown, ok = true) {
  fetchMock.mockImplementation(() => Promise.resolve({ ok, status: ok ? 200 : 403, json: () => Promise.resolve(body) }));
}

function home(isSuperAdmin: boolean) {
  const bootstrap = { user: { id: 'u1', isSuperAdmin } } as unknown as AdminBootstrap;
  return render(
    <AdminBootstrapProvider value={bootstrap}>
      <AdminDashboard />
    </AdminBootstrapProvider>,
  );
}

beforeEach(() => fetchMock.mockReset());

describe('GitHubSetupRow', () => {
  it('opens the setup page inside Orbit, and says what it does and that it is not set up yet', () => {
    render(<GitHubSetupRow made={false} />);
    const row = screen.getByTestId('github-setup');
    expect(row.getAttribute('href')).toBe('/admin/github-app');
    expect(row.getAttribute('data-state')).toBe('todo');
    expect(screen.getByText('GitHub for Universe')).toBeTruthy();
    expect(screen.getByText('Not set up')).toBeTruthy();
    expect(screen.getByText(/press Create on GitHub/)).toBeTruthy();
  });

  it('says it is set up once it is, still a link', () => {
    render(<GitHubSetupRow made />);
    const row = screen.getByTestId('github-setup');
    expect(row.getAttribute('href')).toBe('/admin/github-app');
    expect(row.getAttribute('data-state')).toBe('made');
    expect(screen.getByText('Set up')).toBeTruthy();
    expect(screen.getByText('Everyone can connect GitHub in Apps.')).toBeTruthy();
  });

  it('points at a page Orbit knows, with Orbit to go back to', () => {
    const route = ROUTES.find((entry) => entry.pattern === '/admin/github-app');
    expect(route?.parent).toBe('/admin');
  });
});

describe('Orbit home', () => {
  it('shows a super admin the row under the alerts while GitHub is not set up', async () => {
    answer({ made: false });
    const { container } = home(true);
    const row = await screen.findByTestId('github-setup');
    expect(row.getAttribute('data-state')).toBe('todo');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/github-app');
    // Above the rows, not below them
    const all = Array.from(container.querySelectorAll('[data-testid]')).map((node) => node.getAttribute('data-testid'));
    expect(all.indexOf('github-setup')).toBeLessThan(all.indexOf('stars-row'));
  });

  it('keeps a quiet row at the bottom once it is set up', async () => {
    answer({ made: true, slug: 'bawes-universe', url: 'https://github.com/apps/bawes-universe' });
    const { container } = home(true);
    const row = await screen.findByTestId('github-setup');
    expect(row.getAttribute('data-state')).toBe('made');
    const all = Array.from(container.querySelectorAll('[data-testid]')).map((node) => node.getAttribute('data-testid'));
    expect(all.indexOf('github-setup')).toBeGreaterThan(all.indexOf('memberships-row'));
  });

  it('shows nobody else the row, and does not even ask', async () => {
    answer({ made: false });
    home(false);
    await waitFor(() => expect(screen.getByTestId('stars-row')).toBeTruthy());
    expect(screen.queryByTestId('github-setup')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows nothing, and no error, when Orbit cannot say', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    home(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('github-setup')).toBeNull();
    answer({ error: 'no' }, false);
    home(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('github-setup')).toBeNull();
  });
});

describe('useGitHubSetup', () => {
  it('stays unknown while off', () => {
    function Probe() {
      return <span data-testid="probe">{String(useGitHubSetup(false))}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('null');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
