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
    for (const who of ['owner', 'admin', 'mod', 'helper', 'plain', 'outsider']) {
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

  it('removes someone only from below, and only with the permission everywhere they are', async () => {
    expect((await as('mod', memberRoute.DELETE, { userId: people.admin })).status).toBe(403);
    // plain is in A and B; mod may remove people only in A
    expect((await as('mod', memberRoute.DELETE, { userId: people.plain })).status).toBe(403);
    expect((await as('admin', memberRoute.DELETE, { userId: people.plain })).status).toBe(200);
    expect(await tagsOf('plain', worldA)).toBeNull();
    expect((await as('admin', memberRoute.DELETE, { userId: people.owner })).status).toBe(404);
  });

  it('lists members with emails only for those who manage people, and says what you may do', async () => {
    const asHelper = await as('helper', membersRoute.GET, {});
    expect(asHelper.status).toBe(200);
    expect(asHelper.body.members.every((m: { email: string | null }) => m.email === null)).toBe(true);
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
    expect((await as('helper', membersRoute.GET, {}, undefined, `roleId=${role.moderator}`)).body.total).toBe(0);
    expect(rolesOf((await as('admin', membersRoute.GET, {})).body, people.mod)).toEqual([role.moderator]);
    expect((await as('helper', memberRoute.GET, { userId: people.mod })).body.member.roles).toEqual([]);
    expect((await as('mod', memberRoute.GET, { userId: people.mod })).body.member.roles).toHaveLength(1);
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
});
