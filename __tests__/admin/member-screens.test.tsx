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
// As the server lists them: the highest role first
const MEMBERS = [
  { userId: 'sara', name: 'Sara Ali', email: 'sara@example.com', joinedAt: '2026-08-01T00:00:00Z', isOwner: false, worlds: everywhere, roles: [{ roleId: 'r-acct', ...everywhere }, { roleId: 'r-editor', ...everywhere }] },
  { userId: 'newest', name: 'Noor Khan', email: 'noor@example.com', joinedAt: '2026-10-10T00:00:00Z', isOwner: false, worlds: everywhere, roles: [] },
];
const OWNER = { userId: 'owner', name: 'Khalid', email: null, woka: [], joinedAt: '2026-01-01T00:00:00Z', joined: false };

let calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
let memberRoles: { roleId: string; allWorlds: boolean; worldIds: string[] }[] = [];
let can = { giveRoleIds: ['r-admin', 'r-editor', 'r-acct'], giveWorlds: 'all' as 'all' | string[], widen: true, remove: true };
let failNextRole = false;
let failBasics = false;
let staleList: ((value: unknown) => void) | null = null;

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
  calls = [];
  failNextRole = false;
  failBasics = false;
  staleList = null;
  params = { id: 'u1', userId: 'sara' };
  search = new URLSearchParams();
  memberRoles = [{ roleId: 'r-editor', ...everywhere }];
  can = { giveRoleIds: ['r-admin', 'r-editor', 'r-acct'], giveWorlds: 'all', widen: true, remove: true };
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url === '/api/auth/me') return ok({ user: { id: 'owner' } });
    if (url === '/api/admin/universes/u1' && failBasics) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    if (url === '/api/admin/universes/u1') return ok({ id: 'u1', name: 'BAWES', ownerId: 'owner', worlds: [{ id: 'hq', name: 'HQ' }, { id: 'campus', name: 'Campus' }] });
    if (url.endsWith('/u1/roles')) return ok({ roles: ROLES });
    if (url.endsWith('/u1/me')) return ok({ inviteWorlds: 'all' });
    if (url.endsWith('/u1/invitations') && method === 'GET') return ok({ invitations: [], canCancel: false });
    if (url.includes('/u1/members?') && url.includes('cursor=c2')) return new Promise((resolve) => { staleList = resolve; });
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
  it('puts the owner first, then people in the order the server ranks them, each row opening the person', async () => {
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

describe('when the universe or its roles can’t be loaded', () => {
  it.each([
    ['the Members page', () => <UniverseMembersPage />],
    ['a member’s page', () => <MemberPage />],
  ])('%s shows the error with a retry, never a skeleton forever, and the retry asks again', async (_name, view) => {
    failBasics = true;
    wrap(view());
    await screen.findByText(/couldn’t load this universe/);
    failBasics = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/couldn’t load this universe/)).toBeNull());
    await waitFor(() => expect(calls.filter((call) => call.url === '/api/admin/universes/u1').length).toBeGreaterThan(1));
  });
});

