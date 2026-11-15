import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { ClashRefused, OverBudget } from '@/lib/credit-rules';
import { CreditRefused } from '@/lib/credit-values';
import { GrantsRefused } from '@/lib/grants-admin';
import { usd, type ExceptionSetting, type GiftScope, type Interval, type MoneyCategory, type PreviewRequest, type Recipients } from '@/lib/grants-view';

/** What every grants route shares: only a super admin reaches them, the body is checked before it is used, and a refusal is said the same way. */

export async function superAdminOf(request: NextRequest): Promise<{ id: string; email: string | null } | null> {
  const user = await getSessionUser(request);
  return user && isSuperAdmin(user.email) ? { id: user.id, email: user.email } : null;
}

export const refuseUnauthorized = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });

export async function readBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const raw = await request.json();
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Turns what the books or this layer refused into the answer the screen reads: the line to show, and a code where the screen acts on it. */
export function refusal(error: unknown): NextResponse | null {
  if (error instanceof ClashRefused) {
    return NextResponse.json({ error: error.message, code: 'clash', clashes: error.clashes.map(({ userIds: _everyone, ...shown }) => shown) }, { status: 409 });
  }
  if (error instanceof OverBudget) {
    return NextResponse.json(
      { error: `That would give out ${usd(error.mostIssuedMicros)}, but only ${usd(error.roomMicros)} is left in this month’s rollout budget. Raise the budget in Limits first.`, code: 'over_budget', mostIssuedMicros: error.mostIssuedMicros, roomMicros: error.roomMicros },
      { status: 400 },
    );
  }
  if (error instanceof CreditRefused) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.code === 'forbidden' ? 403 : error.code === 'not_found' ? 404 : 400 });
  }
  if (error instanceof GrantsRefused) return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
  return null;
}

export const serverError = (what: string, error: unknown) => {
  console.error(`[Grants] Could not ${what}:`, error instanceof Error ? error.message : 'unknown');
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
};

// ---- Checking what the screens send ----

const INTERVALS: readonly Interval[] = ['once', 'monthly', 'none'];
export const isInterval = (value: unknown): value is Interval => typeof value === 'string' && (INTERVALS as readonly string[]).includes(value);
export const isMoney = (value: unknown): value is MoneyCategory => value === 'instant_apps' || value === 'computers';
const isScope = (value: unknown): value is GiftScope => value === 'apps' || value === 'computers' || value === 'both';
const micros = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null);

export function readSetting(value: unknown): ExceptionSetting | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.mode === 'same' || raw.mode === 'none') return { mode: raw.mode };
  if (raw.mode === 'own') {
    const amountMicros = micros(raw.amountMicros);
    return amountMicros !== null && (raw.interval === 'once' || raw.interval === 'monthly') ? { mode: 'own', amountMicros, interval: raw.interval } : null;
  }
  return null;
}

/** A body as one of the three requests the screens make, or the line that says what is wrong with it. */
export function readRequest(what: PreviewRequest['what'], body: Record<string, unknown>, category?: MoneyCategory): { ok: true; value: PreviewRequest } | { ok: false; error: string } {
  const recipients = (value: unknown): Recipients | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Recipients) : null);
  if (what === 'default') {
    const cat = category ?? body.category;
    if (!isMoney(cat)) return { ok: false, error: 'category must be instant_apps or computers' };
    if (!isInterval(body.interval)) return { ok: false, error: 'interval must be once, monthly or none' };
    const amountMicros = body.amountMicros === null || body.amountMicros === undefined ? null : micros(body.amountMicros);
    if (body.interval !== 'none' && amountMicros === null) return { ok: false, error: 'amountMicros must be a whole number above 0' };
    const who = body.interval === 'none' ? { kind: 'all' as const } : recipients(body.recipients);
    if (!who) return { ok: false, error: 'recipients is required' };
    return { ok: true, value: { what, category: cat, amountMicros, interval: body.interval, recipients: who, ...(body.startsOn === 'now' || body.startsOn === 'next' ? { startsOn: body.startsOn } : {}) } };
  }
  if (what === 'exception') {
    const who = recipients(body.audience);
    const apps = readSetting(body.instant_apps);
    const computers = readSetting(body.computers);
    if (!who || !apps || !computers) return { ok: false, error: 'audience, instant_apps and computers are required' };
    if (body.replaceId !== undefined && typeof body.replaceId !== 'string') return { ok: false, error: 'replaceId must be text' };
    return { ok: true, value: { what, audience: who, instant_apps: apps, computers, ...(typeof body.replaceId === 'string' ? { replaceId: body.replaceId } : {}) } };
  }
  const who = recipients(body.audience);
  const amountMicros = micros(body.amountMicros);
  if (!who || !isScope(body.scope) || amountMicros === null || typeof body.shared !== 'boolean' || typeof body.endsAt !== 'string') return { ok: false, error: 'audience, scope, amountMicros, shared and endsAt are required' };
  const cap = body.joinerCap === undefined ? undefined : micros(body.joinerCap);
  if (body.joinerCap !== undefined && cap === null) return { ok: false, error: 'joinerCap must be a whole number above 0' };
  return { ok: true, value: { what, audience: who, scope: body.scope, amountMicros, shared: body.shared, endsAt: body.endsAt, ...(cap ? { joinerCap: cap } : {}) } };
}
