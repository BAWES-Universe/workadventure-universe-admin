import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/** A Woka worn once and swapped within this long is a try-on: it does not stay in the Recent list. */
export const TRY_ON_MS = 5 * 60 * 1000;
/** A Woka not worn for this long leaves the Recent list (the one worn now never does). */
export const RECENT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
/** The most outfits kept per person. */
export const KEEP_OUTFITS = 10;

/** One outfit's identity: its texture ids in order. */
export function outfitKey(textureIds: string[]): string {
  return textureIds.join('|');
}

/** The Woka someone wears now, in every world: their outfit worn most recently (null when they never picked one). */
export async function currentOutfit(userId: string) {
  return prisma.userOutfit.findFirst({ where: { userId }, orderBy: { lastWornAt: 'desc' } });
}

/**
 * Records that someone put an outfit on (picked it themselves), inside one transaction:
 *  - the outfit worn just before is dropped when it was a try-on: a different outfit, worn only once, less than five
 *    minutes ago;
 *  - this outfit is added, or moved to the front when they wore it before;
 *  - outfits not worn for 30 days go, then only the newest ten stay. The one just put on is never removed.
 */
export async function recordOutfitPick(userId: string, textureIds: string[], now: Date = new Date()): Promise<void> {
  const key = outfitKey(textureIds);
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const previous = await tx.userOutfit.findFirst({ where: { userId }, orderBy: { lastWornAt: 'desc' } });
    if (
      previous &&
      previous.outfitKey !== key &&
      previous.firstWornAt.getTime() === previous.lastWornAt.getTime() &&
      now.getTime() - previous.lastWornAt.getTime() < TRY_ON_MS
    ) {
      // deleteMany, not delete: another device may have just dropped the same row, and that must not fail this pick
      await tx.userOutfit.deleteMany({ where: { id: previous.id } });
    }
    const worn = await tx.userOutfit.upsert({
      where: { userId_outfitKey: { userId, outfitKey: key } },
      create: { userId, textureIds, outfitKey: key, firstWornAt: now, lastWornAt: now },
      update: { lastWornAt: now },
    });
    await tx.userOutfit.deleteMany({ where: { userId, id: { not: worn.id }, lastWornAt: { lt: new Date(now.getTime() - RECENT_EXPIRY_MS) } } });
    const surplus = await tx.userOutfit.findMany({
      where: { userId, id: { not: worn.id } },
      orderBy: { lastWornAt: 'desc' },
      skip: KEEP_OUTFITS - 1,
      select: { id: true },
    });
    if (surplus.length) await tx.userOutfit.deleteMany({ where: { id: { in: surplus.map((row) => row.id) } } });
  });
}
