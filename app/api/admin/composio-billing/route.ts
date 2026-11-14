import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { composioMonth, readComposioBilling, readMonth, reconcileMonth, saveComposioBilling, saveInvoice } from '@/lib/composio-billing';
import { COMPOSIO_RATES_READ_ON, COMPOSIO_RATES_SOURCE, FREE_MANAGED_CALLS_PER_MONTH, FREE_TOOL_CALLS_PER_MONTH, PRO_PLAN_CREDIT_MICROS, PRO_PLAN_FEE_MICROS, RATE_MICROS, SANDBOX_RUN_MICROS, ZDR_ADD_ON_MICROS } from '@/lib/composio-rates';

export const runtime = 'nodejs';

async function superAdmin(request: NextRequest) {
  const user = await getSessionUser(request);
  return user && isSuperAdmin(user.email) ? user : null;
}
const refused = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });

/**
 * GET /api/admin/composio-billing?month=2026-11 - what Composio bills us for the ready-made apps in a calendar month (UTC), from the
 * meter's own events: the free calls and the plan's credit taken off, the plan's fee added (billedMicros is the figure a margin is read
 * from), checked against Composio's own count of calls and against the invoice when one is entered. Without `month`: the current one.
 * Shadow mode: it only reads and reports. Super admins only.
 */
export async function GET(request: NextRequest) {
  if (!(await superAdmin(request))) return refused();
  const asked = request.nextUrl.searchParams.get('month');
  const month = readMonth(asked ?? new Date().toISOString().slice(0, 7));
  if (!month) return NextResponse.json({ error: 'month must look like 2026-11' }, { status: 400 });
  try {
    const settings = await readComposioBilling();
    const billed = await composioMonth(month, settings);
    return NextResponse.json({
      settings,
      billed,
      reconciliation: await reconcileMonth(month, billed),
      rates: {
        readOn: COMPOSIO_RATES_READ_ON,
        source: COMPOSIO_RATES_SOURCE,
        perCallMicros: RATE_MICROS,
        zdrAddOnMicros: ZDR_ADD_ON_MICROS,
        sandboxRunMicros: SANDBOX_RUN_MICROS,
        freeToolCallsPerMonth: FREE_TOOL_CALLS_PER_MONTH,
        freeManagedCallsPerMonth: FREE_MANAGED_CALLS_PER_MONTH,
        proPlanFeeMicros: PRO_PLAN_FEE_MICROS,
        proPlanCreditMicros: PRO_PLAN_CREDIT_MICROS,
      },
    });
  } catch (error) {
    console.error('[Composio billing] Could not build the report:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

const bodySchema = z
  .object({
    plan: z.enum(['pro', 'hobby']).optional(),
    zdrOn: z.boolean().optional(),
    /** What Composio's invoice says for a month, in millionths of a dollar. */
    invoice: z.object({ month: z.string(), micros: z.number().int().min(0).max(1_000_000_000_000) }).strict().optional(),
  })
  .strict();

/** PUT /api/admin/composio-billing { plan?, zdrOn?, invoice?: { month, micros } } - which plan the account is on, whether zero data retention is switched on in Composio, and a month's invoice total. Never required. */
export async function PUT(request: NextRequest) {
  const user = await superAdmin(request);
  if (!user) return refused();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: z.treeifyError(parsed.error) }, { status: 400 });
  const { invoice, ...change } = parsed.data;
  if (invoice && !readMonth(invoice.month)) return NextResponse.json({ error: 'invoice.month must look like 2026-11' }, { status: 400 });
  try {
    if (invoice) await saveInvoice(invoice.month, invoice.micros, user.id);
    return NextResponse.json({ settings: Object.keys(change).length > 0 ? await saveComposioBilling(change, user.id) : await readComposioBilling() });
  } catch (error) {
    console.error('[Composio billing] Could not save:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
