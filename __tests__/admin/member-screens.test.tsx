/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { UniverseMembersPage } from '@/app/admin/universes/[id]/members/members-list';
import { MemberPage } from '@/app/admin/universes/[id]/members/[userId]/member-page';
import { ToastProvider } from '@/components/ui/toast';

const fetchMock = jest.fn();
const replace = jest.fn();
let params: Record<string, string> = { id: 'u1', userId: 'sara' };
let search = new URLSearchParams();

jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('next/navigation', () => ({
  useParams: () => params,
  useSearchParams: () => search,
  useRouter: () => ({ replace, push: jest.fn(), refresh: jest.fn() }),
}));

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const ROLES = [
  { id: 'r-admin', key: 'admin', name: 'Admin', color: '#F87171', builtIn: true, position: 1_000_000, permissions: String(BigInt(1) << BigInt(30)), people: 1 },
  { id: 'r-editor', key: 'editor', name: 'Editor', color: '#60A5FA', builtIn: true, position: 2, permissions: '8416', people: 1 },
  { id: 'r-member', key: 'member', name: 'Member', color: '#A78BFA', builtIn: true, position: 1, permissions: '0', people: 5 },
  { id: 'r-acct', key: 'accountant', name: 'Accountant', color: '#34D399', builtIn: false, position: 12, permissions: '0', people: 2 },
];
const everywhere = { allWorlds: true, worldIds: [] as string[] };
const MEMBERS = [
  { userId: 'newest', name: 'Noor Khan', email: 'noor@example.com', joinedAt: '2026-10-10T00:00:00Z', isOwner: false, worlds: everywhere, roles: [] },
  { userId: 'sara', name: 'Sara Ali', email: 'sara@example.com', joinedAt: '2026-08-01T00:00:00Z', isOwner: false, worlds: everywhere, roles: [{ roleId: 'r-acct', ...everywhere }, { roleId: 'r-editor', ...everywhere }] },
];
const OWNER = { userId: 'owner', name: 'Khalid', email: null, woka: [], joinedAt: '2026-01-01T00:00:00Z', joined: false };

let calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
let memberRoles: { roleId: string; allWorlds: boolean; worldIds: string[] }[] = [];
let can = { giveRoleIds: ['r-admin', 'r-editor', 'r-acct'], giveWorlds: 'all' as 'all' | string[], remove: true };
let failNextRole = false;

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
  calls = [];
  failNextRole = false;
  params = { id: 'u1', userId: 'sara' };
  search = new URLSearchParams();
  memberRoles = [{ roleId: 'r-editor', ...everywhere }];
  can = { giveRoleIds: ['r-admin', 'r-editor', 'r-acct'], giveWorlds: 'all', remove: true };
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url === '/api/auth/me') return ok({ user: { id: 'owner' } });
    if (url === '/api/admin/universes/u1') return ok({ id: 'u1', name: 'BAWES', ownerId: 'owner', worlds: [{ id: 'hq', name: 'HQ' }, { id: 'campus', name: 'Campus' }] });
    if (url.endsWith('/u1/roles')) return ok({ roles: ROLES });
    if (url.endsWith('/u1/me')) return ok({ inviteWorlds: 'all' });
    if (url.endsWith('/u1/invitations') && method === 'GET') return ok({ invitations: [], canCancel: false });
    if (url.includes('/u1/members?')) return ok({ members: MEMBERS, total: 2, owner: OWNER, nextCursor: null });
    if (url.includes('/roles/')) {
      if (failNextRole) return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: 'Needs Give roles' }) });
      return ok({});
    }
    if (url.endsWith('/members/sara') && method === 'DELETE') return ok({});
    if (url.endsWith('/members/sara')) {
      return ok({
        member: { userId: 'sara', name: 'Sara Ali', email: 'sara@example.com', joinedAt: '2026-08-01T00:00:00Z', lastVisitedAt: null, isOwner: false, worlds: everywhere, roles: memberRoles },
        can,
      });
    }
    return ok({});
  });
});

const wrap = (node: React.ReactNode) => render(<ToastProvider>{node}</ToastProvider>);

