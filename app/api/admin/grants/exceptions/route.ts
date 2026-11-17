import { NextRequest, NextResponse } from 'next/server';
import { issuerFor, saveExceptionFor } from '@/lib/grants-admin';
import { readBody, readRequest, refuseUnauthorized, refusal, serverError, superAdminOf } from '@/lib/grants-route';

export const runtime = 'nodejs';

/**
 * POST /api/admin/grants/exceptions { audience, instant_apps, computers, replaceId?, clashChoice? } - saves a standing rule for a person, people
 * you pick, or a universe's members (super admin): for each category its own amount and how often, no grant, or "as everyone". Two rules that
 * disagree for the same people are refused (409, naming them) until `clashChoice` says which one applies.
 */
export async function POST(request: NextRequest) {
  const admin = await superAdminOf(request);
  if (!admin) return refuseUnauthorized();
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const checked = readRequest('exception', body);
  if (!checked.ok || checked.value.what !== 'exception') return NextResponse.json({ error: checked.ok ? 'Invalid request' : checked.error }, { status: 400 });
  if (body.clashChoice !== undefined && body.clashChoice !== 'this' && body.clashChoice !== 'other') return NextResponse.json({ error: 'clashChoice must be this or other' }, { status: 400 });
  try {
    await saveExceptionFor({ ...checked.value, ...(body.clashChoice ? { clashChoice: body.clashChoice as 'this' | 'other' } : {}) }, issuerFor(admin, true));
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return refusal(error) ?? serverError('save the exception', error);
  }
}
