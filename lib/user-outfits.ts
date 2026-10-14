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

/** Something else to write in the same transaction as a pick, so both are saved or neither is. */
export type AlsoWrite = (tx: Prisma.TransactionClient) => Promise<unknown>;

/**
 * Records that someone put an outfit on (picked it themselves), inside one transaction:
 *  - the outfit worn just before is dropped when it was a try-on: a different outfit, worn only once, less than five
 *    minutes ago;
 *  - this outfit is added, or moved to the front when they wore it before;
 *  - outfits not worn for 30 days go, then only the newest ten stay. The one just put on is never removed.
 * Picks for one person run one at a time. A pick older than the newest one saved (a slow request that finishes after a
 * later pick) is kept in Recent but never put in front of the newer one, never drops it as a try-on and never moves a
 * time backwards. `alsoWrite` runs in the same transaction, before the pick.
 */
export async function recordOutfitPick(
  userId: string,
  textureIds: string[],
  now: Date = new Date(),
  alsoWrite?: AlsoWrite,
): Promise<void> {
  try {
    await recordOutfitPickOnce(userId, textureIds, now, alsoWrite);
  } catch (error) {
    // The same new outfit saved twice at once (a double submit, two devices): both found no row and both tried to add it,
    // so the second hit the unique key. The row exists now, so one more run (a new transaction) just moves it to the front.
    if (!isUniqueConflict(error)) throw error;
    await recordOutfitPickOnce(userId, textureIds, now, alsoWrite);
  }
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

async function recordOutfitPickOnce(userId: string, textureIds: string[], now: Date, alsoWrite?: AlsoWrite): Promise<void> {
  const key = outfitKey(textureIds);
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // One pick per person at a time: a second one waits here until this one is saved, then sees it. Taken before any
    // other write, so two picks never each hold something the other waits for.
    await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
    if (alsoWrite) await alsoWrite(tx);
    const previous = await tx.userOutfit.findFirst({ where: { userId }, orderBy: { lastWornAt: 'desc' } });
    if (
      previous &&
      previous.outfitKey !== key &&
      previous.firstWornAt.getTime() === previous.lastWornAt.getTime() &&
      now.getTime() >= previous.lastWornAt.getTime() &&
      now.getTime() - previous.lastWornAt.getTime() < TRY_ON_MS
    ) {
      // deleteMany, not delete: another device may have just dropped the same row, and that must not fail this pick
      await tx.userOutfit.deleteMany({ where: { id: previous.id } });
    }
    const before = await tx.userOutfit.findFirst({ where: { userId, outfitKey: key } });
    const worn = await tx.userOutfit.upsert({
      where: { userId_outfitKey: { userId, outfitKey: key } },
      create: { userId, textureIds, outfitKey: key, firstWornAt: now, lastWornAt: now },
      update: { lastWornAt: before && before.lastWornAt.getTime() > now.getTime() ? before.lastWornAt : now },
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
