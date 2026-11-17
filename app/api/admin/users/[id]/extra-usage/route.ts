import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { prisma } from '@/lib/db';
import { GrantKeyUsed, GrantRefused, changeGrant, endGrantNow, markGrantBilled, recordGrant } from '@/lib/meter-grants';
import { answerRequests } from '@/lib/meter-requests';
import { personUsage } from '@/lib/meter-person';
import { SCOPE_WORDS, endEntitlementGrantNow, entitlementGrantsOf, isEntitlementScope, recordEntitlementGrant, type EntitlementGrant, type EntitlementScope } from '@/lib/entitlement-grants';
import { entitlementLine } from '@/lib/entitlement-usage';

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

/**
 * What "Give more" of one scope would do, for the sheet to show before it is given and after: the ONE entitlement it extends, what it never
 * overrides, and when it ends (billing consensus v2, P5).
 */
function previewOf(scope: EntitlementScope, grant: Pick<EntitlementGrant, 'multiplier' | 'noLimit' | 'startsAt' | 'endsAt'> | null) {
  return {
    scope,
    extends: SCOPE_WORDS[scope].extends,
    never: SCOPE_WORDS[scope].never,
    ...(grant ? { multiplier: grant.noLimit ? null : grant.multiplier, noLimit: grant.noLimit, startsAt: grant.startsAt.toISOString(), endsAt: grant.endsAt.toISOString() } : {}),
  };
}

/** What one person has of speech and Apps: each one's own entitlement (with figures, for a super admin), what a grant extends, and the grants given. */
async function entitlementsOf(personId: string, now: Date) {
  const scopes: EntitlementScope[] = ['speech', 'apps'];
  const rows = await Promise.all(
    scopes.map(async (scope) => {
      const [read, grants] = await Promise.all([entitlementLine(personId, scope, now, true), entitlementGrantsOf(personId, scope)]);
      return [
        scope,
        {
          preview: previewOf(scope, null),
          ...(read ? { ...read.line, figures: read.figures } : {}),
          grants: grants.map((grant) => ({ ...previewOf(scope, grant), grantKey: grant.grantKey, settlement: grant.settlement, billedAt: grant.billedAt?.toISOString() ?? null, note: grant.note, running: grant.startsAt <= now && grant.endsAt > now })),
        },
      ] as const;
    }),
  );
  return Object.fromEntries(rows);
}

