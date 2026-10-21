/** @jest-environment jsdom */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fromKeys, toWire } from '@/lib/permissions';
import { RolesListPage } from '@/app/admin/components/roles/roles-list';
import { RoleEditPage } from '@/app/admin/components/roles/role-editor';
import type { MeResponse, RoleRow } from '@/lib/role-ui';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const push = jest.fn();
const replace = jest.fn();
let params: Record<string, string> = { id: 'u1' };
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useParams: () => params,
}));

const addToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast }) }));
jest.mock('@/app/admin/components/profile-card', () => ({ PersonIcon: () => <span /> }));

const fetchMock = jest.fn();
jest.mock('@/lib/client-auth', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

const role = (over: Partial<RoleRow> & Pick<RoleRow, 'id' | 'key' | 'name'>): RoleRow => ({
  color: '#34D399',
  showBadge: true,
  permissions: '0',
  position: 12,
  builtIn: false,
  people: 0,
  canEdit: true,
  ...over,
});

// What a new universe's Everyone starts with (lib/roles.ts EVERYONE_DEFAULT_PERMISSIONS; not imported, it reaches the database)
const EVERYONE_DEFAULT_PERMISSIONS = fromKeys(['CHAT_BOTS_NEARBY', 'DM_BOTS', 'SUMMON_BOTS']);

const ROLES: RoleRow[] = [
  role({ id: 'admin', key: 'admin', name: 'Admin', builtIn: true, position: 1_000_000, permissions: '131071', people: 1, color: '#F87171' }),
  role({ id: 'lead', key: 'lead', name: 'Lead', position: 40, people: 1, canEdit: false }),
  role({ id: 'mod', key: 'moderator', name: 'Moderator', position: 13, people: 1, permissions: toWire(fromKeys(['MODERATE_CALLS'])) }),
  role({ id: 'acc', key: 'accountant', name: 'Accountant', position: 12, people: 2 }),
  role({ id: 'editor', key: 'editor', name: 'Editor', builtIn: true, position: 2, permissions: toWire(fromKeys(['EDIT_MAPS'])), people: 1 }),
  role({ id: 'member', key: 'member', name: 'Member', builtIn: true, position: 1, people: 23 }),
  role({ id: 'everyone', key: 'everyone', name: 'Everyone', builtIn: true, position: 0, people: null, permissions: toWire(EVERYONE_DEFAULT_PERMISSIONS) }),
];

const OWNER_ME: MeResponse = {
  isOwner: true,
  full: true,
  inUniverse: true,
  highestPosition: null,
  everywhere: toWire(fromKeys(['ADMINISTRATOR'])),
  perWorld: {},
  canManageRoles: true,
  giveWorlds: 'all',
  inviteWorlds: 'all',
};

const LEAD_ME: MeResponse = {
  ...OWNER_ME,
  isOwner: false,
  full: false,
  highestPosition: 40,
  everywhere: toWire(fromKeys(['MANAGE_ROLES', 'GIVE_ROLES', 'EDIT_MAPS'])),
};

let me = OWNER_ME;
let roles = ROLES;
let canManageRoles = true;
let canCreateRoles = true;

function serve(extra?: (url: string, init?: RequestInit) => Promise<Response> | undefined) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const special = extra?.(url, init);
    if (special) return special;
    if (url === '/api/admin/universes/u1') return json({ id: 'u1', name: 'BAWES', worlds: [{ id: 'hq', name: 'HQ' }, { id: 'campus', name: 'Campus' }] });
    if (url === '/api/admin/universes/u1/roles') return json({ roles, canManageRoles, canCreateRoles: canManageRoles && canCreateRoles, canGiveRoles: 'all' });
    if (url === '/api/admin/universes/u1/me') return json(me);
    if (url.endsWith('/used-in')) {
      return json({
        doors: { basis: 'none', rooms: [], roomsTotal: 0 },
        reach: { held: false, allWorlds: false, worlds: [], rooms: [], roomsTotal: 0, mapAreas: { status: 'not_configured', areas: [], unread: 0, skipped: 0, read: 0 }, permissions: [] },
      });
    }
    if (url.includes('/members')) return json({ members: [], total: 0, nextCursor: null });
    return json({});
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  replace.mockReset();
  addToast.mockReset();
  params = { id: 'u1' };
  me = OWNER_ME;
  roles = ROLES;
  canManageRoles = true;
  canCreateRoles = true;
});

