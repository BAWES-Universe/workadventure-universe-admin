/**
 * The notices and clean-up around an ownership offer (#820), kept apart from lib/ownership-offer.ts so that
 * lib/universe-members.ts can end an offer when someone leaves without the two files importing each other.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { addNotice, clearNotices } from '@/lib/notices';

type Db = PrismaClient | Prisma.TransactionClient;

export const OWNERSHIP_NOTICE = 'ownership-offer';
const WHERE = '/admin/memberships';

export const personName = (user: { name: string | null } | null | undefined, fallback: string) => user?.name?.trim() || fallback;

/** A name for a notice. A failed lookup gives the fallback: a notice's words must never undo what already happened. */
export async function nameOf(db: Db, userId: string, fallback: string): Promise<string> {
  try {
    return personName(await db.user.findUnique({ where: { id: userId }, select: { name: true } }), fallback);
  } catch (error) {
    console.error('[Ownership] Could not read a name:', error instanceof Error ? error.message : 'unknown');
    return fallback;
  }
}

/** Tell someone, once. A notice is only a courtesy, so a failure to write one never undoes what already happened. */
export async function tell(userId: string, dedupeKey: string, title: string, body: string, badge: string | null = null): Promise<void> {
  try {
    await addNotice({ userId, kind: OWNERSHIP_NOTICE, dedupeKey, title, body, badge, href: WHERE });
  } catch (error) {
    console.error('[Ownership] Could not write the notice:', error instanceof Error ? error.message : 'unknown');
  }
}

/** Takes the "offered to you" notice off the recipient's list once the offer is answered or gone. */
export async function clearOffered(toUserId: string, offerId: string): Promise<void> {
  try {
    await clearNotices(toUserId, OWNERSHIP_NOTICE, `offered:${offerId}`);
  } catch (error) {
    console.error('[Ownership] Could not clear the notice:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * The owner hears about how an offer ended, and so does whoever started it when that was someone else (a super admin).
 * The words to the owner talk about the owner ("You still own it"), so a starter who is not the owner gets their own.
 */
export async function tellOwnerAndStarter(
  offer: { offeredById: string; universe: { ownerId: string } },
  dedupeKey: string,
  title: string,
  body: string,
  starterBody: string = body,
): Promise<void> {
  await tell(offer.universe.ownerId, dedupeKey, title, body);
  if (offer.offeredById !== offer.universe.ownerId) await tell(offer.offeredById, dedupeKey, title, starterBody);
}

/** The notices for an offer that just ended. Run it once the transaction that ended the offer has committed. */
export type AnnounceEndedOffer = () => Promise<void>;

/**
 * Call after anything that can take someone out of a universe. If they are no longer a member, the offer made to them
 * ends. The notices are not written here: this runs inside the transaction that removes them, and a notice written on the
 * side would stay when that transaction rolls back. It hands back what to tell people (null when no offer ended), and the
 * caller runs it after the commit. Safe to call any number of times, and for people who have no offer.
 */
export async function endOfferIfLeft(db: Db, universeId: string, userId: string): Promise<AnnounceEndedOffer | null> {
  const offer = await db.ownershipOffer.findUnique({
    where: { universeId },
    include: { universe: { select: { name: true, ownerId: true } } },
  });
  if (!offer || offer.toUserId !== userId) return null;
  const stillIn = await db.universeMember.findUnique({
    where: { universeId_userId: { universeId, userId } },
    select: { id: true },
  });
  if (stillIn) return null;
  const gone = await db.ownershipOffer.deleteMany({ where: { id: offer.id } });
  if (gone.count === 0) return null;
  const name = await nameOf(db, userId, 'They');
  return async () => {
    await clearOffered(userId, offer.id);
    await tellOwnerAndStarter(
      offer,
      `left:${offer.id}`,
      `The offer for ${offer.universe.name} ended`,
      `${name} is no longer a member, so the offer to them ended. You still own ${offer.universe.name}.`,
      `${name} is no longer a member, so the offer to them ended. Nothing changed.`,
    );
  };
}
