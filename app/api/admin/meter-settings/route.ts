import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { getMeterSettings, saveMeterSettings } from '@/lib/meter';
import { METER_RANGES, checkMeterSettings, missingSettings } from '@/lib/meter-values';

export const runtime = 'nodejs';

/**
 * GET /api/admin/meter-settings - the numbers the meter works from (game #1998): the computer allowance for each member, our pool's
 * ceiling, the reserve, what kept storage costs us, jobs at once and how long room is held. Empty ones have not been set yet, and
 * room is refused until they are (`missing`). The Limits page gets its row for them with the issue that shows usage (game #1999).
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  try {
    const settings = await getMeterSettings();
    return NextResponse.json({ settings, missing: missingSettings(settings), ranges: METER_RANGES });
  } catch (error) {
    console.error('[Meter] Could not read the settings:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** PATCH /api/admin/meter-settings { memberAllowanceMicros?, poolCeilingMicros?, ... } - changes only what it names; null empties one again. */
export async function PATCH(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const checked = checkMeterSettings(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  try {
    const settings = await saveMeterSettings(checked.value, user.id);
    return NextResponse.json({ settings, missing: missingSettings(settings), ranges: METER_RANGES });
  } catch (error) {
    console.error('[Meter] Could not save the settings:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
