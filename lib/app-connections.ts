import { randomBytes } from 'crypto';
import { Prisma, type AppConnection, type BotMcpServer } from '@prisma/client';
import { z } from 'zod';
import { confirmReadyMade } from '@/lib/app-adapter/confirm';
import { prisma } from '@/lib/db';
import { lendAccess } from '@/lib/ai-key-lend';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';
import { endApprovalsForServers } from '@/lib/bot-actions';
import { ownsBrick } from '@/lib/brick';
import { addNotice } from '@/lib/notices';
import { botUniverseId, recordUse } from '@/lib/app-uses';
import { isAppLendable } from '@/lib/app-lendable';
import { getManagedConnection, managesConnection } from '@/lib/app-team-access';
import { findUserByIdentifier } from '@/lib/user-identifier';
import { createMcpServerSchema } from '@/lib/mcp/server-input';
import { isReconnectRequired, parseOAuthConfig, refreshBlockedReason } from '@/lib/mcp/oauth-token';
import { syncToolSignInNotices } from '@/lib/tool-signin';
import { revokeAtApp } from '@/lib/mcp/revoke';
import { holdRefreshLease } from '@/lib/mcp/oauth-refresh';

/**
 * Apps a person connects once (game #2001, "Apps").
 *
 * A connection is the link of an app and the way into it (a sign-in, a key or a token, encrypted as a bot's own server's
 * is), made by ONE person. It is never lent, shared or used for anyone else here. A Brick of theirs uses it through a grant:
 * a `BotMcpServer` row for that Brick whose `connectionId` points at the connection. The row keeps what is the Brick's own,
 * its four headings with today's defaults, its tools and their confirmations, its switch, so everything that works per Brick
 * today works for a grant unchanged. What is the app's, the link, the way in and the sign-in lost fields, is only ever read
 * from the connection (`effectiveServer`), never copied onto the row.
 *
 * Rules held here and again by the database (the trigger of migration 20261112100000):
 *  - A grant is only from a person to their own Brick. A room bot, or a Brick of someone else, never holds one.
 *  - A new Brick has no grant. Nothing grants an app by default.
 *  - Taking a grant away, or disconnecting, deletes the rows at once, ends every approval the person gave for them, and the
 *    next use finds nothing (`checkAppUse`), also in a chat that is already open and a goal that is already running.
 *  - A use through a connection is only for the person who owns it (`checkAppUse`).
 */

/** What a grant row is read together with, so its app's link and way in come from the connection. */
export const WITH_CONNECTION = { connection: true } as const;

export type ServerRow = BotMcpServer & { connection?: AppConnection | null };

/**
 * The row as it is used: for a grant, the app's name, link, way in, headers and sign-in lost fields come from its
 * connection. A row without a connection is returned as it is. A grant read without its connection is a mistake in the
 * caller, so it throws instead of serving a row with no link or credential.
 */
export function effectiveServer<T extends ServerRow>(row: T): T {
  if (!row.connectionId) return row;
  const connection = row.connection;
  if (!connection) throw new Error('A grant has to be read together with its connection');
  return {
    ...row,
    // The whole connection rides along on the row for callers that read other fields of it: for a key app it carries no key
    connection: connection.kind === 'direct' ? { ...connection, keyCipher: null } : connection,
    name: connection.name,
    serverUrl: connection.serverUrl,
    // A key app (game #2044) is never an app link and its key is never handed on: a grant of one carries no way in at all
    authType: connection.kind === 'direct' ? 'none' : connection.authType,
    authConfig: connection.kind === 'direct' ? null : connection.authConfig,
    headers: connection.kind === 'direct' ? null : connection.headers,
    signInLostAt: connection.signInLostAt,
    signInLostStatus: connection.signInLostStatus,
    noAnswerAt: connection.noAnswerAt,
    reconnectedAt: connection.reconnectedAt,
    connectedById: connection.connectedById,
  };
}

/** Why an app cannot be used for a request. The bot server only ever learns `allowed`, never what the app holds. */
export type AppUseRefusal = 'gone' | 'off' | 'not_owner' | 'not_lent' | 'limit_reached' | 'incomplete';

