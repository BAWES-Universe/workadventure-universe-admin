import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { liftWindDown, startWindDown, windDownStatus } from '@/lib/computer';

export const runtime = 'nodejs';

/**
 * The team's wind-down of every computer (build handoff v2): a command, not a setting. Super admins only.
 *
 *   GET  -> { on, since, by, jobsLeft, machinesLeft }   where it stands (zero left means it is finished)
 *   POST { action: 'start' }  closes the door (no computer takes new work), ends every job (keys revoked, turns cancelled, time counted),
 *                             saves files and stops every machine, proving each stop; the sweeps go on until none is left.
 *   POST { action: 'lift' }   opens the door again.
 *
 * The files and the pages' state stay the whole time; only the work and the machines stop.
 */
const bodySchema = z.object({ action: z.enum(['start', 'lift']) });

async function superAdmin(request: NextRequest): Promise<string | null> {
  const user = await getSessionUser(request);
  return user && isSuperAdmin(user.email) ? (user.email as string) : null;
}

const noStore = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(request: NextRequest) {
  try {
    if (!(await superAdmin(request))) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
    return NextResponse.json(await windDownStatus(), noStore);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const by = await superAdmin(request);
    if (!by) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Say { "action": "start" } or { "action": "lift" }' }, { status: 400 });
    const status = parsed.data.action === 'start' ? await startWindDown(by) : await liftWindDown(by);
    return NextResponse.json(status, noStore);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] The wind-down command failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
