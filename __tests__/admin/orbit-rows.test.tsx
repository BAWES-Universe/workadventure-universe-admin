/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MembershipsRow, StarsRow, UniversesRow } from '@/app/admin/components/orbit/rows';
import { AdminBootstrapProvider, type AdminBootstrap } from '@/app/admin/admin-bootstrap-context';
import type { LiveView, LivePlace } from '@/lib/live-presence';

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

function route(routes: Record<string, unknown>) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return ok({});
    return ok(routes[url.split('?')[0]] ?? {});
  });
}

const bootstrap = (universes: number): AdminBootstrap => ({
  version: 1,
  user: { id: 'u', uuid: 'u', name: 'Khalid', email: null, tags: [], isSuperAdmin: false },
  stats: { universes: 0, worlds: 0, rooms: 0, users: 0 },
  mine: { universes, worlds: 0, stars: 0, invitations: 0 },
});

/** A room with `count` people listed in it (you among them when `here`), as Live now gives it. */
function place(roomId: string, universeId: string, count: number, bots = 0, here = false): LivePlace {
  const people = Array.from({ length: count }, (_, index) => ({
    uuid: here && index === 0 ? 'me' : `${roomId}-${index}`,
    userId: `${roomId}-${index}`,
    name: `Person ${index}`,
    status: 'online',
    woka: [],
    you: here && index === 0,
    friend: false,
  })) as LivePlace['people'];
  return { roomId, name: roomId, world: { id: 'w', name: 'World' }, universe: { id: universeId, name: universeId }, playPath: '/@/x', count, guests: 0, bots, here, people };
}
const live = (places: LivePlace[]): LiveView => ({ available: true, generatedAt: Date.now(), places, botRooms: [], people: [] });

const names = (row: HTMLElement, selector: string) => Array.from(row.querySelectorAll(selector)).map((node) => node.textContent);

beforeEach(() => fetchMock.mockReset());

describe('Your stars on Orbit', () => {
  const stars = {
    rooms: [
      { id: 'r-hq', name: 'Headquarters', world: { name: 'Office', universe: { name: 'BAWES' } } },
      { id: 'r-quiet', name: 'Library', world: { name: 'Office', universe: { name: 'BAWES' } } },
      { id: 'r-conf', name: 'Conference', world: { name: 'Sandbox', universe: { name: 'Sandbox' } } },
    ],
  };

  it('puts the busiest first, counts people only, and says where you are', async () => {
    route({ '/api/admin/stars/rooms': stars });
    render(<StarsRow live={live([place('r-conf', 'u2', 4, 3), place('r-hq', 'u1', 2, 1, true)])} />);
    const row = await screen.findByTestId('orbit-stars');
    await waitFor(() => expect(names(row, 'strong')).toEqual(['Conference', 'Headquarters', 'Library']));
    const [conference, hq, library] = Array.from(row.querySelectorAll('a[data-kind="star"]'));
    expect(conference.textContent).toContain('4 here');
    // You're in Headquarters: it says so instead of a count.
    expect(hq.textContent).toContain('You’re here');
    expect(library.textContent).not.toMatch(/here/);
    expect(row.textContent).not.toMatch(/bot/);
    expect(within(row).getByRole('link', { name: 'View all' }).getAttribute('href')).toBe('/admin/stars');
  });

  it('keeps your order when nobody is anywhere', async () => {
    route({ '/api/admin/stars/rooms': stars });
    render(<StarsRow live={null} />);
    const row = await screen.findByTestId('orbit-stars');
    await waitFor(() => expect(names(row, 'strong')).toEqual(['Headquarters', 'Library', 'Conference']));
  });

  it('leads someone with no stars to rooms, with no View all', async () => {
    route({ '/api/admin/stars/rooms': { rooms: [] } });
    render(<StarsRow />);
    expect((await screen.findByTestId('empty-stars')).getAttribute('href')).toBe('/admin/discover/rooms');
    expect(screen.queryByText('View all')).toBeNull();
  });
});