/** The four headings a bot's settings are kept under, and what a lend may narrow bots to. */
export const HEADINGS = ['lookUp', 'make', 'change', 'deleteSend'] as const;
export type Heading = (typeof HEADINGS)[number];

export interface AppUseVerdict {
  allowed: boolean;
  /** Present only when not allowed. */
  reason?: AppUseRefusal;
  /** True when this is a person's connection (a grant); false for an app set up on a bot as before, which this does not decide. */
  viaConnection: boolean;
  /** True when the app was made through the ready-made adapter: its use is paid by the universe, not the person (the meter's payer). */
  readyMade?: boolean;
  /** Who pays for this use: a person's own app lent to a universe is the lender's; a universe's own app is counted for that universe. */
  paidBy?: { kind: 'person'; personId: string } | { kind: 'universe'; universeId: string };
}

export const useCheckSchema = z
  .object({
    /** Who is asking, as the bot server authenticated them: their WorkAdventure uuid or their email. A guest has no account. */
    requesterKey: z.string().trim().min(1).max(400).optional(),
    /** The Brick is working for its owner on its own, such as a goal they set (game #2002): no one else is asking. */
    forOwner: z.boolean().optional(),
    /** Required for a lent or a universe's own app (a use without it is refused as `incomplete`): the bot server's id for this call, so "uses a day" counts a retry once. */
    callId: z.string().trim().min(1).max(200).optional(),
    /** Required for a lent app (a use without it is refused as `incomplete`): which heading the tool falls under, so what the lender allowed is held at every use. */
    heading: z.enum(HEADINGS).optional(),
  })
  .strict();

/**
 * May this app be used right now, for this request? Called by the bot server on EVERY use of an app, not once per chat, so a
 * grant that was taken away, an app that was disconnected, or a turned-off switch stops it at once, also in a chat that is
 * already open and in a goal that is already running.
 *
 * A per-bot row (no connection) is allowed as before: its own rules are not changed here. For a grant, all of these must hold:
 *  - a person's app used by their own Brick: the row exists and is on, the Brick is still its owner's, and the person asking is
 *    its owner (or the Brick works for its owner on its own). Anyone else, in a group chat or on the map, gets nothing from it.
 *  - a person's app lent to a universe, used by a bot there: the lend still exists (taking it back stops the bot at once), the
 *    heading is one the lender allowed, and the day's uses are not used up. Any visitor may ask the bot.
 *  - a universe's own app, used by a bot of that universe: the row is on. Any visitor may ask the bot.
 * The answer never says what is in it or whose it is.
 */
