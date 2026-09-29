import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getViewer, isPrivileged, viewerUserId } from '@/lib/access-scope';
import { deleteActorQuestData } from '@/lib/quests/engine';

export const runtime = 'nodejs';

/**
 * DELETE /api/admin/users/[id]/quests
 *
 * Removes everything the quest ledger holds about an account: the step account deletion takes before the user row
 * goes. Super admins and the admin token only; the deletion is logged with who asked.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await getViewer(request);
    if (!viewer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!isPrivileged(viewer)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { id } = await params;
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    const report = await deleteActorQuestData(prisma, { actorId: id, byToken: viewerUserId(viewer) ?? 'admin-token', scope: 'account' });
    return NextResponse.json({ removed: report.removed });
  } catch (error) {
    console.error('[Quests] Account deletion failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
