import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { stopFollowing } from '@/lib/quests/engine';
import { questPreflight, withMeQuests } from '@/lib/quests/engine/http';

export const runtime = 'nodejs';

const METHODS = 'POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return questPreflight(request, METHODS);
}

/** POST /api/me/quests/[progressId]/stop: stop following a quest; its progress is kept for when it is accepted again. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ progressId: string }> }) {
  return withMeQuests(request, METHODS, 'stop', null, async ({ user }) => stopFollowing(prisma, user.id, (await params).progressId));
}
