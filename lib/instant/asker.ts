import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { ownCopyOf, ownGrantsOf } from '@/lib/app-same';
import { connectedState } from '@/lib/app-connections';

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

/**
 * The Apps this Brick's owner has switched on for THIS Brick: an enabled grant of one of the owner's own ready-made Apps. Nothing is on
 * for a Brick by default, so a Brick can rely on the model alone or use just the Apps its owner gave it. An Instant tool is offered and
 * run only for an App in this list. An App this Brick also has the owner's own copy of (switched on) is left out: their own comes first.
 */
export async function brickApps(botId: string): Promise<Set<string>> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { ownerId: true } });
  if (!bot?.ownerId) return new Set();
  const [grants, own] = await Promise.all([
    prisma.botMcpServer.findMany({
      where: { botId, enabled: true, connection: { ownerId: bot.ownerId, providerToolkit: { not: null } } },
      select: { connection: { select: { providerToolkit: true, name: true } } },
    }),
    ownGrantsOf(botId, (own) => connectedState(own).connected),
  ]);
  // The owner's own copy of an App comes first (lib/app-same.ts): while this Brick has their own Exa switched on, Instant's Exa is neither
  // offered nor run, so their own account is what is used and nothing is paid for or counted by Universe
  return new Set(
    grants
      .filter((grant) => !ownCopyOf(own, { key: grant.connection?.providerToolkit, name: grant.connection?.name }))
      .map((grant) => appKeyOf(grant.connection?.providerToolkit ?? ''))
      .filter(Boolean),
  );
}

export async function brickHasApp(botId: string, toolkit: string): Promise<boolean> {
  return (await brickApps(botId)).has(appKeyOf(toolkit));
}
