import { prisma } from '@/lib/db';
import { ownsBrick } from '@/lib/brick';
import { findUserByIdentifier } from '@/lib/user-identifier';
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

/** The host of a link, lower case, or null when it is not a link. */
function hostOf(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    return new URL(link).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The App of the table a link, key or ready-made App is the same service as (`api.exa.ai` and `mcp.exa.ai` are Exa), or null. */
export function serviceOf(app: { providerToolkit?: string | null; serverUrl?: string | null }): string | null {
  const toolkit = app.providerToolkit ? appKeyOf(app.providerToolkit) : '';
  const host = hostOf(app.serverUrl);
  for (const [key, info] of Object.entries(INSTANT_APPS)) {
    if (toolkit && toolkit === appKeyOf(key)) return key;
    if (host && info.hosts.some((own) => host === own || host.endsWith(`.${own}`))) return key;
  }
  return null;
}

/**
 * The research Apps this Brick has as its OWNER's own App, switched on for it: a link, a key or a ready-made sign-in of the same service as an
 * App of the table (an app set up on the Brick itself before Apps were connected once counts too). The owner's own App always wins: the
 * Universe-paid version of that App is then not offered to this Brick at all, so the Brick uses the owner's own account, which Universe never
 * meters or limits, and the per-action choices (Right away, Asks first, Off) of that App are the ones that apply. One that cannot work right now
 * (a ready-made sign-in never finished, or a sign-in the App refused) does not count, so the Brick is never left with no way to search.
 */
export async function brickOwnResearch(botId: string): Promise<Set<string>> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { ownerId: true } });
  if (!bot?.ownerId) return new Set();
  const rows = await prisma.botMcpServer.findMany({
    where: { botId, enabled: true, OR: [{ connectionId: null }, { connection: { ownerId: bot.ownerId } }] },
    select: {
      serverUrl: true,
      signInLostAt: true,
      connection: { select: { serverUrl: true, providerToolkit: true, source: true, providerConfirmedAt: true, signInLostAt: true } },
    },
  });
  const own = new Set<string>();
  for (const row of rows) {
    const connection = row.connection;
    if (connection) {
      if (connection.signInLostAt || (connection.source === 'ready_made' && !connection.providerConfirmedAt)) continue;
    } else if (row.signInLostAt) continue;
    const service = serviceOf(connection ?? { serverUrl: row.serverUrl });
    if (service) own.add(service);
  }
  return own;
}

/**
 * The research Apps a person has as their own (any connection of theirs of the same service, whichever Bricks use it), for the Apps page: an App
 * they connected themselves is listed there under Connected, so the Universe-paid version of it is not listed beside it.
 */
export async function personOwnResearch(personId: string): Promise<Set<string>> {
  const connections = await prisma.appConnection.findMany({
    where: { ownerId: personId },
    select: { serverUrl: true, providerToolkit: true, source: true, providerConfirmedAt: true, signInLostAt: true },
  });
  const own = new Set<string>();
  for (const connection of connections) {
    if (connection.signInLostAt || (connection.source === 'ready_made' && !connection.providerConfirmedAt)) continue;
    const service = serviceOf(connection);
    if (service) own.add(service);
  }
  return own;
}

/**
 * Whether an App of the table is on for this Brick: research Apps are on for every Brick's owner by default, with nothing to connect and no
 * switch, unless the owner's own App of the same service is on for it (then theirs is used instead). Who may run it (only the owner, on
 * their own Brick, in its own chat) is checked by the caller.
 */
export async function brickHasApp(botId: string, toolkit: string): Promise<boolean> {
  const key = appKeyOf(toolkit);
  if (!Object.keys(INSTANT_APPS).some((app) => appKeyOf(app) === key)) return false;
  return !(await brickOwnResearch(botId)).has(key);
}
