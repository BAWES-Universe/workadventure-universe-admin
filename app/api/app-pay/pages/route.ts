import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { inventoryPaymentPages } from '@/lib/app-direct/page-contract-inventory';

export const runtime = 'nodejs';

const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const unauthorized = (error: unknown) => error instanceof Error && error.message === 'Unauthorized: Invalid service token';

/**
 * GET /api/app-pay/pages?take=&cursor= - which pages that take payments still speak the old page protocol (no request id or document session), so
 * an owner can be asked to upgrade them: { counts, legacy: { active, withOrders }, rows: [{ jobId, artifactId, jobActive, openScope, contract,
 * orders }], nextCursor }. Reads only; ids only, never a name, address or account. Auth: service token only.
 */
export async function GET(request: NextRequest) {
  try {
    requireServiceToken(request);
    const take = Number(request.nextUrl.searchParams.get('take'));
    const cursor = request.nextUrl.searchParams.get('cursor');
    return respond(await inventoryPaymentPages({ ...(Number.isFinite(take) && take > 0 ? { take } : {}), cursor: cursor && /^[A-Za-z0-9-]{1,64}$/.test(cursor) ? cursor : null }));
  } catch (error) {
    if (unauthorized(error)) return respond({ error: 'Unauthorized' }, 401);
    Sentry.captureException(error, { tags: { area: 'page-payments' } });
    console.error('[PagePayments] Page inventory failed:', error instanceof Error ? error.message : 'unknown');
    return respond({ error: 'Internal server error' }, 500);
  }
}
