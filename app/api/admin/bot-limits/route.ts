import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { getServerLimits, saveServerLimits } from '@/lib/bot-limits';
import { checkServerLimits } from '@/lib/bot-limit-values';

export const runtime = 'nodejs';

/**
 * GET /api/admin/bot-limits - the limits a super admin sets for all bots (#666): Universe AI's reply limits, the artifact
 * limits, the "Say when nothing was saved" switch and fair usage. Anything never changed comes back as its recommended value.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  try {
    return NextResponse.json({ limits: await getServerLimits() });
  } catch (error) {
    console.error('[BotLimits] Could not list the limits:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/bot-limits { universeAi?, artifacts?, guard?, fairUsage? } - changes only the values it names, e.g.
 * { universeAi: { reply: 16000 } }. Answers with all of them as saved.
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
  const checked = checkServerLimits(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  try {
    return NextResponse.json({ limits: await saveServerLimits(checked.value, user.id) });
  } catch (error) {
    console.error('[BotLimits] Could not save the limits:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
