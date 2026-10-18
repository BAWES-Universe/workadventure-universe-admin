import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parsePermissions } from '@/lib/permissions';
import { ensureBuiltInRoles } from '@/lib/roles';
import { computeUsedIn } from '@/lib/role-used-in';
import { failed, seesHiddenRoles, universeContext } from '@/lib/universe-route';

// GET /api/admin/universes/[id]/roles/[roleId]/used-in - Where a role opens doors and what it reaches, for the role's
// "Used in" tab. Anyone who can see the universe and the role can read it, and it names only the rooms they can see.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; roleId: string }> }) {
  try {
    const { id, roleId } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { user, access } = context;

    await ensureBuiltInRoles(prisma, id);
    const role = await prisma.role.findFirst({ where: { id: roleId, universeId: id }, select: { id: true, key: true, permissions: true, showBadge: true } });
    if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    // A role whose badge is hidden exists, as on the Roles list, only to people who handle roles and to whoever holds it
    const seesHidden = seesHiddenRoles(access);
    if (!role.showBadge && !seesHidden) {
      const holds = await prisma.universeMemberRole.count({ where: { roleId: role.id, member: { universeId: id, userId: user.id } } });
      if (holds === 0) return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }

    const usedIn = await computeUsedIn({
      universeId: id,
      role: { id: role.id, key: role.key, permissions: parsePermissions(role.permissions) ?? BigInt(0), showBadge: role.showBadge },
      viewer: { id: user.id, isSuperAdmin: user.isSuperAdmin },
      seesHidden,
    });
    return NextResponse.json(usedIn);
  } catch (error) {
    return failed(error, 'read where a role is used');
  }
}
