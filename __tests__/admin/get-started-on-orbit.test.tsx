/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GetStartedOnOrbit } from '@/app/admin/components/orbit/get-started-on-orbit';
import { AdminBootstrapProvider, type AdminBootstrap } from '@/app/admin/admin-bootstrap-context';

/**
 * Get started at the top of Orbit: the whole checklist when nothing is done, one line with the next step once something
 * is, nothing when every step is done or it was hidden.
 */

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

function bootstrap(mine: AdminBootstrap['mine']): AdminBootstrap {
  return { version: 1, user: { id: 'u', uuid: 'u', name: 'Khalid', email: null, tags: [], isSuperAdmin: false }, stats: { universes: 0, worlds: 0, rooms: 0, users: 0 }, mine };
}

function serve(options: { hidden?: boolean; bio?: string; universes?: unknown[]; memberships?: unknown[]; stars?: unknown[] }) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const path = url.split('?')[0];
    if (init?.method === 'PUT') return ok({});
    if (path === '/api/me/preferences') return ok({ preferences: { 'guidance.dismissed.getStarted': { hidden: options.hidden === true } } });
    if (path === '/api/admin/profile') return ok({ bio: options.bio ?? '', links: [] });
    if (path === '/api/admin/universes') return ok({ universes: options.universes ?? [] });
    if (path === '/api/memberships/my') return ok({ memberships: options.memberships ?? [] });
    if (path === '/api/admin/stars/rooms') return ok({ rooms: options.stars ?? [] });
    return ok({});
  });
}

function show(mine: AdminBootstrap['mine']) {
  return render(
    <AdminBootstrapProvider value={bootstrap(mine)}>
      <GetStartedOnOrbit />
    </AdminBootstrapProvider>,
  );
}

const MINE_NONE = { universes: 0, worlds: 0, stars: 0, invitations: 0 };

beforeEach(() => fetchMock.mockReset());

describe('Get started on Orbit', () => {
  it('shows the whole checklist when nothing is done yet', async () => {
    serve({});
    show(MINE_NONE);
    const card = await screen.findByTestId('get-started');
    expect(within(card).getByText(/0 of 5/)).toBeTruthy();
    expect(within(card).getByRole('link', { name: /Create your universe/ }).getAttribute('href')).toBe('/admin/universes/new?next=world');
    expect(screen.queryByTestId('get-started-strip')).toBeNull();
  });

  it('shows one line with the next step once something is done', async () => {
    serve({ bio: 'Hello', universes: [{ id: 'u1', name: 'BAWES', isPublic: true }] });
    show({ universes: 1, worlds: 0, stars: 0, invitations: 0 });
    const strip = await screen.findByTestId('get-started-strip');
    expect(strip.textContent).toContain('2 of 5 done');
    // The next step you can take: a world in your one universe, straight to it.
    expect(within(strip).getByRole('link', { name: /Create a world/ }).getAttribute('href')).toBe('/admin/worlds/new?universeId=u1');
    expect(screen.queryByTestId('get-started')).toBeNull();
  });

  it('names the invitation step "Invite a member" once you run a world', async () => {
    serve({
      bio: 'Hello',
      universes: [{ id: 'u1', name: 'BAWES', isPublic: true }],
      memberships: [{ id: 'm1', tags: ['admin'], isUniverseOwner: true, world: { id: 'w1', name: 'HQ', universe: { name: 'BAWES' } } }],
    });
    show({ universes: 1, worlds: 1, ownedWorlds: 1, stars: 0, invitations: 0 });
    const strip = await screen.findByTestId('get-started-strip');
    expect(within(strip).getByRole('link', { name: /Invite a member/ }).getAttribute('href')).toBe('/admin/worlds/w1?tab=members');
  });

  it('Hide saves it for the account, on Orbit and You together, and removes the line', async () => {
    serve({ bio: 'Hello' });
    show(MINE_NONE);
    const strip = await screen.findByTestId('get-started-strip');
    fireEvent.click(within(strip).getByRole('button', { name: 'Hide' }));
    expect(screen.queryByTestId('get-started-strip')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/me/preferences', {
      method: 'PUT',
      body: JSON.stringify({ key: 'guidance.dismissed.getStarted', value: { hidden: true } }),
    });
  });

  it('shows nothing when it was hidden before, and asks the profile and lists for nothing', async () => {
    serve({ hidden: true });
    const { container } = show(MINE_NONE);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toBe('');
    expect(fetchMock.mock.calls.map((call) => String(call[0]).split('?')[0])).toEqual(['/api/me/preferences']);
  });

  it('shows nothing when every step is done', async () => {
    serve({
      bio: 'Hello',
      universes: [{ id: 'u1', name: 'BAWES', isPublic: true }],
      memberships: [{ id: 'm1', tags: ['admin'], isUniverseOwner: true, world: { id: 'w1', name: 'HQ', universe: { name: 'BAWES' } } }],
      stars: [{ id: 'r1' }],
    });
    const { container } = show({ universes: 1, worlds: 1, ownedWorlds: 1, invitationsSent: 1, stars: 1, invitations: 0 });
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith('/api/admin/profile'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toBe('');
  });
});
