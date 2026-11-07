import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { allowKeyAttempt } from '@/lib/ai-key-models';
import { decryptApiKey } from '@/lib/encryption';
import { checkVoiceKeyWithCompany } from '@/lib/voice-key-check';

export const runtime = 'nodejs';

const STATUS = { refused: 422, unreachable: 502, 'bad-request': 400 } as const;

/**
 * POST /api/admin/voice-providers/:id/check - asks the company if it knows the key a server provider holds (#792). The same one
 * free call as for a pasted key: nothing is spoken or heard, so nothing is billed, and the key never leaves Orbit except to the
 * company's own address. Answers `{ ok: true }`, or `{ error }`: 404 no such provider, 409 it has no key, 422 the company turned
 * the key away, 502 it couldn't be reached, 429 too many tries. A provider with its own address answers 409: the company's address
 * can't vouch for a key made for another one.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  try {
    const row = await prisma.voiceProvider.findUnique({ where: { id: (await params).id } });
    if (!row || row.ownerId !== null) return NextResponse.json({ error: 'Voice provider not found' }, { status: 404 });
    if (!row.apiKeyEncrypted) return NextResponse.json({ error: `${row.name} has no key to check.` }, { status: 409 });
    // The check asks the company's own address only, which can't vouch for a key made for the provider's own address
    if (row.endpoint) return NextResponse.json({ error: 'This provider uses its own address, so the company can’t check its key.' }, { status: 409 });
    if (!allowKeyAttempt(user.id)) return NextResponse.json({ error: 'Too many tries. Wait a minute and try again.' }, { status: 429 });
    let key: string;
    try {
      key = decryptApiKey(row.apiKeyEncrypted);
    } catch {
      return NextResponse.json({ error: `${row.name}’s key can’t be read. Replace it.` }, { status: 409 });
    }
    const result = await checkVoiceKeyWithCompany(row.adapter, key, row.region);
    return result.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: result.message }, { status: STATUS[result.reason] });
  } catch (error) {
    console.error('[VoiceProviders] Check key failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
