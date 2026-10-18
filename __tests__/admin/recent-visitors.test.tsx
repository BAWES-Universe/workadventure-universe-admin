/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render as renderPlain, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import RecentVisitors from '@/app/admin/components/recent-visitors';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const render = (ui: React.ReactElement) => renderPlain(<ToastProvider>{ui}</ToastProvider>);
const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const visitors = [
  { key: 'omar', userId: 'omar', guest: false, name: 'Omar', woka: [], at: ago(1), room: { id: 'r1', name: 'HQ Lobby' } },
  { key: 'sara', userId: 'sara', guest: false, name: 'Sara', woka: [], at: ago(4), room: { id: 'r1', name: 'HQ Lobby' } },
];

function serve(routes: Record<string, unknown>) {
  fetchMock.mockImplementation((path: string) => {
    const key = Object.keys(routes).find((candidate) => path.startsWith(candidate) && (candidate.endsWith('/passport') ? path.endsWith('/passport') : !path.endsWith('/passport')));
    return Promise.resolve(key ? { ok: true, json: async () => routes[key] } : { ok: false, status: 404, json: async () => ({}) });
  });
}

beforeEach(() => fetchMock.mockReset());

describe('Recent visitors', () => {
  it('shows a face for each person with a name and how long ago, and says these are past visits', async () => {
    serve({ '/api/admin/recent-visitors': { visitors } });
    render(<RecentVisitors scope="universe" id="u1" />);
    const section = await screen.findByTestId('recent-visitors');
    expect(within(section).getByText('Recent visitors')).toBeTruthy();
    expect(within(section).getByText('Who came by lately, newest first. Past visits, not who is online.')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Omar, 1 minute ago' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Sara, 4 minutes ago' })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/recent-visitors?scope=universe&id=u1');
  });

  it('draws each face on the colour the game gives that name, with a solid chip and no dashed lines', async () => {
    serve({ '/api/admin/recent-visitors': { visitors, guests: 3 } });
    render(<RecentVisitors scope="universe" id="u1" />);
    const section = await screen.findByTestId('recent-visitors');
    const omar = within(within(section).getByRole('button', { name: 'Omar, 1 minute ago' })).getByTestId('woka-avatar');
    expect(omar.getAttribute('data-tinted')).toBe('true');
    expect(omar.style.background).toBe('rgb(153, 123, 77)');
    const sara = within(within(section).getByRole('button', { name: 'Sara, 4 minutes ago' })).getByTestId('woka-avatar');
    expect(sara.style.background).toBe('rgb(153, 121, 77)');
  });

  it('has one See all, in the header, and no second one at the end of the row', async () => {
    const open = jest.fn();
    serve({ '/api/admin/recent-visitors': { visitors, guests: 0 } });
    render(<RecentVisitors scope="universe" id="u1" onOpenVisitors={open} />);
    const section = await screen.findByTestId('recent-visitors');
    expect(within(section).queryByTestId('recent-visitors-see-all-tile')).toBeNull();
    expect(within(section).getAllByText('See all')).toHaveLength(1);
    expect(section.querySelector('ul')?.contains(within(section).getByTestId('recent-visitors-see-all'))).toBe(false);
    fireEvent.click(within(section).getByTestId('recent-visitors-see-all'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shows a guest by the name they typed, marked Guest, and opens a card with no profile to go to', async () => {
    const guest = { key: 'g-nova', userId: null, guest: true, name: 'Nova', woka: [], at: ago(4), room: { id: 'r1', name: 'HQ Lobby' } };
    serve({ '/api/admin/recent-visitors': { visitors: [visitors[0], guest], guests: 0 } });
    render(<RecentVisitors scope="universe" id="u1" />);
    const section = await screen.findByTestId('recent-visitors');
    const face = within(section).getByRole('button', { name: 'Nova, guest, 4 minutes ago' });
    expect(face.textContent).toContain('Nova');
    expect(face.textContent).toContain('Guest · 4 min');
    fireEvent.click(face);
    const sheet = await screen.findByTestId('visitor-sheet');
    expect(sheet.textContent).toContain('Guest · Here 4 minutes ago · HQ Lobby');
    expect(within(sheet).queryByText('Full profile')).toBeNull();
    // No profile to fetch for a guest.
    expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith('/api/admin/users/'))).toBe(false);
  });

  it('has no See all when there is nowhere to go from it', async () => {
    serve({ '/api/admin/recent-visitors': { visitors, guests: 0 } });
    render(<RecentVisitors scope="universe" id="u1" />);
    const section = await screen.findByTestId('recent-visitors');
    expect(within(section).queryByText('See all')).toBeNull();
  });

  it('puts a Guests chip first, with how many different guests this week, and opens the Visitors page', async () => {
    const open = jest.fn();
    serve({ '/api/admin/recent-visitors': { visitors, guests: 12 } });
    render(<RecentVisitors scope="universe" id="u1" onOpenVisitors={open} />);
    const section = await screen.findByTestId('recent-visitors');
    const chip = within(section).getByRole('button', { name: '12 guests this week. See all visitors' });
    expect(chip.textContent).toContain('12');
    expect(chip.textContent).toContain('Guests');
    expect(chip.textContent).toContain('this week');
    // First in the row, ahead of the faces.
    expect(section.querySelector('ul li:first-child button')).toBe(chip);
    expect(section.textContent).toContain('Guests are people without an account.');
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('says "Guest" for one, and still shows the chip when only guests came by', async () => {
    serve({ '/api/admin/recent-visitors': { visitors: [], guests: 1 } });
    render(<RecentVisitors scope="room" id="r1" />);
    const chip = await screen.findByRole('button', { name: '1 guest this week. See all visitors' });
    expect(chip.textContent).toContain('Guest');
    expect(chip.textContent).not.toContain('Guests');
  });

  it('has no chip, and no guest note, when no guests came', async () => {
    serve({ '/api/admin/recent-visitors': { visitors, guests: 0 } });
    render(<RecentVisitors scope="universe" id="u1" />);
    const section = await screen.findByTestId('recent-visitors');
    expect(within(section).queryByText('this week')).toBeNull();
    expect(section.textContent).not.toContain('Guests are people');
  });

  it('is left out when there is nobody to show, or it cannot be read', async () => {
    serve({ '/api/admin/recent-visitors': { visitors: [] } });
    const { container, unmount } = render(<RecentVisitors scope="world" id="w1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    unmount();
    serve({});
    const second = render(<RecentVisitors scope="room" id="r1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(second.container.textContent).toBe('');
  });

  it('opens their profile card when a face is tapped: words, links, stamps and a way to the full profile', async () => {
    serve({
      '/api/admin/recent-visitors': { visitors },
      '/api/admin/users/sara/passport': { stamps: [{ worldId: 'hq', world: 'HQ', universe: { id: 'u-bawes', name: 'BAWES' }, visits: 212, since: '2026-01-12T08:00:00Z' }] },
      '/api/admin/users/sara': { visitCard: { bio: 'Ops at BAWES.', links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/sara' }, { label: 'Bad', url: 'javascript:alert(1)' }] } },
    });
    render(<RecentVisitors scope="universe" id="u1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sara, 4 minutes ago' }));
    const sheet = await screen.findByTestId('visitor-sheet');
    expect(within(sheet).getByRole('heading', { name: 'Sara' })).toBeTruthy();
    expect(within(sheet).getByText('Here 4 minutes ago · HQ Lobby')).toBeTruthy();
    expect(await within(sheet).findByText('Ops at BAWES.')).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'LinkedIn' }).getAttribute('href')).toBe('https://linkedin.com/in/sara');
    expect(within(sheet).queryByRole('link', { name: 'Bad' })).toBeNull();
    expect(within(sheet).getByText('212 visits')).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'Full profile' }).getAttribute('href')).toBe('/admin/users/sara');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('visitor-sheet')).toBeNull());
  });

  it('still opens the card with name, time and room when the profile cannot be read', async () => {
    serve({ '/api/admin/recent-visitors': { visitors } });
    render(<RecentVisitors scope="room" id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Omar, 1 minute ago' }));
    const sheet = await screen.findByTestId('visitor-sheet');
    expect(within(sheet).getByText('Here 1 minute ago · HQ Lobby')).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'Full profile' })).toBeTruthy();
    expect(within(sheet).queryByText('Ops at BAWES.')).toBeNull();
  });

  it('shows last visited near the heading, with an exact timestamp', async () => {
    serve({ '/api/admin/recent-visitors': { visitors } });
    render(<RecentVisitors scope="room" id="r1" lastVisited={visitors[0].at} />);
    const section = await screen.findByTestId('recent-visitors');
    expect((within(section).getByText(/Last visited/)).textContent).toContain('Last visited 1 minute ago');
    expect(section.querySelector('time')?.getAttribute('datetime')).toBe(visitors[0].at);
  });

  it.each(['member', 'invited', 'owner'])('shows %s status without offering another invitation', async (status) => {
    serve({
      '/api/admin/recent-visitors': { visitors },
      '/api/admin/rooms/r1/members/omar': { world: { id: 'w1', name: 'HQ' }, status, tags: ['member'], canInvite: false },
    });
    render(<RecentVisitors scope="room" id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Omar, 1 minute ago' }));
    expect(await screen.findByText(status === 'member' ? 'Already a member' : status === 'invited' ? 'Invitation pending' : 'Universe owner')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite as member' })).toBeNull();
  });

  const universeRoutes = {
    '/api/admin/universes/u1/invitations': { invitation: { id: 'i1' } },
    '/api/admin/universes/u1/me': { highestPosition: null, full: true, giveWorlds: 'all', inviteWorlds: 'all' },
    '/api/admin/universes/u1/roles': { roles: [{ id: 'r-editor', key: 'editor', name: 'Editor', color: '#60A5FA', builtIn: true, position: 2, permissions: '8416', people: 1 }] },
    '/api/admin/universes/u1': { id: 'u1', name: 'BAWES', ownerId: 'owner', worlds: [{ id: 'w1', name: 'HQ' }, { id: 'w2', name: 'Campus' }] },
  };
  const inviteable = { world: { id: 'w1', name: 'HQ' }, universeId: 'u1', status: 'none', tags: [], canInvite: true };

  it('opens the invite sheet with the visitor and the room’s world picked, then shows pending after one tap on Send invite', async () => {
    serve({ '/api/admin/recent-visitors': { visitors }, '/api/admin/rooms/r1/members/omar': inviteable, ...universeRoutes });
    render(<RecentVisitors scope="room" id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Omar, 1 minute ago' }));
    expect(await screen.findByText('Not in BAWES')).toBeTruthy();
    expect(screen.getByText('You pick their roles and worlds before the invite goes.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Invite as member' }));
    expect(await screen.findByRole('heading', { name: 'Invite Omar to BAWES' })).toBeTruthy();
    const send = await screen.findByRole('button', { name: 'Send invite' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole('button', { name: 'HQ' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(send);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/admin/universes/u1/invitations', expect.objectContaining({ method: 'POST', body: expect.stringContaining('"userId":"omar"') })),
    );
    const body = JSON.parse(fetchMock.mock.calls.find(([path, init]) => path === '/api/admin/universes/u1/invitations' && init?.method === 'POST')![1].body);
    expect(body).toMatchObject({ userId: 'omar', roleIds: [], worlds: { allWorlds: false, worldIds: ['w1'] } });
    expect(await screen.findByText('Invitation pending')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite as member' })).toBeNull();
  });

  it('says what went wrong and leaves the visitor invitable when the invite is refused', async () => {
    serve({ '/api/admin/recent-visitors': { visitors }, '/api/admin/rooms/r1/members/omar': inviteable, ...universeRoutes });
    render(<RecentVisitors scope="room" id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Omar, 1 minute ago' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Invite as member' }));
    const send = await screen.findByRole('button', { name: 'Send invite' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'Please try again.' }) }));
    fireEvent.click(send);
    expect((await screen.findByText('Please try again.')).textContent).toBe('Please try again.');
    expect(screen.queryByText('Invitation pending')).toBeNull();
  });

  it('fails closed if status cannot load and rechecks when reopened', async () => {
    serve({ '/api/admin/recent-visitors': { visitors } });
    render(<RecentVisitors scope="room" id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Omar, 1 minute ago' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t check membership.');
    expect(screen.queryByRole('button', { name: 'Invite as member' })).toBeNull();
    serve({
      '/api/admin/rooms/r1/members/omar': { world: { id: 'w1', name: 'HQ' }, status: 'member', tags: [], canInvite: false },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Already a member')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('visitor-sheet')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Omar, 1 minute ago' }));
    expect(await screen.findByText('Already a member')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/admin/rooms/r1/members/omar')).toHaveLength(3);
  });

  it('does not invite guests or viewers without membership-management permission', async () => {
    const guest = { ...visitors[1], guest: true, userId: null };
    serve({
      '/api/admin/recent-visitors': { visitors: [visitors[0], guest] },
      '/api/admin/rooms/r1/members/omar': { world: { id: 'w1', name: 'HQ' }, status: 'none', tags: [], canInvite: false },
    });
    render(<RecentVisitors scope="room" id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Omar, 1 minute ago' }));
    expect(await screen.findByText('Not a member')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite as member' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('visitor-sheet')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Sara, guest, 4 minutes ago' }));
    expect(screen.getByText('Not a member. Guests need an account before they can be invited.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite as member' })).toBeNull();
    expect(fetchMock.mock.calls.some(([path]) => path.includes('/members/sara'))).toBe(false);
  });
});
