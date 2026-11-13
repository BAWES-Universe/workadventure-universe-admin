import { NextRequest } from 'next/server';
import { z } from 'zod';
import { addManager } from '@/lib/app-sharing';
import { NOT_FOUND } from '@/lib/app-connections';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

const bodySchema = z.object({ userId: z.string().trim().min(1).max(100) }).strict();

/**
 * POST /api/me/team-apps/:id/managers { userId } - "Add a manager". Only a manager can; the person must be able to manage bots in
 * that universe (422 otherwise). Asked twice, the same answer. Anyone who is not a manager gets 404.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ connectionId: string }> }) {
  return appsRoute(request, METHODS, 'adding a manager', async (user, respond) => {
    const { connectionId } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Invalid input data' }, 400);
    const added = await addManager(user.id, connectionId, parsed.data.userId);
    if (added === 'not_found') return respond({ error: NOT_FOUND }, 404);
    if (added === 'not_eligible') return respond({ error: 'They cannot manage bots in this universe' }, 422);
    return respond({ userId: parsed.data.userId }, 201);
  });
}
