import { prisma } from '@/lib/db';
import { connectedState, confirmIfPending } from '@/lib/app-connections';
import { ownerAskingThrough } from '@/lib/brick-make';

/** One app on the list as the bot server needs it to tell a Brick what it may offer its owner. Never the link or the sign-in. */
export interface OfferableApp {
  key: string;
  name: string;
  blurb: string;
  /** The owner's own connection made from it, when they have one. */
  connectionId: string | null;
  /** That connection is signed in and works. */
  connected: boolean;
  /** This Brick already has a grant on it. */
  usable: boolean;
}

/**
 * The apps a Brick may offer its owner ("Let it use Gmail" once connected, and not yet used by this Brick): every app that is on
 * and listed, with the owner's own connection of it. Only for the owner of Brick `viaBrickId`; for anyone else, and for a room
 * bot, null, the same as for a Brick that does not exist.
 */
export async function offerableForBrick(viaBrickId: string, userId: string): Promise<OfferableApp[] | null> {
  const ownerId = await ownerAskingThrough(viaBrickId, userId);
  if (!ownerId) return null;
  const [entries, mine] = await Promise.all([
    prisma.appCatalogEntry.findMany({ where: { enabled: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.appConnection.findMany({
      where: { ownerId, catalogKey: { not: null } },
      include: { grants: { where: { botId: viaBrickId }, select: { id: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const confirmed = await Promise.all(mine.map(confirmIfPending));
  const byKey = new Map(confirmed.map((row) => [row.catalogKey as string, row]));
  return entries.map((entry) => {
    const own = byKey.get(entry.key);
    return {
      key: entry.key,
      name: entry.name,
      blurb: entry.blurb,
      connectionId: own?.id ?? null,
      connected: own ? connectedState(own).connected : false,
      usable: !!own && own.grants.length > 0,
    };
  });
}
