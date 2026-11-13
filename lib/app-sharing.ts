import { Prisma, type AppConnection, type BotMcpServer } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { endApprovalsForServers } from '@/lib/bot-actions';
import { canManageBotMcpServers } from '@/lib/bot-permissions';
import { lendAccess, lendAccessMany, lendableUniverses, type LendableUniverse } from '@/lib/ai-key-lend';
import { syncToolSignInNotices } from '@/lib/tool-signin';
import { addConnectionSchema, AppConnectionError, HEADINGS, NOT_FOUND, connectedState, type Heading } from '@/lib/app-connections';
import { encryptApiKey } from '@/lib/encryption';
import { botUniverseId, startOfDay, startOfMonth } from '@/lib/app-uses';
import { managesTeamApp } from '@/lib/app-team-access';
import { isAppLendable } from '@/lib/app-lendable';

/**
 * Lending an app to a universe, and a universe's own apps (game #2001 step 7, the approved mock "Lending Apps to a team").
 * An app works like an AI key (lib/ai-key-lend.ts): a person lends one of theirs to a universe where they can manage bots, with
 * limits, and takes it back at any time. Lending moves no bot: a person who manages a bot there lets that bot use it. A universe
 * can also own apps, with named managers, so they stay when someone leaves. No bot gets an app by default.
 */

/* ----------------------------------- lending ----------------------------------- */

export const lendInputSchema = z
  .object({
    universeId: z.string().min(1),
    /** Which of the four things bots there may use it for, or null for all four. */
    things: z.array(z.enum(HEADINGS)).min(1).max(HEADINGS.length).nullable().default(null),
    /** Uses a day there, for everyone in the universe together, or null for no limit. */
    usesPerDay: z.number().int().min(1).max(1_000_000).nullable().default(null),
  })
  .strict();

export const lendChangeSchema = z
  .object({
    things: z.array(z.enum(HEADINGS)).min(1).max(HEADINGS.length).nullable().optional(),
    usesPerDay: z.number().int().min(1).max(1_000_000).nullable().optional(),
  })
  .strict();

// Counted after the duplicates are gone: ['lookUp', 'lookUp', 'make', 'change'] is three headings, not all four
const uniqueThings = (things: Heading[] | null | undefined): Heading[] | null => {
  if (!things) return null;
  const kept = HEADINGS.filter((heading) => things.includes(heading));
  return kept.length === HEADINGS.length ? null : kept;
};

export type LendResult = 'not_found' | 'not_lendable' | 'no_access';

/** The universes this person could lend this app to, or [] when it cannot be lent at all. */
export async function lendTargets(ownerId: string, connectionId: string): Promise<LendableUniverse[]> {
  const connection = await prisma.appConnection.findFirst({ where: { id: connectionId, ownerId } });
  if (!connection || !isAppLendable(connection)) return [];
  return lendableUniverses(ownerId);
}

/** Lends (or, if already lent there, changes the limits of the lend). Lending moves no bot. */
export async function lendApp(ownerId: string, connectionId: string, input: z.infer<typeof lendInputSchema>) {
  const connection = await prisma.appConnection.findFirst({ where: { id: connectionId, ownerId } });
  if (!connection) return 'not_found' as const;
  if (!isAppLendable(connection)) return 'not_lendable' as const;
  if (!(await lendAccess(ownerId, input.universeId))) return 'no_access' as const;
  const data = { things: uniqueThings(input.things) ?? Prisma.JsonNull, usesPerDay: input.usesPerDay };
  return prisma.appLend.upsert({
    where: { connectionId_universeId: { connectionId, universeId: input.universeId } },
    create: { connectionId, universeId: input.universeId, lentById: ownerId, ...data },
    update: data,
  });
}

