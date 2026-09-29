import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { removeFromLog } from '@/lib/quests/engine';
import { questPreflight, withMeQuests } from '@/lib/quests/engine/http';
import { meRespond } from '@/lib/me-api';

export const runtime = 'nodejs';

const METHODS = 'DELETE, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return questPreflight(request, METHODS);
}

/** DELETE /api/me/quests/[progressId]: remove a quest from the caller's log. Grants stay; accepting again shows it again. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ progressId: string }> }) {
  return withMeQuests(request, METHODS, 'remove', null, async ({ user }) => {
    await removeFromLog(prisma, user.id, (await params).progressId);
    return meRespond(request, null, 204, METHODS);
  });
}
