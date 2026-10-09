/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import RoomMembers from '@/app/admin/components/room-members';

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
// The invite dialog has its own tests; here it only has to open for the world it is given.
jest.mock('@/app/admin/components/invite-member-dialog', () => ({
  __esModule: true,
  default: ({ open, worldId }: { open: boolean; worldId: string }) => (open ? <div data-testid="invite-dialog">Invite to {worldId}</div> : null),
}));

type Member = { id: string; tags: string[]; isUniverseOwner: boolean; woka: string[]; user: { id: string; name: string; email: null } };
const person = (id: string, name: string, tags: string[], isUniverseOwner = false): Member => ({ id: `m-${id}`, tags, isUniverseOwner, woka: [], user: { id, name, email: null } });
const sara = person('sara', 'Sara', ['admin']);
const khalid = person('khalid', 'Khalid', ['admin'], true);
const omar = person('omar', 'Omar', ['editor']);

beforeEach(() => fetchMock.mockReset());

function serve({ canManage = true, members = [sara], yourId = 'someone-else' }: { canManage?: boolean; members?: Member[]; yourId?: string } = {}) {
  fetchMock.mockImplementation(async (path: string) => ({ ok: true, json: async () =>
    path.includes('/members?') ? { members, total: members.length, canManage, yourTags: [], yourId, universeName: 'Butterfly Universe' }
      : path.endsWith('/passport') ? { stamps: [] }
        : { visitCard: { bio: 'Ops at HQ', links: [] } },
  }));
}

async function openCard(name: string, role: string) {
  fireEvent.click(await screen.findByRole('button', { name: `${name}, ${role}` }));
  return screen.findByTestId('member-sheet');
}

it('reuses the ranked world preview and opens a member card with Full profile and Manage membership in one row at the bottom', async () => {
  serve();
  render(<RoomMembers world={{ id: 'w1', name: 'HQ' }} />);
  const sheet = await openCard('Sara', 'admin');
  expect(fetchMock).toHaveBeenCalledWith('/api/admin/worlds/w1/members?limit=8');
  expect(within(sheet).getByText('Member of HQ · Access to all its rooms')).toBeTruthy();
  expect(await within(sheet).findByText('Ops at HQ')).toBeTruthy();
  const full = within(sheet).getByRole('link', { name: 'Full profile' });
  const manage = within(sheet).getByRole('link', { name: 'Manage membership' });
  expect(full.getAttribute('href')).toBe('/admin/users/sara');
  expect(manage.getAttribute('href')).toBe('/admin/worlds/w1/members');
  // Same row, Full profile first, and that row is the last content on the card (only the close button follows).
  expect(full.parentElement).toBe(manage.parentElement);
  expect(full.nextElementSibling).toBe(manage);
  expect(full.parentElement?.nextElementSibling?.textContent).toBe('Close');
  expect(within(sheet).queryByText('You')).toBeNull();
  fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByTestId('member-sheet')).toBeNull());
  expect(screen.getByText('Members of HQ belong to all its rooms.')).toBeTruthy();
});

it('has a single See all, in the header, and no arrow tile at the end of the row', async () => {
  serve();
  render(<RoomMembers world={{ id: 'w1', name: 'HQ' }} />);
  await screen.findByRole('button', { name: 'Sara, admin' });
  const links = screen.getAllByRole('link', { name: /see all/i });
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute('href')).toBe('/admin/worlds/w1/members');
  expect(screen.queryByRole('link', { name: 'See all members' })).toBeNull();
});

it('does not offer membership management to a read-only viewer', async () => {
  serve({ canManage: false });
  render(<RoomMembers world={{ id: 'w1', name: 'HQ' }} />);
  const sheet = await openCard('Sara', 'admin');
  expect(await within(sheet).findByText('Ops at HQ')).toBeTruthy();
  expect(within(sheet).queryByRole('link', { name: 'Manage membership' })).toBeNull();
  expect(within(sheet).getByRole('link', { name: 'Full profile' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /invite member/i })).toBeNull();
});