/** GET /api/admin/users/:id/extra-usage - what this person uses, whether they asked for more and the extra usage running for them (and, under `entitlements`, their own speech and Apps allowances with what a grant of each would extend). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await asSuperAdmin(request);
  if (!viewer) return refuse();
  const { id } = await params;
  try {
    const person = await prisma.user.findUnique({ where: { id }, select: { id: true, isGuest: true } });
    if (!person || person.isGuest) return NextResponse.json({ error: 'Person not found' }, { status: 404 });
    const now = new Date();
    return NextResponse.json({ ...(await personUsage(id, now, viewer.id)), entitlements: await entitlementsOf(id, now) });
  } catch (error) {
    console.error('[ExtraUsage] Could not read:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/users/:id/extra-usage { grantKey, amount: double | five | none, endsAt, settlement: gift | to_bill, note? } - gives
 * extra usage from now until `endsAt`. `grantKey` makes it once (the sheet makes one when it opens, so a double tap gives it once).
 * Giving it answers whatever the person asked for. Nothing is charged here: "to_bill" only records what was agreed outside.
 *
 * With `scope: "speech" | "apps"` it extends only that one entitlement of the person (their own monthly speech allowance, or their own monthly
 * allowance for connected Apps), never a platform budget, another payer's rules or a provider's limit. The answer carries `preview` (what it
 * extends, what it never overrides, when it ends). Without `scope` it is extra computer usage, as before.
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
  const amount = typeof body.amount === 'string' ? AMOUNTS[body.amount] : undefined;
  if (!amount) return NextResponse.json({ error: 'amount must be double, five or none' }, { status: 400 });
  if (body.settlement !== 'gift' && body.settlement !== 'to_bill') return NextResponse.json({ error: 'settlement must be gift or to_bill' }, { status: 400 });
  if (typeof body.grantKey !== 'string' || !body.grantKey) return NextResponse.json({ error: 'grantKey is required' }, { status: 400 });
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return NextResponse.json({ error: 'note must be text' }, { status: 400 });
  // A grant key belongs to one person: the same key for someone else is a different grant, so it is refused rather than reused
  const key = `${id}:${body.grantKey}`;
  // Never cut short: two long keys sharing their first part would otherwise become one stored key
  if (key.length > 255) return NextResponse.json({ error: 'grantKey is too long' }, { status: 400 });
  const { settlement } = body;
  if (body.scope !== undefined && !isEntitlementScope(body.scope)) return NextResponse.json({ error: 'scope must be speech or apps (or left out for computer usage)' }, { status: 400 });
  if (isEntitlementScope(body.scope)) return giveEntitlement(id, body.scope, key, { amount, settlement, endsAt: body.endsAt, note: body.note }, admin.id);
  try {
    // One key is settled one at a time, from before anything about time is judged to the end: a try that got no answer and is sent
    // again waits for the first to finish, then finds what it saved. So "was it saved?" always has an answer before a new grant is
    // given, and a key that was saved answers as saved even when the end date has passed since. The write is made in the same
    // transaction that holds the lock, so a try that runs out of time is undone whole and nothing of it can land late.
    const outcome = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`grant:${key}`}))`;
        const now = new Date();
        const person = await tx.user.findUnique({ where: { id }, select: { id: true, isGuest: true } });
        if (!person || person.isGuest) return { status: 404 as const };
        const saved = await tx.meterGrant.findUnique({ where: { grantKey: key }, select: { startsAt: true, endsAt: true } });
        // What was saved stands, with the times it was saved with; a new grant needs an end in the future
        const endsAt = saved ? saved.endsAt : endsAtOf(body.endsAt, now);
        if (!endsAt) return { status: 400 as const };
        return recordGrant(
          {
            grantKey: key,
            personId: id,
            settlement,
            multiplier: amount.multiplier,
            noLimit: amount.noLimit,
            startsAt: saved ? saved.startsAt : now,
            endsAt,
            givenById: admin.id,
            note: typeof body.note === 'string' ? body.note : null,
          },
          tx,
        );
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    if ('status' in outcome) {
      return NextResponse.json({ error: outcome.status === 404 ? 'Person not found' : 'endsAt must be a date in the future, within a year' }, { status: outcome.status });
    }
    const { recorded, grant } = outcome;
    // A new grant answers every ask made up to now, including one made while it was being recorded. A replay answers only what was
    // asked before that grant began, never a newer ask.
    const answeredAt = new Date();
    await answerRequests(id, key, answeredAt, recorded ? answeredAt : grant.startsAt, 'computer');
    return NextResponse.json({ recorded, usage: await personUsage(id, new Date(), admin.id) }, { status: recorded ? 201 : 200 });
  } catch (error) {
    // Something is saved under this key, with other figures than these (changed since, most likely): not a refusal, so the sheet
    // never reads it as "nothing was given" and gives again
    if (error instanceof GrantKeyUsed) {
      return NextResponse.json({ error: error.message, code: 'key_used', usage: await personUsage(id, new Date(), admin.id).catch(() => null) }, { status: 409 });
    }
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
    // A speech or Apps grant is ended the same way: "End it now", only through this person's page
    const own = await prisma.meterEntitlementGrant.findUnique({ where: { grantKey: body.grantKey }, select: { personId: true } });
    if (own) {
      if (own.personId !== id) return NextResponse.json({ error: 'That extra usage was not found' }, { status: 404 });
      if (body.action !== 'end') return NextResponse.json({ error: 'action must be end for speech and Apps extra usage' }, { status: 400 });
      await endEntitlementGrantNow(body.grantKey, now);
      return NextResponse.json({ entitlements: await entitlementsOf(id, new Date()) });
    }
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

/** "Give more" of one entitlement: once under its key, then it answers the asks for that scope made until now. */
async function giveEntitlement(
  id: string,
  scope: EntitlementScope,
  key: string,
  input: { amount: { multiplier: number | null; noLimit: boolean }; settlement: 'gift' | 'to_bill'; endsAt: unknown; note: unknown },
  adminId: string,
) {
  try {
    const outcome = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`grant:${key}`}))`;
        const now = new Date();
        const person = await tx.user.findUnique({ where: { id }, select: { id: true, isGuest: true } });
        if (!person || person.isGuest) return { status: 404 as const };
        const saved = await tx.meterEntitlementGrant.findUnique({ where: { grantKey: key }, select: { startsAt: true, endsAt: true } });
        const endsAt = saved ? saved.endsAt : endsAtOf(input.endsAt, now);
        if (!endsAt) return { status: 400 as const };
        return recordEntitlementGrant(
          { grantKey: key, personId: id, scope, settlement: input.settlement, multiplier: input.amount.multiplier, noLimit: input.amount.noLimit, startsAt: saved ? saved.startsAt : now, endsAt, givenById: adminId, note: typeof input.note === 'string' ? input.note : null },
          tx,
        );
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    if ('status' in outcome) return NextResponse.json({ error: outcome.status === 404 ? 'Person not found' : 'endsAt must be a date in the future, within a year' }, { status: outcome.status });
    const { recorded, grant } = outcome;
    // The ask for this scope made up to now is answered; a replay answers only what was asked before the grant began
    const answeredAt = new Date();
    await answerRequests(id, key, answeredAt, recorded ? answeredAt : grant.startsAt, scope === 'speech' ? 'speech' : 'apps');
    return NextResponse.json({ recorded, preview: previewOf(scope, grant), entitlements: await entitlementsOf(id, new Date()) }, { status: recorded ? 201 : 200 });
  } catch (error) {
    if (error instanceof GrantKeyUsed) return NextResponse.json({ error: error.message, code: 'key_used' }, { status: 409 });
    if (error instanceof GrantRefused) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('[ExtraUsage] Could not give:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
