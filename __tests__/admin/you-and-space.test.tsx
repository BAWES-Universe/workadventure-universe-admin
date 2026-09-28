/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Yours from '@/app/admin/components/yours';
import SpacePage from '@/app/admin/space/page';
import { AdminBootstrapProvider, type AdminBootstrap } from '@/app/admin/admin-bootstrap-context';
import { UNIVERSE_COLOURS, universeColour } from '@/lib/universe-colour';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const replace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace }),
  usePathname: () => '/admin/space',
  useSearchParams: () => new URLSearchParams(),
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

function bootstrap(mine: AdminBootstrap['mine']): AdminBootstrap {
  return {
    version: 1,
    user: { id: 'u', uuid: 'u', name: 'Khalid', email: 'k@example.com', tags: [], isSuperAdmin: false },
    stats: { universes: 14, worlds: 41, rooms: 233, users: 1208 },
    mine,
  };
}

function route(routes: Record<string, unknown>) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const path = url.split('?')[0];
    if (init?.method === 'POST') return ok({});
    return ok(routes[path] ?? {});
  });
}

beforeEach(() => fetchMock.mockReset());

describe('You, for someone new', () => {
  it('shows empty sections that lead somewhere, with no "View all" on empty lists and no first-steps list', async () => {
    route({
      '/api/admin/universes': { universes: [] },
      '/api/memberships/my': { memberships: [] },
      '/api/memberships/invitations': { invitations: [] },
      '/api/admin/stars/rooms': { rooms: [] },
    });
    render(
      <AdminBootstrapProvider value={bootstrap({ universes: 0, worlds: 0, stars: 0, invitations: 0 })}>
        <Yours />
      </AdminBootstrapProvider>,
    );
    expect((await screen.findByTestId('empty-universes')).getAttribute('href')).toBe('/admin/universes/new');
    // First steps are the game's quests now.
    expect(screen.queryByText('Get started')).toBeNull();
    expect((await screen.findByTestId('empty-memberships')).textContent).toMatch(/invites you|world of your own/);
    expect((await screen.findByTestId('empty-stars')).getAttribute('href')).toBe('/admin/discover/rooms');
    expect(screen.queryByText('View all')).toBeNull();
    expect(screen.queryByText('Manage')).toBeNull();
  });
});

describe('You, with one universe and no world', () => {
  it('sends "Create a world" straight to that universe', async () => {
    route({
      '/api/admin/universes': { universes: [{ id: 'u1', name: 'BAWES', isPublic: true }] },
      '/api/memberships/my': { memberships: [] },
      '/api/memberships/invitations': { invitations: [] },
      '/api/admin/stars/rooms': { rooms: [] },
    });
    render(
      <AdminBootstrapProvider value={bootstrap({ universes: 1, worlds: 0, stars: 0, invitations: 0 })}>
        <Yours />
      </AdminBootstrapProvider>,
    );
    await waitFor(async () =>
      expect((await screen.findByTestId('empty-memberships')).getAttribute('href')).toBe('/admin/worlds/new?universeId=u1'),
    );
  });
});

