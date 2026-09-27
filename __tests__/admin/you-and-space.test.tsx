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
  it('shows first steps and empty sections that lead somewhere, with no "View all" on empty lists', async () => {
    route({
      '/api/admin/universes': { universes: [] },
      '/api/memberships/my': { memberships: [] },
      '/api/memberships/invitations': { invitations: [] },
      '/api/admin/stars/rooms': { rooms: [] },
    });
    render(
      <AdminBootstrapProvider value={bootstrap({ universes: 0, worlds: 0, stars: 0, invitations: 0 })}>
        <Yours profileComplete={false} />
      </AdminBootstrapProvider>,
    );
    const steps = await screen.findByTestId('get-started');
    expect(within(steps).getByText('0 of 4')).toBeTruthy();
    expect(within(steps).getByRole('link', { name: /Create your universe/ }).getAttribute('href')).toBe('/admin/universes/new');
    // A world needs a universe first: that step isn't a link yet.
    expect(within(steps).queryByRole('link', { name: /Add a world/ })).toBeNull();
    expect((await screen.findByTestId('empty-universes')).getAttribute('href')).toBe('/admin/universes/new');
    expect((await screen.findByTestId('empty-memberships')).textContent).toMatch(/invites you|world of your own/);
    expect((await screen.findByTestId('empty-stars')).getAttribute('href')).toBe('/admin/discover/rooms');
    expect(screen.queryByText('View all')).toBeNull();
    expect(screen.queryByText('Manage')).toBeNull();
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
        <Yours profileComplete />
      </AdminBootstrapProvider>,
    );
    const invitations = await screen.findByTestId('invitations');
    expect(invitations.textContent).toContain('Sara invited you as member');
    fireEvent.click(within(invitations).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(screen.queryByTestId('invitations')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/memberships/invitations/i1/accept', { method: 'POST' });
    expect((await screen.findByText('Office')).closest('div')?.parentElement?.textContent).toMatch(/Owner.*Admin/);
    // Someone with a universe and a world doesn't get the first steps.
    expect(screen.queryByTestId('get-started')).toBeNull();
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
