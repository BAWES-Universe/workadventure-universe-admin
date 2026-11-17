import { prisma } from '@/lib/db';
import { currentRules, personFacts } from '@/lib/credit-store';
import { pickBase, reaches } from '@/lib/credit-values';

/**
 * Universe AI replies are an entitlement with a window, not credit (paying spec v3, section 2): there are no lots, and the window stays
 * anchored as built (lib/reply-limits.ts). The default is today's Limits value ("replies per window for signed-in people"), and it stays
 * the one place the default lives. What a super admin's exceptions change is how many replies a person or group has in a window, or
 * none at all.
 *
 * An exception replaces the default for the people it reaches: the narrowest one wins (a person's own, then a group's), and two that
 * disagree are refused when saved, so there is never a "bigger wins". Extra usage (2x, 5x, no limit, lib/meter-grants.ts) multiplies
 * whatever this returns and is not touched.
 */

/**
 * The replies a signed-in person has in each window: their exception's number, or `base` (Limits) when none reaches them.
 * Reading never fails a reply: if the rules cannot be read, the person has the base, and it is logged.
 */
export async function repliesPerWindowFor(personId: string, base: number, now: Date = new Date()): Promise<number> {
  try {
    const rules = (await currentRules(prisma, { categoryId: 'universe_ai', now })).filter((rule) => rule.programKind === 'exception');
    if (rules.length === 0) return base;
    const person = await personFacts(prisma, personId);
    if (!person) return base;
    const picked = pickBase(rules.filter((rule) => reaches(rule, person)));
    // A clash cannot be saved; if one exists anyway nobody gets a number by guesswork: they keep the base
    if (!picked.winner) return base;
    return picked.winner.schedule === 'none' ? 0 : picked.winner.amount;
  } catch (error) {
    console.error('[Funding] Could not read reply exceptions:', error instanceof Error ? error.message : 'unknown');
    return base;
  }
}
