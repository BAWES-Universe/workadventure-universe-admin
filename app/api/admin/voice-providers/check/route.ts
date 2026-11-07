import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { allowKeyAttempt } from '@/lib/ai-key-models';
import { checkVoiceKeyWithCompany, listCompanyModels } from '@/lib/voice-key-check';
import { VOICE_COMPANY_JOBS, voiceKeyCompanyInfo, type VoiceCompanyJobName } from '@/lib/voice-key-companies';

export const runtime = 'nodejs';

const STATUS = { refused: 422, unreachable: 502, 'bad-request': 400 } as const;

/**
 * POST /api/admin/voice-providers/check { adapter, apiKey, job? } - asks the company if it knows a key before a provider is added
 * (#792). One free call to the company's own address, the same one a person's own key gets: nothing is saved, spoken or heard, so
 * nothing is billed, and the key is never logged or returned. Answers `{ ok: true, models }`, with the models the company lists for its
 * job (`[{ id, label?, kind }]`, read with one more free call: Orbit #840), or null when it has no list or the list can't be read
 * (then they are typed), or `{ error }` with a plain sentence: 422 the
 * company turned the key away, 502 it couldn't be reached, 400 the company or key isn't usable, 429 too many tries.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return NextResponse.json({ error: 'Expected an object' }, { status: 400 });
  if (!allowKeyAttempt(user.id)) return NextResponse.json({ error: 'Too many tries. Wait a minute and try again.' }, { status: 429 });
  const input = body as { adapter?: unknown; apiKey?: unknown; job?: unknown };
  try {
    const result = await checkVoiceKeyWithCompany(input.adapter, input.apiKey);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: STATUS[result.reason] });
    // The company knows the key: its own list of models, so the super admin ticks them instead of typing ids (null: typed)
    const company = voiceKeyCompanyInfo(input.adapter);
    // The job the provider is being set up for, when the company does more than one
    const job = VOICE_COMPANY_JOBS.find((each) => each === input.job) as VoiceCompanyJobName | undefined;
    const models = company && typeof input.apiKey === 'string' ? await listCompanyModels(company, input.apiKey.trim(), job && company.jobs[job] ? job : undefined) : null;
    return NextResponse.json({ ok: true, models });
  } catch (error) {
    console.error('[VoiceProviders] Check key failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