export async function checkAppUse(botId: string, serverId: string, input: z.infer<typeof useCheckSchema>): Promise<AppUseVerdict | null> {
  const row = await prisma.botMcpServer.findFirst({
    where: { id: serverId, botId },
    include: { connection: true, bot: { select: { roomId: true, ownerId: true, deletedAt: true } } },
  });
  if (!row) return null;
  if (!row.connectionId) return { allowed: row.enabled, ...(row.enabled ? {} : { reason: 'off' as const }), viaConnection: false };
  const refuse = (reason: AppUseRefusal): AppUseVerdict => ({ allowed: false, reason, viaConnection: true });
  const connection = row.connection;
  if (!connection) return refuse('gone');

  // A room bot: through a lend of a person's app, or through its universe's own app
  if (row.bot.roomId !== null) {
    if (row.bot.deletedAt !== null) return refuse('gone');
    const universeId = await botUniverseId(botId);
    if (!universeId) return refuse('gone');
    // A use with no call id could not be counted, and one with no heading could not be held to what the lender allowed: both are
    // refused, never let through unchecked
    if (!input.callId) return refuse('incomplete');
    if (connection.universeId) {
      if (connection.universeId !== universeId) return refuse('gone');
      if (!row.enabled) return refuse('off');
      if ((await recordUse({ connectionId: connection.id, universeId, botId, callId: input.callId, limit: null, serverId: row.id })) === 'gone') return refuse('gone');
      return { allowed: true, viaConnection: true, paidBy: { kind: 'universe', universeId } };
    }
    const lend = await prisma.appLend.findUnique({ where: { connectionId_universeId: { connectionId: connection.id, universeId } } });
    if (!lend || !connection.ownerId) return refuse('gone');
    // The lender must still be allowed to lend here: someone who left the universe, or lost Manage bots, no longer has their app
    // serving it (and billed to them) just because the lend row is still there
    if (!lend.lentById || !(await lendAccess(lend.lentById, universeId))) return refuse('gone');
    if (!row.enabled) return refuse('off');
    if (!input.heading) return refuse('incomplete');
    const things = Array.isArray(lend.things) ? (lend.things as unknown[]) : null;
    if (things && !things.includes(input.heading)) return refuse('not_lent');
    const outcome = await recordUse({ connectionId: connection.id, universeId, botId, callId: input.callId, limit: lend.usesPerDay, serverId: row.id, lend: true });
    // Taken back while this check was waiting: nothing is recorded, and nothing is let through
    if (outcome === 'gone') return refuse('gone');
    if (outcome === 'limit_reached') {
      await tellLenderOfLimit(lend, connection.name);
      return refuse('limit_reached');
    }
    return { allowed: true, viaConnection: true, paidBy: { kind: 'person', personId: lend.lentById ?? connection.ownerId } };
  }

  if (!connection.ownerId || !ownsBrick(row.bot, connection.ownerId)) return refuse('gone');
  if (!row.enabled) return refuse('off');
  const allowed: AppUseVerdict = { allowed: true, viaConnection: true, ...(connection.source === 'ready_made' ? { readyMade: true } : {}) };
  if (input.forOwner === true) return allowed;
  if (!input.requesterKey) return refuse('not_owner');
  const asker = await findUserByIdentifier(input.requesterKey);
  if (!asker || asker.isGuest || asker.id !== connection.ownerId) return refuse('not_owner');
  return allowed;
}

/** The lender is told once a day that today's uses ran out, with what they need to change the limit. Never throws. */
async function tellLenderOfLimit(lend: { id: string; connectionId: string; universeId: string; lentById: string | null; usesPerDay: number | null }, appName: string): Promise<void> {
  if (!lend.lentById) return;
  try {
    const universe = await prisma.universe.findUnique({ where: { id: lend.universeId }, select: { name: true } });
    const day = new Date().toISOString().slice(0, 10);
    await addNotice({
      userId: lend.lentById,
      kind: 'app-lend-limit',
      dedupeKey: `app-lend-limit:${lend.id}:${day}`,
      title: `${appName} used up today's ${lend.usesPerDay ?? ''} uses in ${universe?.name ?? 'a universe'}`.replace('  ', ' '),
      body: `Bots there carry on without ${appName} until tomorrow. You can change the limit.`,
      data: { connectionId: lend.connectionId, universeId: lend.universeId },
    });
  } catch (error) {
    console.error('[AppLend] Could not tell the lender about the limit:', error instanceof Error ? error.message : 'unknown');
  }
}

/* -------------------------------- connections -------------------------------- */

export class AppConnectionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const NOT_FOUND = 'App not found';

/** One of the person's own connections, or null: someone else's looks exactly like one that does not exist. */
export async function getOwnedConnection(connectionId: string, ownerId: string): Promise<AppConnection | null> {
  return prisma.appConnection.findFirst({ where: { id: connectionId, ownerId } });
}

export const addConnectionSchema = createMcpServerSchema
  .safeExtend({ source: z.enum(['link', 'listed']).default('link') })
  .omit({ enabled: true });

/** A connection made from a person's own input is "link"; the list (lib/app-catalog.ts) adds `catalogKey` for its own. */
type NewConnection = Omit<z.infer<typeof addConnectionSchema>, 'source'> & { source: 'link' | 'listed' | 'ready_made'; catalogKey?: string | null; providerToolkit?: string | null; providerAccountId?: string | null };

