import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { refused, superAdmin } from '@/lib/budget/auth';
import { numberById, saveNumber } from '@/lib/budget/numbers';
import { clearBudgetNotices } from '@/lib/budget/warnings';

export const runtime = 'nodejs';

const bodySchema = z.object({ id: z.string().min(1).max(120), value: z.number().int().nullable() }).strict();

/**
 * PUT /api/admin/budget/numbers { id, value } (super admins only)
 * Saves one number on the Budget page: a budget, a limit, a price or a warning level. It is checked against the number's own range (a raise outside
 * it is refused with a plain line and nothing is saved), saved in the store the number lives in with its change history written in the same
 * transaction, and read back. `inEffect` is true only when that fresh read gives the value that was asked for: the page says "in effect" on that.
 * A saved number is used by the very next check: there is nothing to restart.
 */
export async function PUT(request: NextRequest) {
  const user = await superAdmin(request);
  if (!user) return refused();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Send { id, value }: a number id and a whole number (or null to empty it)' }, { status: 400 });
  try {
    const result = await saveNumber(parsed.data.id, parsed.data.value, user.id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    // A warning about the old amount is no longer true: its notices are cleared, and the new amount gets its own
    const def = numberById(parsed.data.id);
    if (def?.area) await clearBudgetNotices(`:${def.area}${def.line ? `:${def.line}` : ''}:`).catch(() => undefined);
    return NextResponse.json({ id: parsed.data.id, value: result.value, inEffect: result.inEffect });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'budget' } });
    console.error('[Budget] Could not save a number:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
