/** @jest-environment jsdom */

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockFetch = jest.fn();
let mockPeople: { uuid: string }[] = [];
let mockCapabilities: string[] = [];
let mockId = 'u-ali';
const mockInvite = jest.fn();
const mockMessage = jest.fn();

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: mockId }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (url: string, options?: RequestInit) => mockFetch(url, options) }));
jest.mock('@/app/admin/hooks/use-live', () => ({ useLive: () => ({ available: true, people: mockPeople, places: [] }) }));
jest.mock('@/app/admin/components/orbit-bridge', () => ({
  useGameCapability: (capability: string) => mockCapabilities.includes(capability),
  inviteInGame: (...args: unknown[]) => mockInvite(...args),
  messageInGame: (...args: unknown[]) => mockMessage(...args),
}));
jest.mock('@/app/admin/components/passport', () => ({ PassportSection: () => null }));
jest.mock('@/app/admin/components/invite-sheet', () => ({
  __esModule: true,
  default: ({ open, person, universeId, universes, giving }: { open: boolean; person: { userId: string; name: string; notes?: Record<string, string | null> }; universeId: string; universes: { id: string; status?: string }[]; giving?: boolean }) =>
    open ? (
      <div role="dialog">
        {giving ? 'Give' : 'Invite'} {person.name} ({person.userId}) to {universeId} of {universes.map((universe) => universe.id + (universe.status ? `:${universe.status}` : '')).join(',')}
        {person.notes ? ` · ${person.notes[universeId] ?? 'no line'}` : ''}
      </div>
    ) : null,
  personNote: ({ friend, visit }: { friend?: boolean; visit?: { room?: { name: string }; world?: { name: string } } | null }) =>
    !friend && !visit ? null : [friend ? 'Your friend' : null, visit ? `in ${visit.world?.name} ${visit.room?.name}` : null].filter(Boolean).join(' · '),
}));

import UserDetailPage from '@/app/admin/users/[id]/page';

const ali = {
  id: 'u-ali',
  uuid: 'uuid-ali',
  name: 'Ali',
  isGuest: false,
  createdAt: '2026-01-12T00:00:00Z',
  updatedAt: '2026-01-12T00:00:00Z',
  visitCard: null,
  ownedUniverses: [],
  worldMemberships: [],
  _count: { ownedUniverses: 0, worldMemberships: 0, bans: 0, favorites: 0, avatars: 0 },
};

function json(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: async () => body });
}

function serve({ me = 'u-sara', connect, universes = [], taken = [], friend = false, guest = false }: { me?: string; connect?: unknown; universes?: unknown[]; taken?: unknown[]; friend?: boolean; guest?: boolean }) {
  mockFetch.mockImplementation((url: string, options?: RequestInit) => {
    if (url === '/api/auth/me') return json({ user: { id: me } });
    if (url === '/api/admin/users/u-ali') return json({ ...ali, isGuest: guest });
    if (url === '/api/admin/users/u-ali/connect') {
      if (options?.method === 'POST') return json({ relationship: 'request_sent' });
      return json(connect ?? { available: false });
    }
    if (url === '/api/admin/users/u-ali/worlds') return json({ worlds: [], universes, taken, friend });
    if (url.startsWith('/api/admin/analytics/users/')) return json({ total: 0, page: 1, limit: 10, totalPages: 0, firstAccess: null, lastAccess: null, accesses: [] });
    return json({ rooms: [] });
  });
}

async function open() {
  render(<UserDetailPage />);
  await screen.findByRole('heading', { name: 'Ali' });
}

const names = () => screen.queryAllByRole('button').map((button) => button.textContent);
/** The gradient main button: Button's default variant. */
const isMain = (name: string) => screen.getByRole('button', { name }).className.includes('--brand-gradient');

