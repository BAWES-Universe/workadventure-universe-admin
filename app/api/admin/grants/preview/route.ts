import { NextRequest, NextResponse } from 'next/server';
import { previewFor } from '@/lib/grants-admin';
import { readBody, readRequest, refuseUnauthorized, refusal, serverError, superAdminOf } from '@/lib/grants-route';

export const runtime = 'nodejs';

/**
 * POST /api/admin/grants/preview { what: default | exception | gift, ... } - the three-part preview before anything is saved (who gets
 * what, the most credit issued, what it can cost us), and a clash between two rules with the people named. Reads only: nothing is saved.
 */
export async function POST(request: NextRequest) {
  if (!(await superAdminOf(request))) return refuseUnauthorized();
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  if (body.what !== 'default' && body.what !== 'exception' && body.what !== 'gift') return NextResponse.json({ error: 'what must be default, exception or gift' }, { status: 400 });
  const checked = readRequest(body.what, body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  try {
    return NextResponse.json(await previewFor(checked.value));
  } catch (error) {
    return refusal(error) ?? serverError('preview', error);
  }
}
