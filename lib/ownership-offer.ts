/**
 * Passing a universe to another account (#820): offer, then accept.
 *
 * Ownership is for the whole universe, never a world or room (they have no owner of their own). The owner (or a super
 * admin, for an owner who lost their account) offers it to a member; nothing changes until that person accepts. On accept,
 * in one transaction: the universe's owner changes, the new owner gets Admin in every world (in the game owning gives
 * nothing, only roles do), and the old owner stays as Admin in every world, which is also what keeps their bots running on
 * their lent AI key (lib/ai-key-pay.ts needs the key's owner to hold Manage bots).
 *
 * One offer per universe at a time (the table's unique universe_id), with no time limit. It ends when the person accepts or
 * declines, the owner takes it back, the person leaves or is removed, or the universe is deleted.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { clearOffered, nameOf, tell, tellOwnerAndStarter } from '@/lib/ownership-offer-ends';
import { ADMIN_KEY, ensureBuiltInRoles } from '@/lib/roles';
import { joinUniverse } from '@/lib/universe-members';

/** A reason an offer, take back or answer was refused, with the status the route sends. */
export class OfferError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = 'OfferError';
  }
}

/** Who may start or take back an offer: the owner, or a super admin acting for them. */
export function mayOffer(user: { id: string; isSuperAdmin: boolean }, universe: { ownerId: string }): boolean {
  return user.id === universe.ownerId || user.isSuperAdmin;
}

interface OfferedBy {
  id: string;
  isSuperAdmin: boolean;
}

/**
 * Offer the whole universe to a member. The universe's name is typed to confirm, so a stray tap never starts one.
 * The person has to be a signed-in member already, and not the owner.
 */
