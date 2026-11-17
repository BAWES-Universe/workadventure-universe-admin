import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { resolveSpeechHold, speechStatus } from '@/lib/speech-status';

export const runtime = 'nodejs';

/**
 * GET /api/admin/speech-budget - where the Speech budget stands this month (UTC): the budget, what was spent (and how much of it is estimated),
 * what is set aside for speech still going on, what is counted unknown (no receipt yet), what is left, hours as information, the holds of earlier
 * months still waiting to be reconciled, which figures are estimates and why, and which voice companies have no funds. The budget itself is the
 * meter setting `speechBudgetMicros` (PATCH /api/admin/meter-settings), in effect at once.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  try {
    return NextResponse.json(await speechStatus(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Speech] Could not read the budget:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/speech-budget { botId, turnId, outcome: "release" | "charge" } - settles one reply whose receipt never came: `release` (it was
 * never spoken or charged) or `charge` (count what it could have cost at the rate admitted, as an estimate). Said twice it changes nothing.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const raw = await request.json();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('shape');
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { botId, turnId, outcome } = body;
  if (typeof botId !== 'string' || !botId || typeof turnId !== 'string' || !turnId) return NextResponse.json({ error: 'botId and turnId are required' }, { status: 400 });
  if (outcome !== 'release' && outcome !== 'charge') return NextResponse.json({ error: 'outcome must be release or charge' }, { status: 400 });
  try {
    const result = await resolveSpeechHold({ botId, turnId, outcome });
    return result.ok ? NextResponse.json({ outcome: result.outcome }) : NextResponse.json({ error: 'That reply has no hold' }, { status: 404 });
  } catch (error) {
    console.error('[Speech] Could not settle the hold:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
