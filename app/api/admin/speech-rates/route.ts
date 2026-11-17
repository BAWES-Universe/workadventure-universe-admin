import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { RATE_RANGES, checkRateChange, getRateCard, saveRateCard } from '@/lib/speech-rates';
import { SPEECH_TERM_RANGES, checkSpeechTerms, getSpeechTerms, saveSpeechTerms } from '@/lib/speech-terms';

export const runtime = 'nodejs';

/**
 * GET /api/admin/speech-rates - what speech costs and how its admissions are timed: the rate card (a price for each voice company and job, each
 * marked as published or an estimate with its basis) and the terms (window length, grace, hold for an older game), with the supported ranges.
 * Every figure is a saved setting, read on every check: a change is used by the next admission, with no restart.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  try {
    return NextResponse.json({ card: await getRateCard(), terms: await getSpeechTerms(), ranges: { rates: RATE_RANGES, terms: SPEECH_TERM_RANGES } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Speech] Could not read the rates:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/speech-rates { rates?, charactersPerSecond?, terms? } - `rates` is the whole list and replaces the saved one; a change to any
 * price (or to charactersPerSecond) is a NEW rate version, and what was admitted under an older one is priced at that one. `terms` changes only
 * the names it carries.
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
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return NextResponse.json({ error: 'Expected an object' }, { status: 400 });
  const { terms, ...rest } = body as Record<string, unknown>;
  const rateChange = Object.keys(rest).length > 0 ? checkRateChange(rest) : null;
  if (rateChange && !rateChange.ok) return NextResponse.json({ error: rateChange.error }, { status: 400 });
  const termChange = terms !== undefined ? checkSpeechTerms(terms) : null;
  if (termChange && !termChange.ok) return NextResponse.json({ error: termChange.error }, { status: 400 });
  try {
    if (rateChange?.ok) await saveRateCard(rateChange.value, user.id);
    if (termChange?.ok) await saveSpeechTerms(termChange.value, user.id);
    return NextResponse.json({ card: await getRateCard(), terms: await getSpeechTerms(), ranges: { rates: RATE_RANGES, terms: SPEECH_TERM_RANGES } });
  } catch (error) {
    console.error('[Speech] Could not save the rates:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