export async function startOffer(input: {
  universe: { id: string; name: string; ownerId: string };
  by: OfferedBy;
  toUserId: string;
  typedName: string;
}) {
  const { universe, by, toUserId, typedName } = input;
  if (!mayOffer(by, universe)) throw new OfferError('Only the owner can pass the universe on', 403);
  if (typedName !== universe.name) throw new OfferError('Type the universe’s name to confirm', 400);
  if (toUserId === universe.ownerId) throw new OfferError('They already own it', 400);

  const member = await prisma.universeMember.findUnique({
    where: { universeId_userId: { universeId: universe.id, userId: toUserId } },
    select: { id: true },
  });
  if (!member) throw new OfferError('They have to be a member first', 404);

  let offer;
  try {
    offer = await prisma.ownershipOffer.create({
      data: { universeId: universe.id, toUserId, offeredById: by.id },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new OfferError('An offer is already waiting. Take it back first.', 409);
    }
    throw error;
  }

  const owner = await nameOf(prisma, universe.ownerId, 'The owner');
  await tell(
    toUserId,
    `offered:${offer.id}`,
    `${universe.name} was offered to you`,
    by.id === universe.ownerId
      ? `${owner} offered you the whole universe. Open Memberships to accept or decline.`
      : `A super admin offered you the whole universe, on behalf of ${owner}. Open Memberships to accept or decline.`,
    'Offer',
  );
  // A super admin who starts one tells the owner, who did not
  if (by.id !== universe.ownerId) {
    await tell(
      universe.ownerId,
      `started:${offer.id}`,
      `${universe.name} was offered to someone else`,
      `A super admin offered ${universe.name} to ${await nameOf(prisma, toUserId, 'a member')}. Nothing changes until they accept, and you can take the offer back.`,
    );
  }
  return offer;
}

/** The owner (or a super admin) takes a waiting offer back. */
export async function takeBackOffer(input: { universe: { id: string; name: string; ownerId: string }; by: OfferedBy }) {
  const { universe, by } = input;
  if (!mayOffer(by, universe)) throw new OfferError('Only the owner can take the offer back', 403);
  const removed = await prisma.ownershipOffer.findUnique({ where: { universeId: universe.id } });
  if (!removed) throw new OfferError('There is no offer waiting', 404);
  const gone = await prisma.ownershipOffer.deleteMany({ where: { id: removed.id } });
  if (gone.count === 0) throw new OfferError('There is no offer waiting', 404);
  await clearOffered(removed.toUserId, removed.id);
  if (by.id !== universe.ownerId) {
    await tell(universe.ownerId, `taken-back:${removed.id}`, `The offer for ${universe.name} was taken back`, `A super admin took back the offer of ${universe.name}. You still own it.`);
  }
  return removed;
}

/** The person says no. The owner is told, and the person keeps every role they had. */
export async function declineOffer(input: { offerId: string; userId: string }) {
  const offer = await prisma.ownershipOffer.findUnique({
    where: { id: input.offerId },
    include: { universe: { select: { id: true, name: true, ownerId: true } } },
  });
  if (!offer || offer.toUserId !== input.userId) throw new OfferError('Offer not found', 404);
  const gone = await prisma.ownershipOffer.deleteMany({ where: { id: offer.id, toUserId: input.userId } });
  if (gone.count === 0) throw new OfferError('Offer not found', 404);
  await clearOffered(offer.toUserId, offer.id);
  const name = await nameOf(prisma, offer.toUserId, 'They');
  await tellOwnerAndStarter(offer, `declined:${offer.id}`, `${name} declined ${offer.universe.name}`, `${name} said no to owning ${offer.universe.name}. You still own it.`);
  return offer;
}

/**
 * The person says yes. One transaction does it all or nothing: the offer is spent (the first accept wins, a second one
 * finds it gone), the owner changes, and both people end up Admin in every world.
 */
export async function acceptOffer(input: { offerId: string; userId: string }) {
  const result = await prisma.$transaction(
    async (tx) => {
      const offer = await tx.ownershipOffer.findUnique({
        where: { id: input.offerId },
        include: { universe: { select: { id: true, name: true, ownerId: true } } },
      });
      if (!offer || offer.toUserId !== input.userId) throw new OfferError('Offer not found', 404);
      const spent = await tx.ownershipOffer.deleteMany({ where: { id: offer.id, toUserId: input.userId } });
      if (spent.count === 0) throw new OfferError('Offer not found', 404);

      const { universe } = offer;
      if (universe.ownerId === input.userId) throw new OfferError('You already own this universe', 409);
      const member = await tx.universeMember.findUnique({
        where: { universeId_userId: { universeId: universe.id, userId: input.userId } },
        select: { id: true },
      });
      // Leaving or removal ends the offer on its own (endOfferIfLeft); this is for a path that did not
      if (!member) throw new OfferError('You are no longer a member of this universe', 409);

      await ensureBuiltInRoles(tx, universe.id);
      const admin = await tx.role.findUniqueOrThrow({
        where: { universeId_key: { universeId: universe.id, key: ADMIN_KEY } },
        select: { id: true },
      });
      const everywhere = { allWorlds: true, worldIds: [] as string[] };
      const adminEverywhere = [{ roleId: admin.id, scope: everywhere }];
      // The new owner keeps every other role; the old owner (who may never have joined) becomes a member with Admin
      await joinUniverse(tx, { universeId: universe.id, userId: input.userId, worlds: everywhere, roles: adminEverywhere });
      await joinUniverse(tx, { universeId: universe.id, userId: universe.ownerId, worlds: everywhere, roles: adminEverywhere });

      // Only while the owner is still who the offer was made by: a change made some other way in the meantime wins
      const moved = await tx.universe.updateMany({
        where: { id: universe.id, ownerId: universe.ownerId },
        data: { ownerId: input.userId, ownerSince: new Date(), previousOwnerId: universe.ownerId },
      });
      if (moved.count === 0) throw new OfferError('The universe changed hands in the meantime', 409);
      return { offer, universe, oldOwnerId: universe.ownerId };
    },
    { timeout: 30_000 },
  );

  const { offer, universe, oldOwnerId } = result;
  await clearOffered(offer.toUserId, offer.id);
  const [newName, oldName] = await Promise.all([nameOf(prisma, offer.toUserId, 'They'), nameOf(prisma, oldOwnerId, 'The previous owner')]);
  await tell(offer.toUserId, `now-yours:${offer.id}`, `You own ${universe.name}`, `${universe.name} is yours now, with every world and room in it. ${oldName} stays as Admin.`);
  await tellOwnerAndStarter(
    { offeredById: offer.offeredById, universe: { ownerId: oldOwnerId } },
    `accepted:${offer.id}`,
    `${newName} owns ${universe.name} now`,
    `${newName} accepted. You stay as Admin in every world.`,
  );
  return { universeId: universe.id, universeName: universe.name, previousOwnerName: oldName };
}
