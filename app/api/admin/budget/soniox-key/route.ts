import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { refused, superAdmin } from '@/lib/budget/auth';
import { readSoniox, Unreadable, type FetchLike } from '@/lib/budget/accounts';
import { clearSonioxOrgKey, saveSonioxOrgKey, SONIOX_ORG_PREFIX } from '@/lib/budget/provider-keys';
import { buildReport } from '@/lib/budget/report';

export const runtime = 'nodejs';

/**
 * PUT /api/admin/budget/soniox-key { key } (super admins only): saves Soniox's organization key, encrypted, after Soniox has accepted it. A key Soniox
 * refuses is not saved. The key is never sent back: the answer is the Soniox row as it reads now.
 * DELETE disconnects: the key is removed and the row says it is not connected. Nothing else stops working either way.
 */
export async function PUT(request: NextRequest) {
  const user = await superAdmin(request);
  if (!user) return refused();
  const body = (await request.json().catch(() => null)) as { key?: unknown } | null;
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (!key) return NextResponse.json({ error: 'Paste the organization key from the Soniox console.' }, { status: 400 });
  if (!key.startsWith(SONIOX_ORG_PREFIX)) return NextResponse.json({ error: `That is not an organization key. It starts with ${SONIOX_ORG_PREFIX}, and an organization admin makes it in the Soniox console.` }, { status: 400 });
  try {
    try {
      await readSoniox(key, ((url, init) => fetch(url, init)) as FetchLike);
    } catch (error) {
      if (error instanceof Unreadable) return NextResponse.json({ error: `${error.message}. The key was not saved.` }, { status: 422 });
      return NextResponse.json({ error: 'Soniox could not be reached, so the key was not saved. Try again in a moment.' }, { status: 502 });
    }
    await saveSonioxOrgKey(key, user.id);
    const report = await buildReport({ onlyCompany: 'soniox', userId: user.id });
    return NextResponse.json({ account: report.accounts.find((entry) => entry.key === 'soniox') }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'budget' } });
    console.error('[Budget] Could not save the Soniox key:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = await superAdmin(request);
  if (!user) return refused();
  try {
    await clearSonioxOrgKey();
    const report = await buildReport({ onlyCompany: 'soniox', userId: user.id });
    return NextResponse.json({ account: report.accounts.find((entry) => entry.key === 'soniox') }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'budget' } });
    console.error('[Budget] Could not remove the Soniox key:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
