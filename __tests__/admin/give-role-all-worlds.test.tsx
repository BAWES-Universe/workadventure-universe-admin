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

const addToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast }) }));
jest.mock('@/app/admin/components/profile-card', () => ({ PersonIcon: () => <span /> }));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

const WORLDS = [
  { id: 'hq', name: 'HQ' },
  { id: 'campus', name: 'Campus' },
];

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
const BOSS: RoleRow = { ...ROLE, id: 'boss', key: 'boss', name: 'Boss', permissions: String(BigInt(1) << BigInt(30)) };

const meWith = (overrides: Partial<MeResponse>) =>
  ({
    isOwner: false,
    full: false,
    inUniverse: true,
    highestPosition: 50,
    everywhere: '0',
    perWorld: {},
    canManageRoles: true,
    giveWorlds: 'all',
    inviteWorlds: 'all',
    ...overrides,
  }) as unknown as MeResponse;

const LIMITED = { userId: 'lim', name: 'Melon', worlds: { allWorlds: false, worldIds: ['hq'] }, roles: [] };
const EVERYWHERE = { userId: 'all', name: 'Ahmad', worlds: { allWorlds: true, worldIds: [] }, roles: [] };

let puts: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  addToast.mockReset();
  puts = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'PUT') {
      puts.push({ url, body: JSON.parse(init.body ?? '{}') });
      return json({ ok: true });
    }
    return json({ members: [LIMITED, EVERYWHERE], total: 2, nextCursor: null });
  });
});
afterEach(cleanup);

async function openFor(role: RoleRow, me: MeResponse, person: RegExp) {
  render(<MembersTab role={role} universeId="u1" worlds={WORLDS} me={me} onChanged={jest.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Give to someone/ }));
  fireEvent.click(await screen.findByRole('radio', { name: person }));
  return {
    all: await screen.findByRole('radio', { name: /All worlds/ }),
    give: screen.getByRole('button', { name: 'Give role' }) as HTMLButtonElement,
  };
}

describe('Give role sheet, "All worlds" for someone limited to some worlds', () => {
  it('lets whoever may add people everywhere tap it, and adds them to every world', async () => {
    const { all, give } = await openFor(ROLE, meWith({}), /Melon/);
    expect(all.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(all);
    expect(give.disabled).toBe(false);
    fireEvent.click(give);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].url).toBe('/api/admin/universes/u1/members/lim/roles/ops');
    expect(puts[0].body).toEqual({ allWorlds: true, worldIds: [] });
  });

  it('starts on the worlds they are in, so giving without a tap on All worlds never widens them', async () => {
    const { give } = await openFor(ROLE, meWith({}), /Melon/);
    expect(give.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'HQ' }));
    fireEvent.click(give);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({ allWorlds: false, worldIds: ['hq'] });
  });

  it('locks it, with the reason on a tap, when you may add people to some worlds only', async () => {
    const { all, give } = await openFor(ROLE, meWith({ inviteWorlds: ['hq'] }), /Melon/);
    expect(all.getAttribute('aria-disabled')).toBe('true');
    expect(all.querySelector('svg')).not.toBeNull();
    fireEvent.click(all);
    expect(addToast).toHaveBeenCalledWith({ description: 'You can add people to some worlds only' });
    expect(give.disabled).toBe(true);
    expect(screen.getByText(/You can add people to some worlds only, so it can work only in the ones they have/)).toBeTruthy();
    expect(puts).toHaveLength(0);
  });

  it('says it is Give roles that is limited when that is the reason', async () => {
    const { all } = await openFor(ROLE, meWith({ giveWorlds: ['hq'] }), /Melon/);
    fireEvent.click(all);
    expect(addToast).toHaveBeenCalledWith({ description: 'You can give roles in some worlds only' });
    expect(screen.getByText('Needs Give roles in every world to give it everywhere.')).toBeTruthy();
  });

  it('keeps it open for someone who is in every world already, whatever you may invite', async () => {
    const { all, give } = await openFor(ROLE, meWith({ inviteWorlds: [] }), /Ahmad/);
    expect(all.getAttribute('aria-disabled')).toBeNull();
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(give.disabled).toBe(false);
    fireEvent.click(give);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({ allWorlds: true, worldIds: [] });
  });

  it('gives an Administrator role everywhere to someone limited, when you may add people everywhere', async () => {
    const { all, give } = await openFor(BOSS, meWith({}), /Melon/);
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(all.getAttribute('aria-disabled')).toBeNull();
    expect(give.disabled).toBe(false);
    fireEvent.click(give);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body).toEqual({ allWorlds: true, worldIds: [] });
  });

  it('refuses an Administrator role for someone limited when you may add people to some worlds only, with no toast on the picked choice', async () => {
    const { all, give } = await openFor(BOSS, meWith({ inviteWorlds: ['hq'] }), /Melon/);
    expect(all.getAttribute('aria-disabled')).toBe('true');
    expect(give.disabled).toBe(true);
    fireEvent.click(all);
    expect(addToast).not.toHaveBeenCalled();
    expect(screen.getByText(/Administrator works in every world, and you can add people to some worlds only/)).toBeTruthy();
  });
});