describe('Your universes on Orbit', () => {
  it('shows the planet cards, busiest first, with Featured only on featured universes', async () => {
    route({
      '/api/admin/universes': {
        universes: [
          { id: 'u1', name: 'BAWES', isPublic: true, featured: true, _count: { worlds: 2, rooms: 18 } },
          { id: 'u2', name: 'Plugn', isPublic: true, featured: false, _count: { worlds: 1, rooms: 3 } },
        ],
      },
    });
    render(
      <AdminBootstrapProvider value={bootstrap(2)}>
        <UniversesRow live={live([place('r1', 'u2', 2), place('r2', 'u2', 1, 5), place('r3', 'u1', 1, 0, true)])} />
      </AdminBootstrapProvider>,
    );
    const row = await screen.findByTestId('orbit-universes');
    await waitFor(() => expect(names(row, 'h3')).toEqual(['Plugn', 'BAWES']));
    const [plugn, bawes] = Array.from(row.querySelectorAll('a[data-kind="universe"]'));
    expect(plugn.textContent).toContain('3 here');
    // Only you are in BAWES, and you aren't counted.
    expect(bawes.textContent).not.toMatch(/\d here/);
    expect(screen.getAllByText('Featured')).toHaveLength(1);
    expect(within(row).getByRole('link', { name: /New universe/ }).getAttribute('href')).toBe('/admin/universes/new');
  });

  it('counts someone in two rooms of one universe at once only once', async () => {
    route({ '/api/admin/universes': { universes: [{ id: 'u1', name: 'BAWES', isPublic: true }] } });
    const sara = { uuid: 'sara', userId: 's', name: 'Sara', status: 'online', woka: [], you: false, friend: false } as LivePlace['people'][number];
    const me = { ...sara, uuid: 'me', userId: 'm', name: 'Khalid', you: true };
    const lobby = { ...place('r1', 'u1', 2, 0, true), people: [sara, me] };
    const studio = { ...place('r2', 'u1', 2), guests: 1, people: [sara] };
    render(
      <AdminBootstrapProvider value={bootstrap(1)}>
        <UniversesRow live={live([lobby, studio])} />
      </AdminBootstrapProvider>,
    );
    const row = await screen.findByTestId('orbit-universes');
    // Sara (in both rooms) and one guest; you are left out.
    await waitFor(() => expect(row.querySelector('a[data-kind="universe"]')?.textContent).toContain('2 here'));
  });

  it('ends with a card to all of them when there are more than it shows', async () => {
    route({ '/api/admin/universes': { universes: [{ id: 'u1', name: 'BAWES', isPublic: true }] } });
    render(
      <AdminBootstrapProvider value={bootstrap(30)}>
        <UniversesRow />
      </AdminBootstrapProvider>,
    );
    expect((await screen.findByRole('link', { name: /All 30 universes/ })).getAttribute('href')).toBe('/admin/universes');
  });

  it('invites someone with none to make one', async () => {
    route({ '/api/admin/universes': { universes: [] } });
    render(
      <AdminBootstrapProvider value={bootstrap(0)}>
        <UniversesRow />
      </AdminBootstrapProvider>,
    );
    expect((await screen.findByTestId('empty-universes')).getAttribute('href')).toBe('/admin/universes/new');
  });
});

