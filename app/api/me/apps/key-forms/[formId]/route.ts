import { NextRequest } from 'next/server';
import { readKeyForm, KeyFormError } from '@/lib/app-direct/connect';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/** GET /api/me/apps/key-forms/:formId - what the safe form shows: the service, where the key will be sent, and what is checked. Only for the person it was opened for. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ formId: string }> }) {
  return appsRoute(request, METHODS, 'reading a key form', async (user, respond) => {
    const { formId } = await params;
    try {
      return respond({ form: await readKeyForm(formId, user.id) });
    } catch (error) {
      if (error instanceof KeyFormError) return respond({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  });
}
