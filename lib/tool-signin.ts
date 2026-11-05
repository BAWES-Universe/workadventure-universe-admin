import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { canManageBotMcpServers } from '@/lib/bot-permissions';
import { describeToolSignIn, type ToolSignInNoticeData } from '@/lib/tool-signin-words';

/**
 * A bot's tool sign-in that stopped working (game #1819).
 *
 * The bot server is the one that finds out: it gets a 401 or 403 from a tool server while a bot is using it. It tells Orbit
 * (the sign-in route), and Orbit keeps what it said on the connection, so the Tools row can say "Sign-in expired · since
 * 12:54 PM" without anyone pressing Test, and tells the person who connected it once on Orbit home. Reconnecting (a new
 * sign-in, key or token) clears it everywhere.
 */

export const TOOL_SIGNIN_KIND = 'tool-signin';

export type ToolSignInState = 'expired' | 'no-answer' | 'ok';

export interface ToolSignInReport {
  state: ToolSignInState;
  /** When the bot server saw it. A time in the future is taken as now. */
  at?: Date;
  /** 401 or 403, for "expired". */
  status?: number | null;
}

function clampAt(at: Date | undefined, now = new Date()): Date {
  if (!at || Number.isNaN(at.getTime()) || at.getTime() > now.getTime() + 60_000) return now;
  return at;
}

/** The connectors and the bot's maker who can still manage this bot's tools (the same rule the tools page and routes use). */
async function peopleWhoCanManageTools(botId: string): Promise<Set<string>> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { id: true, createdById: true, roomId: true, mcpServers: { where: { signInLostAt: { not: null } }, select: { connectedById: true } } },
  });
  if (!bot) return new Set();
  const candidates = new Set([bot.createdById, ...bot.mcpServers.map((server) => server.connectedById)].filter((id): id is string => !!id));
  const told = new Set<string>();
  for (const userId of candidates) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (await canManageBotMcpServers(userId, user?.email ?? null, bot)) told.add(userId);
  }
  return told;
}

/**
 * Brings the notices of one bot in line with its connections that are signed out: one card per person and bot, a row per
 * connection, taken down when nothing is left (or when the bot or the connection is gone). A card is only made when `fresh`
 * (a connection that just went down) belongs to that person, so a dismissed card stays dismissed until another outage starts.
 * The person told is whoever connected it, or the bot's maker for connections made before that was kept, and only while they
 * can still manage this bot's tools: someone who lost that access gets no card (and an open one is taken down).
 *
 * Runs one bot at a time (an advisory lock held for the transaction): a bot whose tools fail together reports them together,
 * and two syncs that each found no card would otherwise each make one.
 */
