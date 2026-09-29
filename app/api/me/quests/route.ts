import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { deleteActorQuestData, ensureWelcomeChapterOnce, myQuests } from '@/lib/quests/engine';
import { questPreflight, withMeQuests } from '@/lib/quests/engine/http';

export const runtime = 'nodejs';

const METHODS = 'GET, DELETE, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return questPreflight(request, METHODS);
}

const query = z.object({ roomId: z.string().min(1).max(64).optional() });

/** GET /api/me/quests[?roomId=]: the caller's own log, badges, what they follow and what they already know. */
export async function GET(request: NextRequest) {
  return withMeQuests(request, METHODS, 'read', query, async ({ user, body }) => {
    await ensureWelcomeChapterOnce(prisma);
    return myQuests(prisma, user.id, body.roomId ?? null);
  });
}

/** DELETE /api/me/quests: clears the caller's own quest data (progress, observations, grants, badges); logged. */
export async function DELETE(request: NextRequest) {
  return withMeQuests(request, METHODS, 'delete', null, async ({ user }) => {
    const report = await deleteActorQuestData(prisma, { actorId: user.id, byToken: user.id, scope: 'quests' });
    return { removed: report.removed };
  });
}