describe('You, with memberships', () => {
  it('answers an invitation in place and shows roles', async () => {
    route({
      '/api/admin/universes': { universes: [{ id: 'u1', name: 'BAWES', isPublic: true, _count: { worlds: 2, rooms: 18 } }] },
      '/api/memberships/my': {
        memberships: [{ id: 'm1', tags: ['admin'], isUniverseOwner: true, world: { id: 'w1', name: 'Office', universe: { name: 'BAWES' } } }],
      },
      '/api/memberships/invitations': {
        invitations: [{ id: 'i1', tags: ['member'], world: { id: 'w3', name: 'Studio', universe: { name: 'Plugn' } }, invitedBy: { name: 'Sara', email: null } }],
      },
      '/api/admin/stars/rooms': { rooms: [] },
    });
    render(
      <AdminBootstrapProvider value={bootstrap({ universes: 1, worlds: 1, stars: 0, invitations: 1 })}>
        <Yours />
      </AdminBootstrapProvider>,
    );
    const invitations = await screen.findByTestId('invitations');
    expect(invitations.textContent).toContain('Sara invited you as member');
    // The invitation opens its own page for more before deciding.
    expect(within(invitations).getByRole('link', { name: 'Studio' }).getAttribute('href')).toBe('/admin/invitations/i1');
    fireEvent.click(within(invitations).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(screen.queryByTestId('invitations')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/memberships/invitations/i1/accept', { method: 'POST' });
    expect((await screen.findByText('Office')).closest('div')?.parentElement?.textContent).toMatch(/Owner.*Admin/);
  });
});

describe('You, declining', () => {
  it('asks before declining, and locks only the invitation being answered', async () => {
    let finishFirst: () => void = () => undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/i1/')) return new Promise((resolve) => (finishFirst = () => resolve({ ok: true, json: () => Promise.resolve({}) })));
      if (init?.method === 'POST') return ok({});
      const path = url.split('?')[0];
      const routes: Record<string, unknown> = {
        '/api/admin/universes': { universes: [] },
        '/api/memberships/my': { memberships: [] },
        '/api/memberships/invitations': {
          invitations: [
            { id: 'i1', tags: ['member'], world: { id: 'w1', name: 'Studio', universe: { name: 'Plugn' } }, invitedBy: { name: 'Sara', email: null } },
            { id: 'i2', tags: ['member'], world: { id: 'w2', name: 'Office', universe: { name: 'BAWES' } }, invitedBy: { name: 'Sara', email: null } },
          ],
        },
        '/api/admin/stars/rooms': { rooms: [] },
      };
      return ok(routes[path] ?? {});
    });
    render(
      <AdminBootstrapProvider value={bootstrap({ universes: 0, worlds: 0, stars: 0, invitations: 2 })}>
        <Yours />
      </AdminBootstrapProvider>,
    );
    const invitations = await screen.findByTestId('invitations');
    fireEvent.click(within(invitations).getAllByRole('button', { name: 'Accept' })[0]);
    // Answering Studio leaves Office free to answer.
    const [studioAccept, officeAccept] = within(invitations).getAllByRole('button', { name: 'Accept' });
    expect((studioAccept as HTMLButtonElement).disabled).toBe(true);
    expect((officeAccept as HTMLButtonElement).disabled).toBe(false);
    // Declining asks first.
    fireEvent.click(within(invitations).getByRole('button', { name: /Decline the invitation to Office/ }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/i2/reject'))).toBe(false);
    fireEvent.click(within(invitations).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/i2/reject'))).toBe(true));
    finishFirst();
    await waitFor(() => expect(screen.queryByTestId('invitations')).toBeNull());
  });
});

describe('Space', () => {
  it('searches everything at once and hides what has no match', async () => {
    route({
      '/api/admin/universes': { universes: [{ id: 'u1', name: 'BAWES' }] },
      '/api/admin/worlds': { worlds: [{ id: 'w1', name: 'Office', universe: { id: 'u1', name: 'BAWES' } }] },
      '/api/admin/rooms': { rooms: [] },
      '/api/admin/users': { users: [{ id: 'p1', name: 'Sara' }] },
    });
    render(
      <AdminBootstrapProvider value={bootstrap({ universes: 0, worlds: 0, stars: 0, invitations: 0 })}>
        <SpacePage />
      </AdminBootstrapProvider>,
    );
    expect(await screen.findByRole('link', { name: 'BAWES' })).toBeTruthy();
    fireEvent.change(screen.getByTestId('space-search'), { target: { value: 'off' } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('search=off'))).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('space-rooms')).toBeNull());
    for (const path of ['/api/admin/universes', '/api/admin/worlds', '/api/admin/rooms', '/api/admin/users']) {
      expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(path) && String(url).includes('search=off'))).toBe(true);
    }
    // Guests are left out by the server, before paging.
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/admin/users') && String(url).includes('guests=exclude'))).toBe(true);
    // The search is in the address, and See all keeps it.
    expect(replace).toHaveBeenCalledWith('/admin/space?q=off', { scroll: false });
    const universesSection = screen.getByTestId('space-universes');
    expect(within(universesSection).getAllByRole('link').some((link) => link.getAttribute('href') === '/admin/discover/universes?q=off')).toBe(true);
  });
});

describe('Universe colours', () => {
  it('gives the same universe the same colour, from the palette', () => {
    expect(universeColour('abc')).toBe(universeColour('abc'));
    expect(UNIVERSE_COLOURS).toContain(universeColour('abc'));
    const spread = new Set(Array.from({ length: 40 }, (_, index) => universeColour(`universe-${index}`)));
    expect(spread.size).toBeGreaterThan(3);
  });
});
