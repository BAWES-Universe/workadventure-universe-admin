import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { knowCapability } from '@/lib/quests/engine';
import { questPreflight, withMeQuests } from '@/lib/quests/engine/http';

export const runtime = 'nodejs';

const METHODS = 'PUT, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return questPreflight(request, METHODS);
}

const body = z.object({
  capabilityKey: z.string().min(1).max(64),
  state: z.enum(['known', 'dismissed']).default('known'),
});

/** PUT /api/me/quests/guidance { capabilityKey, state? }: "I know this"; the capability is not taught again. */
export async function PUT(request: NextRequest) {
  return withMeQuests(request, METHODS, 'guidance', body, async ({ user, body }) => {
    const saved = await knowCapability(prisma, user.id, body.capabilityKey, body.state === 'dismissed' ? 'DISMISSED' : 'KNOWN');
    return { capabilityKey: saved.capabilityKey, state: saved.state.toLowerCase() };
  });
}