describe('Roles & permissions list', () => {
  it('lists custom roles highest first, then the built-in ones apart, with a line for each', async () => {
    serve();
    render(<RolesListPage />);
    await screen.findByText('Your roles');
    const rows = screen.getAllByTestId('role-row').map((row) => row.textContent ?? '');
    ['Lead', 'Moderator', 'Accountant', 'Everyone', 'Admin', 'Editor', 'Member'].forEach((name, index) => {
      expect(rows[index].startsWith(name)).toBe(true);
    });
    expect(rows[3]).toContain('Every visitor');
    expect(rows[6]).toContain('23 people');
    expect(screen.getByText('Highest first. Drag to change who manages whom.')).toBeTruthy();
    expect(screen.getByText('Their names can’t change.', { exact: false })).toBeTruthy();
  });

  it('opens a role by tapping its row, and has no action buttons on rows', async () => {
    serve();
    render(<RolesListPage />);
    await screen.findByText('Your roles');
    const row = screen.getAllByTestId('role-row')[2];
    expect(within(row).getByRole('link').getAttribute('href')).toBe('/admin/universes/u1/roles/acc');
    expect(within(row).queryAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Move Accountant. Drag, or use the up and down arrow keys.',
    ]);
    expect(within(screen.getAllByTestId('role-row')[3]).queryAllByRole('button')).toHaveLength(0);
  });

  it('lets only the roles below yours be dragged', async () => {
    me = LEAD_ME;
    serve();
    render(<RolesListPage />);
    await screen.findByText('Your roles');
    expect(screen.queryByRole('button', { name: /Move Lead/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Move Moderator/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Move Accountant/ })).toBeTruthy();
  });

  it('shows no drag handles without Manage roles in every world, even for a role ranked below yours', async () => {
    me = LEAD_ME;
    canManageRoles = false;
    serve();
    render(<RolesListPage />);
    await screen.findByText('Your roles');
    expect(screen.getByText('Moderator')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Move / })).toBeNull();
  });

  it('saves a move made with the arrow keys when the page is left before the save would start', async () => {
    serve((url, init) => (url.endsWith('/roles/order') && init?.method === 'PUT' ? json({ success: true }) : undefined));
    const { unmount } = render(<RolesListPage />);
    await screen.findByText('Your roles');
    fireEvent.keyDown(screen.getByRole('button', { name: /Move Accountant/ }), { key: 'ArrowUp' });
    unmount();
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/roles/order') && init?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put![1].body)).toEqual({ roleIds: ['lead', 'acc', 'mod'] });
    });
  });

  it('moves a role with the arrow keys and saves the new order', async () => {
    serve((url, init) => (url.endsWith('/roles/order') && init?.method === 'PUT' ? json({ success: true }) : undefined));
    render(<RolesListPage />);
    await screen.findByText('Your roles');
    fireEvent.keyDown(screen.getByRole('button', { name: /Move Accountant/ }), { key: 'ArrowUp' });
    expect(screen.getAllByTestId('role-row').slice(0, 3).map((row) => row.textContent?.slice(0, 5))).toEqual(['Lead1', 'Accou', 'Moder']);
    await waitFor(
      () => {
        const put = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/roles/order') && init?.method === 'PUT');
        expect(put).toBeTruthy();
        expect(JSON.parse(put![1].body)).toEqual({ roleIds: ['lead', 'acc', 'mod'] });
      },
      { timeout: 3000 },
    );
  });

  it('saves an arrow-key move at once when a drag starts, so its late save cannot undo the drag', async () => {
    const puts: string[][] = [];
    serve((url, init) => {
      if (!url.endsWith('/roles/order') || init?.method !== 'PUT') return undefined;
      puts.push(JSON.parse(init.body as string).roleIds);
      return json({ success: true });
    });
    render(<RolesListPage />);
    await screen.findByText('Your roles');
    fireEvent.keyDown(screen.getByRole('button', { name: /Move Accountant/ }), { key: 'ArrowUp' });
    const handle = screen.getByRole('button', { name: /Move Moderator/ });
    Object.assign(handle, { setPointerCapture: () => {} });
    // Each row 80px tall, in the order shown
    screen.getAllByTestId('role-row').forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: index * 80, height: 72 }) as DOMRect;
    });
    // Drag Moderator to the top before the arrow-key wait is over
    fireEvent.pointerDown(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await waitFor(() => expect(puts.length).toBeGreaterThanOrEqual(2));
    // The arrow-key wait has passed: the drag is still the last order saved
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(puts).toEqual([
      ['lead', 'acc', 'mod'],
      ['mod', 'lead', 'acc'],
    ]);
  });

  it('saves a drag let go away from the handle, after the handle lost the pointer', async () => {
    const puts: string[][] = [];
    serve((url, init) => {
      if (!url.endsWith('/roles/order') || init?.method !== 'PUT') return undefined;
      puts.push(JSON.parse(init.body as string).roleIds);
      return json({ success: true });
    });
    render(<RolesListPage />);
    await screen.findByText('Your roles');
    screen.getAllByTestId('role-row').forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: index * 80, height: 72 }) as DOMRect;
    });
    const handle = screen.getByRole('button', { name: /Move Accountant/ });
    Object.assign(handle, { setPointerCapture: () => {} });
    fireEvent.pointerDown(handle, { pointerId: 1 });
    // The rest of the drag reaches only the page, not the handle
    fireEvent.pointerMove(document.body, { pointerId: 1, clientY: 0 });
    fireEvent.pointerUp(document.body, { pointerId: 1 });
    await waitFor(() => expect(puts).toEqual([['acc', 'lead', 'mod']]));
    expect(document.querySelector('[data-dragging]')).toBeNull();
  });

  it('keeps a move made while an earlier order is still being saved, and saves both moves', async () => {
    let finishFirstSave: () => void = () => {};
    const puts: string[][] = [];
    serve((url, init) => {
      if (!url.endsWith('/roles/order') || init?.method !== 'PUT') return undefined;
      puts.push(JSON.parse(init.body as string).roleIds);
      if (puts.length > 1) return json({ success: true });
      return new Promise<Response>((resolve) => {
        finishFirstSave = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) } as Response);
      });
    });
    render(<RolesListPage />);
    await screen.findByText('Your roles');
    const names = () => screen.getAllByTestId('role-row').slice(0, 3).map((row) => row.textContent?.slice(0, 5));

    // First move: Accountant above Moderator. Its save starts and stays open.
    fireEvent.keyDown(screen.getByRole('button', { name: /Move Accountant/ }), { key: 'ArrowUp' });
    await waitFor(() => expect(puts).toEqual([['lead', 'acc', 'mod']]), { timeout: 3000 });

    // Second move while that save is still open: Accountant above Lead
    fireEvent.keyDown(screen.getByRole('button', { name: /Move Accountant/ }), { key: 'ArrowUp' });
    expect(names()).toEqual(['Accou', 'Lead1', 'Moder']);

    // The first save and its reload finish: the newer order stays, it does not snap back to the server's
    finishFirstSave();
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ description: 'Order saved' })));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(names()).toEqual(['Accou', 'Lead1', 'Moder']);

    // And the second save carries both moves
    await waitFor(() => expect(puts).toEqual([['lead', 'acc', 'mod'], ['acc', 'lead', 'mod']]), { timeout: 3000 });
  });

  it('creates a role from a template and opens it', async () => {
    serve((url, init) => (url.endsWith('/roles') && init?.method === 'POST' ? json({ role: { id: 'new-1' } }, 201) : undefined));
    render(<RolesListPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create role' }));
    const sheet = await screen.findByTestId('create-role-sheet');
    expect(within(sheet).getByText('You can change everything after. The new role goes just below yours.')).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: /close/i })).toBeNull();
    const submit = within(sheet).getByRole('button', { name: 'Create and edit' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Door staff' } });
    fireEvent.click(within(sheet).getByRole('radio', { name: /Moderator/ }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/universes/u1/roles/new-1'));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    const body = JSON.parse(post[1].body);
    expect(body.name).toBe('Door staff');
    expect(BigInt(body.permissions)).toBe(fromKeys(['MODERATE_CALLS', 'KICK_FROM_ROOM', 'BAN_AND_APPEALS', 'MODERATE_AREA_CHATS']));
  });

  it('copies a role, and disables a start the viewer cannot give', async () => {
    me = LEAD_ME;
    serve();
    render(<RolesListPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create role' }));
    const sheet = await screen.findByTestId('create-role-sheet');
    // A lead without Ban and answer appeals cannot start from Moderator
    expect((within(sheet).getByRole('radio', { name: /Moderator/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByText(/Needs Ban and answer appeals/)).toBeTruthy();
    expect((within(sheet).getByRole('radio', { name: /Builder/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(sheet).getByRole('radio', { name: /Blank/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(sheet).getByRole('radio', { name: /Copy a role/ }));
    expect(within(sheet).getByRole('button', { name: 'Accountant' })).toBeTruthy();
  });

  it('hides Create role and says what is needed when you manage roles but only from Editor or Member', async () => {
    canCreateRoles = false;
    me = { ...LEAD_ME, highestPosition: 2 };
    serve();
    render(<RolesListPage />);
    await screen.findByText('Your roles');
    expect(screen.queryByRole('button', { name: 'Create role' })).toBeNull();
    expect(screen.getByText(/Needs a role above Editor to create roles/)).toBeTruthy();
  });

  it('hides Create role and says what is needed when you cannot manage roles', async () => {
    canManageRoles = false;
    serve();
    render(<RolesListPage />);
    await screen.findByText('Your roles');
    expect(screen.queryByRole('button', { name: 'Create role' })).toBeNull();
    expect(screen.getByText(/Needs Manage roles in every world/)).toBeTruthy();
  });
});

describe('a role page', () => {
  function open(id: string) {
    params = { id: 'u1', roleId: id };
    return render(<RoleEditPage />);
  }

  it('opens on Permissions, with every permission in its group and a switch each', async () => {
    serve();
    open('acc');
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.getByRole('tab', { name: 'Permissions' }).getAttribute('data-state')).toBe('active');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Display', 'Permissions', 'Members', 'Used in']);
    for (const group of ['People', 'Places', 'Broadcast', 'Calls and chat', 'Bots', 'Owner level']) {
      expect(screen.getByRole('heading', { name: group })).toBeTruthy();
    }
    expect(screen.getAllByRole('switch')).toHaveLength(18);
    // The universe's name is filled in
    expect(screen.getByText('Reach all of BAWES')).toBeTruthy();
    // Everyone's three bot permissions are on, so they count
    expect(screen.getByText('3 of 17 on, all from Everyone.', { exact: false })).toBeTruthy();
  });

  it('shows what Member and Editor inherit on and locked, and saves none of it', async () => {
    serve((url, init) => (url.endsWith('/roles/editor') && init?.method === 'PATCH' ? json({ role: {} }) : undefined));
    open('member');
    await screen.findByRole('heading', { name: 'People' });
    for (const label of ['Chat with bots nearby', 'DM bots', 'Summon bots']) {
      const toggle = screen.getByRole('switch', { name: label }) as HTMLButtonElement;
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(toggle.disabled).toBe(true);
      expect(toggle.getAttribute('aria-describedby')).toMatch(/-hint perm-\w+-from$/);
      expect(within(screen.getByTestId(`permission-${label === 'DM bots' ? 'DM_BOTS' : label === 'Summon bots' ? 'SUMMON_BOTS' : 'CHAT_BOTS_NEARBY'}`)).getByText('From Everyone')).toBeTruthy();
    }
    // What the role has to add itself stays a normal switch
    expect(screen.getByRole('switch', { name: 'Manage bots' }).getAttribute('aria-checked')).toBe('false');
    expect((screen.getByRole('switch', { name: 'Manage bots' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('switch', { name: 'Manage bots' }).getAttribute('aria-describedby')).toBe('perm-MANAGE_BOTS-hint');
    cleanup();

    open('editor');
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.getByText('4 of 17 on. 3 come from Everyone.', { exact: false })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Summon bots' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('switch', { name: 'Go live' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(patch![1].body)).toEqual({ permissions: toWire(fromKeys(['EDIT_MAPS', 'GO_LIVE'])) });
    });
  });

  it('shows Save only after a change, saves just what changed, and Undo puts it back', async () => {
    serve((url, init) => (url.endsWith('/roles/acc') && init?.method === 'PATCH' ? json({ role: {} }) : undefined));
    open('acc');
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();

    const goLive = screen.getByRole('switch', { name: 'Go live' });
    fireEvent.click(goLive);
    expect(goLive.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('1 unsaved change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.queryByText('1 unsaved change')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Go live' }).getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByRole('switch', { name: 'Go live' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch![1].body)).toEqual({ permissions: toWire(fromKeys(['GO_LIVE'])) });
    });
  });

  it('locks a switch the viewer does not have, dimmed with a lock and the "Needs" reason', async () => {
    me = LEAD_ME;
    serve();
    open('acc');
    await screen.findByRole('heading', { name: 'People' });
    const locked = screen.getByRole('switch', { name: 'Go live' }) as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    expect(locked.getAttribute('data-locked')).toBe('true');
    expect(within(screen.getByTestId('permission-GO_LIVE')).getByText('Needs Go live')).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Edit maps' }) as HTMLButtonElement).disabled).toBe(false);
    // Administrator is not theirs to give
    expect((screen.getByRole('switch', { name: 'Administrator' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('locks everything on a role at or above the viewer, with the reason said once', async () => {
    me = LEAD_ME;
    serve();
    open('lead');
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.getAllByRole('switch').every((toggle) => (toggle as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByText(/Needs a role above Lead to change these/)).toBeTruthy();
  });

  it('asks before switching Administrator on', async () => {
    serve();
    open('acc');
    await screen.findByRole('heading', { name: 'Owner level' });
    const administrator = screen.getByRole('switch', { name: 'Administrator' });
    fireEvent.click(administrator);
    expect(screen.getByText('Make Accountant like the owner of BAWES?')).toBeTruthy();
    expect(administrator.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Switch on Administrator' }));
    await waitFor(() => expect(administrator.getAttribute('aria-checked')).toBe('true'));
    // The rest are then included, and say so
    expect((screen.getByRole('switch', { name: 'Go live' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Included in Administrator').length).toBeGreaterThan(0);
  });

  it('puts Delete alone in a Danger zone at the end of Display, behind a confirm step', async () => {
    serve((url, init) => (url.endsWith('/roles/acc') && init?.method === 'DELETE' ? json({ success: true }) : undefined));
    open('acc');
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Display' }), { button: 0 });
    fireEvent.click(screen.getByRole('tab', { name: 'Display' }));
    const heading = await screen.findByRole('heading', { name: 'Danger zone' });
    const sections = Array.from(heading.closest('section')!.parentElement!.children);
    expect(sections[sections.length - 1]).toBe(heading.closest('section'));
    expect(within(heading.closest('section') as HTMLElement).getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('Takes the role off the 2 people who have it.', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete role' }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete Accountant?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete role' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/admin/universes/u1/roles'));
  });

  it('keeps a built-in name locked and gives it no Delete', async () => {
    serve();
    open('editor');
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Display' }), { button: 0 });
    fireEvent.click(screen.getByRole('tab', { name: 'Display' }));
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(screen.queryByText('Danger zone')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete role' })).toBeNull();
  });

  it('shows Admin with every permission on and locked, no Administrator, and no Delete', async () => {
    serve();
    open('admin');
    await screen.findByRole('heading', { name: 'People' });
    const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
    expect(switches).toHaveLength(17);
    expect(switches.every((toggle) => toggle.disabled && toggle.getAttribute('aria-checked') === 'true')).toBe(true);
    expect(screen.getByText(/Admin always has every permission/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
    // Every permission is locked there, so there is nothing to search
    expect(screen.queryByRole('searchbox', { name: 'Search permissions' })).toBeNull();
  });

  it('offers the search on a role whose permissions can change', async () => {
    serve();
    open('acc');
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.getByRole('searchbox', { name: 'Search permissions' })).toBeTruthy();
  });

  it('offers Duplicate only to someone the server would let make a role, and who has every permission it carries', async () => {
    canCreateRoles = false;
    serve();
    open('acc');
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
  });

  it('keeps Duplicate off a role that carries a permission the viewer lacks', async () => {
    me = LEAD_ME;
    serve();
    open('mod');
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
    cleanup();
    open('acc');
    expect(await screen.findByRole('button', { name: 'Duplicate' })).toBeTruthy();
  });

  it('says who has a role with its badge off only to people who give or manage roles', async () => {
    roles = ROLES.map((item) => (item.id === 'acc' ? { ...item, showBadge: false, people: null } : item));
    me = { ...LEAD_ME, full: false, canManageRoles: false, giveWorlds: [], everywhere: toWire(BigInt(0)) };
    canManageRoles = false;
    serve();
    open('acc');
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Members' }), { button: 0 });
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    expect(await screen.findByText('Only people who give or manage roles see who has this role.')).toBeTruthy();
    expect(screen.queryByText('No one has it yet.')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/members?'))).toBe(false);
  });

  it('turns the badge off from Display as a change, and saves it as showBadge', async () => {
    serve((url, init) => (url.endsWith('/roles/acc') && init?.method === 'PATCH' ? json({ role: {} }) : undefined));
    open('acc');
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Display' }), { button: 0 });
    fireEvent.click(screen.getByRole('tab', { name: 'Display' }));
    expect(screen.queryByLabelText(/Badge/)).toBeNull();
    const toggle = await screen.findByRole('switch', { name: 'Show the badge to everyone' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/Off: only people who manage roles see it/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.getByText('1 unsaved change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(patch![1].body)).toEqual({ showBadge: false });
    });
  });

  it('lists the three bot permissions under Bots, after Manage bots, with their copy', async () => {
    serve();
    open('acc');
    const bots = await screen.findByRole('region', { name: 'Bots' });
    const rows = within(bots).getAllByRole('switch').map((toggle) => toggle.id);
    expect(rows).toEqual(['perm-MANAGE_BOTS', 'perm-CHAT_BOTS_NEARBY', 'perm-DM_BOTS', 'perm-SUMMON_BOTS']);
    expect(within(bots).getByText('Chat with bots nearby')).toBeTruthy();
    expect(within(bots).getByText('Lets people walk up to a bot on the map and chat in its bubble. Everyone in the bubble sees it.')).toBeTruthy();
    expect(within(bots).getByText('DM bots')).toBeTruthy();
    expect(within(bots).getByText("Lets signed-in people who can see the bot's room chat privately with it, one to one, from anywhere. Only they and the bot see it.")).toBeTruthy();
    expect(within(bots).getByText('Summon bots')).toBeTruthy();
    expect(within(bots).getByText('Lets people, including guests, summon a bot to them in its own room.')).toBeTruthy();
  });

  it('shows the three bot switches on for Everyone, so bots work as they always have', async () => {
    serve();
    open('everyone');
    await screen.findByRole('heading', { name: 'Bots' });
    const on = (key: string) => screen.getByRole('switch', { name: new RegExp(key) }).getAttribute('aria-checked');
    expect(on('Chat with bots nearby')).toBe('true');
    expect(on('DM bots')).toBe('true');
    expect(on('Summon bots')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Manage bots' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('3 of 17 on', { exact: false })).toBeTruthy();
    expect(screen.getByText(/Chat, DM and Summon bots start on/)).toBeTruthy();
  });

  it('lets Everyone switch one off and saves just that bit', async () => {
    serve((url, init) => (url.endsWith('/roles/everyone') && init?.method === 'PATCH' ? json({ role: {} }) : undefined));
    open('everyone');
    fireEvent.click(await screen.findByRole('switch', { name: 'Summon bots' }));
    expect(screen.getByText('2 of 17 on', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(patch![1].body)).toEqual({ permissions: toWire(EVERYONE_DEFAULT_PERMISSIONS & ~BigInt(65536)) });
    });
  });

  it('gives Everyone only Permissions and Used in', async () => {
    serve();
    open('everyone');
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Permissions', 'Used in']);
    expect(screen.getByText(/Every visitor, signed in or guest/)).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Administrator' })).toBeNull();
  });

  it('duplicates a role and opens the copy', async () => {
    serve((url, init) => (url.endsWith('/roles') && init?.method === 'POST' ? json({ role: { id: 'copy-1' } }, 201) : undefined));
    open('mod');
    fireEvent.click(await screen.findByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/universes/u1/roles/copy-1'));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(post[1].body)).toMatchObject({ name: 'Moderator copy', permissions: toWire(fromKeys(['MODERATE_CALLS'])) });
  });

  it('says plainly what Used in cannot know', async () => {
    serve();
    open('acc');
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Used in' }), { button: 0 });
    fireEvent.click(screen.getByRole('tab', { name: 'Used in' }));
    expect(await screen.findByText('Where it opens doors')).toBeTruthy();
    expect(screen.getByText('What Accountant can reach')).toBeTruthy();
    expect(screen.getByText(/no map-storage address/)).toBeTruthy();
    expect(screen.getByText('Not known')).toBeTruthy();
    expect(screen.getByText('None yet: no one has it')).toBeTruthy();
  });

  async function openUsedIn(reach: object) {
    serve((url) =>
      url.endsWith('/used-in')
        ? json({ doors: { basis: 'none', rooms: [], roomsTotal: 0 }, reach: { held: false, allWorlds: false, worlds: [], rooms: [], roomsTotal: 0, permissions: [], ...reach } })
        : undefined,
    );
    open('acc');
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Used in' }), { button: 0 });
    fireEvent.click(screen.getByRole('tab', { name: 'Used in' }));
    await screen.findByText('What Accountant can reach');
  }

  it('says "Not in any world you can see" when the role is held only where you cannot look', async () => {
    await openUsedIn({ held: true, mapAreas: { status: 'read', areas: [], unread: 0, skipped: 0, read: 3 } });
    expect(screen.getByText('Not in any world you can see')).toBeTruthy();
    expect(screen.queryByText('None yet: no one has it')).toBeNull();
  });

  it('says apart which maps were not checked and which could not be read', async () => {
    await openUsedIn({ mapAreas: { status: 'partial', areas: [], unread: 2, skipped: 5, read: 58 } });
    const notes = screen.getAllByTestId('map-areas-note').map((note) => note.textContent);
    expect(notes).toEqual(['Read the first 60 maps; 5 more not checked.', '2 maps could not be read.']);
    expect(screen.queryByText(/just now/)).toBeNull();
  });

  it('says only that maps could not be read when nothing was skipped', async () => {
    await openUsedIn({ mapAreas: { status: 'partial', areas: [], unread: 1, skipped: 0, read: 4 } });
    expect(screen.getAllByTestId('map-areas-note').map((note) => note.textContent)).toEqual(['1 map could not be read.']);
  });
});
