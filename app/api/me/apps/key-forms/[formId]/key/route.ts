import { NextRequest } from 'next/server';
import { z } from 'zod';
import { submitKey, KeyFormError } from '@/lib/app-direct/connect';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

// The key is checked by the connect code, which says nothing about what is wrong with it; a body of any other shape is refused whole
const bodySchema = z.object({ key: z.unknown(), confirmChange: z.boolean().optional() }).strict();

/**
 * POST /api/me/apps/key-forms/:formId/key { key, confirmChange? } - the key, typed into the safe form (game #2044). It is checked with the
 * service's own non-changing request, then stored encrypted, and never read back: the answer holds the app's id and name only.
 * 422 `rejected` when the service does not accept it, 409 `mode_change` when it switches between a test and a real key (send it again with confirmChange).
 * Nothing in this route logs the body, and Sentry's copy of the request is taken out (lib/sentry-private.ts).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ formId: string }> }) {
  return appsRoute(request, METHODS, 'saving a key', async (user, respond) => {
    const { formId } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Invalid input data' }, 400);
    try {
      const done = await submitKey({ requestId: formId, ownerId: user.id, key: parsed.data.key, confirmChange: parsed.data.confirmChange });
      return respond(done, done.created ? 201 : 200);
    } catch (error) {
      if (error instanceof KeyFormError) return respond({ error: error.message, code: error.code, ...(error.extra ?? {}) }, error.status);
      // The generic handler logs the error object: it never holds the key, which is only ever a local of submitKey
      throw error;
    }
  });
}
