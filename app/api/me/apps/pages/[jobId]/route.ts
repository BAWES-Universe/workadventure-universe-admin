import { NextRequest } from 'next/server';
import { appsRoute, preflight } from '@/lib/me-apps-route';
import { stopPageJob } from '@/lib/app-direct/pay';
import { NOT_FOUND } from '@/lib/app-connections';

export const runtime = 'nodejs';

const METHODS = 'DELETE, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/** DELETE /api/me/apps/pages/:jobId - stop a page of the caller's taking payments, at once. A checkout already open can still finish and is still checked. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  return appsRoute(request, METHODS, 'stopping payments', async (user, respond) => {
    const { jobId } = await params;
    return (await stopPageJob(user.id, jobId)) ? respond({ stopped: true }) : respond({ error: NOT_FOUND }, 404);
  });
}
