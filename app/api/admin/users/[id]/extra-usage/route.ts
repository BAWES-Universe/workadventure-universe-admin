import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { prisma } from '@/lib/db';
import { GrantRefused, changeGrant, endGrantNow, markGrantBilled, recordGrant } from '@/lib/meter-grants';
import { answerRequests } from '@/lib/meter-requests';
import { personUsage } from '@/lib/meter-person';

export const runtime = 'nodejs';

/** The furthest ahead extra usage may end: one year. Every grant ends. */
const MAX_AHEAD = 366 * 24 * 60 * 60 * 1000;

const AMOUNTS: Record<string, { multiplier: number | null; noLimit: boolean }> = {
  double: { multiplier: 2, noLimit: false },
  five: { multiplier: 5, noLimit: false },
  none: { multiplier: null, noLimit: true },
};

async function asSuperAdmin(request: NextRequest) {
  const user = await getSessionUser(request);
  return user && isSuperAdmin(user.email) ? user : null;
}

const refuse = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });

const endsAtOf = (value: unknown, now: Date): Date | null => {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date > now && date.getTime() - now.getTime() <= MAX_AHEAD ? date : null;
};

/** GET /api/admin/users/:id/extra-usage - what this person uses, whether they asked for more and the extra usage running for them. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await asSuperAdmin(request);
  if (!viewer) return refuse();
  const { id } = await params;
  try {
    const person = await prisma.user.findUnique({ where: { id }, select: { id: true, isGuest: true } });
    if (!person || person.isGuest) return NextResponse.json({ error: 'Person not found' }, { status: 404 });
    return NextResponse.json(await personUsage(id, new Date(), viewer.id));
  } catch (error) {
    console.error('[ExtraUsage] Could not read:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/users/:id/extra-usage { grantKey, amount: double | five | none, endsAt, settlement: gift | to_bill, note? } - gives
 * extra usage from now until `endsAt`. `grantKey` makes it once (the sheet makes one when it opens, so a double tap gives it once).
 * Giving it answers whatever the person asked for. Nothing is charged here: "to_bill" only records what was agreed outside.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await asSuperAdmin(request);
  if (!admin) return refuse();
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    const raw = await request.json();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('shape');
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const now = new Date();
  const amount = typeof body.amount === 'string' ? AMOUNTS[body.amount] : undefined;
  if (!amount) return NextResponse.json({ error: 'amount must be double, five or none' }, { status: 400 });
  const endsAt = endsAtOf(body.endsAt, now);
  if (!endsAt) return NextResponse.json({ error: 'endsAt must be a date in the future, within a year' }, { status: 400 });
  if (body.settlement !== 'gift' && body.settlement !== 'to_bill') return NextResponse.json({ error: 'settlement must be gift or to_bill' }, { status: 400 });
  if (typeof body.grantKey !== 'string' || !body.grantKey) return NextResponse.json({ error: 'grantKey is required' }, { status: 400 });
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return NextResponse.json({ error: 'note must be text' }, { status: 400 });
  try {
    const person = await prisma.user.findUnique({ where: { id }, select: { id: true, isGuest: true } });
    if (!person || person.isGuest) return NextResponse.json({ error: 'Person not found' }, { status: 404 });
    // A grant key belongs to one person: the same key for someone else is a different grant, so it is refused rather than reused
    const { recorded, grant } = await recordGrant({
      grantKey: `${id}:${body.grantKey}`.slice(0, 255),
      personId: id,
      settlement: body.settlement,
      multiplier: amount.multiplier,
      noLimit: amount.noLimit,
      startsAt: now,
      endsAt,
      givenById: admin.id,
      note: typeof body.note === 'string' ? body.note : null,
    });
    // A replay answers only what was asked before the grant began, never a newer ask
    await answerRequests(id, `${id}:${body.grantKey}`.slice(0, 255), now, grant.startsAt);
    return NextResponse.json({ recorded, usage: await personUsage(id, new Date(), admin.id) }, { status: recorded ? 201 : 200 });
  } catch (error) {
    if (error instanceof GrantRefused) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('[ExtraUsage] Could not give:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/users/:id/extra-usage { grantKey, action: change | end | billed, amount?, endsAt?, note? } - "Change" a running
 * extra usage's amount, end or note; "End it now"; or "Mark as billed" for extra usage that was to be billed (a gift is never owed).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await asSuperAdmin(request);
  if (!viewer) return refuse();
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    const raw = await request.json();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('shape');
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const now = new Date();
  if (typeof body.grantKey !== 'string' || !body.grantKey) return NextResponse.json({ error: 'grantKey is required' }, { status: 400 });
  try {
    // Only this person's extra usage can be touched through this person's page
    const grant = await prisma.meterGrant.findUnique({ where: { grantKey: body.grantKey }, select: { personId: true } });
    if (!grant || grant.personId !== id) return NextResponse.json({ error: 'That extra usage was not found' }, { status: 404 });
    if (body.action === 'billed') {
      const result = await markGrantBilled(body.grantKey, now);
      if (result === 'not_billable') return NextResponse.json({ error: 'A gift is never owed, so it cannot be marked billed' }, { status: 400 });
    } else if (body.action === 'end') {
      await endGrantNow(body.grantKey, now);
    } else if (body.action === 'change') {
      const change: { multiplier?: number | null; noLimit?: boolean; endsAt?: Date; note?: string | null } = {};
      if (body.amount !== undefined) {
        const amount = typeof body.amount === 'string' ? AMOUNTS[body.amount] : undefined;
        if (!amount) return NextResponse.json({ error: 'amount must be double, five or none' }, { status: 400 });
        change.multiplier = amount.multiplier;
        change.noLimit = amount.noLimit;
      }
      if (body.endsAt !== undefined) {
        const endsAt = endsAtOf(body.endsAt, now);
        if (!endsAt) return NextResponse.json({ error: 'endsAt must be a date in the future, within a year' }, { status: 400 });
        change.endsAt = endsAt;
      }
      if (body.note !== undefined) {
        if (body.note !== null && typeof body.note !== 'string') return NextResponse.json({ error: 'note must be text' }, { status: 400 });
        change.note = body.note as string | null;
      }
      await changeGrant(body.grantKey, change, now);
    } else {
      return NextResponse.json({ error: 'action must be change, end or billed' }, { status: 400 });
    }
    return NextResponse.json({ usage: await personUsage(id, new Date(), viewer.id) });
  } catch (error) {
    if (error instanceof GrantRefused) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('[ExtraUsage] Could not change:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
