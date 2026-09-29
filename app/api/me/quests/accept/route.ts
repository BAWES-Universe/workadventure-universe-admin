import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { acceptQuest, ensureWelcomeChapterOnce, KEY_PATTERN } from '@/lib/quests/engine';
import { questPreflight, withMeQuests } from '@/lib/quests/engine/http';

export const runtime = 'nodejs';

const METHODS = 'POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return questPreflight(request, METHODS);
}

const body = z
  .object({
    questId: z.string().min(1).max(64).optional(),
    key: z.string().regex(KEY_PATTERN).optional(),
    roomId: z.string().min(1).max(64).optional(),
  })
  .refine((value) => value.questId || value.key, { message: 'questId or key is required' });

/** POST /api/me/quests/accept { questId | key, roomId? }: accepts a quest for the caller, where they are. */
export async function POST(request: NextRequest) {
  return withMeQuests(request, METHODS, 'accept', body, async ({ user, body }) => {
    await ensureWelcomeChapterOnce(prisma);
    return acceptQuest(prisma, { actorId: user.id, definitionId: body.questId, key: body.key, roomId: body.roomId ?? null });
  });
}
