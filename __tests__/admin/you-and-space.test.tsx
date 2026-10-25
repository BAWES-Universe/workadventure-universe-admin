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

// Get started as You hands it down: not hidden.
const shown = { hidden: false, hide: () => undefined };

beforeEach(() => fetchMock.mockReset());

describe('You, for someone new', () => {
  it('shows first steps, and no universes, memberships or stars: those are rows on Orbit', async () => {
    route({
      '/api/admin/universes': { universes: [] },
      '/api/memberships/my': { memberships: [] },
      '/api/memberships/invitations': { invitations: [] },
      '/api/admin/stars/rooms': { rooms: [] },
    });
    render(
      <AdminBootstrapProvider value={bootstrap({ universes: 0, worlds: 0, stars: 0, invitations: 0 })}>
        <Yours profileComplete={false} getStarted={shown} />
      </AdminBootstrapProvider>,
    );
    const steps = await screen.findByTestId('get-started');
    expect(within(steps).getByText(/0 of 5/)).toBeTruthy();
    expect(within(steps).getByRole('link', { name: /Create your universe/ }).getAttribute('href')).toBe('/admin/universes/new?next=world');
    // A world needs a universe first, and inviting needs a world: those steps aren't links yet.
    expect(within(steps).queryByRole('link', { name: /Create a world/ })).toBeNull();
    expect(within(steps).queryByRole('link', { name: /Invite a member/ })).toBeNull();
    expect(screen.queryByText('Your universes')).toBeNull();
    expect(screen.queryByText('Memberships')).toBeNull();
    expect(screen.queryByText('Stars')).toBeNull();
    expect(screen.queryByTestId('empty-universes')).toBeNull();
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
        <Yours profileComplete getStarted={shown} />
      </AdminBootstrapProvider>,
    );
    const steps = await screen.findByTestId('get-started');
    await waitFor(() =>
      expect(within(steps).getByRole('link', { name: /Create a world/ }).getAttribute('href')).toBe('/admin/worlds/new?universeId=u1'),
    );
  });
});

describe('You, as an owner', () => {
  it('keeps "Invite a member" as a step: being a member (even an owner) does not tick it', async () => {
    route({
      '/api/admin/universes': { universes: [{ id: 'u1', name: 'BAWES', isPublic: true, _count: { worlds: 2, rooms: 18 } }] },
      '/api/memberships/my': {
        memberships: [{ id: 'm1', tags: ['admin'], isUniverseOwner: true, world: { id: 'w1', name: 'Office', universe: { name: 'BAWES' } } }],
      },
      '/api/admin/stars/rooms': { rooms: [] },
    });
    render(
      <AdminBootstrapProvider value={bootstrap({ universes: 1, worlds: 1, stars: 0, invitations: 0 })}>
        <Yours profileComplete getStarted={shown} />
      </AdminBootstrapProvider>,
    );
    const steps = await screen.findByTestId('get-started');
    await waitFor(() => expect(within(steps).getByRole('link', { name: /Invite a member/ }).getAttribute('href')).toBe('/admin/worlds/w1?tab=members'));
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
