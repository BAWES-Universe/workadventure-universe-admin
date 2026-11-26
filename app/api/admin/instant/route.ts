import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { getAdapter } from '@/lib/app-adapter';
import { instantFundsAreWired } from '@/lib/instant/funds';
import { sessionCheckStatus } from '@/lib/instant/sessions';
import { getInstantLimits, getInstantPause, saveInstantLimits } from '@/lib/instant/state';
import { exposureIn } from '@/lib/instant/executor';
import { prisma } from '@/lib/db';
import { INSTANT_LIMIT_LABELS, INSTANT_LIMIT_RANGES, INSTANT_LIMITS_RECOMMENDED, INSTANT_NEEDED, INSTANT_PRICE_VERSION, INSTANT_PRICES_READ_ON, checkInstantLimits, instantCatalog, missingInstantLimits, type InstantLimits } from '@/lib/instant/values';

export const runtime = 'nodejs';

const refused = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });

/** Every limit with its value (null when empty), range, recommended value (null when there is none: the number is the super admin's) and words. */
function shape(limits: InstantLimits) {
  return Object.fromEntries(
    (Object.keys(INSTANT_LIMIT_RANGES) as (keyof InstantLimits)[]).map((key) => [
      key,
      {
        value: limits[key],
        range: INSTANT_LIMIT_RANGES[key],
        recommended: key in INSTANT_LIMITS_RECOMMENDED ? INSTANT_LIMITS_RECOMMENDED[key as keyof typeof INSTANT_LIMITS_RECOMMENDED] : null,
        ...INSTANT_LIMIT_LABELS[key],
        required: INSTANT_NEEDED.includes(key),
      },
    ]),
  );
}

/** What Instant may owe the provider now, against its ceiling (held for runs not finished, charges not known yet, this month's settled charges); null when it cannot be read. */
async function exposure(): Promise<{ usedMicros: number } | null> {
  try {
    return { usedMicros: await exposureIn(prisma, new Date()) };
  } catch (error) {
    console.error('[Instant] Could not read what is owed against the ceiling:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

async function answer() {
  const limits = await getInstantLimits();
  return {
    limits: shape(limits),
    exposure: await exposure(),
    missing: missingInstantLimits(limits),
    pause: await getInstantPause(),
    readiness: {
      providerAdapterOn: !!getAdapter()?.instant,
      creditSourceWired: instantFundsAreWired(),
      sessions: await sessionCheckStatus().catch(() => null),
      prices: { version: INSTANT_PRICE_VERSION, readOn: INSTANT_PRICES_READ_ON, tools: instantCatalog() },
    },
  };
}

/** GET /api/admin/instant - Instant's limits (each with value, range, recommended value and words), what is missing, whether it is paused, and what it still needs before it can run. Super admins only. */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return refused();
  try {
    return NextResponse.json(await answer());
  } catch (error) {
    console.error('[Instant] Could not read the limits:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** PATCH /api/admin/instant { <limit>: number | null, ... } - changes only what it names (null empties a money or count limit again) and answers as GET does. */
export async function PATCH(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return refused();
  const body = await request.json().catch(() => null);
  const checked = checkInstantLimits(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  try {
    await saveInstantLimits(checked.value, user.id);
    return NextResponse.json(await answer());
  } catch (error) {
    console.error('[Instant] Could not save the limits:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
