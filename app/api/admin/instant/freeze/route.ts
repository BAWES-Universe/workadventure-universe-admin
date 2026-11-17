import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { getCeilings, getFrozenTools, saveCeiling, unfreezeTools } from '@/lib/instant/freeze';
import { instantListedPrices } from '@/lib/instant/values';

export const runtime = 'nodejs';

const refused = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });

async function answer() {
  const [frozen, ceilings] = await Promise.all([getFrozenTools(), getCeilings()]);
  const table = new Map(instantListedPrices().map((row) => [row.tool, row]));
  return {
    // null: the list could not be read, and every tool is held until it can
    frozen: frozen === null ? null : Object.entries(frozen).map(([tool, entry]) => ({ tool, ...entry, tableUnitMicros: table.get(tool)?.unitMicros ?? null, covered: !!ceilings[tool] && ceilings[tool].unitMicros <= (table.get(tool)?.unitMicros ?? 0) })),
    ceilings: Object.entries(ceilings).map(([tool, ceiling]) => ({ tool, ...ceiling, tableUnitMicros: table.get(tool)?.unitMicros ?? null })),
  };
}

/** GET /api/admin/instant/freeze - the Instant tools frozen for an unreadable price change (S4), and the proven independent ceilings. Super admins only. */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return refused();
  try {
    return NextResponse.json(await answer());
  } catch (error) {
    console.error('[Instant] Could not read the frozen tools:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/instant/freeze { tool, ceiling: { unitMicros, proof } | null, unfreeze?: true } - saves (or removes, with null) the proven independent
 * ceiling of one tool, with the proof that backs it; or clears a tool's freeze after a super admin looked at why it froze. A ceiling at or below what the
 * table reserves for one unit lets the tool carry on while the live words are still unclear. Never a switch for a tool that is not in the table.
 */
export async function PATCH(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return refused();
  let body: Record<string, unknown>;
  try {
    const raw = await request.json();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('shape');
    body = raw as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const tool = typeof body.tool === 'string' ? body.tool : '';
  if (!instantListedPrices().some((row) => row.tool === tool)) return NextResponse.json({ error: 'That tool is not one Instant offers' }, { status: 400 });
  try {
    if (body.ceiling !== undefined) {
      const ceiling = body.ceiling as { unitMicros?: unknown; proof?: unknown } | null;
      if (ceiling !== null) {
        if (typeof ceiling !== 'object' || typeof ceiling.unitMicros !== 'number' || !Number.isSafeInteger(ceiling.unitMicros) || ceiling.unitMicros < 1) return NextResponse.json({ error: 'unitMicros must be a whole number, 1 or more' }, { status: 400 });
        if (typeof ceiling.proof !== 'string' || !ceiling.proof.trim()) return NextResponse.json({ error: 'A ceiling needs the proof that backs it' }, { status: 400 });
        await saveCeiling(tool, { unitMicros: ceiling.unitMicros, proof: ceiling.proof }, user.id);
      } else {
        await saveCeiling(tool, null, user.id);
      }
    }
    if (body.unfreeze === true) await unfreezeTools([tool]);
    if (body.ceiling === undefined && body.unfreeze !== true) return NextResponse.json({ error: 'Say what to change: ceiling or unfreeze' }, { status: 400 });
    return NextResponse.json(await answer());
  } catch (error) {
    console.error('[Instant] Could not change the freeze:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
