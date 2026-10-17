/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InviteSheet from '@/app/admin/components/invite-sheet';
import { ToastProvider } from '@/components/ui/toast';

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const ROLES = [
  { id: 'r-admin', key: 'admin', name: 'Admin', color: '#F87171', builtIn: true, position: 1_000_000, permissions: '16383', people: 1 },
  { id: 'r-editor', key: 'editor', name: 'Editor', color: '#60A5FA', builtIn: true, position: 2, permissions: '8416', people: 1 },
  { id: 'r-member', key: 'member', name: 'Member', color: '#A78BFA', builtIn: true, position: 1, permissions: '0', people: 5 },
  { id: 'r-acct', key: 'accountant', name: 'Accountant', color: '#34D399', builtIn: false, position: 12, permissions: '0', people: 2 },
];
const HANAN = { userId: 'hanan', name: 'Hanan Aziz', friend: true, at: new Date().toISOString(), room: { id: 'r1', name: 'Lobby' }, world: { id: 'hq', name: 'HQ' }, woka: [] };

let me = { highestPosition: null as number | null, full: true, giveWorlds: 'all' as 'all' | string[], inviteWorlds: 'all' as 'all' | string[] };
let posts: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  posts = [];
  me = { highestPosition: null, full: true, giveWorlds: 'all', inviteWorlds: 'all' };
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body ?? '{}') });
      return ok({ invitation: { id: 'inv' } });
    }
    if (url.endsWith('/me')) return ok(me);
    if (url.endsWith('/roles')) return ok({ roles: ROLES });
    if (url.includes('/invite-candidates')) {
      return ok({ visitors: [HANAN], friends: [{ userId: 'tariq', name: 'Tariq Mansour', lastVisitedAt: null, woka: [] }], results: [] });
    }
    return ok({ id: 'u1', name: 'BAWES', ownerId: 'owner', worlds: [{ id: 'hq', name: 'HQ' }, { id: 'campus', name: 'Campus' }] });
  });
});

function open(props: Partial<React.ComponentProps<typeof InviteSheet>> = {}) {
  const onOpenChange = jest.fn();
  const onSent = jest.fn();
  render(
    <ToastProvider>
      <InviteSheet open onOpenChange={onOpenChange} universeId="u1" onSent={onSent} {...props} />
    </ToastProvider>,
  );
  return { onOpenChange, onSent };
}

it('offers this week’s visitors and your friends, with Cancel as the only way out', async () => {
  open();
  expect(await screen.findByRole('heading', { name: 'Invite to BAWES' })).toBeTruthy();
  expect(await screen.findByText('Visited BAWES this week')).toBeTruthy();
  expect(screen.getByText('Hanan Aziz')).toBeTruthy();
  expect(screen.getByText(/Your friend · in HQ Lobby/)).toBeTruthy();
  expect(screen.getByText('Your friends')).toBeTruthy();
  expect(screen.getByText('Hasn’t visited BAWES yet')).toBeTruthy();
  expect(screen.getByText(/Members already in BAWES aren’t listed/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
});

it('searches by name after a pause in typing', async () => {
  open();
  await screen.findByText('Hanan Aziz');
  fetchMock.mockClear();
  fireEvent.change(screen.getByPlaceholderText('Search by name'), { target: { value: 'lin' } });
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('invite-candidates?q=lin'))).toBe(true));
});

it('step two: roles on top of Member (no Member tick), where they work, then one tap on Send invite', async () => {
  const { onSent, onOpenChange } = open();
  fireEvent.click(await screen.findByRole('button', { name: /Hanan Aziz/ }));
  expect(await screen.findByRole('heading', { name: 'Invite Hanan to BAWES' })).toBeTruthy();
  expect(screen.getByText(/Everyone who joins is a Member/)).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'Admin' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Member' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Accountant' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Some worlds' }));
  fireEvent.click(screen.getByRole('button', { name: 'HQ' }));
  fireEvent.change(screen.getByPlaceholderText('Say why you’re inviting them'), { target: { value: 'Join us' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].url).toBe('/api/admin/universes/u1/invitations');
  expect(posts[0].body).toEqual({ userId: 'hanan', roleIds: ['r-acct'], worlds: { allWorlds: false, worldIds: ['hq'] }, message: 'Join us' });
  await waitFor(() => expect(onSent).toHaveBeenCalled());
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it('opens on step two with the person picked and the room’s world ticked, still one tap on Send invite', async () => {
  open({ person: { userId: 'hanan', name: 'Hanan Aziz' }, worldId: 'hq' });
  expect(await screen.findByRole('heading', { name: 'Invite Hanan to BAWES' })).toBeTruthy();
  // Handed a person, there is nothing to change
  expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  const send = await screen.findByRole('button', { name: 'Send invite' });
  await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole('button', { name: 'HQ' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(send);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].body).toMatchObject({ userId: 'hanan', roleIds: [], worlds: { allWorlds: false, worldIds: ['hq'] } });
});

it('offers only the roles below yours and the worlds you may invite to', async () => {
  me = { highestPosition: 12, full: false, giveWorlds: 'all', inviteWorlds: ['hq'] };
  open({ person: { userId: 'hanan', name: 'Hanan Aziz' } });
  await screen.findByRole('heading', { name: 'Invite Hanan to BAWES' });
  await screen.findByRole('button', { name: 'Editor' });
  // Admin ranks above you and Accountant is your own rank: neither is yours to give
  expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Accountant' })).toBeNull();
  // "All worlds" is not yours to pick, so the choice starts on the worlds you may invite to
  expect(screen.getByRole('radio', { name: 'All worlds' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Campus' })).toBeNull();
});

it('says what went wrong and stays open when the invite is refused', async () => {
  open({ person: { userId: 'hanan', name: 'Hanan Aziz' } });
  const send = await screen.findByRole('button', { name: 'Send invite' });
  await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
  fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'They already have an invitation to this universe' }) }));
  fireEvent.click(send);
  expect((await screen.findByRole('alert')).textContent).toBe('They already have an invitation to this universe');
});
