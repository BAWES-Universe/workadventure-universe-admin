import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { canManageBotMcpServers, preloadBotRules, type ManageMemo } from '@/lib/bot-permissions';
import { describeToolSignIn, type ToolSignInNoticeData } from '@/lib/tool-signin-words';
import { KEY_NO_ANSWER_HOLDS_MS } from '@/lib/app-same';

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
 * The connectors and the bot's maker who can still manage this bot's tools (the same rule the tools page and routes use).
 * Every connection's connector is checked, not only those signed out now: this runs before the lock, so a connection that
 * expires while another sync is running must already have its person in the set, or that sync would take their card down.
 */
async function peopleWhoCanManageTools(botId: string): Promise<Set<string>> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { id: true, createdById: true, roomId: true, ownerId: true, deletedAt: true, mcpServers: { select: { connectedById: true, connection: { select: { connectedById: true } } } } },
  });
  if (!bot) return new Set();
  const candidates = new Set([bot.createdById, ...bot.mcpServers.map((server) => server.connection?.connectedById ?? server.connectedById)].filter((id): id is string => !!id));
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
export async function syncToolSignInNotices(botId: string, fresh?: { serverId: string; at: Date }): Promise<boolean> {
  try {
    // Who may be told is worked out first, outside the lock: it reads roles and rules, not the notices
    const mayBeTold = await peopleWhoCanManageTools(botId);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${TOOL_SIGNIN_KIND}:${botId}`}))`;
      const bot = await tx.bot.findUnique({
        where: { id: botId },
        select: { id: true, name: true, createdById: true, room: { select: { world: { select: { universe: { select: { name: true } } } } } } },
      });
      // A grant on a person's connection is down when its connection is: the app's own fields are the ones read (game #2001)
      const downRows = bot
        ? await tx.botMcpServer.findMany({
            where: { botId, OR: [{ signInLostAt: { not: null }, connectionId: null }, { connection: { signInLostAt: { not: null } } }] },
            select: { id: true, name: true, authType: true, signInLostAt: true, connectedById: true, connectionId: true, connection: { select: { name: true, authType: true, kind: true, signInLostAt: true, connectedById: true, ownerId: true } } },
          })
        : [];
      const lost = downRows
        .map((row) => (row.connection ? { id: row.id, name: row.connection.name, authType: row.connection.authType, direct: row.connection.kind === 'direct', signInLostAt: row.connection.signInLostAt, connectedById: row.connection.connectedById, keyOwnerId: row.connection.ownerId } : row))
        .filter((row) => row.signInLostAt !== null)
        .sort((a, b) => (a.signInLostAt as Date).getTime() - (b.signInLostAt as Date).getTime());
      const byPerson = new Map<string, typeof lost>();
      for (const server of lost) {
        // The one who connected it; the bot's maker when that person can no longer manage it (or never was recorded). A key belongs to
        // the person who gave it and only they can replace it, so its card goes to them alone: the maker could not do what it asks
        const candidates = 'direct' in server && server.direct ? [server.keyOwnerId] : [server.connectedById, bot?.createdById];
        const person = candidates.find((candidate): candidate is string => !!candidate && mayBeTold.has(candidate));
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
            kind: 'direct' in server && server.direct ? 'direct' : server.authType === 'oauth' ? 'oauth' : server.authType === 'none' ? 'open' : 'key',
            at: (server.signInLostAt as Date).toISOString(),
          })),
        };
        const words = describeToolSignIn(data);
        const href = data.servers.some((server) => server.kind !== 'oauth' && server.kind !== 'direct') ? `/admin/bots/${botId}/mcp-servers` : null;
        const existing = open.find((notice) => notice.userId === userId);
        const fields = { title: words.title.slice(0, 200), body: words.body.slice(0, 1000), badge: words.badge, href, data: data as unknown as Prisma.InputJsonValue };
        if (existing) {
          await tx.userNotice.update({ where: { id: existing.id }, data: fields });
        } else if (fresh && servers.some((server) => server.id === fresh.serverId && (server.signInLostAt as Date).getTime() === fresh.at.getTime())) {
          // Only for the outage that is still the current one: a tool that was connected again (or went down again) since `fresh` was read
          // is a different story and makes no card for this one
          // A card already there for that instant (one the person dismissed for that outage, or one made by a sync that ran first) is "already told": the
          // insert skips it inside the transaction, so it never aborts the rest of the work (a duplicate error would roll back every update and dismissal above)
          await tx.userNotice.createMany({
            data: [{ userId, kind: TOOL_SIGNIN_KIND, dedupeKey: `${TOOL_SIGNIN_KIND}:${botId}:${fresh.at.toISOString()}`, ...fields }],
            skipDuplicates: true,
          });
        }
      }
    });
    return true;
  } catch (error) {
    // Any failure is reported, and the state is saved either way. False says it did not finish (everything the transaction did is undone), so the
    // caller's marker stays and the next report for the same sign-in tries the cards again. A card made twice for the same instant is not a failure:
    // the insert skips it (see above)
    Sentry.captureException(error, { tags: { area: 'tool-signin' } });
    console.error('[ToolSignIn] Could not update the notices:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

/**
 * Brings the cards of one bot's server in line with its saved state when a change of it (a loss, a clear) left them pending: the
 * marker is set in the same write as the change and cleared only once the card work finished, so a lookup or a write that failed after
 * the change is tried again by the next report, never skipped because the state already moved. Never throws.
 */
async function finishServerNotices(serverId: string): Promise<void> {
  try {
    const row = await prisma.botMcpServer.findUnique({ where: { id: serverId }, select: { botId: true, signInLostAt: true, noticesPendingAt: true } });
    if (!row?.noticesPendingAt) return;
    const done = await syncToolSignInNotices(row.botId, row.signInLostAt ? { serverId, at: row.signInLostAt } : undefined);
    if (done) await prisma.botMcpServer.updateMany({ where: { id: serverId, noticesPendingAt: row.noticesPendingAt }, data: { noticesPendingAt: null } });
  } catch (error) {
    console.error('[ToolSignIn] Could not finish the cards of a server:', error instanceof Error ? error.message : 'unknown');
  }
}

/** The same, for a connection: the cards of every Brick that uses it. Exported for the places that clear a connection's sign-in. Never throws. */
export async function finishConnectionNotices(connectionId: string): Promise<void> {
  try {
    const row = await prisma.appConnection.findUnique({ where: { id: connectionId }, select: { signInLostAt: true, noticesPendingAt: true } });
    if (!row?.noticesPendingAt) return;
    const rows = await prisma.botMcpServer.findMany({ where: { connectionId }, select: { id: true, botId: true } });
    let done = true;
    for (const server of rows) {
      if (!(await syncToolSignInNotices(server.botId, row.signInLostAt ? { serverId: server.id, at: row.signInLostAt } : undefined))) done = false;
    }
    if (done) await prisma.appConnection.updateMany({ where: { id: connectionId, noticesPendingAt: row.noticesPendingAt }, data: { noticesPendingAt: null } });
  } catch (error) {
    console.error('[ToolSignIn] Could not finish the cards of a connection:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * The bot server's report. "expired" keeps the first time it was seen (the "since"), "no-answer" does too and never
 * replaces an expired sign-in, "ok" clears both. A failure seen before the tool was last connected again is old news (a
 * call that started before the reconnect and reported after it) and changes nothing. `changed` is true only when what is
 * stored moved. Null when the bot has no such server.
 */
export async function reportToolSignIn(botId: string, serverId: string, report: ToolSignInReport): Promise<{ changed: boolean } | null> {
  const server = await prisma.botMcpServer.findFirst({ where: { id: serverId, botId }, select: { id: true, connectionId: true } });
  if (!server) return null;
  const at = clampAt(report.at);
  // A grant on a person's connection reports on the connection, so one Reconnect fixes every Brick that uses it (game #2001)
  if (server.connectionId) return reportConnectionSignIn(server.connectionId, report, at);
  const afterLastReconnect = { OR: [{ reconnectedAt: null }, { reconnectedAt: { lt: at } }] };

  if (report.state === 'expired') {
    const result = await prisma.botMcpServer.updateMany({
      where: { id: serverId, botId, signInLostAt: null, ...afterLastReconnect },
      data: { signInLostAt: at, signInLostStatus: report.status ?? null, noAnswerAt: null, noticesPendingAt: new Date() },
    });
    // Also when nothing changed: the cards of an earlier report of this same loss may not have finished
    await finishServerNotices(serverId);
    return { changed: result.count === 1 };
  }

  if (report.state === 'no-answer') {
    const result = await prisma.botMcpServer.updateMany({
      where: { id: serverId, botId, signInLostAt: null, noAnswerAt: null, ...afterLastReconnect },
      data: { noAnswerAt: at },
    });
    await finishServerNotices(serverId);
    return { changed: result.count === 1 };
  }

  // The moment the tool was seen working is kept first, like a reconnect and only ever moving forward: a failure seen before it
  // that reports after it is old news from here on, even if it arrives between these two writes
  await prisma.botMcpServer.updateMany({ where: { id: serverId, botId, ...afterLastReconnect }, data: { reconnectedAt: at } });
  // It clears only what went down before it was seen working: a failure seen after it is newer news
  const lost = await prisma.botMcpServer.updateMany({
    where: { id: serverId, botId, signInLostAt: { lte: at } },
    data: { signInLostAt: null, signInLostStatus: null, noAnswerAt: null, noticesPendingAt: new Date() },
  });
  const unanswered = lost.count === 1 ? { count: 0 } : await prisma.botMcpServer.updateMany({ where: { id: serverId, botId, noAnswerAt: { lte: at } }, data: { noAnswerAt: null } });
  await finishServerNotices(serverId);
  return { changed: lost.count === 1 || unanswered.count === 1 };
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
    // never keep a working sign-in marked as lost. The time is kept even when nothing was down: a failure that a call saw
    // before this moment and reports after it must not start an outage on a tool that has just been connected.
    await prisma.botMcpServer.update({
      where: { id: serverId },
      data: wasDown ? { signInLostAt: null, signInLostStatus: null, noAnswerAt: null, reconnectedAt: new Date(), ...(server.signInLostAt ? { noticesPendingAt: new Date() } : {}) } : { reconnectedAt: new Date() },
    });
    if (personId) {
      await prisma.botMcpServer.update({ where: { id: serverId }, data: { connectedById: personId } }).catch((error) => {
        console.warn('[ToolSignIn] Could not remember who connected it:', error instanceof Error ? error.message : 'unknown');
      });
    }
    if (server.signInLostAt) await finishServerNotices(serverId);
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
    const bots = await prisma.bot.findMany({ where: { id: { in: open.map((notice) => botIdOf(notice.dedupeKey)) } }, select: { id: true, createdById: true, roomId: true, ownerId: true, deletedAt: true } });
    const email = bots.length > 0 ? ((await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email ?? null) : null;
    // One person, one request: their standing in a room is worked out once, and the bots' rules are read in one query
    const memo: ManageMemo = new Map();
    await preloadBotRules(memo, bots.map((bot) => bot.id));
    const mayAct = new Map<string, boolean>();
    for (const bot of bots) mayAct.set(bot.id, await canManageBotMcpServers(userId, email, bot, memo));
    const gone = open.filter((notice) => !mayAct.get(botIdOf(notice.dedupeKey))).map((notice) => notice.id);
    if (gone.length > 0) await prisma.userNotice.updateMany({ where: { userId, id: { in: gone }, dismissedAt: null }, data: { dismissedAt: new Date() } });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'tool-signin' } });
    console.error('[ToolSignIn] Could not check the cards for deleted bots:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * A good answer from a key: clears a "stopped working" mark, but only when the key is still the one that was used (a late answer from a
 * key that has been replaced says nothing about the new one) and only when the connection is marked right now (not as it was when the
 * call began, since another call may have reported a refusal in between).
 *
 * Every good answer is written down, as the moment the key was seen working, so a refusal seen before it that reports after it is old news
 * however close the two were (a write only once in a while would leave the moment of an earlier answer, and a refusal between the two would
 * count as the newest word). It is written first, then anything marked lost that is not newer than it is cleared in what is saved now: a
 * refusal that was saved between the read above and these writes is cleared, and one that comes after is refused by its own check.
 */
export async function reportKeyWorked(connectionId: string, keyVersion: number, now: Date = new Date()): Promise<void> {
  const row = await prisma.appConnection.findUnique({ where: { id: connectionId }, select: { keyVersion: true, signInLostAt: true, noticesPendingAt: true } });
  if (!row || row.keyVersion !== keyVersion) return;
  if (row.signInLostAt) {
    await reportConnectionSignIn(connectionId, { state: 'ok' }, now, keyVersion);
    return;
  }
  await prisma.appConnection.updateMany({ where: { id: connectionId, keyVersion, OR: [{ lastWorkedAt: null }, { lastWorkedAt: { lt: now } }] }, data: { lastWorkedAt: now } });
  const [lost] = await Promise.all([
    prisma.appConnection.updateMany({
      where: { id: connectionId, keyVersion, signInLostAt: { lte: now } },
      data: { signInLostAt: null, signInLostStatus: null, noAnswerAt: null, noticesPendingAt: new Date() },
    }),
    prisma.appConnection.updateMany({ where: { id: connectionId, keyVersion, signInLostAt: null, noAnswerAt: { lte: now } }, data: { noAnswerAt: null } }),
  ]);
  // The cards of a loss cleared here, and of an earlier change that did not finish, are finished now
  if (lost.count === 1 || row.noticesPendingAt) await finishConnectionNotices(connectionId);
}

/**
 * A key App's service did not answer a call Orbit made with the key (no answer in time, or it could not be reached). Written on the App, as a
 * "no-answer" report is, and also over a mark older than KEY_NO_ANSWER_HOLDS_MS: that mark no longer holds (lib/app-same.ts ownCopyWorks), so
 * a service still down when it is tried again starts a new while. Never over a refused key, and never for a call that started before the key
 * was replaced or before a call that worked. Never throws.
 */
export async function reportKeyNoAnswer(connectionId: string, at: Date): Promise<void> {
  await prisma.appConnection
    .updateMany({
      where: {
        id: connectionId,
        kind: 'direct',
        signInLostAt: null,
        OR: [{ noAnswerAt: null }, { noAnswerAt: { lt: new Date(at.getTime() - KEY_NO_ANSWER_HOLDS_MS) } }],
        AND: [{ OR: [{ reconnectedAt: null }, { reconnectedAt: { lt: at } }] }, { OR: [{ lastWorkedAt: null }, { lastWorkedAt: { lt: at } }] }],
      },
      data: { noAnswerAt: at },
    })
    .catch((error) => console.error('[ToolSignIn] Could not write that a key App did not answer:', error instanceof Error ? error.message : 'unknown'));
}

/** The same report, for the connection a grant belongs to: its fields move, and the cards of every Brick that uses it follow. */
export async function reportConnectionSignIn(connectionId: string, report: ToolSignInReport, at: Date, onlyKeyVersion?: number): Promise<{ changed: boolean }> {
  const result = await applyConnectionReport(connectionId, report, at, onlyKeyVersion);
  // The cards follow what is saved, and a change whose cards did not finish (the lookup of the Bricks failed after the state moved) is
  // finished by the next report, whether or not that report changes anything
  await finishConnectionNotices(connectionId);
  return result;
}

async function applyConnectionReport(connectionId: string, report: ToolSignInReport, at: Date, onlyKeyVersion?: number): Promise<{ changed: boolean }> {
  // A failure is old news when the tool was connected again, or a call with the current key worked, after it was seen
  const afterLastReconnect = { AND: [{ OR: [{ reconnectedAt: null }, { reconnectedAt: { lt: at } }] }, { OR: [{ lastWorkedAt: null }, { lastWorkedAt: { lt: at } }] }] };

  if (report.state === 'expired') {
    const result = await prisma.appConnection.updateMany({
      where: { id: connectionId, signInLostAt: null, ...afterLastReconnect },
      data: { signInLostAt: at, signInLostStatus: report.status ?? null, noAnswerAt: null, noticesPendingAt: new Date() },
    });
    return { changed: result.count === 1 };
  }
  if (report.state === 'no-answer') {
    const result = await prisma.appConnection.updateMany({
      where: { id: connectionId, signInLostAt: null, noAnswerAt: null, ...afterLastReconnect },
      data: { noAnswerAt: at },
    });
    return { changed: result.count === 1 };
  }
  // A success of one key says nothing about another: when it names the key it used, only that key's connection is written (the owner
  // may have replaced it, and the new key may have a refusal of its own, since the success was read)
  const ofKey = onlyKeyVersion === undefined ? {} : { keyVersion: onlyKeyVersion };
  await prisma.appConnection.updateMany({ where: { id: connectionId, ...ofKey, OR: [{ reconnectedAt: null }, { reconnectedAt: { lt: at } }] }, data: { reconnectedAt: at } });
  // A key that worked is written down as such, so a refusal seen before it that reports after it is old news
  if (onlyKeyVersion !== undefined) await prisma.appConnection.updateMany({ where: { id: connectionId, ...ofKey, OR: [{ lastWorkedAt: null }, { lastWorkedAt: { lt: at } }] }, data: { lastWorkedAt: at } });
  const lost = await prisma.appConnection.updateMany({
    where: { id: connectionId, ...ofKey, signInLostAt: { lte: at } },
    data: { signInLostAt: null, signInLostStatus: null, noAnswerAt: null, noticesPendingAt: new Date() },
  });
  const unanswered = lost.count === 1 ? { count: 0 } : await prisma.appConnection.updateMany({ where: { id: connectionId, ...ofKey, noAnswerAt: { lte: at } }, data: { noAnswerAt: null } });
  return { changed: lost.count === 1 || unanswered.count === 1 };
}
