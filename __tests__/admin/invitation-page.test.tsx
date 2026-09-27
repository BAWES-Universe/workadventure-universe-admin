/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import InvitationPage from '@/app/admin/invitations/[id]/page';
import PendingInvitationsAlert from '@/app/admin/components/pending-invitations-alert';
import { WorkAdventureContext, type WorkAdventureContextValue } from '@/app/admin/workadventure-context';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'inv-1' }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  usePathname: () => '/admin/invitations/inv-1',
}));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const respond = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    status: 'pending',
    tags: ['editor'],
    message: 'Come build with us',
    invitedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    respondedAt: null,
    invitedBy: { id: 'u-sara', name: 'Sara', woka: [] },
    world: {
      id: 'w-1',
      name: 'Studio',
      slug: 'studio',
      description: 'Where we make things',
      isPublic: false,
      thumbnailUrl: null,
      universe: { id: 'un-1', name: 'Plugn', slug: 'plugn' },
      counts: { rooms: 3, members: 9 },
      firstRoom: { slug: 'lobby' },
      members: [{ id: 'u-sara', name: 'Sara', woka: ['https://play.test/sara.png'] }],
    },
    ...overrides,
  };
}

function game(isReady: boolean): WorkAdventureContextValue & { navigateToRoom: jest.Mock } {
  return { wa: null, isReady, isLoading: false, error: null, navigateToRoom: jest.fn().mockResolvedValue(undefined) };
}

function renderPage(wa = game(true)) {
  render(
    <WorkAdventureContext.Provider value={wa}>
      <InvitationPage />
    </WorkAdventureContext.Provider>,
  );
  return wa;
}

function routeDetail(detail: unknown, status = 200) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return respond({ success: true });
    if (url === '/api/memberships/invitations/inv-1') return respond(detail, status);
    return respond({});
  });
}

beforeEach(() => fetchMock.mockReset());

