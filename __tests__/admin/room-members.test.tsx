/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import RoomMembers from '@/app/admin/components/room-members';

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const member = { id: 'm1', tags: ['admin'], isUniverseOwner: false, woka: [], user: { id: 'sara', name: 'Sara', email: null } };

beforeEach(() => fetchMock.mockReset());

function serve(canManage = true, members = [member]) {
  fetchMock.mockImplementation(async (path: string) => ({ ok: true, json: async () =>
    path.includes('/members?') ? { members, total: members.length, canManage, yourTags: [] }
      : path.endsWith('/passport') ? { stamps: [] }
        : { visitCard: { bio: 'Ops at HQ', links: [] } },
  }));
}

it('reuses the ranked world preview and opens a member card with profile and management actions', async () => {
  serve();
  render(<RoomMembers world={{ id: 'w1', name: 'HQ' }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sara, admin' }));
  expect(fetchMock).toHaveBeenCalledWith('/api/admin/worlds/w1/members?limit=8');
  const sheet = await screen.findByTestId('member-sheet');
  expect(within(sheet).getByText('Member of HQ · Access to all its rooms')).toBeTruthy();
  expect(await within(sheet).findByText('Ops at HQ')).toBeTruthy();
  expect(within(sheet).getByRole('link', { name: 'Full profile' }).getAttribute('href')).toBe('/admin/users/sara');
  expect(within(sheet).getByRole('link', { name: 'Manage membership' }).getAttribute('href')).toBe('/admin/worlds/w1/members');
  fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByTestId('member-sheet')).toBeNull());
  expect(screen.getByText('Members of HQ belong to all its rooms.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'See all members' }).getAttribute('href')).toBe('/admin/worlds/w1/members');
});

it('does not offer membership management to a read-only viewer', async () => {
  serve(false);
  render(<RoomMembers world={{ id: 'w1', name: 'HQ' }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sara, admin' }));
  expect(await screen.findByText('Ops at HQ')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Manage membership' })).toBeNull();
});

it('shows an empty state and does not expose a list when the endpoint denies access', async () => {
  serve(true, []);
  const first = render(<RoomMembers world={{ id: 'w1', name: 'HQ' }} />);
  expect(await screen.findByText('No members yet.')).toBeTruthy();
  first.unmount();
  fetchMock.mockResolvedValue({ ok: false });
  const second = render(<RoomMembers world={{ id: 'private', name: 'Private' }} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/admin/worlds/private/members?limit=8'));
  expect(second.container.textContent).toBe('');
});
