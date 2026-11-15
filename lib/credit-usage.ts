import { prisma } from '@/lib/db';
import { ensureIssued } from '@/lib/credit-issue';
import { usableLots } from '@/lib/credit-store';
import { monthEnd, type MoneyCategory } from '@/lib/credit-values';
import { openRequestFor } from '@/lib/meter-requests';

/**
 * The money part of what a person sees on their Usage page, from the server (paying spec v3, sections 1 and 2b): real numbers from the same
 * books that decide what the server will admit, so the page and the enforcement never disagree. Read by GET /api/me/usage
 * (lib/meter-usage.ts), which adds it beside today's fields; the names are the ones the game's Usage page reads (G1's contract).
 *
 *  - Available leaves out room held for work already running; that is "in progress".
 *  - A monthly line renews on the 1st (UTC), with no roll-over; a one-off says it does not renew.
 *  - Extra credit (gifts, credit to be billed, purchases, replacements) appears only while someone has it, as one amount for everything it
 *    covers; the default and exceptions are the line itself.
 *  - A read that fails says so (`unavailable`): never a made-up full or empty bar.
 */

export interface MoneyLine {
  kind: 'oneoff' | 'monthly';
  availableMicros: number;
  totalMicros: number;
  inProgressMicros: number;
  /** Monthly only: the first moment of next month (UTC), when it renews. */
  renewsAt: string | null;
  asked: boolean;
  /** "Ask for more" is offered when this is used up. */
  canAskForMore: boolean;
  unavailable: false;
}

export interface Unavailable {
  unavailable: true;
}

export interface CreditEntry {
  covers: ('apps' | 'computer')[];
  availableMicros: number;
  totalMicros: number;
  /** When it ends; null when it never does. */
  until: string | null;
  /** Who is giving it: "universe" for the platform's own account, "sponsor" for a person or a universe paying. */
  from: 'universe' | 'sponsor';
  sponsorName?: string;
}

const NAMES: Record<string, 'apps' | 'computer'> = { instant_apps: 'apps', computers: 'computer' };

/**
 * A person's default (or exception) line for one money category, from the base lot of the current period. Null when nobody has been
 * given one (no default is set up), so the game shows no section.
 */
export async function moneyLine(personId: string, category: MoneyCategory, now: Date): Promise<MoneyLine | Unavailable | null> {
  try {
    const lots = await usableLots(prisma, personId, category, now);
    const base = lots.filter((lot) => lot.lot.slotKey === `base:${category}`);
    if (base.length === 0) return null;
    // The most recently issued lot is the line. Credit left from a schedule it replaced (a one-off before it turned monthly, or the month's lot
    // before it turned one-off) is still spendable, so it counts too; an old lot that is used up does not pad the total.
    const sorted = [...base].sort((a, b) => b.lot.issuedAt.getTime() - a.lot.issuedAt.getTime() || b.lot.startsAt.getTime() - a.lot.startsAt.getTime());
    const monthly = sorted[0].lot.periodKey !== 'once';
    const lines = [sorted[0], ...sorted.slice(1).filter((lot) => lot.availableMicros + lot.balance.heldMicros > 0)];
    const available = lines.reduce((sum, lot) => sum + lot.availableMicros, 0);
    const total = lines.reduce((sum, lot) => sum + lot.balance.amountMicros, 0);
    const inProgress = lines.reduce((sum, lot) => sum + lot.balance.heldMicros, 0);
    const asked = (await openRequestFor(personId, category === 'instant_apps' ? 'apps' : 'computer')) !== null;
    return {
      kind: monthly ? 'monthly' : 'oneoff',
      availableMicros: available,
      totalMicros: total,
      inProgressMicros: inProgress,
      renewsAt: monthly ? monthEnd(now).toISOString() : null,
      asked,
      canAskForMore: available + inProgress <= 0,
      unavailable: false,
    };
  } catch (error) {
    console.error('[Usage] Could not read credit:', error instanceof Error ? error.message : 'unknown');
    return { unavailable: true };
  }
}

/** Extra credit a person has now: gifts, credit to be billed, purchases and replacements, each as one amount for what it covers. */
export async function extraCredit(personId: string, now: Date): Promise<CreditEntry[] | Unavailable> {
  try {
    const out: CreditEntry[] = [];
    // A lot that covers both categories shows once, under the first category it is found in
    const seen = new Set<string>();
    for (const category of ['instant_apps', 'computers'] as const) {
      const lots = await usableLots(prisma, personId, category, now);
      for (const lot of lots) {
        if (lot.lot.slotKey.startsWith('base:') || seen.has(lot.id)) continue;
        seen.add(lot.id);
        out.push({
          covers: lot.covers.map((c) => NAMES[c]).filter((c): c is 'apps' | 'computer' => !!c),
          availableMicros: lot.availableMicros,
          totalMicros: lot.balance.amountMicros,
          until: lot.expiresAt ? lot.expiresAt.toISOString() : null,
          from: lot.lot.fundingAccountId === 'funding-platform' ? 'universe' : 'sponsor',
        });
      }
    }
    return out.filter((entry) => entry.availableMicros > 0).sort((a, b) => (a.until ?? '9').localeCompare(b.until ?? '9'));
  } catch (error) {
    console.error('[Usage] Could not read extra credit:', error instanceof Error ? error.message : 'unknown');
    return { unavailable: true };
  }
}

export interface CreditUsage {
  apps: MoneyLine | Unavailable | null;
  credit: CreditEntry[] | Unavailable;
}

/** Issues what is due (once per program and period) and reads the money lines. Never throws: a failed read says `unavailable`. */
export async function creditUsage(personId: string, now: Date): Promise<CreditUsage> {
  try {
    await ensureIssued(personId, now);
  } catch (error) {
    console.error('[Usage] Could not issue credit:', error instanceof Error ? error.message : 'unknown');
  }
  const [apps, credit] = await Promise.all([moneyLine(personId, 'instant_apps', now), extraCredit(personId, now)]);
  return { apps, credit };
}
