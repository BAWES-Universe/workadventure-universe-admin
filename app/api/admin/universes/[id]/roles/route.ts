import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parsePermissions } from '@/lib/permissions';
import { CUSTOM_MIN_POSITION, ensureBuiltInRoles } from '@/lib/roles';
import { allows, mayChangePermissions, roleForJson, worldsAllowing } from '@/lib/role-access';
import { badRequest, failed, keyForName, needs, roleFieldsSchema, universeContext } from '@/lib/universe-route';

// GET /api/admin/universes/[id]/roles - The Roles list, highest first, with how many people hold each one
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access } = context;

    await ensureBuiltInRoles(prisma, id);
    const [roles, counts, members] = await Promise.all([
      prisma.role.findMany({ where: { universeId: id }, orderBy: [{ position: 'desc' }, { name: 'asc' }] }),
      prisma.universeMemberRole.groupBy({ by: ['roleId'], where: { role: { universeId: id } }, _count: { _all: true } }),
      prisma.universeMember.count({ where: { universeId: id } }),
    ]);
    const countOf = new Map(counts.map((row) => [row.roleId, row._count._all]));

    return NextResponse.json({
      roles: roles.map((role) => ({
        ...roleForJson(role),
        // Everyone who joined is a Member; Everyone is everyone, so it has no count
        people: role.key === 'member' ? members : role.key === 'everyone' ? null : countOf.get(role.id) ?? 0,
        canEdit: allows(access, 'MANAGE_ROLES', { allWorlds: true }) && (access.full || role.position < access.highest),
      })),
      canManageRoles: allows(access, 'MANAGE_ROLES', { allWorlds: true }),
      canGiveRoles: worldsAllowing(access, 'GIVE_ROLES'),
    });
  } catch (error) {
    return failed(error, 'list roles');
  }
}

// POST /api/admin/universes/[id]/roles - Create a role. It starts at the bottom of the custom roles.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access } = context;

    if (!allows(access, 'MANAGE_ROLES', { allWorlds: true })) return needs('Manage roles in every world');
    // The new role sits at the bottom of the custom roles, so they must rank above that to be able to touch it
    if (!access.full && access.highest <= CUSTOM_MIN_POSITION + 1) return needs('a role above the new one');

    const data = roleFieldsSchema.parse(await request.json());
    const permissions = parsePermissions(data.permissions);
    if (permissions === null) return badRequest('Invalid permissions');
    if (!mayChangePermissions(access, BigInt(0), permissions)) return needs('every permission you give the role');

    const role = await prisma.$transaction(async (tx) => {
      await ensureBuiltInRoles(tx, id);
      const keys = await tx.role.findMany({ where: { universeId: id }, select: { key: true } });
      const key = keyForName(data.name, new Set(keys.map((row) => row.key)));
      await tx.role.updateMany({ where: { universeId: id, builtIn: false }, data: { position: { increment: 1 } } });
      return tx.role.create({
        data: {
          universeId: id,
          key,
          name: data.name,
          color: data.color,
          badge: data.badge || null,
          permissions,
          position: CUSTOM_MIN_POSITION + 1,
        },
      });
    });
    return NextResponse.json({ role: roleForJson(role) }, { status: 201 });
  } catch (error) {
    return failed(error, 'create role');
  }
}
