import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { flag, parsePermissions } from '@/lib/permissions';
import { ADMIN_KEY, EVERYONE_KEY, MEMBER_KEY, syncWorldMembers } from '@/lib/roles';
import { allows, mayChangePermissions, ranksAbove, roleForJson } from '@/lib/role-access';
import { badRequest, failed, needs, roleFieldsSchema, universeContext } from '@/lib/universe-route';

const updateRoleSchema = roleFieldsSchema.partial();

type Params = { params: Promise<{ id: string; roleId: string }> };

async function findRole(universeId: string, roleId: string) {
  return prisma.role.findFirst({ where: { id: roleId, universeId } });
}

// PATCH /api/admin/universes/[id]/roles/[roleId] - Rename, recolour or change what a role allows
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const { id, roleId } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access } = context;

    const role = await findRole(id, roleId);
    if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    if (!allows(access, 'MANAGE_ROLES', { allWorlds: true })) return needs('Manage roles in every world');
    if (!ranksAbove(access, role)) return needs('a role above this one');

    const data = updateRoleSchema.parse(await request.json());
    // A built-in role keeps its name, and Admin always has every permission
    if (role.builtIn && data.name !== undefined && data.name !== role.name) return badRequest('A built-in role keeps its name');
    let permissions = role.permissions;
    if (data.permissions !== undefined) {
      const parsed = parsePermissions(data.permissions);
      if (parsed === null) return badRequest('Invalid permissions');
      if (role.key === ADMIN_KEY && role.builtIn && parsed !== role.permissions) return badRequest('Admin always has every permission');
      if (!mayChangePermissions(access, role.permissions, parsed)) return needs('every permission you change');
      permissions = parsed;
    }
    // Administrator can't be limited to some worlds, so it can't be added while the role is given that way
    const administrator = flag('ADMINISTRATOR');
    if ((permissions & administrator) !== BigInt(0) && (role.permissions & administrator) === BigInt(0)) {
      // Member follows each person's worlds and Everyone reaches every visitor, so neither may carry it
      if (role.key === MEMBER_KEY || role.key === EVERYONE_KEY) return badRequest('Administrator goes on a role given in every world');
      const limited = await prisma.universeMemberRole.count({ where: { roleId, allWorlds: false } });
      if (limited > 0) return badRequest('Administrator works in every world: give this role in every world first');
    }

    const updated = await prisma.role.update({
      where: { id: roleId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.color !== undefined ? { color: data.color } : {}),
        ...(data.showBadge !== undefined ? { showBadge: data.showBadge } : {}),
        permissions,
      },
    });
    return NextResponse.json({ role: roleForJson(updated) });
  } catch (error) {
    return failed(error, 'update role');
  }
}

// DELETE /api/admin/universes/[id]/roles/[roleId] - Delete a custom role. The people who had it keep their other roles.
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { id, roleId } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access } = context;

    const role = await findRole(id, roleId);
    if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    if (role.builtIn) return badRequest('A built-in role cannot be deleted');
    if (!allows(access, 'MANAGE_ROLES', { allWorlds: true })) return needs('Manage roles in every world');
    if (!ranksAbove(access, role)) return needs('a role above this one');

    await prisma.$transaction(async (tx) => {
      const holders = await tx.universeMemberRole.findMany({ where: { roleId }, select: { member: { select: { userId: true } } } });
      await tx.role.delete({ where: { id: roleId } });
      for (const holder of holders) await syncWorldMembers(tx, id, holder.member.userId);
    }, { timeout: 60_000 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return failed(error, 'delete role');
  }
}
