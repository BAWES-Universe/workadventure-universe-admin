import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ACTION_PATTERN, ensureWelcomeChapterOnce, EVENT_ID_PATTERN, MAX_SUBJECT_LENGTH, recordObservation } from '@/lib/quests/engine';
import { questPreflight, withMeQuests } from '@/lib/quests/engine/http';

export const runtime = 'nodejs';

const METHODS = 'POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return questPreflight(request, METHODS);
}

/**
 * What the game reports: the action and its subject, never an objective (anything naming one is dropped here).
 * The client is the least trusted observer; every observation it sends is CLIENT evidence from the source "game".
 */
const body = z.object({
  eventId: z.string().regex(EVENT_ID_PATTERN),
  action: z.string().regex(ACTION_PATTERN),
  subject: z.string().min(1).max(MAX_SUBJECT_LENGTH).optional(),
  roomId: z.string().min(1).max(64).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  evidence: z.object({ seconds: z.number().optional(), amount: z.number().optional() }).optional(),
});

/** POST /api/me/quests/observations: records one action once and applies it to every eligible quest of the caller. */
export async function POST(request: NextRequest) {
  return withMeQuests(request, METHODS, 'observe', body, async ({ user, body }) => {
    await ensureWelcomeChapterOnce(prisma);
    const now = new Date();
    return recordObservation(
      prisma,
      {
        source: 'CLIENT',
        sourceId: 'game',
        eventId: body.eventId,
        actorId: user.id,
        action: body.action,
        subject: body.subject ?? null,
        roomId: body.roomId ?? null,
        occurredAt: body.occurredAt ? new Date(body.occurredAt) : now,
        evidence: body.evidence ?? null,
      },
      now,
    );
  });
}
