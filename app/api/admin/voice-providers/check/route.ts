import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { allowKeyAttempt } from '@/lib/ai-key-models';
import { checkVoiceKeyWithCompany } from '@/lib/voice-key-check';

export const runtime = 'nodejs';

const STATUS = { refused: 422, unreachable: 502, 'bad-request': 400 } as const;

/**
 * POST /api/admin/voice-providers/check { adapter, apiKey } - asks the company if it knows a key before a provider is added
 * (#792). One free call to the company's own address, the same one a person's own key gets: nothing is saved, spoken or heard, so
 * nothing is billed, and the key is never logged or returned. Answers `{ ok: true }`, or `{ error }` with a plain sentence: 422 the
 * company turned the key away, 502 it couldn't be reached, 400 the company or key isn't usable, 429 too many tries.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return NextResponse.json({ error: 'Expected an object' }, { status: 400 });
  if (!allowKeyAttempt(user.id)) return NextResponse.json({ error: 'Too many tries. Wait a minute and try again.' }, { status: 429 });
  const input = body as { adapter?: unknown; apiKey?: unknown };
  try {
    const result = await checkVoiceKeyWithCompany(input.adapter, input.apiKey);
    return result.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: result.message }, { status: STATUS[result.reason] });
  } catch (error) {
    console.error('[VoiceProviders] Check key failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
