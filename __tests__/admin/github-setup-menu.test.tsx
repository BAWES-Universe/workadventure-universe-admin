/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

/**
 * "GitHub for Universe" (game #2041) is a one-time setup, so it is a quiet item in the menu under Admin, for super admins only,
 * and nothing on Orbit home.
 */

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('next/navigation', () => ({ usePathname: () => '/admin' }));
jest.mock('@/app/admin/orbit-frame-context', () => ({ useOrbitFrame: () => ({ section: '/admin', menuOpen: true, setMenuOpen: () => undefined }) }));
jest.mock('@/app/admin/components/shell/theme-choice', () => ({ ThemeChoice: () => null }));
jest.mock('@/app/admin/logout-button', () => ({ __esModule: true, default: () => null }));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('@/app/admin/hooks/use-live', () => ({ useLive: () => null }));
jest.mock('@/app/admin/components/here-panel', () => ({ __esModule: true, default: () => null }));
jest.mock('@/app/admin/components/pending-invitations-alert', () => ({ __esModule: true, default: () => null }));
jest.mock('@/app/admin/components/live/live-now', () => ({ LiveStrip: () => null }));
jest.mock('@/app/admin/components/orbit/get-started-on-orbit', () => ({ useGetStartedOnOrbit: () => ({ guide: null, comesBack: null }) }));
jest.mock('@/app/admin/components/orbit/rows', () => ({ MembershipsRow: () => null, StarsRow: () => null, UniversesRow: () => null }));
jest.mock('@/app/admin/components/world-safety', () => ({ ReportsAlert: () => null }));
jest.mock('@/app/admin/components/notices-alert', () => ({ NoticesAlert: () => null }));

import { MenuSheet } from '@/app/admin/components/shell/menu-sheet';
import { getNavSections } from '@/app/admin/config/navigation';
import { ROUTES } from '@/app/admin/config/routes';
import { AdminBootstrapProvider, type AdminBootstrap } from '@/app/admin/admin-bootstrap-context';
import AdminDashboard from '@/app/admin/page';

const superAdmin = { name: 'Khalid', email: 'k@example.test', isSuperAdmin: true };
const someone = { name: 'Sara', email: 's@example.test', isSuperAdmin: false };

beforeEach(() => fetchMock.mockReset());

describe('GitHub for Universe in the menu', () => {
  it('is the last item under Admin for a super admin, and in no other section', () => {
    const sections = getNavSections(superAdmin);
    const admin = sections.find((section) => section.key === 'admin');
    expect(admin?.items.map((item) => item.label).at(-1)).toBe('GitHub for Universe');
    expect(admin?.items.at(-1)?.href).toBe('/admin/github-app');
    const elsewhere = sections.filter((section) => section.key !== 'admin').flatMap((section) => section.items);
    expect(elsewhere.some((item) => item.href === '/admin/github-app')).toBe(false);
  });

  it('is not there for anyone who is not a super admin, nor for someone not signed in', () => {
    for (const user of [someone, null]) {
      const labels = getNavSections(user).flatMap((section) => section.items.map((item) => item.label));
      expect(labels).not.toContain('GitHub for Universe');
    }
  });

  it('points at a page Orbit knows, with Orbit to go back to', () => {
    expect(ROUTES.find((entry) => entry.pattern === '/admin/github-app')?.parent).toBe('/admin');
  });

  it('is a plain link in the open menu, found by typing "github"', () => {
    render(<MenuSheet user={superAdmin} />);
    const link = screen.getByRole('link', { name: 'GitHub for Universe' });
    expect(link.getAttribute('href')).toBe('/admin/github-app');
    expect(within(screen.getByRole('region', { name: 'Admin' })).getByRole('link', { name: 'GitHub for Universe' })).toBe(link);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'github' } });
    expect(screen.getAllByRole('link', { name: 'GitHub for Universe' })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'Bots' })).toBeNull();
  });

  it('is not in the menu of anyone else', () => {
    render(<MenuSheet user={someone} />);
    expect(screen.queryByRole('link', { name: 'GitHub for Universe' })).toBeNull();
  });
});

describe('Orbit home', () => {
  it('says nothing about GitHub setup, even to a super admin, and never asks the server', () => {
    const bootstrap = { user: { id: 'u1', isSuperAdmin: true } } as unknown as AdminBootstrap;
    const { container } = render(
      <AdminBootstrapProvider value={bootstrap}>
        <AdminDashboard />
      </AdminBootstrapProvider>,
    );
    expect(container.textContent).not.toMatch(/GitHub/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
