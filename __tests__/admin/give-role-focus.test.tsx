/** @jest-environment jsdom */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MembersTab } from '@/app/admin/components/roles/members-tab';
import type { MeResponse, RoleRow } from '@/lib/role-ui';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast: jest.fn() }) }));
jest.mock('@/app/admin/components/profile-card', () => ({ PersonIcon: () => <span /> }));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

const ROLE: RoleRow = {
  id: 'ops',
  key: 'operations',
  name: 'Operations',
  color: '#34D399',
  showBadge: true,
  permissions: '0',
  position: 12,
  builtIn: false,
  people: 0,
  canEdit: true,
};

const ME = {
  isOwner: true,
  full: true,
  inUniverse: true,
  highestPosition: null,
  everywhere: '0',
  perWorld: {},
  canManageRoles: true,
  giveWorlds: 'all',
  inviteWorlds: 'all',
} as unknown as MeResponse;

const PEOPLE = [
  { userId: 'a', name: 'Ahmad', worlds: { allWorlds: true, worldIds: [] }, roles: [] },
  { userId: 'b', name: 'Mishari', worlds: { allWorlds: true, worldIds: [] }, roles: [] },
];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => json({ members: PEOPLE, total: 2, nextCursor: null }));
});
afterEach(cleanup);

describe('Give role sheet', () => {
  it('opens with the people list showing and the search box not focused, so a phone keyboard stays down', async () => {
    render(<MembersTab role={ROLE} universeId="u1" worlds={[]} me={ME} onChanged={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Give to someone/ }));

    const search = await screen.findByPlaceholderText('Search people who joined');
    expect(await screen.findByRole('radio', { name: /Ahmad/ })).toBeTruthy();
    expect(document.activeElement).not.toBe(search);
  });

  it('still lets the search box take focus when it is tapped', async () => {
    render(<MembersTab role={ROLE} universeId="u1" worlds={[]} me={ME} onChanged={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Give to someone/ }));

    const search = await screen.findByPlaceholderText('Search people who joined');
    search.focus();
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: 'Mis' } });
    expect((search as HTMLInputElement).value).toBe('Mis');
  });
});
