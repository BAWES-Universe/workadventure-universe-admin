/**
 * GET /api/admin/universes/[id]/roles: the counts it says, and whether the viewer can make a role, as the screens use them.
 */
import { NextRequest } from 'next/server';

const roleFindMany = jest.fn();
const groupBy = jest.fn();
const memberCount = jest.fn();
const heldRoles = jest.fn();
jest.mock('@/lib/db', () => ({
  prisma: {
    role: { findMany: (...args: unknown[]) => roleFindMany(...args) },
    universeMemberRole: { groupBy: (...args: unknown[]) => groupBy(...args), findMany: (...args: unknown[]) => heldRoles(...args) },
    universeMember: { count: (...args: unknown[]) => memberCount(...args) },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/roles', () => ({ ...jest.requireActual('@/lib/roles'), ensureBuiltInRoles: jest.fn().mockResolvedValue(undefined) }));
const context = jest.fn();
jest.mock('@/lib/universe-route', () => ({
  ...jest.requireActual('@/lib/universe-route'),
  universeContext: (...args: unknown[]) => context(...args),
}));

import { GET } from '@/app/api/admin/universes/[id]/roles/route';
import { computeAccess } from '@/lib/role-access';
import { fromKeys } from '@/lib/permissions';
import { ADMIN_POSITION, CUSTOM_MIN_POSITION } from '@/lib/roles';

const role = (id: string, key: string, position: number, builtIn: boolean, showBadge = true) => ({
  id,
  key,
  name: key,
  color: '#fff',
  showBadge,
  permissions: BigInt(0),
  position,
  builtIn,
});

const ROLES = [
  role('admin', 'admin', ADMIN_POSITION, true),
  role('lead', 'lead', CUSTOM_MIN_POSITION + 2, false),
  role('secret', 'secret', CUSTOM_MIN_POSITION + 1, false, false),
  role('editor', 'editor', 2, true),
  role('member', 'member', 1, true),
  role('everyone', 'everyone', 0, true),
];

/** Someone who joined everywhere with one role, as the access rules see them. */
function viewerWith(held: { key: string; position: number; permissions: bigint } | null, everyone = BigInt(0)) {
  return computeAccess({
    universeId: 'u',
    worldIds: ['hq'],
    full: false,
    isOwner: false,
    everyone,
    member: BigInt(0),
    membership: { allWorlds: true, worldIds: [] },
    roles: held ? [{ ...held, allWorlds: true, worldIds: [] }] : [],
  });
}

const owner = computeAccess({ universeId: 'u', worldIds: ['hq'], full: true, isOwner: true, everyone: BigInt(0), member: BigInt(0), membership: null, roles: [] });

async function list(access: ReturnType<typeof computeAccess>) {
  context.mockResolvedValue({ ok: true, user: { id: 'viewer', isSuperAdmin: false }, access, universe: { id: 'u' } });
  const response = await GET(new NextRequest('http://localhost/api/admin/universes/u/roles'), { params: Promise.resolve({ id: 'u' }) });
  return response.json();
}

const people = (body: { roles: { key: string; people: number | null }[] }, key: string) => body.roles.find((item) => item.key === key)?.people;

beforeEach(() => {
  jest.clearAllMocks();
  roleFindMany.mockResolvedValue(ROLES);
  groupBy.mockResolvedValue([
    { roleId: 'lead', _count: { _all: 3 } },
    { roleId: 'secret', _count: { _all: 2 } },
    { roleId: 'admin', _count: { _all: 1 } },
  ]);
  memberCount.mockResolvedValue(23);
  heldRoles.mockResolvedValue([]);
});

describe('how many people hold a role', () => {
  it('is said for every role to someone who manages roles', async () => {
    const body = await list(owner);
    expect(people(body, 'secret')).toBe(2);
    expect(people(body, 'lead')).toBe(3);
  });

  it('is not said, and the role not listed, for a badge that is off, to someone who neither gives nor manages roles', async () => {
    const body = await list(viewerWith({ key: 'viewer-role', position: CUSTOM_MIN_POSITION + 5, permissions: BigInt(0) }));
    expect(body.roles.map((item: { key: string }) => item.key)).not.toContain('secret');
    // Roles with their badge on are counted as ever, and Member is everyone who joined
    expect(people(body, 'lead')).toBe(3);
    expect(people(body, 'member')).toBe(23);
    expect(people(body, 'everyone')).toBeNull();
  });

  it('lists a role whose badge is off to whoever holds it, without saying how many do', async () => {
    heldRoles.mockResolvedValue([{ roleId: 'secret' }]);
    const body = await list(viewerWith({ key: 'secret', position: CUSTOM_MIN_POSITION + 1, permissions: BigInt(0) }));
    expect(body.roles.map((item: { key: string }) => item.key)).toContain('secret');
    expect(people(body, 'secret')).toBeNull();
  });

  it('is said to someone who gives roles, who is shown those roles on the Members page', async () => {
    const body = await list(viewerWith({ key: 'giver', position: CUSTOM_MIN_POSITION + 5, permissions: fromKeys(['GIVE_ROLES']) }));
    expect(people(body, 'secret')).toBe(2);
  });
});

describe('whether the viewer can create a role', () => {
  it('is yes for the owner', async () => {
    const body = await list(owner);
    expect(body).toMatchObject({ canManageRoles: true, canCreateRoles: true });
  });

  it('is yes with Manage roles and a custom role above Editor', async () => {
    const body = await list(viewerWith({ key: 'lead', position: CUSTOM_MIN_POSITION + 2, permissions: fromKeys(['MANAGE_ROLES']) }));
    expect(body).toMatchObject({ canManageRoles: true, canCreateRoles: true });
  });

  it('is no with Manage roles when the highest role is Editor or Member, where the server refuses to create one', async () => {
    const asEditor = await list(viewerWith({ key: 'editor', position: 2, permissions: fromKeys(['MANAGE_ROLES']) }));
    expect(asEditor).toMatchObject({ canManageRoles: true, canCreateRoles: false });
    const asMember = await list(viewerWith(null, fromKeys(['MANAGE_ROLES'])));
    expect(asMember).toMatchObject({ canManageRoles: true, canCreateRoles: false });
  });

  it('is no without Manage roles', async () => {
    const body = await list(viewerWith({ key: 'lead', position: CUSTOM_MIN_POSITION + 2, permissions: BigInt(0) }));
    expect(body).toMatchObject({ canManageRoles: false, canCreateRoles: false });
  });
});
