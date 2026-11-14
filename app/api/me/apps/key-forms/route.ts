import { NextRequest } from 'next/server';
import { z } from 'zod';
import { openKeyForm, KeyFormError } from '@/lib/app-direct/connect';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

const bodySchema = z.union([z.object({ service: z.string().trim().min(1).max(60) }).strict(), z.object({ connectionId: z.string().trim().min(1).max(100) }).strict()]);

/**
 * POST /api/me/apps/key-forms { service } or { connectionId } - opens the safe form for the caller's own key (game #2044): a service of the
 * shipped list, or an app of theirs whose key they are replacing. The form is for this person, this service and this moment, and it
 * closes after "How long the safe form stays open". The key is typed into it (POST .../:formId/key), never sent here.
 */
export async function POST(request: NextRequest) {
  return appsRoute(request, METHODS, 'opening a key form', async (user, respond) => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Invalid input data' }, 400);
    try {
      return respond(await openKeyForm({ ownerId: user.id, ...parsed.data }), 201);
    } catch (error) {
      if (error instanceof KeyFormError) return respond({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  });
}