describe('The invitation page', () => {
  it('shows who invited you, the world, the role in plain words, and Accept and Decline', async () => {
    routeDetail({ invitation: invitation() });
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Studio' })).toBeTruthy();
    expect(screen.getByText('In Plugn')).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();
    expect(screen.getByTestId('invitation-inviter').querySelector('a')?.getAttribute('href')).toBe('/admin/users/u-sara');
    expect(screen.getByText(/invited you 2 days ago/)).toBeTruthy();
    expect(screen.getByTestId('invitation-message').textContent).toContain('Come build with us');
    expect(screen.getByText('3 rooms · 9 members')).toBeTruthy();
    expect(screen.getByText('Private')).toBeTruthy();
    expect(screen.getByTestId('invitation-role').textContent).toMatch(/edit its maps, rooms and bots/);
    const actions = screen.getByTestId('invitation-actions');
    expect(within(actions).getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(within(actions).getByRole('button', { name: 'Decline' })).toBeTruthy();
  });

  it('shows as many members as fit in one row, the last slot counting the rest', async () => {
    const members = Array.from({ length: 8 }, (_, i) => ({ id: `u-${i}`, name: `Member ${i}`, woka: [] }));
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const observers: ResizeObserverCallback[] = [];
    const previous = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    // A phone's row: 4 slots of 64px.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 260 });
    try {
      routeDetail({ invitation: invitation({ world: { ...invitation().world, counts: { rooms: 3, members: 12 }, members } }) });
      renderPage();
      const row = await screen.findByTestId('invitation-members');
      await waitFor(() => expect(row.querySelectorAll('li')).toHaveLength(4));
      expect(row.textContent).toContain('Member 2');
      expect(row.textContent).not.toContain('Member 3');
      expect(row.textContent).toContain('+9 more members');
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
      globalThis.ResizeObserver = previous;
    }
  });

  it('describes a custom role by name', async () => {
    routeDetail({ invitation: invitation({ tags: ['dj'] }) });
    renderPage();
    const role = await screen.findByTestId('invitation-role');
    expect(role.textContent).toMatch(/Dj/);
    expect(role.textContent).toMatch(/custom role set by the world’s admins/);
  });

  it('accepting makes you a member, offers Visit inside the game, and tells Orbit', async () => {
    routeDetail({ invitation: invitation() });
    const refresh = jest.fn();
    window.addEventListener('orbit:refresh', refresh);
    const wa = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    const done = await screen.findByTestId('invitation-accepted');
    expect(done.textContent).toMatch(/You’re a member of Studio/);
    expect(fetchMock).toHaveBeenCalledWith('/api/memberships/invitations/inv-1/accept', { method: 'POST' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/accept'))).toHaveLength(1);
    expect(within(done).getByRole('link', { name: 'Open Studio’s page' }).getAttribute('href')).toBe('/admin/worlds/w-1');
    await act(async () => fireEvent.click(within(done).getByRole('button', { name: 'Visit Studio' })));
    expect(wa.navigateToRoom).toHaveBeenCalledWith('/@/plugn/studio/lobby');
    expect((refresh.mock.calls[0][0] as CustomEvent).detail).toEqual({ topic: 'memberships' });
    expect(screen.queryByTestId('invitation-actions')).toBeNull();
    window.removeEventListener('orbit:refresh', refresh);
  });

  it('hides Visit outside the game', async () => {
    routeDetail({ invitation: invitation() });
    renderPage(game(false));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await screen.findByTestId('invitation-accepted');
    expect(screen.queryByRole('button', { name: /Visit/ })).toBeNull();
  });

  it('declining asks first, then says it is done', async () => {
    routeDetail({ invitation: invitation() });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/reject'))).toBe(false);
    const confirm = screen.getByTestId('decline-confirm');
    expect(confirm.textContent).toMatch(/Decline Sara’s invitation to Studio\? They’d need to invite you again\./);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Decline invitation' }));
    expect(await screen.findByText('Invitation declined.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/memberships/invitations/inv-1/reject', { method: 'POST' });
    expect(screen.getByRole('link', { name: 'Back to Orbit' }).getAttribute('href')).toBe('/admin');
  });

  it.each([
    ['accepted', 'You already accepted this invitation.'],
    ['rejected', 'You already declined this invitation.'],
    ['cancelled', 'This invitation was withdrawn.'],
  ])('an invitation already %s says so and has no Accept or Decline', async (status, text) => {
    routeDetail({ invitation: invitation({ status }) });
    renderPage();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    expect(screen.queryByText('Waiting')).toBeNull();
    const link = screen.queryByRole('link', { name: 'Open Studio’s page' });
    expect(Boolean(link)).toBe(status === 'accepted');
  });

  it('a missing invitation leads back to You', async () => {
    routeDetail({ error: 'Invitation not found' }, 404);
    renderPage();
    expect((await screen.findByTestId('invitation-missing')).getAttribute('href')).toBe('/admin/you');
    expect(screen.getByText('We couldn’t find this invitation')).toBeTruthy();
  });

  it('a failed load can be retried', async () => {
    routeDetail({}, 500);
    renderPage();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    routeDetail({ invitation: invitation() });
    await act(async () => fireEvent.click(retry));
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeTruthy();
  });
});

describe('The invitations card on Orbit', () => {
  const listed = (id: string, world: string, extra: Record<string, unknown> = {}) => ({
    id,
    tags: ['member'],
    message: 'Join us for standup',
    invitedAt: new Date(Date.now() - 3_600_000).toISOString(),
    world: { id: `w-${id}`, name: world, slug: world.toLowerCase(), universe: { id: 'un-1', name: 'Plugn', slug: 'plugn' } },
    invitedBy: { id: 'u-sara', name: 'Sara', email: null },
    ...extra,
  });

  function routeList(invitations: unknown[] | null) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' || init?.method === 'PUT') return respond({ success: true });
      if (url === '/api/memberships/invitations') return invitations ? respond({ invitations }) : respond({}, 500);
      if (url.startsWith('/api/me/preferences')) return respond({ preferences: {} });
      if (url.startsWith('/api/memberships/invitations/')) return respond({ invitation: { invitedBy: { woka: [] } } });
      return respond({});
    });
  }

  it('one invitation: who, what, as what, and View invitation or Decline', async () => {
    routeList([listed('i1', 'Studio')]);
    render(<PendingInvitationsAlert />);
    const card = await screen.findByTestId('pending-invitations');
    expect(card.textContent).toMatch(/Sara invited you to Studio in Plugn/);
    expect(card.textContent).toMatch(/as a member/);
    expect(within(card).getByTestId('pending-invitation-message').textContent).toContain('Join us for standup');
    expect(within(card).getByRole('link', { name: 'View invitation' }).getAttribute('href')).toBe('/admin/invitations/i1');
    fireEvent.click(within(card).getByRole('button', { name: 'Decline' }));
    expect(within(card).getByTestId('decline-confirm').textContent).toMatch(/Decline Sara’s invitation to Studio\?/);
    fireEvent.click(within(card).getByRole('button', { name: 'Decline invitation' }));
    await waitFor(() => expect(screen.queryByTestId('pending-invitations')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/memberships/invitations/i1/reject', { method: 'POST' });
  });

  it('several invitations: a count and one row each, leading to its invitation', async () => {
    routeList([listed('i1', 'Studio'), listed('i2', 'Office')]);
    render(<PendingInvitationsAlert />);
    const card = await screen.findByTestId('pending-invitations');
    expect(card.textContent).toMatch(/You have 2 invitations/);
    const rows = within(card).getAllByTestId('pending-invitation-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByRole('link').getAttribute('href')).toBe('/admin/invitations/i2');
    expect(within(card).queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('can still be dismissed', async () => {
    routeList([listed('i1', 'Studio')]);
    render(<PendingInvitationsAlert />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('pending-invitations')).toBeNull();
  });

  it('a failed load offers to try again', async () => {
    routeList(null);
    render(<PendingInvitationsAlert />);
    const line = await screen.findByTestId('pending-invitations-error');
    routeList([listed('i1', 'Studio')]);
    fireEvent.click(within(line).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('pending-invitations')).toBeTruthy();
  });
});