describe('Someone’s profile buttons', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockInvite.mockReset();
    mockMessage.mockReset();
    mockPeople = [];
    mockCapabilities = [];
    mockId = 'u-ali';
  });

  it('shows Invite over, Message, Add friend and Give membership in that order, while they are online in a game that can take them', async () => {
    mockPeople = [{ uuid: 'uuid-ali' }];
    mockCapabilities = ['invite', 'message'];
    serve({ connect: { available: true, relationship: 'none', chatId: '@ali:chat' }, universes: [{ id: 'bawes', name: 'BAWES' }] });
    await open();
    await waitFor(() => expect(names()).toEqual(['Invite over', 'Message', 'Add friend', 'Give membership']));
    expect(isMain('Invite over')).toBe(true);
    expect(isMain('Give membership')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Invite over' }));
    expect(mockInvite).toHaveBeenCalledWith('uuid-ali', 'Ali');
    fireEvent.click(screen.getByRole('button', { name: 'Message' }));
    expect(mockMessage).toHaveBeenCalledWith('uuid-ali', 'Ali', '@ali:chat');
  });

  it('opens the invite sheet with this person picked when Give membership is tapped', async () => {
    mockPeople = [{ uuid: 'uuid-ali' }];
    mockCapabilities = ['invite', 'message'];
    serve({
      connect: { available: true, relationship: 'none', chatId: '@ali:chat' },
      friend: true,
      universes: [{ id: 'bawes', name: 'BAWES', visit: { at: '2026-10-16T10:00:00Z', room: { name: 'Lobby' }, world: { name: 'HQ' } } }, { id: 'other', name: 'Other', visit: null }],
    });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Give membership' }));
    expect((await screen.findByRole('dialog')).textContent).toBe('Give Ali (u-ali) to bawes of bawes,other · Your friend · in HQ Lobby');
  });

  it('shows the universes they already belong to or are invited to in the sheet, not pickable', async () => {
    serve({
      connect: { available: true, relationship: 'none', chatId: null },
      universes: [{ id: 'sandbox', name: 'Sandbox', visit: null }],
      taken: [{ id: 'bawes', name: 'BAWES', status: 'member' }, { id: 'cup', name: 'Cup', status: 'invited' }],
    });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Give membership' }));
    expect((await screen.findByRole('dialog')).textContent).toBe('Give Ali (u-ali) to sandbox of sandbox,bawes:member,cup:invited · no line');
  });

  it('has no Give membership when they are already in every universe you could offer', async () => {
    serve({ connect: { available: true, relationship: 'none', chatId: null }, taken: [{ id: 'bawes', name: 'BAWES', status: 'member' }] });
    await open();
    await waitFor(() => expect(names()).toEqual(['Add friend']));
  });

  it('has no Give membership for a guest, who could not accept it', async () => {
    serve({ guest: true, universes: [{ id: 'bawes', name: 'BAWES', visit: null }] });
    await open();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/admin/users/u-ali/worlds', undefined));
    expect(names()).toEqual([]);
  });

  it('leaves out Invite over when they are offline', async () => {
    mockCapabilities = ['message'];
    serve({ connect: { available: true, relationship: 'none', chatId: '@ali:chat' } });
    await open();
    await waitFor(() => expect(names()).toEqual(['Message', 'Add friend']));
  });

  it('shows no Invite over or Message outside the game, only Add friend', async () => {
    mockPeople = [{ uuid: 'uuid-ali' }];
    serve({ connect: { available: true, relationship: 'none', chatId: '@ali:chat' } });
    await open();
    await waitFor(() => expect(names()).toEqual(['Add friend']));
  });

  it('shows only Invite over when Message and Add friend are not available (a guest)', async () => {
    mockPeople = [{ uuid: 'uuid-ali' }];
    mockCapabilities = ['invite', 'message'];
    serve({ connect: { available: false } });
    await open();
    await waitFor(() => expect(names()).toEqual(['Invite over']));
  });

  it('shows none of them on your own profile', async () => {
    mockPeople = [{ uuid: 'uuid-ali' }];
    mockCapabilities = ['invite', 'message'];
    serve({ me: 'u-ali', connect: { available: false } });
    await open();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/auth/me', undefined));
    expect(names()).toEqual([]);
  });

  it.each([
    ['request_sent', 'Cancel request'],
    ['request_received', 'Accept request'],
    ['friends', 'Remove friend'],
  ])('says %s as “%s”', async (relationship, label) => {
    serve({ connect: { available: true, relationship, chatId: null } });
    await open();
    await waitFor(() => expect(names()).toEqual([label]));
    // Undoing something is never the main button; accepting a request is.
    expect(isMain(label)).toBe(relationship === 'request_received');
  });

  it('asks before removing a friend, and only removes on Remove friend', async () => {
    serve({ connect: { available: true, relationship: 'friends', chatId: null } });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove friend' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Remove Ali as a friend?');
    expect(mockFetch).not.toHaveBeenCalledWith('/api/admin/users/u-ali/connect', expect.objectContaining({ method: 'POST' }));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mockFetch).not.toHaveBeenCalledWith('/api/admin/users/u-ali/connect', expect.objectContaining({ method: 'POST' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove friend' }));
    const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove friend' });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(mockFetch).toHaveBeenCalledWith('/api/admin/users/u-ali/connect', expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'remove' }) }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('keeps the confirm open and says why when removing a friend fails', async () => {
    serve({ connect: { available: true, relationship: 'friends', chatId: null } });
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, options?: RequestInit) =>
      options?.method === 'POST' ? Promise.reject(new Error('offline')) : original(url, options));
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove friend' }));
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove friend' }));
    });
    expect(within(screen.getByRole('alertdialog')).getByRole('alert').textContent).toBe('That didn’t work. Try again.');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('hides Add friend and Message when either of you has blocked the other', async () => {
    mockCapabilities = ['message'];
    serve({ connect: { available: true, relationship: 'blocked_by_me', chatId: null } });
    await open();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/admin/users/u-ali/connect', undefined));
    expect(names()).toEqual([]);
  });

  it('sends a friend request and then offers to cancel it', async () => {
    serve({ connect: { available: true, relationship: 'none', chatId: null } });
    await open();
    const add = await screen.findByRole('button', { name: 'Add friend' });
    await act(async () => {
      fireEvent.click(add);
    });
    await waitFor(() => expect(names()).toEqual(['Cancel request']));
    expect(mockFetch).toHaveBeenCalledWith('/api/admin/users/u-ali/connect', expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'request' }) }));
  });

  it('says why a request was refused', async () => {
    serve({ connect: { available: true, relationship: 'none', chatId: null } });
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, options?: RequestInit) =>
      options?.method === 'POST' ? json({ error: 'not_accepting_requests' }, false) : original(url, options));
    await open();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Add friend' }));
    });
    expect((await screen.findByRole('alert')).textContent).toBe('They aren’t taking friend requests.');
    expect(names()).toEqual(['Add friend']);
  });
  it('never carries the previous person’s chat to the next profile while their lookup is still loading', async () => {
    mockCapabilities = ['message'];
    const bob = { ...ali, id: 'u-bob', uuid: 'uuid-bob', name: 'Bob' };
    let answerBob: (value: unknown) => void = () => undefined;
    const bobConnect = new Promise((resolve) => {
      answerBob = resolve;
    });
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/auth/me') return json({ user: { id: 'u-sara' } });
      if (url === '/api/admin/users/u-ali') return json(ali);
      if (url === '/api/admin/users/u-bob') return json(bob);
      if (url === '/api/admin/users/u-ali/connect') return json({ available: true, relationship: 'none', chatId: '@ali:chat' });
      if (url === '/api/admin/users/u-bob/connect') return bobConnect;
      if (url.endsWith('/worlds')) return json({ worlds: [], universes: [] });
      if (url.startsWith('/api/admin/analytics/users/')) return json({ total: 0, page: 1, limit: 10, totalPages: 0, firstAccess: null, lastAccess: null, accesses: [] });
      return json({ rooms: [] });
    });
    const view = render(<UserDetailPage />);
    await screen.findByRole('heading', { name: 'Ali' });
    await waitFor(() => expect(names()).toEqual(['Message', 'Add friend']));

    // On to Bob, whose friend lookup has not come back yet.
    mockId = 'u-bob';
    view.rerender(<UserDetailPage />);
    await screen.findByRole('heading', { name: 'Bob' });
    expect(names()).toEqual([]);
    expect(mockMessage).not.toHaveBeenCalled();

    await act(async () => {
      answerBob(await json({ available: true, relationship: 'none', chatId: '@bob:chat' }));
    });
    await waitFor(() => expect(names()).toEqual(['Message', 'Add friend']));
    fireEvent.click(screen.getByRole('button', { name: 'Message' }));
    expect(mockMessage).toHaveBeenCalledWith('uuid-bob', 'Bob', '@bob:chat');
  });
});
