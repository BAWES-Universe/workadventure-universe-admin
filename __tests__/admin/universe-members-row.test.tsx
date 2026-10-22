/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import UniverseMembersRow from '@/app/admin/components/universe-members-row';
import { MemberPage } from '@/app/admin/universes/[id]/members/[userId]/member-page';
import { ToastProvider } from '@/components/ui/toast';

const fetchMock = jest.fn();
let params: Record<string, string> = { id: 'u1', userId: 'owner' };

jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
jest.mock('next/navigation', () => ({
  useParams: () => params,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), refresh: jest.fn() }),
}));

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const ROLES = [
  { id: 'r-admin', key: 'admin', name: 'Admin', color: '#F87171', builtIn: true, position: 1_000_000, permissions: String(BigInt(1) << BigInt(30)), people: 1 },
  { id: 'r-head', key: 'head', name: 'Head of Customer Experience and Quality', color: '#34D399', builtIn: false, position: 30, permissions: '0', people: 1 },
  { id: 'r-cs', key: 'customer_service', name: 'Customer Service', color: '#38BDF8', builtIn: false, position: 20, permissions: '0', people: 2 },
  { id: 'r-member', key: 'member', name: 'Member', color: '#A78BFA', builtIn: true, position: 1, permissions: '0', people: 5 },
];
const everywhere = { allWorlds: true, worldIds: [] as string[] };
const given = (...ids: string[]) => ids.map((roleId) => ({ roleId, ...everywhere }));
const face = (userId: string, name: string, roles: string[], isOwner = false) => ({
  userId, name, email: null, joinedAt: '2026-01-01T00:00:00Z', isOwner, worlds: everywhere, roles: given(...roles), woka: [],
});
const KHALID = face('owner', 'Khalid', ['r-admin'], true);
const MEMBERS = [KHALID, face('omar', 'Omar', ['r-head', 'r-cs', 'r-admin']), face('sara', 'Sara', ['r-cs']), face('plain', 'Noor', [])];

beforeEach(() => {
  fetchMock.mockReset();
  params = { id: 'u1', userId: 'owner' };
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/auth/me') return ok({ user: { id: 'owner' } });
    if (url === '/api/admin/universes/u1') return ok({ id: 'u1', name: 'BAWES Universe', ownerId: 'owner', worlds: [{ id: 'hq', name: 'HQ' }] });
    if (url.endsWith('/u1/roles')) return ok({ roles: ROLES });
    if (url.endsWith('/u1/me')) return ok({ inviteWorlds: 'all' });
    if (url.includes('/u1/members?')) return ok({ members: MEMBERS, total: 4, owner: { userId: 'owner', name: 'Khalid', email: null, woka: [], joinedAt: '2026-01-01T00:00:00Z', joined: true }, nextCursor: null });
    if (url.endsWith('/members/owner')) return ok({ member: { ...KHALID, lastVisitedAt: null }, can: { giveRoleIds: [], giveWorlds: [], remove: false } });
    return ok({});
  });
});

const wrap = (node: React.ReactNode) => render(<ToastProvider>{node}</ToastProvider>);
const faceOf = async (name: string) => {
  const faces = await screen.findByTestId('members-faces');
  return within(faces).getByText(name).closest('li') as HTMLElement;
};

describe('Members row', () => {
  it('shows the owner as a crown by the name, with their highest given role and no +1 for Owner', async () => {
    wrap(<UniverseMembersRow universeId="u1" />);
    const khalid = await faceOf('Khalid');
    expect(within(khalid).getByRole('img', { name: 'Owner' })).toBeTruthy();
    expect(within(khalid).getByText('Admin')).toBeTruthy();
    expect(within(khalid).queryByText('Owner')).toBeNull();
    expect(within(khalid).queryByText(/^\+\d/)).toBeNull();
  });

  it('shows the highest role and +N for the others, and Member only for someone with no role', async () => {
    wrap(<UniverseMembersRow universeId="u1" />);
    const omar = await faceOf('Omar');
    expect(within(omar).getByText('Head of Customer Experience and Quality')).toBeTruthy();
    expect(within(omar).getByText('+2')).toBeTruthy();
    expect(within(await faceOf('Sara')).getByText('Customer Service')).toBeTruthy();
    expect(within(await faceOf('Noor')).getByText('Member')).toBeTruthy();
    expect(within(omar).queryByRole('img', { name: 'Owner' })).toBeNull();
  });

  it('keeps the face a link to the person, and the roles their own 44px button outside it', async () => {
    wrap(<UniverseMembersRow universeId="u1" />);
    const omar = await faceOf('Omar');
    expect(within(omar).getByRole('link').getAttribute('href')).toBe('/admin/universes/u1/members/omar');
    const button = within(omar).getByRole('button', { name: /Omar’s roles/ });
    expect(button.closest('a')).toBeNull();
    expect(button.className).toContain('min-h-11');
    expect(omar.className).toContain('w-[128px]');
  });

  it('opens every role in full from the pill, and closes with Close', async () => {
    wrap(<UniverseMembersRow universeId="u1" />);
    fireEvent.click(within(await faceOf('Omar')).getByRole('button', { name: /Omar’s roles/ }));
    const list = await screen.findByTestId('roles-sheet');
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Head of Customer Experience and Quality', 'Customer Service', 'Admin']);
    expect(screen.getByText('Everyone who joined is also a Member.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('roles-sheet')).toBeNull());
  });

  it('lists Owner first for the owner, as created the universe, then the roles they were given', async () => {
    wrap(<UniverseMembersRow universeId="u1" />);
    fireEvent.click(within(await faceOf('Khalid')).getByRole('button', { name: /Khalid’s roles/ }));
    const items = within(await screen.findByTestId('roles-sheet')).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['OwnerCreated BAWES Universe', 'Admin']);
  });
});

describe('The owner’s own page', () => {
  it('lists Owner, the roles they hold and the automatic Member instead of only "nothing to give"', async () => {
    wrap(<MemberPage />);
    const roles = await screen.findByTestId('owner-roles');
    const rows = within(roles).getAllByText(/Owner|Admin|Member/).map((node) => node.textContent);
    expect(rows).toEqual(expect.arrayContaining(['Owner', 'Admin', 'Member']));
    expect(within(roles).getByText('You created BAWES Universe')).toBeTruthy();
    expect(within(roles).getByText(/The owner has every permission in every world, so roles add nothing here\./)).toBeTruthy();
    expect(screen.queryByText(/nothing to give/)).toBeNull();
  });
});