describe('universe Members page', () => {
  it('puts the owner first, then the highest roles, each row opening the person', async () => {
    wrap(<UniverseMembersPage />);
    const list = await screen.findByTestId('members');
    const rows = within(list).getAllByRole('link');
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('Khalid'), expect.stringContaining('Sara Ali'), expect.stringContaining('Noor Khan')]);
    expect(rows[1].getAttribute('href')).toBe('/admin/universes/u1/members/sara');
    // Highest role plus "+N" for the rest, never a rank number
    const cards = Array.from(list.children) as HTMLElement[];
    expect(within(cards[1]).getByText('Accountant')).toBeTruthy();
    expect(within(cards[1]).getByText('+1')).toBeTruthy();
    expect(within(cards[2]).getByText('Member')).toBeTruthy();
    expect(await screen.findByText(/3 people/)).toBeTruthy();
  });

  it('links to the roles page and offers the invite sheet', async () => {
    wrap(<UniverseMembersPage />);
    const roles = await screen.findByRole('link', { name: /Roles & permissions/ });
    expect(roles.getAttribute('href')).toBe('/admin/universes/u1/roles');
    expect(await screen.findByRole('button', { name: 'Invite member' })).toBeTruthy();
  });

  it('asks the server for one world when the world filter comes in the address', async () => {
    search = new URLSearchParams('world=hq');
    wrap(<UniverseMembersPage />);
    await screen.findByTestId('members');
    expect(calls.some((call) => call.url.includes('/members?') && call.url.includes('worldId=hq'))).toBe(true);
  });
});

describe('a member’s page', () => {
  it('shows the locked Member line and the roles they hold ticked', async () => {
    wrap(<MemberPage />);
    expect(await screen.findByRole('heading', { name: 'Sara Ali' })).toBeTruthy();
    expect(screen.getByText(/sara@example.com · Joined Aug 2026 · Hasn’t visited yet/)).toBeTruthy();
    const base = screen.getByTestId('member-base');
    expect(within(base).getByText('Member')).toBeTruthy();
    expect(within(base).getByText('Everyone who joined · All worlds')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Editor' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('checkbox', { name: 'Accountant' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('checkbox', { name: 'Member' })).toBeNull();
  });

  it('saves as you tap: ticking gives the role, unticking takes it away', async () => {
    wrap(<MemberPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Accountant' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'PUT')).toBeTruthy());
    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.url).toBe('/api/admin/universes/u1/members/sara/roles/r-acct');
    expect(put.body).toEqual({ allWorlds: true, worldIds: [] });
    expect(screen.getByRole('checkbox', { name: 'Accountant' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Editor' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'DELETE')).toBeTruthy());
    expect(calls.find((call) => call.method === 'DELETE')!.url).toBe('/api/admin/universes/u1/members/sara/roles/r-editor');
  });

  it('moves a role to some worlds and saves the picked world', async () => {
    wrap(<MemberPage />);
    await screen.findByRole('checkbox', { name: 'Editor' });
    fireEvent.click(screen.getByRole('radio', { name: 'Some worlds' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ allWorlds: false, worldIds: ['hq'] });
  });

  it('undoes the tick and says why when the save is refused', async () => {
    failNextRole = true;
    wrap(<MemberPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Accountant' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Needs Give roles');
    expect(screen.getByRole('checkbox', { name: 'Accountant' }).getAttribute('aria-checked')).toBe('false');
  });

  it('cannot tick a role above yours', async () => {
    can = { ...can, giveRoleIds: ['r-acct'] };
    wrap(<MemberPage />);
    await screen.findByRole('checkbox', { name: 'Admin' });
    expect(screen.getByRole('checkbox', { name: 'Admin' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'Accountant' }).hasAttribute('disabled')).toBe(false);
  });

  it('removes them only after the confirm, which has Cancel as its way out', async () => {
    wrap(<MemberPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('heading', { name: 'Remove Sara Ali from BAWES?' })).toBeTruthy();
    expect(screen.getByText(/They lose Editor and every room it opens\. You can invite them again later\./)).toBeTruthy();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: /close/i })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/universes/u1/members'));
    expect(calls.find((call) => call.method === 'DELETE')!.url).toBe('/api/admin/universes/u1/members/sara');
  });

  it('hides the Danger zone from someone who cannot remove people', async () => {
    can = { ...can, remove: false };
    wrap(<MemberPage />);
    await screen.findByRole('heading', { name: 'Sara Ali' });
    expect(screen.queryByText('Danger zone')).toBeNull();
  });
});
