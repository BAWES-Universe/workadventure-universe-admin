import { NextRequest, NextResponse } from 'next/server';
import { issuerFor, saveDefaultFor } from '@/lib/grants-admin';
import { isMoney, readBody, readRequest, refuseUnauthorized, refusal, serverError, superAdminOf } from '@/lib/grants-route';

export const runtime = 'nodejs';

/**
 * PUT /api/admin/grants/defaults/:category { amountMicros, interval: once | monthly | none, recipients, startsOn? } - saves the default for
 * Instant Apps or computers (super admin). A new version of the one default; "none" ends it (credit already given stays).
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ category: string }> }) {
  const admin = await superAdminOf(request);
  if (!admin) return refuseUnauthorized();
  const { category } = await params;
  if (!isMoney(category)) return NextResponse.json({ error: 'category must be instant_apps or computers' }, { status: 404 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const checked = readRequest('default', body, category);
  if (!checked.ok || checked.value.what !== 'default') return NextResponse.json({ error: checked.ok ? 'Invalid request' : checked.error }, { status: 400 });
  try {
    await saveDefaultFor(checked.value, issuerFor(admin, true));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return refusal(error) ?? serverError('save the default', error);
  }
}
