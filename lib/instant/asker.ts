import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { brickOwnRowsOf, isOwnApp, ownCopyWorks, ownGrantsOf, sameApp } from '@/lib/app-same';
import { connectedState } from '@/lib/app-connections';
import { INSTANT_APPS } from '@/lib/instant/values';

/**
 * Who an Instant run is for. Instant runs only on a person's own Brick (no room), for the Brick's OWNER's own request, and is paid
 * from that owner's Instant Apps credit. A visitor talking to someone's Brick, or a room bot, never runs it and never pays for it.
 * Returns the owner's id, or null when the asker is not the owner (same words for "not there").
 */
export async function ownerAsker(botId: string, input: { forOwner?: boolean; requesterKey?: string }): Promise<string | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  if (!bot || !bot.ownerId || !ownsBrick(bot, bot.ownerId)) return null;
  if (input.forOwner === true) return bot.ownerId;
  if (!input.requesterKey) return null;
  const asker = await findUserByIdentifier(input.requesterKey);
  return asker && !asker.isGuest && asker.id === bot.ownerId ? bot.ownerId : null;
}

/** An App's name compared loosely, so "google_maps" and "googlemaps" are the same App. */
export const appKeyOf = (toolkit: string): string => toolkit.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The research Apps of the table (their keys, read loosely) that one of these own Apps is the same App as, by the one rule of lib/app-same.ts. */
export function researchCoveredBy(own: readonly { name: string; serverUrl: string | null }[]): Set<string> {
  const covered = new Set<string>();
  for (const [key, info] of Object.entries(INSTANT_APPS)) {
    if (own.some((one) => sameApp(one, { key, name: info.name }))) covered.add(appKeyOf(key));
  }
  return covered;
}

/**
 * The research Apps this Brick's owner has their OWN copy of, switched on for this Brick and working, by the one rule of lib/app-same.ts:
 * ownGrantsOf (their link, a listed App or their key; never a ready-made one, which Universe pays for too) and brickOwnRowsOf (an App added
 * straight on the Brick). Their own copy always wins: the Universe-paid version of that App is then neither offered to this Brick nor run, so
 * the Brick uses the owner's own account, which Universe never meters or limits. One that cannot work right now (not connected, a refused
 * sign-in or key, a server that did not answer) does not count, so the Brick is never left with no way to search.
 */
export async function brickOwnResearch(botId: string): Promise<Set<string>> {
  const [grants, rows] = await Promise.all([ownGrantsOf(botId, (own) => connectedState(own).connected), brickOwnRowsOf(botId)]);
  return researchCoveredBy([...grants, ...rows]);
}

/**
 * The research Apps on for this Brick: every App of the table, on for every Brick's owner by default with nothing to connect and no switch,
 * except one the Brick has the owner's own working copy of (then theirs is used instead). Who may run it (only the owner, on their own Brick,
 * in its own chat) is checked by the caller.
 */
export async function brickApps(botId: string): Promise<Set<string>> {
  const own = await brickOwnResearch(botId);
  return new Set(Object.keys(INSTANT_APPS).map(appKeyOf).filter((key) => !own.has(key)));
}

/**
 * The research Apps a person has their own working copy of (any own App of theirs, whichever Bricks use it), for the Apps page: an App they
 * connected themselves is listed there under Connected, so the Universe-paid version of it is not listed beside it. The same rule as above.
 */
export async function personOwnResearch(personId: string): Promise<Set<string>> {
  const connections = await prisma.appConnection.findMany({ where: { ownerId: personId } });
  return researchCoveredBy(
    connections.filter((connection) => isOwnApp(connection) && ownCopyWorks(connectedState(connection).connected, connection)).map((connection) => ({ name: connection.name, serverUrl: connection.serverUrl })),
  );
}

/** Whether an App of the table is on for this Brick (see brickApps). */
export async function brickHasApp(botId: string, toolkit: string): Promise<boolean> {
  return (await brickApps(botId)).has(appKeyOf(toolkit));
}