export async function changeLend(ownerId: string, connectionId: string, universeId: string, patch: z.infer<typeof lendChangeSchema>) {
  const connection = await prisma.appConnection.findFirst({ where: { id: connectionId, ownerId } });
  if (!connection) return null;
  const data: Prisma.AppLendUpdateManyMutationInput = {};
  if (patch.things !== undefined) data.things = uniqueThings(patch.things) ?? Prisma.JsonNull;
  if (patch.usesPerDay !== undefined) data.usesPerDay = patch.usesPerDay;
  const done = await prisma.appLend.updateMany({ where: { connectionId, universeId }, data });
  if (done.count === 0) return null;
  return prisma.appLend.findUnique({ where: { connectionId_universeId: { connectionId, universeId } } });
}

/**
 * "Take it back": every bot there stops at once, in open chats too (the grants and the approvals for them go in the same step as
 * the lend), and lending again later does not give it back to them: each bot's maker lets it use it again. True when it was lent.
 */
export async function takeBack(ownerId: string, connectionId: string, universeId: string): Promise<boolean> {
  const connection = await prisma.appConnection.findFirst({ where: { id: connectionId, ownerId } });
  if (!connection) return false;
  const bots = await prisma.$transaction(async (tx) => {
    // The lend's row is held first: a bot being let use it at this moment (which holds the same row shared) finishes before the
    // grants are read, and one that starts after finds the lend gone, so no grant is left without a lend
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "app_lends" WHERE "connection_id" = ${connectionId} AND "universe_id" = ${universeId} FOR UPDATE`;
    const lend = locked[0];
    if (!lend) return null;
    const rows = await tx.botMcpServer.findMany({ where: { connectionId, bot: { room: { world: { universeId } } } }, select: { id: true, botId: true } });
    await endApprovalsForServers(tx, rows.map((row) => row.id));
    await tx.botMcpServer.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    await tx.appLend.delete({ where: { id: lend.id } });
    return [...new Set(rows.map((row) => row.botId))];
  });
  if (!bots) return false;
  for (const botId of bots) await syncToolSignInNotices(botId);
  return true;
}

export interface LentTo {
  universeId: string;
  universeName: string;
  /** Null when bots there may use it for all four things. */
  things: Heading[] | null;
  usesPerDay: number | null;
  usedToday: number;
  bots: { botId: string; botName: string; serverId: string; enabled: boolean; usesThisMonth: number }[];
}

/** Where one of the person's apps is lent, with each bot there that uses it and how much. */
export async function lentTo(connectionId: string): Promise<LentTo[]> {
  const lends = await prisma.appLend.findMany({ where: { connectionId }, include: { universe: { select: { name: true } } }, orderBy: { createdAt: 'asc' } });
  const out: LentTo[] = [];
  for (const lend of lends) {
    const [grants, byBot, today] = await Promise.all([
      prisma.botMcpServer.findMany({
        where: { connectionId, bot: { deletedAt: null, room: { world: { universeId: lend.universeId } } } },
        select: { id: true, botId: true, enabled: true, bot: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.appUse.groupBy({ by: ['botId'], where: { connectionId, universeId: lend.universeId, usedAt: { gte: startOfMonth() } }, _count: { _all: true } }),
      prisma.appUse.count({ where: { connectionId, universeId: lend.universeId, usedAt: { gte: startOfDay() } } }),
    ]);
    const used = new Map(byBot.map((row) => [row.botId, row._count._all]));
    out.push({
      universeId: lend.universeId,
      universeName: lend.universe.name,
      things: Array.isArray(lend.things) ? (lend.things as Heading[]) : null,
      usesPerDay: lend.usesPerDay,
      usedToday: today,
      bots: grants.map((grant) => ({ botId: grant.botId, botName: grant.bot.name, serverId: grant.id, enabled: grant.enabled, usesThisMonth: used.get(grant.botId) ?? 0 })),
    });
  }
  return out;
}

/* ------------------------------- a universe's own apps ------------------------------- */

export const teamAppSchema = addConnectionSchema;

/** The universes where this person can manage bots, i.e. where they can see and add a universe's own apps. */
export const myUniverses = (userId: string) => lendableUniverses(userId);

/**
 * Connects an app that belongs to a universe, not to one person. The one who connects it becomes its manager; the app stays when
 * they leave. Needs Manage bots there.
 */
export async function createTeamApp(userId: string, universeId: string, input: z.infer<typeof addConnectionSchema>): Promise<AppConnection | null> {
  if (!(await lendAccess(userId, universeId))) return null;
  return prisma.$transaction(async (tx) => {
    const connection = await tx.appConnection.create({
      data: {
        ownerId: null,
        universeId,
        connectedById: userId,
        name: input.name,
        serverUrl: input.serverUrl,
        authType: input.authType,
        authConfig: input.authConfig ? encryptApiKey(input.authConfig) : null,
        headers: input.headers ?? undefined,
        source: 'link',
      },
    });
    await tx.appConnectionManager.create({ data: { connectionId: connection.id, userId, addedById: userId } });
    return connection;
  });
}

export interface Person {
  id: string;
  name: string;
}

export interface TeamAppView {
  id: string;
  name: string;
  universeId: string;
  universeName: string;
  authType: string;
  connected: boolean;
  reconnectRequired: boolean;
  signInLostAt: Date | null;
  connectedAt: Date;
  /** Who connected it, and whether they still manage it. When they do not, the app depends on someone who left and says so. */
  connectedBy: (Person & { stillManages: boolean; you: boolean }) | null;
  /** Everyone who manages it now: the universe's owner (`owner`, always, and not removable), and the named managers who still have Manage bots there. `you` marks the person asking. */
  managers: (Person & { owner: boolean; you: boolean })[];
  /** Bots of the universe that use it. */
  bots: { botId: string; botName: string; serverId: string; enabled: boolean }[];
  usesThisMonth: number;
  /** Whether the person asking manages it (the others do not see it at all). */
  youManage: boolean;
}

/** Everyone who manages this universe's own app right now. A named manager who lost Manage bots there is not one. */
export async function currentManagers(connectionId: string, universeId: string): Promise<Person[]> {
  const [universe, named] = await Promise.all([
    prisma.universe.findUnique({ where: { id: universeId }, select: { owner: { select: { id: true, name: true } } } }),
    prisma.appConnectionManager.findMany({ where: { connectionId }, select: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } }),
  ]);
  const people = new Map<string, Person>();
  if (universe) people.set(universe.owner.id, { id: universe.owner.id, name: universe.owner.name ?? 'Someone' });
  const stillManage = await lendAccessMany(named.map(({ user }) => user.id), universeId);
  for (const { user } of named) {
    if (!people.has(user.id) && stillManage.has(user.id)) people.set(user.id, { id: user.id, name: user.name ?? 'Someone' });
  }
  return [...people.values()];
}

export async function teamAppView(connection: AppConnection, viewerId: string): Promise<TeamAppView | null> {
  if (!connection.universeId) return null;
  const universeId = connection.universeId;
  const [universe, managers, grants, uses, connector] = await Promise.all([
    prisma.universe.findUnique({ where: { id: universeId }, select: { name: true, ownerId: true } }),
    currentManagers(connection.id, universeId),
    prisma.botMcpServer.findMany({
      where: { connectionId: connection.id, bot: { deletedAt: null } },
      select: { id: true, botId: true, enabled: true, bot: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.appUse.count({ where: { connectionId: connection.id, universeId, usedAt: { gte: startOfMonth() } } }),
    connection.connectedById ? prisma.user.findUnique({ where: { id: connection.connectedById }, select: { id: true, name: true } }) : null,
  ]);
  const state = connectedState(connection);
  return {
    id: connection.id,
    name: connection.name,
    universeId,
    universeName: universe?.name ?? '',
    authType: connection.authType,
    connected: state.connected,
    reconnectRequired: state.reconnectRequired || !!connection.signInLostAt,
    signInLostAt: connection.signInLostAt,
    connectedAt: connection.createdAt,
    connectedBy: connector ? { id: connector.id, name: connector.name ?? 'Someone', stillManages: managers.some((person) => person.id === connector.id), you: connector.id === viewerId } : null,
    managers: managers.map((person) => ({ ...person, owner: person.id === universe?.ownerId, you: person.id === viewerId })),
    bots: grants.map((grant) => ({ botId: grant.botId, botName: grant.bot.name, serverId: grant.id, enabled: grant.enabled })),
    usesThisMonth: uses,
    youManage: managers.some((person) => person.id === viewerId),
  };
}

/** The universe's own apps this person manages, oldest first. Null when they cannot manage bots there at all. */
export async function listTeamApps(userId: string, universeId: string): Promise<TeamAppView[] | null> {
  if (!(await lendAccess(userId, universeId))) return null;
  const rows = await prisma.appConnection.findMany({ where: { universeId }, orderBy: { createdAt: 'asc' } });
  const views = await Promise.all(rows.map(async (row) => ((await managesTeamApp(userId, row)) ? teamAppView(row, userId) : null)));
  return views.filter((view): view is TeamAppView => view !== null);
}

/** One universe's own app, for a person who manages it; anyone else gets null, the same as an app that is not there. */
export async function readTeamApp(userId: string, connectionId: string): Promise<TeamAppView | null> {
  const connection = await prisma.appConnection.findUnique({ where: { id: connectionId } });
  if (!connection || !connection.universeId || !(await managesTeamApp(userId, connection))) return null;
  return teamAppView(connection, userId);
}

/** People who could be made a manager: those with Manage bots in the universe who are not managers yet. */
export async function managerCandidates(userId: string, connectionId: string): Promise<Person[] | null> {
  const connection = await prisma.appConnection.findUnique({ where: { id: connectionId } });
  if (!connection?.universeId || !(await managesTeamApp(userId, connection))) return null;
  const universeId = connection.universeId;
  const [universe, world, member, current] = await Promise.all([
    prisma.universe.findUnique({ where: { id: universeId }, select: { ownerId: true } }),
    prisma.worldMember.findMany({ where: { world: { universeId } }, select: { userId: true } }),
    prisma.universeMember.findMany({ where: { universeId }, select: { userId: true } }),
    currentManagers(connectionId, universeId),
  ]);
  const have = new Set(current.map((person) => person.id));
  const ids = [...new Set([universe?.ownerId, ...world.map((row) => row.userId), ...member.map((row) => row.userId)].filter((id): id is string => !!id))].filter((id) => !have.has(id));
  const eligible = await lendAccessMany(ids, universeId);
  const users = await prisma.user.findMany({ where: { id: { in: [...eligible] }, isGuest: false }, select: { id: true, name: true } });
  const out: Person[] = users.map((user) => ({ id: user.id, name: user.name ?? 'Someone' }));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A manager names another: someone who can manage bots in that universe. Asked twice, the same row. */
export async function addManager(actorId: string, connectionId: string, personId: string): Promise<'ok' | 'not_found' | 'not_eligible'> {
  const connection = await prisma.appConnection.findUnique({ where: { id: connectionId } });
  if (!connection?.universeId || !(await managesTeamApp(actorId, connection))) return 'not_found';
  if (!(await lendAccess(personId, connection.universeId))) return 'not_eligible';
  await prisma.appConnectionManager.upsert({
    where: { connectionId_userId: { connectionId, userId: personId } },
    create: { connectionId, userId: personId, addedById: actorId },
    update: {},
  });
  return 'ok';
}

/** A manager takes another off. The universe's owner always manages, so nobody can leave an app with no manager. */
export async function removeManager(actorId: string, connectionId: string, personId: string): Promise<boolean> {
  const connection = await prisma.appConnection.findUnique({ where: { id: connectionId } });
  if (!connection?.universeId || !(await managesTeamApp(actorId, connection))) return false;
  const done = await prisma.appConnectionManager.deleteMany({ where: { connectionId, userId: personId } });
  return done.count > 0;
}

/* ----------------------------------- bots there ----------------------------------- */

export interface AvailableApp {
  connectionId: string;
  name: string;
  /** "lent" is one of the asker's own apps lent to this universe; "team" is one the universe owns. */
  kind: 'lent' | 'team';
}

type RoomBot = { id: string; createdById: string | null; roomId: string | null; ownerId: string | null; deletedAt: Date | null };

async function roomBotOf(botId: string): Promise<RoomBot | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true, createdById: true, roomId: true, ownerId: true, deletedAt: true } });
  return bot && bot.roomId !== null && bot.deletedAt === null ? bot : null;
}

async function mayManageBot(userId: string, bot: RoomBot): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return canManageBotMcpServers(userId, user?.email ?? null, bot);
}

/**
 * "More apps it can use here" on a bot's page: the asker's own apps lent to this bot's universe (they show only to the person who
 * lent them) and the universe's own apps they manage, that this bot does not use yet. Null when they cannot manage this bot.
 */
export async function availableForBot(userId: string, botId: string): Promise<AvailableApp[] | null> {
  const bot = await roomBotOf(botId);
  if (!bot || !(await mayManageBot(userId, bot))) return null;
  const universeId = await botUniverseId(botId);
  if (!universeId) return null;
  const [lent, team, used] = await Promise.all([
    prisma.appLend.findMany({ where: { universeId, connection: { ownerId: userId } }, select: { connection: { select: { id: true, name: true } } } }),
    prisma.appConnection.findMany({ where: { universeId }, select: { id: true, name: true, universeId: true } }),
    prisma.botMcpServer.findMany({ where: { botId, connectionId: { not: null } }, select: { connectionId: true } }),
  ]);
  const taken = new Set(used.map((row) => row.connectionId));
  const out: AvailableApp[] = lent.filter((row) => !taken.has(row.connection.id)).map((row) => ({ connectionId: row.connection.id, name: row.connection.name, kind: 'lent' as const }));
  for (const app of team) {
    if (taken.has(app.id) || !(await managesTeamApp(userId, app))) continue;
    out.push({ connectionId: app.id, name: app.name, kind: 'team' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * "Let Guide use it": a bot of the universe starts using an app lent there (by the asker) or the universe's own (which the asker
 * manages). The asker must manage the bot. Four headings start at today's defaults, so a change or a send still asks first.
 */
export async function grantSharedToBot(userId: string, connectionId: string, botId: string): Promise<BotMcpServer | null> {
  const bot = await roomBotOf(botId);
  if (!bot || !(await mayManageBot(userId, bot))) return null;
  const universeId = await botUniverseId(botId);
  const connection = await prisma.appConnection.findUnique({ where: { id: connectionId } });
  if (!universeId || !connection) return null;
  if (connection.universeId) {
    if (connection.universeId !== universeId || !(await managesTeamApp(userId, connection))) return null;
  } else {
    if (connection.ownerId !== userId) return null;
  }
  try {
    return await prisma.$transaction(async (tx) => {
      if (!connection.universeId) {
        // The lend is held shared while the grant is made, and taking it back holds it for update: one waits for the other, so a
        // grant is never made after the lend was taken back
        const lend = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "app_lends" WHERE "connection_id" = ${connectionId} AND "universe_id" = ${universeId} FOR SHARE`;
        if (lend.length === 0) return null;
      }
      return tx.botMcpServer.create({
        data: { botId, connectionId, name: connection.name, serverUrl: '', authType: 'none', connectedById: userId },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return prisma.botMcpServer.findFirst({ where: { botId, connectionId } });
    throw error;
  }
}

export { AppConnectionError, NOT_FOUND };