export async function syncToolSignInNotices(botId: string, fresh?: { serverId: string; at: Date }): Promise<void> {
  try {
    // Who may be told is worked out first, outside the lock: it reads roles and rules, not the notices
    const mayBeTold = await peopleWhoCanManageTools(botId);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${TOOL_SIGNIN_KIND}:${botId}`}))`;
      const bot = await tx.bot.findUnique({
        where: { id: botId },
        select: { id: true, name: true, createdById: true, room: { select: { world: { select: { universe: { select: { name: true } } } } } } },
      });
      const lost = bot
        ? await tx.botMcpServer.findMany({
            where: { botId, signInLostAt: { not: null } },
            select: { id: true, name: true, authType: true, signInLostAt: true, connectedById: true },
            orderBy: { signInLostAt: 'asc' },
          })
        : [];
      const byPerson = new Map<string, typeof lost>();
      for (const server of lost) {
        // The one who connected it; the bot's maker when that person can no longer manage it (or never was recorded)
        const person = [server.connectedById, bot?.createdById].find((candidate): candidate is string => !!candidate && mayBeTold.has(candidate));
        if (person) byPerson.set(person, [...(byPerson.get(person) ?? []), server]);
      }
      const open = await tx.userNotice.findMany({
        where: { kind: TOOL_SIGNIN_KIND, dedupeKey: { startsWith: `${TOOL_SIGNIN_KIND}:${botId}:` }, dismissedAt: null },
        select: { id: true, userId: true },
      });
      for (const notice of open) {
        if (!byPerson.has(notice.userId)) await tx.userNotice.updateMany({ where: { id: notice.id, dismissedAt: null }, data: { dismissedAt: new Date() } });
      }
      if (!bot) return;

      for (const [userId, servers] of byPerson) {
        const data: ToolSignInNoticeData = {
          botId,
          bot: bot.name,
          universe: bot.room?.world?.universe?.name ?? null,
          servers: servers.map((server) => ({
            id: server.id,
            name: server.name,
            kind: server.authType === 'oauth' ? 'oauth' : server.authType === 'none' ? 'open' : 'key',
            at: (server.signInLostAt as Date).toISOString(),
          })),
        };
        const words = describeToolSignIn(data);
        const href = data.servers.some((server) => server.kind !== 'oauth') ? `/admin/bots/${botId}/mcp-servers` : null;
        const existing = open.find((notice) => notice.userId === userId);
        const fields = { title: words.title.slice(0, 200), body: words.body.slice(0, 1000), badge: words.badge, href, data: data as unknown as Prisma.InputJsonValue };
        if (existing) {
          await tx.userNotice.update({ where: { id: existing.id }, data: fields });
        } else if (fresh && servers.some((server) => server.id === fresh.serverId)) {
          await tx.userNotice.create({
            data: { userId, kind: TOOL_SIGNIN_KIND, dedupeKey: `${TOOL_SIGNIN_KIND}:${botId}:${fresh.at.toISOString()}`, ...fields },
          });
        }
      }
    });
  } catch (error) {
    // A card made twice for the same instant (same key) is "already told"; any other failure is reported, and the state is
    // saved either way: a card left out of date is the smaller harm
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
    Sentry.captureException(error, { tags: { area: 'tool-signin' } });
    console.error('[ToolSignIn] Could not update the notices:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * The bot server's report. "expired" keeps the first time it was seen (the "since"), "no-answer" does too and never
 * replaces an expired sign-in, "ok" clears both. `changed` is true only when what is stored moved. Null when the bot has no
 * such server.
 */
export async function reportToolSignIn(botId: string, serverId: string, report: ToolSignInReport): Promise<{ changed: boolean } | null> {
  const server = await prisma.botMcpServer.findFirst({ where: { id: serverId, botId }, select: { id: true } });
  if (!server) return null;
  const at = clampAt(report.at);

  if (report.state === 'expired') {
    const result = await prisma.botMcpServer.updateMany({
      where: { id: serverId, botId, signInLostAt: null },
      data: { signInLostAt: at, signInLostStatus: report.status ?? null, noAnswerAt: null, reconnectedAt: null },
    });
    if (result.count === 1) await syncToolSignInNotices(botId, { serverId, at });
    return { changed: result.count === 1 };
  }

  if (report.state === 'no-answer') {
    const result = await prisma.botMcpServer.updateMany({
      where: { id: serverId, botId, signInLostAt: null, noAnswerAt: null },
      data: { noAnswerAt: at, reconnectedAt: null },
    });
    return { changed: result.count === 1 };
  }

  const result = await prisma.botMcpServer.updateMany({
    where: { id: serverId, botId, OR: [{ signInLostAt: { not: null } }, { noAnswerAt: { not: null } }] },
    data: { signInLostAt: null, signInLostStatus: null, noAnswerAt: null, reconnectedAt: null },
  });
  if (result.count === 1) await syncToolSignInNotices(botId);
  return { changed: result.count === 1 };
}

/**
 * Someone connected the tool again (a new sign-in, key or token): remember who, and when something was down, clear it at
 * once and take its card down. Never throws: the sign-in or the save has already gone through.
 */
export async function markToolReconnected(serverId: string, personId: string | null): Promise<void> {
  try {
    const server = await prisma.botMcpServer.findUnique({ where: { id: serverId }, select: { botId: true, signInLostAt: true, noAnswerAt: true } });
    if (!server) return;
    const wasDown = !!server.signInLostAt || !!server.noAnswerAt;
    // The clear comes first and on its own: remembering who connected it can fail (that account may be gone by now) and must
    // never keep a working sign-in marked as lost
    if (wasDown) {
      await prisma.botMcpServer.update({
        where: { id: serverId },
        data: { signInLostAt: null, signInLostStatus: null, noAnswerAt: null, reconnectedAt: new Date() },
      });
    }
    if (personId) {
      await prisma.botMcpServer.update({ where: { id: serverId }, data: { connectedById: personId } }).catch((error) => {
        console.warn('[ToolSignIn] Could not remember who connected it:', error instanceof Error ? error.message : 'unknown');
      });
    }
    if (server.signInLostAt) await syncToolSignInNotices(server.botId);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'tool-signin' } });
    console.error('[ToolSignIn] Could not clear the lost sign-in:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * Takes down this person's cards about bots they can no longer act on: bots that no longer exist, and bots whose tools they
 * can no longer manage (they lost Manage bots in the room, or left it). Deleting a bot or a connection runs the sync above,
 * but deleting a whole room, world or universe removes its bots in the database without it, and losing a role runs nothing
 * for the cards already made, so the cards are checked when Orbit home or the count reads them. Never throws: a card left
 * showing is the smaller harm.
 */
export async function dropOrphanedToolSignInNotices(userId: string): Promise<void> {
  try {
    const open = await prisma.userNotice.findMany({ where: { userId, kind: TOOL_SIGNIN_KIND, dismissedAt: null }, select: { id: true, dedupeKey: true } });
    if (open.length === 0) return;
    // The key is "tool-signin:<bot id>:<time>"
    const botIdOf = (key: string) => key.split(':')[1] ?? '';
    const bots = await prisma.bot.findMany({ where: { id: { in: open.map((notice) => botIdOf(notice.dedupeKey)) } }, select: { id: true, createdById: true, roomId: true } });
    const email = bots.length > 0 ? ((await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email ?? null) : null;
    const mayAct = new Map<string, boolean>();
    for (const bot of bots) mayAct.set(bot.id, await canManageBotMcpServers(userId, email, bot));
    const gone = open.filter((notice) => !mayAct.get(botIdOf(notice.dedupeKey))).map((notice) => notice.id);
    if (gone.length > 0) await prisma.userNotice.updateMany({ where: { userId, id: { in: gone }, dismissedAt: null }, data: { dismissedAt: new Date() } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'tool-signin' } });
    console.error('[ToolSignIn] Could not check the cards for deleted bots:', error instanceof Error ? error.message : 'unknown');
  }
}
