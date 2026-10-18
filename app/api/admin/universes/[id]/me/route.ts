import { NextRequest, NextResponse } from 'next/server';
import { KNOWN_PERMISSIONS } from '@/lib/permissions';
import { allows, worldsAllowing } from '@/lib/role-access';
import { failed, universeContext } from '@/lib/universe-route';

// GET /api/admin/universes/[id]/me - What you may do in this universe, so the screens show only what works
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access } = context;

    return NextResponse.json({
      isOwner: access.isOwner,
      // The owner and super admins: everything, above every role
      full: access.full,
      inUniverse: access.inUniverse,
      highestPosition: access.full ? null : access.highest,
      // Permission numbers as decimal strings: what works in every world, and in each world
      everywhere: (access.full ? KNOWN_PERMISSIONS : access.everywhere).toString(),
      perWorld: Object.fromEntries(
        [...access.perWorld].map(([worldId, permissions]) => [worldId, (access.full ? KNOWN_PERMISSIONS : permissions).toString()]),
      ),
      canManageRoles: allows(access, 'MANAGE_ROLES', { allWorlds: true }),
      giveWorlds: worldsAllowing(access, 'GIVE_ROLES'),
      inviteWorlds: worldsAllowing(access, 'INVITE_AND_REMOVE'),
    });
  } catch (error) {
    return failed(error, 'read your permissions');
  }
}
