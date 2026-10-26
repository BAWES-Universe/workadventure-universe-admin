import { prisma } from '@/lib/db';

/**
 * A guest who signs in becomes a second person in Visitors: their account, and the guest id their device used before.
 * The game sends that id once, right after sign-in (`previousGuestUuid`), only when it checked that it came out of a
 * token it signed and that the same device just signed in. Here the visits saved under that id join the account.
 *
 * Only that id is ever linked: never a name, IP address or Woka. And only visits that belong to no account move, so a
 * guest id joins the one account that signed in with its own token and a second account sending it moves nothing.
 */

/** A guest id is the uuid the game made at their first visit; anything else (an email, `unverified-…`, `bot-…`) is not one. */
const GUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isLinkableGuestId(candidate: string | null | undefined, accountUuid: string): candidate is string {
  return !!candidate && GUEST_ID.test(candidate) && candidate !== accountUuid;
}

export interface LinkedAccount {
  id: string;
  uuid: string;
  name: string | null;
  email: string | null;
}

/**
 * Moves the visits saved under `guestUuid` that have no account onto `account`, and writes each move to
 * `room_access_relinks` with what the visit held before (the log scripts/unverified-visits-undo.sql reads). The visits
 * stay "not signed in", so Visitors lists them as Guest inside the person's card. Returns how many moved.
 */
export async function linkGuestVisits(guestUuid: string, account: LinkedAccount): Promise<number> {
  return prisma.$transaction(async (tx) => {
    // An id that is some account's own is never a guest's to hand over.
    if (await tx.user.findUnique({ where: { uuid: guestUuid }, select: { id: true } })) return 0;
    const visits = await tx.roomAccess.findMany({
      where: { userUuid: guestUuid, userId: null },
      select: { id: true, userUuid: true, userId: true, userName: true, userEmail: true, isGuest: true },
    });
    if (visits.length === 0) return 0;
    await tx.roomAccessRelink.createMany({
      data: visits.map((visit) => ({
        roomAccessId: visit.id,
        userId: account.id,
        oldUserUuid: visit.userUuid,
        oldUserId: visit.userId,
        oldUserName: visit.userName,
        oldUserEmail: visit.userEmail,
        oldIsGuest: visit.isGuest,
      })),
    });
    const moved = await tx.roomAccess.updateMany({
      where: { id: { in: visits.map((visit) => visit.id) }, userId: null },
      data: {
        userId: account.id,
        userUuid: account.uuid,
        isGuest: false,
        ...(account.name ? { userName: account.name } : {}),
        ...(account.email ? { userEmail: account.email } : {}),
      },
    });
    return moved.count;
  });
}