it('shows your own card with a You tag, your top role only and a Your profile button', async () => {
  serve({ members: [khalid, sara], yourId: 'khalid' });
  render(<RoomMembers world={{ id: 'w1', name: 'HQ' }} />);
  const sheet = await openCard('Khalid', 'owner');
  expect(within(sheet).getByText('You')).toBeTruthy();
  expect(within(sheet).getByText('You own Butterfly Universe · Every world and room in it')).toBeTruthy();
  // The owner is also an admin, but only the top role shows.
  expect(within(sheet).getByText('Owner')).toBeTruthy();
  expect(within(sheet).queryByText('Admin')).toBeNull();
  expect(within(sheet).getByRole('link', { name: 'Your profile' }).getAttribute('href')).toBe('/admin/you');
  expect(within(sheet).queryByRole('link', { name: 'Full profile' })).toBeNull();
  expect(within(sheet).queryByRole('link', { name: 'Manage membership' })).toBeNull();
});

it('shows an admin their own card the same way, with their role and no Manage membership', async () => {
  serve({ members: [khalid, sara], yourId: 'sara' });
  render(<RoomMembers world={{ id: 'w1', name: 'HQ' }} />);
  const sheet = await openCard('Sara', 'admin');
  expect(within(sheet).getByText('You')).toBeTruthy();
  expect(within(sheet).getByText('Member of HQ · Access to all its rooms')).toBeTruthy();
  expect(within(sheet).getByText('Admin')).toBeTruthy();
  expect(within(sheet).getByRole('link', { name: 'Your profile' })).toBeTruthy();
  expect(within(sheet).queryByRole('link', { name: 'Manage membership' })).toBeNull();
  expect(within(sheet).queryByRole('link', { name: 'Full profile' })).toBeNull();
});

it("shows the owner's card to someone else as Owns the universe, with Full profile only", async () => {
  serve({ members: [khalid, sara], yourId: 'sara' });
  render(<RoomMembers world={{ id: 'w1', name: 'HQ' }} />);
  const sheet = await openCard('Khalid', 'owner');
  expect(within(sheet).getByText('Owns Butterfly Universe')).toBeTruthy();
  expect(within(sheet).getByText('Owner')).toBeTruthy();
  expect(within(sheet).queryByText('Admin')).toBeNull();
  expect(within(sheet).queryByText('You')).toBeNull();
  expect(within(sheet).getByRole('link', { name: 'Full profile' }).getAttribute('href')).toBe('/admin/users/khalid');
  expect(within(sheet).queryByRole('link', { name: 'Manage membership' })).toBeNull();
  expect(within(sheet).queryByRole('link', { name: 'Your profile' })).toBeNull();
});

it('leaves the other members as they were: their role pills and both buttons', async () => {
  serve({ members: [khalid, omar], yourId: 'khalid' });
  render(<RoomMembers world={{ id: 'w1', name: 'HQ' }} />);
  const sheet = await openCard('Omar', 'editor');
  expect(within(sheet).getByText('Editor')).toBeTruthy();
  expect(within(sheet).getByRole('link', { name: 'Full profile' })).toBeTruthy();
  expect(within(sheet).getByRole('link', { name: 'Manage membership' })).toBeTruthy();
});

it('offers Invite member in the Members header to managers, opening the invite for the room’s world', async () => {
  serve();
  render(<RoomMembers world={{ id: 'w1', name: 'HQ' }} />);
  expect(screen.queryByTestId('invite-dialog')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: /invite member/i }));
  expect((await screen.findByTestId('invite-dialog')).textContent).toBe('Invite to w1');
});

it('shows an empty state and does not expose a list when the endpoint denies access', async () => {
  serve({ members: [] });
  const first = render(<RoomMembers world={{ id: 'w1', name: 'HQ' }} />);
  expect(await screen.findByText('No members yet.')).toBeTruthy();
  first.unmount();
  fetchMock.mockResolvedValue({ ok: false });
  const second = render(<RoomMembers world={{ id: 'private', name: 'Private' }} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/worlds/private/members?limit=8'));
  expect(second.container.textContent).toBe('');
});
