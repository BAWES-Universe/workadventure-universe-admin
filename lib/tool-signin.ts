import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
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

/**
 * Brings the notices of one bot in line with its connections that are signed out: one card per person and bot, a row per
 * connection, taken down when nothing is left (or when the bot or the connection is gone). A card is only made when `fresh`
 * (a connection that just went down) belongs to that person, so a dismissed card stays dismissed until another outage starts.
 * The person told is whoever connected it, or the bot's maker for connections made before that was kept.
 *
 * Runs one bot at a time (an advisory lock held for the transaction): a bot whose tools fail together reports them together,
 * and two syncs that each found no card would otherwise each make one.
 */
export async function syncToolSignInNotices(botId: string, fresh?: { serverId: string; at: Date }): Promise<void> {
  try {
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
        const person = server.connectedById ?? bot?.createdById;
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
            kind: server.authType === 'oauth' ? 'oauth' : 'key',
            at: (server.signInLostAt as Date).toISOString(),
          })),
        };
        const words = describeToolSignIn(data);
        const href = data.servers.some((server) => server.kind === 'key') ? `/admin/bots/${botId}/mcp-servers` : null;
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
    await prisma.botMcpServer.update({
      where: { id: serverId },
      data: {
        ...(personId ? { connectedById: personId } : {}),
        ...(wasDown ? { signInLostAt: null, signInLostStatus: null, noAnswerAt: null, reconnectedAt: new Date() } : {}),
      },
    });
    if (server.signInLostAt) await syncToolSignInNotices(server.botId);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'tool-signin' } });
    console.error('[ToolSignIn] Could not clear the lost sign-in:', error instanceof Error ? error.message : 'unknown');
  }
}
