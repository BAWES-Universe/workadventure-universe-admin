import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { trackQuest } from '@/lib/quests/engine';
import { questPreflight, withMeQuests } from '@/lib/quests/engine/http';

export const runtime = 'nodejs';

const METHODS = 'PUT, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return questPreflight(request, METHODS);
}

const body = z.object({
  progressId: z.string().min(1).max(64).nullable(),
  revision: z.number().int().min(0),
});

/** PUT /api/me/quests/tracked { progressId | null, revision }: the one quest on the map; 409 when another tab moved first. */
export async function PUT(request: NextRequest) {
  return withMeQuests(request, METHODS, 'track', body, async ({ user, body }) =>
    trackQuest(prisma, { actorId: user.id, progressId: body.progressId, revision: body.revision }),
  );
}
