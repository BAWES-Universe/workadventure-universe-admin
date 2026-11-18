/** @jest-environment jsdom */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import SpacePage from '@/app/admin/space/page';
import DiscoverUniversesPage from '@/app/admin/discover/universes/page';
import MyUniversesPage from '@/app/admin/universes/page';
import { UniverseCard } from '@/app/admin/universes/universe-card';
import { AdminBootstrapProvider, type AdminBootstrap } from '@/app/admin/admin-bootstrap-context';
import { clearSummaryCache } from '@/app/admin/hooks/use-room-analytics';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/space',
  useSearchParams: () => new URLSearchParams(),
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) } as Response);

const owner = { id: 'p1', name: 'Faisal', email: 'faisal@example.com' };
const universe = { id: 'u1', slug: 'bawes', name: 'BAWES', description: 'A place', isPublic: true, featured: false, thumbnailUrl: null, owner, _count: { worlds: 2, rooms: 5 } };

const bootstrap: AdminBootstrap = {
  version: 1,
  user: { id: 'me', uuid: 'me', name: 'Khalid', email: 'k@example.com', tags: [], isSuperAdmin: false },
  stats: { universes: 1, worlds: 2, rooms: 5, users: 3 },
  mine: { universes: 1, worlds: 2, stars: 0, invitations: 0 },
};

beforeEach(() => {
  fetchMock.mockReset();
  clearSummaryCache();
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/admin/universes')) return json({ universes: [universe], pagination: { total: 1, totalPages: 1 }, total: 1, totalPages: 1 });
    if (url.startsWith('/api/auth/me')) return json({ user: { id: 'me' } });
    return json({});
  });
});

const noOwnerText = (root: HTMLElement) => {
  expect(root.textContent).not.toMatch(/by Faisal/i);
  expect(root.textContent).not.toMatch(/Faisal/);
  expect(root.textContent).not.toMatch(/Owned by you/i);
  expect(root.textContent).not.toMatch(/\bowner\b/i);
};

describe('Universe cards show no owner line and no owner badge', () => {
  it('on Space', async () => {
    render(
      <AdminBootstrapProvider value={bootstrap}>
        <SpacePage />
      </AdminBootstrapProvider>,
    );
    const section = await screen.findByTestId('space-universes');
    await within(section).findByText('BAWES');
    noOwnerText(section);
  });

  it('on Discover', async () => {
    const { container } = render(<DiscoverUniversesPage />);
    await screen.findByText('BAWES');
    noOwnerText(container);
  });

  it('on your own universes list', async () => {
    const { container } = render(<MyUniversesPage />);
    await screen.findByText('BAWES');
    noOwnerText(container);
  });

  it('on the shared card, whoever owns it', () => {
    const { container } = render(<UniverseCard universe={universe} />);
    expect(screen.getByText('BAWES')).toBeTruthy();
    noOwnerText(container);
  });
});