describe('Your memberships on Orbit', () => {
  const membership = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    universe: { id, name, worlds: [{ id: `${id}-w`, name: `${name} World` }] },
    isOwner: false,
    joinedAt: '2025-12-03T00:00:00.000Z',
    worlds: { allWorlds: true, worldIds: [] },
    roles: [],
    ...extra,
  });

  it('lists the universes you joined (not the ones you own), busiest first, with your roles', async () => {
    route({
      '/api/memberships/my/universes': {
        universes: [
          membership('u1', 'uniboz', { roles: [{ key: 'admin', name: 'Admin', color: '#ef4444', allWorlds: true, worldIds: [] }] }),
          membership('u2', 'Plugn'),
          membership('u3', 'Mine', { isOwner: true }),
        ],
      },
      '/api/memberships/invitations': { invitations: [] },
    });
    render(<MembershipsRow live={live([place('r1', 'u2', 2)])} />);
    const row = await screen.findByTestId('orbit-memberships');
    await waitFor(() => expect(names(row, 'strong')).toEqual(['Plugn', 'uniboz']));
    const [plugn, uniboz] = Array.from(row.querySelectorAll('a[data-kind="universe"]'));
    expect(plugn.textContent).toContain('2 here');
    expect(plugn.textContent).toContain('Member');
    expect(uniboz.textContent).toContain('Admin');
    expect(uniboz.textContent).toMatch(/uniboz World.*Joined Dec 2025/);
    expect(within(row).getByRole('link', { name: 'Manage' }).getAttribute('href')).toBe('/admin/memberships');
  });

  it('answers an invitation in place, first in the row, and shows the new membership', async () => {
    let joined = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        joined = true;
        return ok({});
      }
      const path = url.split('?')[0];
      if (path === '/api/memberships/my/universes') return ok({ universes: joined ? [membership('u9', 'Plugn')] : [] });
      return ok({ invitations: [{ id: 'i1', tags: ['member'], world: { id: 'w3', name: 'Studio', universe: { name: 'Plugn' } }, invitedBy: { name: 'Sara', email: null } }] });
    });
    render(<MembershipsRow />);
    const invitation = await screen.findByTestId('invitation');
    expect(invitation.textContent).toContain('Sara invited you as member');
    expect(within(invitation).getByRole('link', { name: 'Studio' }).getAttribute('href')).toBe('/admin/invitations/i1');
    fireEvent.click(within(invitation).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(screen.queryByTestId('invitation')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/memberships/invitations/i1/accept', { method: 'POST' });
    expect(await screen.findByText('Plugn')).toBeTruthy();
  });

  it('asks before declining, and locks only the invitation being answered', async () => {
    let finishFirst: () => void = () => undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/i1/')) return new Promise((resolve) => (finishFirst = () => resolve({ ok: true, json: () => Promise.resolve({}) })));
      if (init?.method === 'POST') return ok({});
      if (url.startsWith('/api/memberships/my/universes')) return ok({ universes: [] });
      return ok({
        invitations: [
          { id: 'i1', tags: ['member'], world: { id: 'w1', name: 'Studio', universe: { name: 'Plugn' } }, invitedBy: { name: 'Sara', email: null } },
          { id: 'i2', tags: ['member'], world: { id: 'w2', name: 'Office', universe: { name: 'BAWES' } }, invitedBy: { name: 'Sara', email: null } },
        ],
      });
    });
    render(<MembershipsRow />);
    await screen.findAllByTestId('invitation');
    fireEvent.click(screen.getAllByRole('button', { name: 'Accept' })[0]);
    const [studioAccept, officeAccept] = screen.getAllByRole('button', { name: 'Accept' });
    expect((studioAccept as HTMLButtonElement).disabled).toBe(true);
    expect((officeAccept as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Decline the invitation to Office/ }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/i2/reject'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/i2/reject'))).toBe(true));
    finishFirst();
    await waitFor(() => expect(screen.queryAllByTestId('invitation')).toHaveLength(0));
    expect(await screen.findByTestId('empty-memberships')).toBeTruthy();
  });

  it('keeps invitations you can answer when your memberships cannot load', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/memberships/my/universes')) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      return ok({ invitations: [{ id: 'i1', tags: [], world: { id: 'w1', name: 'Studio', universe: { name: 'Plugn' } }, invitedBy: null }] });
    });
    render(<MembershipsRow />);
    const invitation = await screen.findByTestId('invitation');
    expect(within(invitation).getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('We couldn’t load your memberships.');
  });

  it('waits for your invitations before saying you have joined nothing', async () => {
    let answer: () => void = () => undefined;
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/memberships/my/universes')) return ok({ universes: [] });
      return new Promise((resolve) => (answer = () => resolve({ ok: true, json: () => Promise.resolve({ invitations: [{ id: 'i1', tags: [], world: { id: 'w1', name: 'Studio', universe: { name: 'Plugn' } }, invitedBy: null }] }) })));
    });
    render(<MembershipsRow />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/memberships/my/universes', expect.anything()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('empty-memberships')).toBeNull();
    answer();
    expect(await screen.findByTestId('invitation')).toBeTruthy();
    expect(screen.queryByTestId('empty-memberships')).toBeNull();
  });

  it('says so when you have joined nothing yet', async () => {
    route({ '/api/memberships/my/universes': { universes: [membership('u3', 'Mine', { isOwner: true })] }, '/api/memberships/invitations': { invitations: [] } });
    render(<MembershipsRow />);
    expect((await screen.findByTestId('empty-memberships')).textContent).toMatch(/invites you/);
    expect(screen.queryByText('Manage')).toBeNull();
  });
});
