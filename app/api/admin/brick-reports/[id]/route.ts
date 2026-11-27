import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { REPORT_STATES, reportProblem, setReportState } from '@/lib/brick-reports';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const forbidden = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });

/** GET /api/admin/brick-reports/:id - one problem: its counts, why it ranks where it does, and two notes picked at random. Super admins only. */
export async function GET(request: NextRequest, { params }: Params) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return forbidden();
  const { id } = await params;
  try {
    const problem = await reportProblem(id);
    if (!problem) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(problem, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Brick reports] Could not read a problem:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

const patchSchema = z.object({ state: z.enum(REPORT_STATES) }).strict();

/** PATCH /api/admin/brick-reports/:id { state } - moves a problem to New, Working on or Fixed. Super admins only. */
export async function PATCH(request: NextRequest, { params }: Params) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return forbidden();
  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const body = patchSchema.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  try {
    if (!(await setReportState(id, body.data.state))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ state: body.data.state });
  } catch (error) {
    console.error('[Brick reports] Could not move a problem:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