/** The person connects an app. The way in is stored encrypted and never read back by a screen. */
export async function createConnection(ownerId: string, input: NewConnection, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<AppConnection> {
  return db.appConnection.create({
    data: {
      ownerId,
      connectedById: ownerId,
      name: input.name,
      serverUrl: input.serverUrl,
      authType: input.authType,
      authConfig: input.authConfig ? encryptApiKey(input.authConfig) : null,
      headers: input.headers ?? undefined,
      source: input.source,
      catalogKey: input.catalogKey ?? null,
      providerToolkit: input.providerToolkit ?? null,
      providerAccountId: input.providerAccountId ?? null,
    },
  });
}

/** What a screen may know about a connection: never the way in itself, only whether it still works. */
export interface ConnectionView {
  id: string;
  name: string;
  serverUrl: string;
  authType: string;
  /** "Added by you" for an app the person pasted a link for. */
  source: string;
  /** An OAuth app that has signed in (and has not lost it). Keys, tokens and no sign-in are connected as soon as they exist. */
  connected: boolean;
  /** The sign-in expired or was lost: who can fix it is the owner, here, and one Reconnect fixes every Brick. */
  signInLostAt: Date | null;
  reconnectRequired: boolean;
  connectedAt: Date;
  /** `mcp`: an app link. `direct`: an app that runs from a service definition and the person's key (game #2044). */
  kind: string;
  /** A key app only: the last characters of its key, the only part of it that is ever shown. */
  keyLast4: string | null;
  /** A key app only: test or live, when the service's keys say. */
  keyMode: string | null;
  /** Whether it can be lent to a universe: an app added with a link and a key, a token or nothing. One signed in as the person never is. */
  lendable: boolean;
  /** The Bricks of this person that use it, each with what it may do (the four headings). */
  bricks: { botId: string; botName: string; serverId: string; enabled: boolean; headings: Headings }[];
}

export interface Headings {
  lookUp: string;
  make: string;
  change: string;
  deleteSend: string;
}

export function connectedState(connection: AppConnection): { connected: boolean; reconnectRequired: boolean } {
  // A ready-made app is connected only once the provider confirmed the sign-in (lib/app-adapter/confirm.ts), never from the tap
  if (connection.source === 'ready_made') return { connected: !!connection.providerConfirmedAt && !connection.signInLostAt, reconnectRequired: false };
  // A key app is connected while its key works: the call route marks it lost when the service stops accepting it, and a new key clears that
  if (connection.kind === 'direct') return { connected: !connection.signInLostAt, reconnectRequired: !!connection.signInLostAt };
  if (connection.authType !== 'oauth') return { connected: true, reconnectRequired: false };
  if (!connection.authConfig) return { connected: false, reconnectRequired: false };
  try {
    const config = parseOAuthConfig(decryptApiKey(connection.authConfig));
    if (!config?.accessToken) return { connected: false, reconnectRequired: false };
    const needsHuman = isReconnectRequired(config) || !!config.reconnectRequired || !!refreshBlockedReason(config);
    return { connected: !needsHuman && !connection.signInLostAt, reconnectRequired: needsHuman };
  } catch {
    return { connected: false, reconnectRequired: false };
  }
}

type ConnectionWithGrants = AppConnection & { grants: (BotMcpServer & { bot: { id: string; name: string; deletedAt: Date | null; roomId: string | null } })[] };

function toView(connection: ConnectionWithGrants): ConnectionView {
  const state = connectedState(connection);
  return {
    id: connection.id,
    name: connection.name,
    serverUrl: connection.serverUrl,
    authType: connection.authType,
    source: connection.source,
    kind: connection.kind,
    keyLast4: connection.kind === 'direct' ? connection.keyLast4 : null,
    keyMode: connection.kind === 'direct' ? connection.keyMode : null,
    connected: state.connected,
    signInLostAt: connection.signInLostAt,
    reconnectRequired: state.reconnectRequired || !!connection.signInLostAt,
    connectedAt: connection.createdAt,
    lendable: isAppLendable(connection),
    bricks: connection.grants
      // A Brick that waits deleted for Undo uses nothing and is not listed; a room bot that uses it through a lend is listed under "Lent to"
      .filter((grant) => grant.bot.deletedAt === null && grant.bot.roomId === null)
      .map((grant) => ({
        botId: grant.botId,
        botName: grant.bot.name,
        serverId: grant.id,
        enabled: grant.enabled,
        headings: { lookUp: grant.lookUpSetting, make: grant.makeSetting, change: grant.changeSetting, deleteSend: grant.deleteSendSetting },
      })),
  };
}

/** A ready-made app whose sign-in is not confirmed yet is asked about once more before it is shown, so a finished sign-in reads connected. */
export async function confirmIfPending<T extends AppConnection>(row: T): Promise<T> {
  if (row.source !== 'ready_made' || row.providerConfirmedAt) return row;
  const confirmedAt = await confirmReadyMade(row);
  return confirmedAt ? { ...row, providerConfirmedAt: confirmedAt } : row;
}

const GRANTS = { grants: { include: { bot: { select: { id: true, name: true, deletedAt: true, roomId: true } } }, orderBy: { createdAt: 'asc' as const } } };

/** Every app the person connected, oldest first, with the Bricks of theirs that use each. Only theirs. */
export async function listConnections(ownerId: string): Promise<ConnectionView[]> {
  const rows = await prisma.appConnection.findMany({ where: { ownerId }, include: GRANTS, orderBy: { createdAt: 'asc' } });
  return (await Promise.all(rows.map(confirmIfPending))).map(toView);
}

export async function readConnection(connectionId: string, ownerId: string): Promise<ConnectionView | null> {
  const row = await prisma.appConnection.findFirst({ where: { id: connectionId, ownerId }, include: GRANTS });
  return row ? toView(await confirmIfPending(row)) : null;
}

/** The Bricks the person has, so the app's page can offer "Let it use Gmail" for each one that does not use it yet. */
export async function ownBricks(ownerId: string): Promise<{ id: string; name: string }[]> {
  return prisma.bot.findMany({ where: { ownerId, roomId: null, deletedAt: null }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
}

/* ----------------------------------- grants ----------------------------------- */

/**
 * "Let it use Gmail": one of the person's own Bricks may use one of their own connections. Asked twice, the second answer is
 * the same grant. Null when either is not theirs: a Brick of someone else, a room bot, a Brick waiting deleted, a connection
 * that is not theirs. The row starts with today's defaults for the four headings, so a change or a send still asks first.
 */
export async function grantToBrick(ownerId: string, connectionId: string, botId: string): Promise<BotMcpServer | null> {
  const connection = await getOwnedConnection(connectionId, ownerId);
  if (!connection) return null;
  // A key app's grant carries no way in at all (effectiveServer): this is also how a Brick taken off it gets it back
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  if (!bot || !ownsBrick(bot, ownerId)) return null;
  try {
    return await prisma.botMcpServer.create({
      // The link is the connection's and is never copied: the column is not null, so it stays empty here and is read through effectiveServer
      data: { botId, connectionId, name: connection.name, serverUrl: '', authType: 'none', connectedById: ownerId },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.botMcpServer.findFirst({ where: { botId, connectionId } });
    }
    throw error;
  }
}

/**
 * "Remove": the Brick stops using it. Its row is deleted, every approval the person gave for it ends and every card that waits
 * is closed, in the same step, so nothing already said yes to can still run through it. True when there was a grant.
 */
export async function removeGrant(ownerId: string, connectionId: string, botId: string): Promise<boolean> {
  const connection = await getManagedConnection(connectionId, ownerId);
  if (!connection) return false;
  const removed = await prisma.$transaction(async (tx) => {
    const row = await tx.botMcpServer.findFirst({ where: { botId, connectionId }, select: { id: true } });
    if (!row) return false;
    await endApprovalsForServers(tx, [row.id]);
    await tx.botMcpServer.delete({ where: { id: row.id } });
    return true;
  });
  if (removed) await syncToolSignInNotices(botId);
  return removed;
}

/**
 * "Disconnect": the app is taken away from every Brick at once. The connection and every grant of it are deleted, and every
 * approval for them ends. Nothing in the person's account at the app is touched. False when it is not theirs.
 */
export async function disconnect(ownerId: string, connectionId: string): Promise<boolean> {
  if (!(await getManagedConnection(connectionId, ownerId))) return false;
  // A renewal of the sign-in may be in flight: wait for it, then read the sign-in as it is now, so the app is asked to take back the
  // newest token and not one the renewal has just replaced
  const letGo = await holdRefreshLease(connectionId);
  let connection: AppConnection | null;
  let bots: string[];
  try {
    connection = await getManagedConnection(connectionId, ownerId);
    if (!connection) return false;
    bots = await prisma.$transaction(async (tx) => {
      const rows = await tx.botMcpServer.findMany({ where: { connectionId }, select: { id: true, botId: true } });
      await endApprovalsForServers(tx, rows.map((row) => row.id));
      // The rows go with it (onDelete cascade); the connection is gone in the same statement as the rows are
      await tx.appConnection.delete({ where: { id: connectionId } });
      return [...new Set(rows.map((row) => row.botId))];
    });
  } finally {
    await letGo();
  }
  // The sign-in cards that were about it go too; a failed report never undoes the disconnect
  for (const botId of bots) await syncToolSignInNotices(botId);
  // Best effort, after everything above: the app takes the sign-in back when it said where (never throws)
  await revokeAtApp(connection);
  return true;
}

/** Renames the app on the person's own pages. The link and the way in are changed only by connecting it again. */
export async function renameConnection(ownerId: string, connectionId: string, name: string): Promise<boolean> {
  const connection = await getManagedConnection(connectionId, ownerId);
  if (!connection) return false;
  const done = await prisma.appConnection.updateMany({ where: { id: connectionId }, data: { name } });
  return done.count === 1;
}

/* --------------------------------- signing in --------------------------------- */

/**
 * The one ticket a sign-in page may bring back. A new sign-in replaces the last one, so the return of an older sign-in that
 * was opened twice, or of one that was already used, finds a ticket that no longer matches and is refused (check 38).
 */
export async function newSignInNonce(connectionId: string): Promise<string> {
  const nonce = randomBytes(24).toString('base64url');
  await prisma.appConnection.update({ where: { id: connectionId }, data: { signInNonce: nonce } });
  return nonce;
}

/** Uses the ticket exactly once: true for the first return that carries the current one, false for anything else. */
export async function takeSignInNonce(connectionId: string, nonce: string | undefined): Promise<boolean> {
  if (!nonce) return false;
  const taken = await prisma.appConnection.updateMany({ where: { id: connectionId, signInNonce: nonce }, data: { signInNonce: null } });
  return taken.count === 1;
}

/**
 * The person signed the app in again (a new sign-in): what was down is cleared at once for every Brick that uses it, the time is
 * kept so a failure a call saw before it and reports after it never starts an outage, and the cards that were about it go.
 * Never throws: the sign-in has already gone through.
 */
export async function markConnectionReconnected(connectionId: string, personId: string | null): Promise<void> {
  try {
    const connection = await prisma.appConnection.findUnique({
      where: { id: connectionId },
      select: { signInLostAt: true, noAnswerAt: true, ownerId: true, universeId: true, grants: { select: { botId: true } } },
    });
    if (!connection) return;
    const wasDown = !!connection.signInLostAt || !!connection.noAnswerAt;
    await prisma.appConnection.update({
      where: { id: connectionId },
      data: wasDown ? { signInLostAt: null, signInLostStatus: null, noAnswerAt: null, reconnectedAt: new Date() } : { reconnectedAt: new Date() },
    });
    // Only the owner (or a manager of a universe's own app) can have signed it in; remembering who can fail (that account may be gone)
    // and never undoes the clear. A team app signed in again names the one who did it, so it no longer depends on whoever left.
    if (personId && (await managesConnection(personId, { id: connectionId, ownerId: connection.ownerId, universeId: connection.universeId }))) {
      await prisma.appConnection.update({ where: { id: connectionId }, data: { connectedById: personId } }).catch(() => undefined);
    }
    if (connection.signInLostAt) for (const botId of new Set(connection.grants.map((grant) => grant.botId))) await syncToolSignInNotices(botId);
  } catch (error) {
    console.error('[AppConnection] Could not clear the lost sign-in:', error instanceof Error ? error.message : 'unknown');
  }
}
