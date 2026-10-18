/**
 * Roles (#314): the universe roles and people routes against a real database, so the rank and world rules are tested
 * end to end. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/universe-roles-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({ withWokas: jest.fn(async (records: unknown[]) => records) }));
jest.mock('@/lib/friends', () => ({
  ...jest.requireActual('@/lib/friends'),
  listFriends: jest.fn(async () => ({ friends: [], incoming: [], outgoing: [], blocked: [] })),
  searchPeople: jest.fn(async () => []),
}));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { flag, fromKeys } from '@/lib/permissions';
import { ensureBuiltInRoles } from '@/lib/roles';
import { joinUniverse } from '@/lib/universe-members';
import * as rolesRoute from '@/app/api/admin/universes/[id]/roles/route';
import * as roleRoute from '@/app/api/admin/universes/[id]/roles/[roleId]/route';
import * as orderRoute from '@/app/api/admin/universes/[id]/roles/order/route';
import * as membersRoute from '@/app/api/admin/universes/[id]/members/route';
import * as memberRoute from '@/app/api/admin/universes/[id]/members/[userId]/route';
import * as givenRoute from '@/app/api/admin/universes/[id]/members/[userId]/roles/[roleId]/route';
import * as inviteRoute from '@/app/api/admin/universes/[id]/invitations/route';
import * as meRoute from '@/app/api/admin/universes/[id]/me/route';
import { POST as accept } from '@/app/api/memberships/invitations/[id]/accept/route';
import * as worldMembersRoute from '@/app/api/admin/worlds/[id]/members/route';
import * as worldMemberRoute from '@/app/api/admin/worlds/[id]/members/[memberId]/route';
import * as leaveWorldRoute from '@/app/api/memberships/my/world/[id]/route';
import * as userInviteRoute from '@/app/api/admin/users/[id]/invite/route';
import { POST as createWorld } from '@/app/api/admin/worlds/route';
import { GET as inviteCandidates } from '@/app/api/admin/universes/[id]/invite-candidates/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const session = getSessionUser as jest.Mock;

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const tag = randomUUID().slice(0, 8);
const people: Record<string, string> = {};
let universeId = '';
let worldA = '';
let worldB = '';
const role: Record<string, string> = {};

async function as(who: string, route: unknown, params: Record<string, string>, body?: unknown, query = '') {
  session.mockResolvedValue({ id: people[who], uuid: who, email: `${who}-${tag}@example.test`, name: who, tags: [], isSuperAdmin: false });
  const request = new NextRequest(`http://localhost/api?${query}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const handler = route as Handler;
  const response = await handler(request, { params: Promise.resolve({ id: universeId, ...params }) });
  return { status: response.status, body: await response.json() };
}

async function tagsOf(who: string, worldId: string) {
  const row = await prisma.worldMember.findUnique({ where: { userId_worldId: { userId: people[who], worldId } } });
  return row?.tags ?? null;
}

run('universe roles and people routes (real database)', () => {
  beforeAll(async () => {
    for (const who of ['owner', 'admin', 'mod', 'helper', 'plain', 'outsider', 'returning', 'late']) {
      const user = await prisma.user.create({ data: { uuid: `${who}-${tag}`, email: `${who}-${tag}@example.test`, name: who } });
      people[who] = user.id;
    }
    const universe = await prisma.universe.create({ data: { slug: `roles-${tag}`, name: 'Roles test', ownerId: people.owner, isPublic: false } });
    universeId = universe.id;
    worldA = (await prisma.world.create({ data: { universeId, slug: 'a', name: 'A' } })).id;
    worldB = (await prisma.world.create({ data: { universeId, slug: 'b', name: 'B' } })).id;
    await ensureBuiltInRoles(prisma, universeId);
    for (const built of await prisma.role.findMany({ where: { universeId } })) role[built.key] = built.id;
    role.moderator = (
      await prisma.role.create({
        data: { universeId, key: 'moderator', name: 'Moderator', position: 20, permissions: fromKeys(['GIVE_ROLES', 'INVITE_AND_REMOVE', 'MANAGE_ROLES']) },
      })
    ).id;
    role.helper = (await prisma.role.create({ data: { universeId, key: 'helper', name: 'Helper', position: 11 } })).id;

    const all = { allWorlds: true, worldIds: [] };
    const onlyA = { allWorlds: false, worldIds: [worldA] };
    await joinUniverse(prisma, { universeId, userId: people.admin, worlds: all, roles: [{ roleId: role.admin, scope: all }] });
    await joinUniverse(prisma, { universeId, userId: people.mod, worlds: all, roles: [{ roleId: role.moderator, scope: onlyA }] });
    await joinUniverse(prisma, { universeId, userId: people.helper, worlds: onlyA, roles: [{ roleId: role.helper, scope: onlyA }] });
    await joinUniverse(prisma, { universeId, userId: people.plain, worlds: { allWorlds: false, worldIds: [worldA, worldB] }, roles: [] });
  });

  afterAll(async () => {
    await prisma.universe.deleteMany({ where: { id: universeId } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(people) } } });
    await prisma.$disconnect();
  });

  it('lists the roles to a member, and says they cannot manage them', async () => {
    const { status, body } = await as('plain', rolesRoute.GET, {});
    expect(status).toBe(200);
    expect(body.roles.map((r: { key: string }) => r.key)).toEqual(['admin', 'moderator', 'helper', 'editor', 'member', 'everyone']);
    expect(body.canManageRoles).toBe(false);
    expect(body.roles.find((r: { key: string }) => r.key === 'member').people).toBe(4);
  });

  it('hides a private universe from someone who is not in it', async () => {
    const { status } = await as('outsider', rolesRoute.GET, {});
    expect(status).toBe(404);
  });

  it('puts a new role just below its creator, never with a permission they lack', async () => {
    const created = await as('admin', rolesRoute.POST, {}, { name: 'Event Host', color: '#22c55e', permissions: flag('GO_LIVE').toString() });
    expect(created.status).toBe(201);
    expect(created.body.role.key).toBe('event-host');
    // Below Admin: the top of the custom roles
    expect(created.body.role.position).toBe(21);
    role.host = created.body.role.id;

    const refused = await as('admin', rolesRoute.POST, {}, { name: 'Boss', color: '#22c55e', permissions: flag('ADMINISTRATOR').toString() });
    expect(refused.status).toBe(403);
  });

  it('needs Manage roles in every world: a world-limited grant is not enough', async () => {
    const { status } = await as('mod', rolesRoute.POST, {}, { name: 'X', color: '#22c55e', permissions: '0' });
    expect(status).toBe(403);
  });

  it('keeps Admin whole, and only ranks above a role can edit it', async () => {
    expect((await as('owner', roleRoute.PATCH, { roleId: role.admin }, { permissions: '1' })).status).toBe(400);
    expect((await as('admin', roleRoute.PATCH, { roleId: role.admin }, { color: '#000000' })).status).toBe(403);
    expect((await as('owner', roleRoute.PATCH, { roleId: role.admin }, { color: '#000000' })).status).toBe(200);
    expect((await as('admin', roleRoute.PATCH, { roleId: role.helper }, { name: 'Helpers' })).status).toBe(200);
    // Member follows each person's worlds and Everyone reaches every visitor: neither carries Administrator
    const administrator = { permissions: flag('ADMINISTRATOR').toString() };
    expect((await as('owner', roleRoute.PATCH, { roleId: role.member }, administrator)).status).toBe(400);
    expect((await as('owner', roleRoute.PATCH, { roleId: role.everyone }, administrator)).status).toBe(400);
  });

  it('gives a role only in the worlds where the giver may, and only where the person is a member', async () => {
    const inA = await as('mod', givenRoute.PUT, { userId: people.plain, roleId: role.helper }, { allWorlds: false, worldIds: [worldA] });
    expect(inA.status).toBe(200);
    expect(await tagsOf('plain', worldA)).toEqual(['helper', 'member']);
    expect(await tagsOf('plain', worldB)).toEqual(['member']);

    const inB = await as('mod', givenRoute.PUT, { userId: people.plain, roleId: role.helper }, { allWorlds: false, worldIds: [worldA, worldB] });
    expect(inB.status).toBe(403);

    const notThere = await as('admin', givenRoute.PUT, { userId: people.helper, roleId: role.helper }, { allWorlds: false, worldIds: [worldB] });
    expect(notThere.status).toBe(400);

    const fromBelow = await as('mod', givenRoute.PUT, { userId: people.admin, roleId: role.helper }, { allWorlds: false, worldIds: [worldA] });
    expect(fromBelow.status).toBe(403);

    const ownRank = await as('mod', givenRoute.PUT, { userId: people.plain, roleId: role.moderator }, { allWorlds: false, worldIds: [worldA] });
    expect(ownRank.status).toBe(403);
  });

  it('takes a role away, in the worlds the taker controls', async () => {
    const taken = await as('mod', givenRoute.DELETE, { userId: people.plain, roleId: role.helper });
    expect(taken.status).toBe(200);
    expect(await tagsOf('plain', worldA)).toEqual(['member']);
  });

  it('lets someone rank only the roles below their own, in the places those hold', async () => {
    const custom = await prisma.role.findMany({ where: { universeId, builtIn: false }, orderBy: { position: 'desc' } });
    expect((await as('mod', orderRoute.PUT, {}, { roleIds: custom.map((r) => r.id) })).status).toBe(403);

    // The top two swap: Moderator goes above Event Host
    const [first, second, ...rest] = custom.map((r) => r.id);
    const wanted = [second, first, ...rest];
    expect((await as('admin', orderRoute.PUT, {}, { roleIds: wanted })).status).toBe(200);
    const after = await prisma.role.findMany({ where: { universeId, builtIn: false }, orderBy: { position: 'desc' } });
    expect(after.map((r) => r.id)).toEqual(wanted);
    expect(after.map((r) => r.position)).toEqual(custom.map((r) => r.position));
  });

  it('invites to the worlds the inviter may, and the invitation gives its roles when accepted', async () => {
    const everywhere = await as('mod', inviteRoute.POST, {}, { userId: people.outsider, roleIds: [], worlds: { allWorlds: true } });
    expect(everywhere.status).toBe(403);

    const invited = await as('mod', inviteRoute.POST, {}, {
      userId: people.outsider,
      roleIds: [role.helper],
      worlds: { allWorlds: false, worldIds: [worldA] },
    });
    expect(invited.status).toBe(201);

    const again = await as('admin', inviteRoute.POST, {}, { userId: people.outsider, roleIds: [], worlds: { allWorlds: true } });
    expect(again.status).toBe(400);

    session.mockResolvedValue({ id: people.outsider, uuid: 'outsider', email: null, name: 'outsider', tags: [], isSuperAdmin: false });
    const accepted = await accept(new NextRequest('http://localhost/api', { method: 'POST' }), {
      params: Promise.resolve({ id: invited.body.invitation.id }),
    });
    expect(accepted.status).toBe(200);
    expect(await tagsOf('outsider', worldA)).toEqual(['helper', 'member']);
    expect(await tagsOf('outsider', worldB)).toBeNull();
  });

  it('lets someone who left accept a new invitation to a world they once accepted one for', async () => {
    expect((await as('outsider', memberRoute.DELETE, { userId: people.outsider })).status).toBe(200);
    const invited = await as('admin', inviteRoute.POST, {}, {
      userId: people.outsider,
      roleIds: [role.helper],
      worlds: { allWorlds: false, worldIds: [worldA] },
    });
    expect(invited.status).toBe(201);
    session.mockResolvedValue({ id: people.outsider, uuid: 'outsider', email: null, name: 'outsider', tags: [], isSuperAdmin: false });
    const accepted = await accept(new NextRequest('http://localhost/api', { method: 'POST' }), {
      params: Promise.resolve({ id: invited.body.invitation.id }),
    });
    expect(accepted.status).toBe(200);
    expect(await tagsOf('outsider', worldA)).toEqual(['helper', 'member']);
    const rows = await prisma.membershipInvitation.findMany({ where: { worldId: worldA, invitedUserId: people.outsider } });
    expect(rows.map((row) => row.status)).toEqual(['accepted']);
  });

  it('re-sends an old invitation the old way with its new tags, not the roles it once carried', async () => {
    // What the migration leaves on an invitation once sent as Admin and then cancelled
    const old = await prisma.membershipInvitation.create({
      data: {
        worldId: worldB,
        invitedUserId: people.returning,
        invitedByUserId: people.owner,
        status: 'cancelled',
        tags: ['admin'],
        universeId,
        roleIds: [role.admin],
        allWorlds: false,
        worldIds: [worldB],
      },
    });
    const resent = await as('owner', worldMembersRoute.POST, { id: worldB }, { userId: people.returning, tags: ['member'] });
    expect(resent.status).toBeLessThan(300);
    expect((await prisma.membershipInvitation.findUniqueOrThrow({ where: { id: old.id } })).roleIds).toEqual([]);

    session.mockResolvedValue({ id: people.returning, uuid: 'returning', email: null, name: 'returning', tags: [], isSuperAdmin: false });
    const accepted = await accept(new NextRequest('http://localhost/api', { method: 'POST' }), { params: Promise.resolve({ id: old.id }) });
    expect(accepted.status).toBe(200);
    expect(await tagsOf('returning', worldB)).toEqual(['member']);
  });

  it('never lets a pending invitation give Administrator in some worlds', async () => {
    const chief = await prisma.role.create({ data: { universeId, key: `chief-${tag}`, name: 'Chief', position: 15 } });
    const invited = await as('owner', inviteRoute.POST, {}, {
      userId: people.late,
      roleIds: [chief.id],
      worlds: { allWorlds: false, worldIds: [worldA] },
    });
    expect(invited.status).toBe(201);
    const administrator = { permissions: flag('ADMINISTRATOR').toString() };
    expect((await as('owner', roleRoute.PATCH, { roleId: chief.id }, administrator)).status).toBe(400);

    // Had it gained Administrator anyway, accepting still gives the worlds but not the role
    await prisma.role.update({ where: { id: chief.id }, data: { permissions: flag('ADMINISTRATOR') } });
    session.mockResolvedValue({ id: people.late, uuid: 'late', email: null, name: 'late', tags: [], isSuperAdmin: false });
    const accepted = await accept(new NextRequest('http://localhost/api', { method: 'POST' }), {
      params: Promise.resolve({ id: invited.body.invitation.id }),
    });
    expect(accepted.status).toBe(200);
    // ... and says so
    expect((await accepted.json()).rolesNotGiven).toEqual(['Chief']);
    expect(await tagsOf('late', worldA)).toEqual(['member']);
    await prisma.role.delete({ where: { id: chief.id } });
  });

  it('never leaves an Administrator role working in only some worlds when someone leaves one', async () => {
    const boss = await prisma.role.create({
      data: { universeId, key: `boss-${tag}`, name: 'Boss', position: 16, permissions: flag('ADMINISTRATOR') },
    });
    const all = { allWorlds: true, worldIds: [] };
    await joinUniverse(prisma, { universeId, userId: people.late, worlds: all, roles: [{ roleId: boss.id, scope: all }] });
    const row = await prisma.worldMember.findUniqueOrThrow({ where: { userId_worldId: { userId: people.late, worldId: worldA } } });

    expect((await as('owner', worldMemberRoute.PATCH, { id: worldA, memberId: row.id }, { tags: ['member'] })).status).toBe(400);
    expect((await as('owner', worldMemberRoute.DELETE, { id: worldA, memberId: row.id })).status).toBe(400);
    expect((await as('late', leaveWorldRoute.DELETE, { id: worldA })).status).toBe(400);
    const given = await prisma.universeMemberRole.findFirstOrThrow({ where: { roleId: boss.id } });
    expect(given.allWorlds).toBe(true);
    expect(await tagsOf('late', worldA)).toContain(boss.key);
    await prisma.role.delete({ where: { id: boss.id } });
  });

  it('removes someone only from below, and only with the permission everywhere they are', async () => {
    expect((await as('mod', memberRoute.DELETE, { userId: people.admin })).status).toBe(403);
    // plain is in A and B; mod may remove people only in A
    expect((await as('mod', memberRoute.DELETE, { userId: people.plain })).status).toBe(403);
    expect((await as('admin', memberRoute.DELETE, { userId: people.plain })).status).toBe(200);
    expect(await tagsOf('plain', worldA)).toBeNull();
    expect((await as('admin', memberRoute.DELETE, { userId: people.owner })).status).toBe(404);
  });

  it('never lets anyone but the owner change the owner\'s roles, even from Admin', async () => {
    await joinUniverse(prisma, { universeId, userId: people.owner, worlds: { allWorlds: true, worldIds: [] }, roles: [] });
    try {
      expect((await as('admin', givenRoute.PUT, { userId: people.owner, roleId: role.helper }, { allWorlds: true, worldIds: [] })).status).toBe(403);
      expect((await as('owner', givenRoute.PUT, { userId: people.owner, roleId: role.helper }, { allWorlds: true, worldIds: [] })).status).toBe(200);
      expect((await as('admin', givenRoute.DELETE, { userId: people.owner, roleId: role.helper })).status).toBe(403);
      expect((await as('admin', memberRoute.GET, { userId: people.owner })).body.can.giveRoleIds).toEqual([]);
    } finally {
      await prisma.universeMember.deleteMany({ where: { universeId, userId: people.owner } });
      await prisma.worldMember.deleteMany({ where: { userId: people.owner, worldId: { in: [worldA, worldB] } } });
    }
  });

  it('never lists someone in a world only because of a role whose badge is hidden, to people who cannot see it', async () => {
    const hiddenOnly = await prisma.user.create({ data: { uuid: `hidden-${tag}`, email: `hidden-${tag}@example.test`, name: 'hidden' } });
    people.hidden = hiddenOnly.id;
    // In world A, with a role that also works in world B
    await joinUniverse(prisma, { universeId, userId: people.hidden, worlds: { allWorlds: false, worldIds: [worldA] }, roles: [] });
    const member = await prisma.universeMember.findUniqueOrThrow({ where: { universeId_userId: { universeId, userId: people.hidden } } });
    await prisma.universeMemberRole.create({ data: { memberId: member.id, roleId: role.helper, allWorlds: false, worldIds: [worldA, worldB] } });
    const inB = async (who: string) =>
      (await as(who, membersRoute.GET, {}, undefined, `worldId=${worldB}`)).body.members.map((m: { userId: string }) => m.userId);
    expect(await inB('helper')).toContain(people.hidden);
    await prisma.role.update({ where: { id: role.helper }, data: { showBadge: false } });
    try {
      expect(await inB('helper')).not.toContain(people.hidden);
      expect(await inB('hidden')).toContain(people.hidden);
      expect(await inB('admin')).toContain(people.hidden);
    } finally {
      await prisma.role.update({ where: { id: role.helper }, data: { showBadge: true } });
      await prisma.universeMember.delete({ where: { id: member.id } });
      await prisma.worldMember.deleteMany({ where: { userId: people.hidden } });
    }
  });

  it('lists members with emails only for those who manage people, and says what you may do', async () => {
    const asHelper = await as('helper', membersRoute.GET, {});
    expect(asHelper.status).toBe(200);
    // Only their own email
    const emails = asHelper.body.members.filter((m: { email: string | null }) => m.email !== null);
    expect(emails.map((m: { userId: string }) => m.userId)).toEqual([people.helper]);
    expect(asHelper.body.owner.userId).toBe(people.owner);

    // Filtering by Member lists everyone who joined; by a given role, only who holds it
    const byMember = await as('helper', membersRoute.GET, {}, undefined, `roleId=${role.member}`);
    expect(byMember.body.total).toBe(asHelper.body.total);
    const byModerator = await as('helper', membersRoute.GET, {}, undefined, `roleId=${role.moderator}`);
    expect(byModerator.body.members.map((m: { userId: string }) => m.userId)).toEqual([people.mod]);

    const asMod = await as('mod', membersRoute.GET, {});
    expect(asMod.body.members.some((m: { email: string | null }) => m.email !== null)).toBe(true);

    // With its badge hidden, only people who handle roles see who has Moderator
    await prisma.role.update({ where: { id: role.moderator }, data: { showBadge: false } });
    const rolesOf = (body: { members: { userId: string; roles: { roleId: string }[] }[] }, userId: string) =>
      body.members.find((m) => m.userId === userId)!.roles.map((given) => given.roleId);
    expect(rolesOf((await as('helper', membersRoute.GET, {})).body, people.mod)).toEqual([]);
    const ownRow = (await as('mod', membersRoute.GET, {})).body;
    expect(rolesOf(ownRow, people.mod)).toEqual([role.moderator]);
    expect((await as('helper', membersRoute.GET, {}, undefined, `roleId=${role.moderator}`)).body.total).toBe(0);
    expect(rolesOf((await as('admin', membersRoute.GET, {})).body, people.mod)).toEqual([role.moderator]);
    expect((await as('helper', memberRoute.GET, { userId: people.mod })).body.member.roles).toEqual([]);
    expect((await as('mod', memberRoute.GET, { userId: people.mod })).body.member.roles).toHaveLength(1);
    // The Roles list leaves it out too, except for people who handle roles and whoever holds it
    const listed = async (who: string) => (await as(who, rolesRoute.GET, {})).body.roles.map((r: { id: string }) => r.id);
    expect(await listed('helper')).not.toContain(role.moderator);
    expect(await listed('mod')).toContain(role.moderator);
    expect(await listed('admin')).toContain(role.moderator);
    await prisma.role.update({ where: { id: role.helper }, data: { showBadge: false } });
    expect(await listed('helper')).toContain(role.helper);
    await prisma.role.update({ where: { id: role.helper }, data: { showBadge: true } });
    await prisma.role.update({ where: { id: role.moderator }, data: { showBadge: true } });

    const detail = await as('mod', memberRoute.GET, { userId: people.helper });
    expect(detail.body.can.giveWorlds).toEqual([worldA]);
    expect(detail.body.can.giveRoleIds).toContain(role.helper);
    expect(detail.body.can.giveRoleIds).not.toContain(role.moderator);

    const me = await as('mod', meRoute.GET, {});
    expect(me.body.canManageRoles).toBe(false);
    expect(me.body.inviteWorlds).toEqual([worldA]);
  });

  it('deletes a custom role and takes its tag off everyone who had it', async () => {
    expect((await as('admin', roleRoute.DELETE, { roleId: role.editor })).status).toBe(400);
    expect((await as('admin', roleRoute.DELETE, { roleId: role.helper })).status).toBe(200);
    expect(await tagsOf('helper', worldA)).toEqual(['member']);
    expect(await tagsOf('outsider', worldA)).toEqual(['member']);
  });

  it('puts a role made by someone below Admin right under their own role', async () => {
    const lead = await prisma.role.create({
      data: { universeId, key: 'lead', name: 'Lead', position: 500, permissions: fromKeys(['MANAGE_ROLES', 'GO_LIVE']) },
    });
    await joinUniverse(prisma, { universeId, userId: people.helper, worlds: { allWorlds: true, worldIds: [] }, roles: [{ roleId: lead.id, scope: { allWorlds: true, worldIds: [] } }] });
    const created = await as('helper', rolesRoute.POST, {}, { name: 'Squad', color: '#22c55e', permissions: flag('GO_LIVE').toString() });
    expect(created.status).toBe(201);
    expect(created.body.role.position).toBe(500);
    expect((await prisma.role.findUnique({ where: { id: lead.id } }))?.position).toBe(501);
  });

  it('lists pending invitations only for worlds the viewer may invite to, and an every-world one only to someone who may everywhere', async () => {
    const mine: Record<string, string> = {};
    for (const who of ['wanted-a', 'wanted-b', 'wanted-all']) {
      const user = await prisma.user.create({ data: { uuid: `${who}-${tag}`, email: `${who}-${tag}@example.test`, name: who } });
      people[who] = user.id;
      mine[user.id] = who;
    }
    const sent = (who: string, fields: { worldId: string; allWorlds: boolean; worldIds: string[] }) =>
      prisma.membershipInvitation.create({
        data: { ...fields, universeId, invitedUserId: people[who], invitedByUserId: people.admin, status: 'pending', tags: [], roleIds: [] },
      });
    await sent('wanted-a', { worldId: worldA, allWorlds: false, worldIds: [worldA] });
    await sent('wanted-b', { worldId: worldB, allWorlds: false, worldIds: [worldB] });
    await sent('wanted-all', { worldId: worldA, allWorlds: true, worldIds: [] });

    const names = (body: { invitations: { userId: string }[] }) => body.invitations.map((invitation) => mine[invitation.userId]).filter(Boolean).sort();
    // The Moderator invites and removes in world A only
    const moderator = await as('mod', inviteRoute.GET, {});
    expect(moderator.status).toBe(200);
    expect(names(moderator.body)).toEqual(['wanted-a']);
    expect(moderator.body.canCancel).toBe(true);
    // The Admin has it everywhere
    expect(names((await as('admin', inviteRoute.GET, {})).body)).toEqual(['wanted-a', 'wanted-all', 'wanted-b']);
  });
  it('offers every visitor of the week to invite, however often members came in, and never a member or someone invited', async () => {
    for (const who of ['visitor', 'invitee']) {
      people[who] = (await prisma.user.create({ data: { uuid: `${who}-${tag}`, email: `${who}-${tag}@example.test`, name: who } })).id;
    }
    const room = await prisma.room.create({ data: { worldId: worldA, slug: 'lobby', name: 'Lobby' } });
    const visit = (who: string, hoursAgo: number) => ({
      userId: people[who],
      ipAddress: '127.0.0.1',
      universeId,
      worldId: worldA,
      roomId: room.id,
      universeSlug: `roles-${tag}`,
      worldSlug: 'a',
      roomSlug: 'lobby',
      playUri: 'http://localhost/play',
      isGuest: false,
      accessedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
    });
    await prisma.membershipInvitation.create({
      data: { worldId: worldA, universeId, allWorlds: false, worldIds: [worldA], invitedUserId: people.invitee, invitedByUserId: people.admin, status: 'pending', tags: [], roleIds: [] },
    });
    // The visitor came once, a day ago; since then members came in 451 times and the invitee 30 times
    await prisma.roomAccess.createMany({
      data: [visit('visitor', 24), ...Array.from({ length: 450 }, (_, n) => visit('helper', n / 100)), visit('mod', 2), ...Array.from({ length: 30 }, (_, n) => visit('invitee', n / 100))],
    });

    const offered = await as('admin', inviteCandidates, {});
    expect(offered.status).toBe(200);
    expect(offered.body.visitors.map((person: { userId: string }) => person.userId)).toEqual([people.visitor]);
    expect(offered.body.visitors[0].room).toEqual({ id: room.id, name: 'Lobby' });
  });

  it('shows when a member last came only to people who manage members, and to the member themself', async () => {
    const seen = await as('admin', memberRoute.GET, { userId: people.mod });
    expect(seen.body.member.lastVisitedAt).toEqual(expect.any(String));
    const own = await as('helper', memberRoute.GET, { userId: people.helper });
    expect(own.body.member.lastVisitedAt).toEqual(expect.any(String));
    // The helper only has a role with no permissions
    const other = await as('helper', memberRoute.GET, { userId: people.mod });
    expect(other.status).toBe(200);
    expect(other.body.member).not.toHaveProperty('lastVisitedAt');
  });

  it('puts every all-worlds member in a new world, with time for a big universe to do it', async () => {
    const transaction = jest.spyOn(prisma, '$transaction');
    const created = await as('owner', createWorld, {}, { universeId, slug: `new-${tag}`, name: 'New', isPublic: false });
    expect(created.status).toBe(201);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000 });
    transaction.mockRestore();
    const everywhere = await prisma.universeMember.findMany({
      where: { universeId, OR: [{ allWorlds: true }, { roles: { some: { allWorlds: true } } }] },
      select: { userId: true },
    });
    expect(everywhere.length).toBeGreaterThan(0);
    for (const { userId } of everywhere) {
      expect(await prisma.worldMember.findUnique({ where: { userId_worldId: { userId, worldId: created.body.id } } })).not.toBeNull();
    }
  });

  it('refuses to invite someone the way before roles with a role that has Administrator, and says why', async () => {
    const boss = await prisma.role.create({
      data: { universeId, key: `boss-${tag}`, name: 'Boss', position: 16, permissions: flag('ADMINISTRATOR') },
    });
    const asTag = await as('owner', worldMembersRoute.POST, { id: worldB }, { userId: people.late, tags: [boss.key] });
    expect(asTag.status).toBe(400);
    expect(asTag.body.error).toMatch(/Administrator works in every world/);
    const fromProfile = await as('owner', userInviteRoute.POST, { id: people.late }, { worldId: worldB, tags: [boss.key] });
    expect(fromProfile.status).toBe(400);
    expect(await prisma.membershipInvitation.count({ where: { worldId: worldB, invitedUserId: people.late, status: 'pending' } })).toBe(0);
    // Padded the way accepting would still read it
    const padded = await prisma.user.create({ data: { uuid: `padded-${tag}`, email: `padded-${tag}@example.test`, name: 'padded' } });
    expect((await as('owner', worldMembersRoute.POST, { id: worldB }, { userId: padded.id, tags: [` ${boss.key} `] })).status).toBe(400);

    // One sent before the role gained Administrator is accepted without it, and says so
    const stale = await prisma.user.create({ data: { uuid: `stale-${tag}`, email: `stale-${tag}@example.test`, name: 'stale' } });
    people.stale = stale.id;
    const pending = await prisma.membershipInvitation.create({
      data: { worldId: worldB, invitedUserId: stale.id, invitedByUserId: people.owner, status: 'pending', tags: [boss.key] },
    });
    session.mockResolvedValue({ id: stale.id, uuid: 'stale', email: null, name: 'stale', tags: [], isSuperAdmin: false });
    const accepted = await accept(new NextRequest('http://localhost/api', { method: 'POST' }), { params: Promise.resolve({ id: pending.id }) });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).rolesNotGiven).toEqual(['Boss']);
    expect(await tagsOf('stale', worldB)).toEqual(['member']);
    await prisma.role.delete({ where: { id: boss.id } });
  });

  it('still invites someone as Admin of one world the way before roles: Admin has no Administrator', async () => {
    const keen = await prisma.user.create({ data: { uuid: `keen-${tag}`, email: `keen-${tag}@example.test`, name: 'keen' } });
    const sent = await as('owner', worldMembersRoute.POST, { id: worldB }, { userId: keen.id, tags: ['admin'] });
    expect(sent.status).toBe(201);
  });

  it('makes the owner an Admin of the first world of a new universe', async () => {
    const founder = await prisma.user.create({ data: { uuid: `founder-${tag}`, email: `founder-${tag}@example.test`, name: 'founder' } });
    people.founder = founder.id;
    const fresh = await prisma.universe.create({ data: { slug: `fresh-${tag}`, name: 'Fresh', ownerId: founder.id, isPublic: false } });
    const created = await as('founder', createWorld, {}, { universeId: fresh.id, slug: 'first', name: 'First', isPublic: false });
    expect(created.status).toBe(201);
    expect(await tagsOf('founder', created.body.id)).toEqual(['admin', 'member']);
  });

  it('lists an older invitation to a world the viewer may invite to, however many newer ones go elsewhere', async () => {
    const early = await prisma.user.create({ data: { uuid: `early-${tag}`, email: `early-${tag}@example.test`, name: 'early' } });
    await prisma.membershipInvitation.create({
      data: { worldId: worldA, universeId, allWorlds: false, worldIds: [worldA], invitedUserId: early.id, invitedByUserId: people.admin, status: 'pending', tags: [], roleIds: [], invitedAt: new Date('2026-01-01T00:00:00Z') },
    });
    const crowd = Array.from({ length: 200 }, (_, index) => ({ uuid: `crowd-${index}-${tag}`, email: `crowd-${index}-${tag}@example.test`, name: `crowd ${index}` }));
    await prisma.user.createMany({ data: crowd });
    const crowdIds = (await prisma.user.findMany({ where: { uuid: { in: crowd.map((person) => person.uuid) } }, select: { id: true } })).map((person) => person.id);
    await prisma.membershipInvitation.createMany({
      data: crowdIds.map((userId) => ({ worldId: worldB, universeId, allWorlds: false, worldIds: [worldB], invitedUserId: userId, invitedByUserId: people.admin, status: 'pending', tags: [], roleIds: [] })),
    });

    // The Moderator invites and removes in world A only
    const listed = await as('mod', inviteRoute.GET, {});
    expect(listed.body.invitations.map((invitation: { userId: string }) => invitation.userId)).toContain(early.id);
    await prisma.membershipInvitation.deleteMany({ where: { invitedUserId: { in: [early.id, ...crowdIds] } } });
  });
});
