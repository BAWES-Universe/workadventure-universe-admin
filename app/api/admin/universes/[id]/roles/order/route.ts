import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { allows } from '@/lib/role-access';
import { badRequest, failed, needs, universeContext } from '@/lib/universe-route';

const orderSchema = z.object({
  /** The custom roles they rank above, highest first. */
  roleIds: z.array(z.string().uuid()).max(1000),
});

class OrderMismatch extends Error {}

// PUT /api/admin/universes/[id]/roles/order - Rank the custom roles below your own
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access } = context;
    if (!allows(access, 'MANAGE_ROLES', { allWorlds: true })) return needs('Manage roles in every world');

    const { roleIds } = orderSchema.parse(await request.json());
    await prisma.$transaction(async (tx) => {
      const custom = await tx.role.findMany({
        where: { universeId: id, builtIn: false },
        select: { id: true, position: true },
        orderBy: { position: 'desc' },
      });
      // They move only the roles below their own, within the places those roles hold now: a role at or above them
      // keeps its place.
      const movable = custom.filter((role) => access.full || role.position < access.highest);
      const wanted = new Set(roleIds);
      if (wanted.size !== roleIds.length || movable.length !== roleIds.length || movable.some((role) => !wanted.has(role.id))) {
        throw new OrderMismatch();
      }
      const places = movable.map((role) => role.position);
      for (let index = 0; index < roleIds.length; index += 1) {
        const roleId = roleIds[index];
        const current = movable.find((role) => role.id === roleId)!;
        if (current.position !== places[index]) {
          await tx.role.update({ where: { id: roleId }, data: { position: places[index] } });
        }
      }
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof OrderMismatch) return badRequest('Send every role you can move, once each');
    return failed(error, 'rank roles');
  }
}