describe('Show more', () => {
  it('drops the rows of an answer for a search that is no longer the one on screen', async () => {
    // Nine people and more to come, so "Show more" asks for the next page
    const nine = Array.from({ length: 9 }, (_, n) => ({ ...MEMBERS[1], userId: `p${n}`, name: `Person ${n}`, email: null, roles: [] }));
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (url.includes('/u1/members?') && url.includes('q=zed')) return ok({ members: [{ ...MEMBERS[1], userId: 'zed', name: 'Zed Only', email: null, roles: [] }], total: 1, owner: null, nextCursor: null });
      if (url.includes('/u1/members?') && !url.includes('cursor=')) return ok({ members: nine, total: 12, owner: null, nextCursor: 'c2' });
      return base(url, init);
    });
    wrap(<UniverseMembersPage />);
    await screen.findByText('Person 7');
    fireEvent.click(screen.getByRole('button', { name: /Show \d+ more/ }));
    await waitFor(() => expect(staleList).not.toBeNull());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zed' } });
    fireEvent.submit(screen.getByRole('search'));
    await screen.findByText('Zed Only');
    staleList!({ ok: true, status: 200, json: () => Promise.resolve({ members: [{ ...MEMBERS[1], userId: 'late', name: 'Late Arrival', email: null, roles: [] }], total: 12, owner: null, nextCursor: null }) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Late Arrival')).toBeNull();
    expect(screen.getByText('Zed Only')).toBeTruthy();
  });

  it('never asks for the old list’s next page with a new search that hasn’t answered yet', async () => {
    const nine = Array.from({ length: 9 }, (_, n) => ({ ...MEMBERS[1], userId: `p${n}`, name: `Person ${n}`, email: null, roles: [] }));
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method ?? 'GET', body: undefined });
      if (url.includes('/u1/members?') && url.includes('q=zed')) return new Promise(() => {});
      if (url.includes('/u1/members?') && !url.includes('cursor=')) return ok({ members: nine, total: 12, owner: null, nextCursor: 'c2' });
      return base(url, init);
    });
    wrap(<UniverseMembersPage />);
    await screen.findByText('Person 7');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zed' } });
    fireEvent.submit(screen.getByRole('search'));
    await waitFor(() => expect(calls.some((call) => call.url.includes('q=zed'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /Show \d+ more/ }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.some((call) => call.url.includes('cursor=c2'))).toBe(false);
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

  it('keeps the worlds picked when the segment already chosen is tapped again', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith('/members/sara') && !init?.method) {
        return ok({
          member: { userId: 'sara', name: 'Sara Ali', email: 'sara@example.com', joinedAt: '2026-08-01T00:00:00Z', lastVisitedAt: null, isOwner: false, worlds: everywhere, roles: [{ roleId: 'r-editor', allWorlds: false, worldIds: ['hq', 'campus'] }] },
          can,
        });
      }
      return base(url, init);
    });
    wrap(<MemberPage />);
    await screen.findByRole('checkbox', { name: 'Editor' });
    fireEvent.click(screen.getByRole('radio', { name: 'Some worlds' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Some worlds' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(screen.getByRole('button', { name: 'HQ' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Campus' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('undoes the tick and says why when the save is refused', async () => {
    failNextRole = true;
    wrap(<MemberPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Accountant' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Needs Give roles');
    expect(screen.getByRole('checkbox', { name: 'Accountant' }).getAttribute('aria-checked')).toBe('false');
  });

  it('gives Administrator in every world, the only way the server takes it', async () => {
    can = { ...can, giveWorlds: 'all' };
    wrap(<MemberPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Admin' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'PUT')).toBeTruthy());
    expect(calls.find((call) => call.method === 'PUT')!.url).toBe('/api/admin/universes/u1/members/sara/roles/r-admin');
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ allWorlds: true, worldIds: [] });
  });

  it('turns the Administrator row off, with the reason, when you cannot give roles in every world', async () => {
    can = { ...can, giveWorlds: ['hq'] };
    wrap(<MemberPage />);
    const admin = await screen.findByRole('checkbox', { name: 'Admin' });
    expect(admin.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Administrator works in every world')).toBeTruthy();
    fireEvent.click(admin);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    // Other roles still work, in the worlds you may give them in
    expect(screen.getByRole('checkbox', { name: 'Accountant' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Accountant' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'PUT')).toBeTruthy());
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ allWorlds: false, worldIds: ['hq'] });
  });

  it('keeps the newest change when an earlier save of the same role fails late', async () => {
    // The first save waits; it is answered with a refusal only after the role was tapped again
    let refuseFirst: ((value: unknown) => void) | null = null;
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith('/roles/r-acct') && init?.method === 'PUT') {
        calls.push({ url, method: 'PUT', body: JSON.parse(init.body ?? '{}') });
        return new Promise((resolve) => { refuseFirst = resolve; });
      }
      return base(url, init);
    });
    wrap(<MemberPage />);
    const box = await screen.findByRole('checkbox', { name: 'Accountant' });
    fireEvent.click(box); // on
    fireEvent.click(screen.getByRole('checkbox', { name: 'Accountant' })); // and off again before the first save answers
    expect(screen.getByRole('checkbox', { name: 'Accountant' }).getAttribute('aria-checked')).toBe('false');
    // One request per role at a time: the second waits for the first
    expect(calls.filter((call) => call.url.endsWith('/roles/r-acct') && call.method === 'DELETE')).toHaveLength(0);
    await waitFor(() => expect(refuseFirst).not.toBeNull());
    refuseFirst!({ ok: false, status: 403, json: () => Promise.resolve({ error: 'Needs Give roles' }) });
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/roles/r-acct') && call.method === 'DELETE')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The late failure does not put the tick back, or show its error over the newer change
    expect(screen.getByRole('checkbox', { name: 'Accountant' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('goes back to what was saved when the newest change fails', async () => {
    wrap(<MemberPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Accountant' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    failNextRole = true;
    fireEvent.click(screen.getByRole('checkbox', { name: 'Accountant' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Needs Give roles');
    // Back on: the first tick was saved, the second (taking it away) was refused
    expect(screen.getByRole('checkbox', { name: 'Accountant' }).getAttribute('aria-checked')).toBe('true');
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

  it('after you leave a universe yourself, goes to your universes, not the Members page you can no longer open', async () => {
    params = { id: 'u1', userId: 'sara' };
    const base = fetchMock.getMockImplementation()!;
    // Sara is the one looking
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => (url === '/api/auth/me' ? ok({ user: { id: 'sara' } }) : base(url, init)));
    wrap(<MemberPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/universes'));
    expect(replace).not.toHaveBeenCalledWith('/admin/universes/u1/members');
  });

  it('turns a role off, with the reason, when the only worlds you may give it in are ones they are not in', async () => {
    // Sara is a member of HQ only, and you may give roles in Campus only
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith('/members/sara') && !init?.method) {
        return ok({
          member: { userId: 'sara', name: 'Sara Ali', email: 'sara@example.com', joinedAt: '2026-08-01T00:00:00Z', lastVisitedAt: null, isOwner: false, worlds: { allWorlds: false, worldIds: ['hq'] }, roles: [] },
          can: { giveRoleIds: ['r-admin', 'r-editor', 'r-acct'], giveWorlds: ['campus'], widen: false, remove: true },
        });
      }
      return base(url, init);
    });
    wrap(<MemberPage />);
    const box = await screen.findByRole('checkbox', { name: 'Accountant' });
    expect(box.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText('You can give roles only in worlds they’re not in').length).toBeGreaterThan(0);
    fireEvent.click(box);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  describe('someone limited to some worlds', () => {
    // Sara is a member of HQ only, with Editor working in HQ: the universe has HQ and Campus
    function limitedSara(giver: Partial<typeof can>) {
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
        if (url.endsWith('/members/sara') && !init?.method) {
          return ok({
            member: { userId: 'sara', name: 'Sara Ali', email: 'sara@example.com', joinedAt: '2026-08-01T00:00:00Z', lastVisitedAt: null, isOwner: false, worlds: { allWorlds: false, worldIds: ['hq'] }, roles: [{ roleId: 'r-editor', allWorlds: false, worldIds: ['hq'] }] },
            can: { ...can, ...giver },
          });
        }
        return base(url, init);
      });
    }

    it('widens them to every world on one tap on "All worlds", and the Member line follows', async () => {
      limitedSara({});
      wrap(<MemberPage />);
      await screen.findByRole('checkbox', { name: 'Editor' });
      expect(within(screen.getByTestId('member-base')).getByText('Everyone who joined · HQ only')).toBeTruthy();
      const all = screen.getByRole('radio', { name: 'All worlds' });
      expect(all.hasAttribute('disabled')).toBe(false);
      expect(all.hasAttribute('aria-disabled')).toBe(false);
      fireEvent.click(all);
      await waitFor(() => expect(calls.find((call) => call.method === 'PUT')).toBeTruthy());
      expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ allWorlds: true, worldIds: [] });
      expect(await within(screen.getByTestId('member-base')).findByText('Everyone who joined · All worlds')).toBeTruthy();
      // Tapping back limits the role only: they stay in every world and every world can be picked
      fireEvent.click(screen.getByRole('radio', { name: 'Some worlds' }));
      await waitFor(() => expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2));
      expect(within(screen.getByTestId('member-base')).getByText('Everyone who joined · All worlds')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Campus' })).toBeTruthy();
    });

    it('leaves the Member line and the choice as they were when the save is refused', async () => {
      limitedSara({});
      failNextRole = true;
      wrap(<MemberPage />);
      await screen.findByRole('checkbox', { name: 'Editor' });
      fireEvent.click(screen.getByRole('radio', { name: 'All worlds' }));
      expect((await screen.findByRole('alert')).textContent).toBe('Needs Give roles');
      expect(within(screen.getByTestId('member-base')).getByText('Everyone who joined · HQ only')).toBeTruthy();
      expect(screen.getByRole('radio', { name: 'Some worlds' }).getAttribute('aria-checked')).toBe('true');
    });

    it('does not widen them when a role is only ticked: it starts in the worlds they are in', async () => {
      limitedSara({});
      wrap(<MemberPage />);
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Accountant' }));
      await waitFor(() => expect(calls.find((call) => call.method === 'PUT')).toBeTruthy());
      expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ allWorlds: false, worldIds: ['hq'] });
      expect(within(screen.getByTestId('member-base')).getByText('Everyone who joined · HQ only')).toBeTruthy();
    });

    it('gives Administrator, which is every world, to someone who may widen', async () => {
      limitedSara({});
      wrap(<MemberPage />);
      const admin = await screen.findByRole('checkbox', { name: 'Admin' });
      expect(admin.hasAttribute('disabled')).toBe(false);
      fireEvent.click(admin);
      await waitFor(() => expect(calls.find((call) => call.method === 'PUT')).toBeTruthy());
      expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ allWorlds: true, worldIds: [] });
    });

    it('locks "All worlds" with the reason, and sends nothing, for someone who may not add people to every world', async () => {
      limitedSara({ widen: false });
      wrap(<MemberPage />);
      await screen.findByRole('checkbox', { name: 'Editor' });
      const all = screen.getByRole('radio', { name: 'All worlds' });
      expect(all.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(all);
      expect((await screen.findByRole('status')).textContent).toBe('You can add people to some worlds only');
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
      expect(screen.getByRole('radio', { name: 'Some worlds' }).getAttribute('aria-checked')).toBe('true');
      // Administrator stays off for them, with its reason
      expect(screen.getByRole('checkbox', { name: 'Admin' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByText('Administrator works in every world')).toBeTruthy();
    });

    it('says it is the roles they may give that are limited, for someone who gives roles in some worlds only', async () => {
      limitedSara({ giveWorlds: ['hq'], widen: true });
      wrap(<MemberPage />);
      await screen.findByRole('checkbox', { name: 'Editor' });
      fireEvent.click(screen.getByRole('radio', { name: 'All worlds' }));
      expect((await screen.findByRole('status')).textContent).toBe('You can give roles in some worlds only');
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    });

    it('does not widen them when a role is ticked and none of their worlds is one you can start it in', async () => {
      // Their only world is one that no longer exists; you may widen, but a tick is never the way
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
        if (url.endsWith('/members/sara') && !init?.method) {
          return ok({
            member: { userId: 'sara', name: 'Sara Ali', email: 'sara@example.com', joinedAt: '2026-08-01T00:00:00Z', lastVisitedAt: null, isOwner: false, worlds: { allWorlds: false, worldIds: ['gone'] }, roles: [] },
            can,
          });
        }
        return base(url, init);
      });
      wrap(<MemberPage />);
      const box = await screen.findByRole('checkbox', { name: 'Accountant' });
      expect(box.hasAttribute('disabled')).toBe(true);
      fireEvent.click(box);
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    });

    it('keeps Administrator tickable for someone who may widen, even when none of their worlds still exists', async () => {
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
        if (url.endsWith('/members/sara') && !init?.method) {
          return ok({
            member: { userId: 'sara', name: 'Sara Ali', email: 'sara@example.com', joinedAt: '2026-08-01T00:00:00Z', lastVisitedAt: null, isOwner: false, worlds: { allWorlds: false, worldIds: ['gone'] }, roles: [] },
            can,
          });
        }
        return base(url, init);
      });
      wrap(<MemberPage />);
      const admin = await screen.findByRole('checkbox', { name: 'Admin' });
      expect(admin.hasAttribute('disabled')).toBe(false);
      fireEvent.click(admin);
      await waitFor(() => expect(calls.find((call) => call.method === 'PUT')).toBeTruthy());
      expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ allWorlds: true, worldIds: [] });
    });

    it('says nothing when the locked "All worlds" is already the choice', async () => {
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
        if (url.endsWith('/members/sara') && !init?.method) {
          return ok({
            member: { userId: 'sara', name: 'Sara Ali', email: 'sara@example.com', joinedAt: '2026-08-01T00:00:00Z', lastVisitedAt: null, isOwner: false, worlds: { allWorlds: false, worldIds: ['hq'] }, roles: [{ roleId: 'r-editor', ...everywhere }] },
            can: { ...can, widen: false },
          });
        }
        return base(url, init);
      });
      wrap(<MemberPage />);
      await screen.findByRole('checkbox', { name: 'Editor' });
      const all = screen.getByRole('radio', { name: 'All worlds' });
      expect(all.getAttribute('aria-checked')).toBe('true');
      fireEvent.click(all);
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('never offers "All worlds" on a role that is not yours to give: the whole row is off', async () => {
      limitedSara({ giveRoleIds: ['r-acct'] });
      wrap(<MemberPage />);
      await screen.findByRole('checkbox', { name: 'Editor' });
      const all = screen.getByRole('radio', { name: 'All worlds' });
      expect(all.hasAttribute('disabled')).toBe(true);
      fireEvent.click(all);
      expect(screen.queryByRole('status')).toBeNull();
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    });
  });

  it('hides the Danger zone from someone who cannot remove people', async () => {
    can = { ...can, remove: false };
    wrap(<MemberPage />);
    await screen.findByRole('heading', { name: 'Sara Ali' });
    expect(screen.queryByText('Danger zone')).toBeNull();
  });
});
