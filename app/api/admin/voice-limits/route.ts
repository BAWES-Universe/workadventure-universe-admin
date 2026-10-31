import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { getVoiceLimits, saveVoiceLimits } from '@/lib/voice-limits';
import { checkVoiceLimits } from '@/lib/voice-limit-values';

export const runtime = 'nodejs';

/**
 * GET /api/admin/voice-limits - the voice limits a super admin sets for all bots (#740), with their revision. Anything never
 * changed comes back as its recommended value.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  try {
    return NextResponse.json(await getVoiceLimits());
  } catch (error) {
    console.error('[VoiceLimits] Could not list the limits:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/voice-limits { textReserveShare?, guestVoiceReplies?, turnSeconds?, replyCharacters?, replySeconds?,
 * listenMinutesPerDay?, followUpSeconds? } - changes only the values it names. Answers with all of them as saved, or 400 with
 * the line that says why not.
 */
export async function PATCH(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const checked = checkVoiceLimits(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  try {
    return NextResponse.json(await saveVoiceLimits(checked.value, user.id));
  } catch (error) {
    console.error('[VoiceLimits] Could not save the limits:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
