import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getAdapter, AdapterError, type LinkAnswer } from '@/lib/app-adapter';
import { readReadyMadeApps } from '@/lib/app-adapter/settings';
import { createConnection } from '@/lib/app-connections';
import { confirmReadyMade } from '@/lib/app-adapter/confirm';
import { getMeterSettings, recordMeterEvent } from '@/lib/meter';
import { APP_USE_MICROS_DEFAULT, personKeyOf } from '@/lib/meter-values';
import { truncateDetail } from '@/lib/mcp/test-result';

/**
 * Ready-made apps through the adapter (game #2001, step 8). Everything here answers "not there" while the adapter is off, which
 * is always until Khalid says otherwise, so nothing of it shows anywhere. Connecting an app never makes a computer.
 *
 * Which apps, and the adapter's sign-in setup for each, are a super admin setting (settings.ts), never in code.
 */

/** What a person may know of the ready-made apps: the name, and their own connection when they have one. Empty while the adapter is off. */
export async function listReadyMadeForPerson(ownerId: string): Promise<{ key: string; name: string; connectionId: string | null }[]> {
  if (!getAdapter()) return [];
  const [apps, mine] = await Promise.all([
    readReadyMadeApps(),
    prisma.appConnection.findMany({ where: { ownerId, providerToolkit: { not: null } }, select: { id: true, providerToolkit: true } }),
  ]);
  const connectionOf = new Map(mine.map((row) => [row.providerToolkit, row.id]));
  return apps.filter((app) => app.enabled).map((app) => ({ key: app.key, name: app.name, connectionId: connectionOf.get(app.key) ?? null }));
}

/**
 * "Connect" on a ready-made app: starts the person's sign-in on the provider's own page and makes the connection (theirs alone,
 * source `ready_made`), whose link is the person's own at the provider. Null when the adapter is off or the app is not listed or
 * is off: the same answer as an app that does not exist. Asked again, the person's existing connection is returned if they finished signing in; if they did not (they closed the page, or it expired), the
 * sign-in starts again and a fresh `redirectUrl` comes back for the same connection.
 */
export async function connectReadyMade(ownerId: string, key: string, returnUrl: string): Promise<{ id: string; redirectUrl: string | null; created: boolean } | null> {
  const adapter = getAdapter();
  if (!adapter) return null;
  const app = (await readReadyMadeApps()).find((entry) => entry.key === key && entry.enabled);
  if (!app) return null;
  // One person's connect of one app at a time: the lock is taken before looking for an existing connection and held until the
  // connection is saved, so a second tap at the same moment waits, then finds the first one's connection, instead of opening a
  // second account at the provider that nothing would ever use
  let createFailed = false;
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ready-made:${ownerId}:${key}`}, 0))`;
        const existing = await tx.appConnection.findFirst({ where: { ownerId, providerToolkit: key } });
        if (existing) return await restartIfNotSignedIn(ownerId, existing, key, returnUrl, adapter, tx, app.authConfigId);

        const start = await adapter.startConnect({ person: ownerId, toolkit: key, returnUrl, authConfigId: app.authConfigId });
        const link = await adapter.appLink({ person: ownerId, toolkits: [key], accounts: { [key]: start.providerAccountId } });
        try {
          const connection = await createConnection(ownerId, {
            name: app.name,
            serverUrl: link.url,
            // No sign-in method and no headers stored, ever: the link needs the provider key, which only Orbit holds and sends itself
            // (callLink), so it is never written to a row, a screen or the bot server
            authType: 'none',
            authConfig: undefined,
            source: 'ready_made',
            providerToolkit: key,
            providerAccountId: start.providerAccountId,
          }, tx);
          return { id: connection.id, redirectUrl: start.redirectUrl, created: true as boolean };
        } catch (error) {
          // A failed statement has already ended the transaction, so nothing more is read inside it: the error leaves, and the
          // lookup below runs after the rollback
          createFailed = true;
          throw error;
        }
      },
      { maxWait: 15_000, timeout: 90_000 },
    );
  } catch (error) {
    if (!createFailed) throw error;
    // Anything else that made it first (read outside the transaction, after it rolled back)
    const again = await prisma.appConnection.findFirst({ where: { ownerId, providerToolkit: key } });
    if (again) return { id: again.id, redirectUrl: null, created: false as boolean };
    throw error;
  }
}

async function restartIfNotSignedIn(
  ownerId: string,
  existing: { id: string; source: string; providerAccountId: string | null; providerConfirmedAt: Date | null; signInLostAt: Date | null },
  key: string,
  returnUrl: string,
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
  db: Prisma.TransactionClient | typeof prisma = prisma,
  authConfigId?: string | null,
): Promise<{ id: string; redirectUrl: string | null; created: false }> {
  // Signed in and not lost: nothing to do. A sign-in the bot server saw lost (`signInLostAt`) is asked for again even though it was
  // once confirmed, otherwise it could never be recovered.
  if (!existing.signInLostAt && (await confirmReadyMade(existing, db))) return { id: existing.id, redirectUrl: null, created: false };
  // Not signed in yet, or lost: a new sign-in replaces the old one, so a repeat tap always gets a page that works. What was seen
  // lost is cleared with it, and the app reads connected again only when the provider confirms the new sign-in. The app link is
  // made again for the new account, so it never reaches an older one the person still has at the provider, and a failure seen
  // before this moment cannot mark the new sign-in lost.
  const start = await adapter.startConnect({ person: ownerId, toolkit: key, returnUrl, authConfigId });
  const link = await adapter.appLink({ person: ownerId, toolkits: [key], accounts: { [key]: start.providerAccountId } });
  await db.appConnection.update({
    where: { id: existing.id },
    data: { serverUrl: link.url, providerAccountId: start.providerAccountId, providerConfirmedAt: null, signInLostAt: null, signInLostStatus: null, noAnswerAt: null, reconnectedAt: new Date() },
  });
  return { id: existing.id, redirectUrl: start.redirectUrl, created: false };
}

/**
 * The use is written to the meter. Paid by the universe: the cost is the super admin's setting while it has one, else the built-in
 * estimate (always `estimated`; the provider sends no cost back). The event id comes from the call's own id, so a retry never counts twice.
 */
async function meterUse(input: { botId: string; ownerId: string; toolkit: string; tool: string; callId: string }) {
  const settings = await getMeterSettings();
  // A saved price wins; with none, the built-in estimate: a use is never written free or with no cost
  const cost = settings.appUseMicros ?? APP_USE_MICROS_DEFAULT;
  return recordMeterEvent({
    // Per Brick: a call id is only known to be unique for the one that made it, so two Bricks never count as one call
    eventId: `app:${input.botId}:${input.callId}`,
    kind: 'app_use',
    pool: 'chat',
    occurredAt: new Date(),
    personKey: personKeyOf({ personId: input.ownerId }),
    personId: input.ownerId,
    botId: input.botId,
    brick: true,
    payerKind: 'universe',
    payerPersonId: null,
    route: 'app',
    jobId: null,
    quantity: 1,
    unit: 'use',
    costMicros: cost,
    basis: 'estimated',
    sourceRef: null,
    // What was asked is the person's: only which app and which tool, never the arguments
    detail: { toolkit: input.toolkit, tool: input.tool },
  });
}

/** Whether the app is on the list and not turned off: a super admin turning one off stops every use of it at once, connections included. */
async function appIsOn(toolkit: string): Promise<boolean> {
  return (await readReadyMadeApps()).some((app) => app.key === toolkit && app.enabled);
}

export type ReadyMadeLinkOutcome =
  | { status: 'done'; answer: LinkAnswer }
  | { status: 'off' | 'gone' | 'not_owner' | 'already_asked' | 'unavailable' | 'refused' };

/** What may be sent to an app link through Orbit: opening a session, listing tools, and running one (which is counted like a use). */
const LINK_METHODS = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);

/**
 * One message to the person's own app link, sent by Orbit with the provider key (never given to anyone else). Same rules as a use:
 * their own signed-in connection and Brick only. A `tools/call` is a use: it needs a call id and is written to the meter first, once
 * for each call id (this is also how the provider's code sandbox runs, as an action of the link). Nothing else is passed on.
 */
export async function linkReadyMade(input: { botId: string; connectionId: string; ownerId: string; message: Record<string, unknown>; sessionId: string | null; callId: string | null }): Promise<ReadyMadeLinkOutcome> {
  const adapter = getAdapter();
  if (!adapter) return { status: 'off' };
  const method = typeof input.message.method === 'string' ? input.message.method : '';
  if (!LINK_METHODS.has(method)) return { status: 'refused' };
  const connection = await prisma.appConnection.findFirst({ where: { id: input.connectionId, ownerId: input.ownerId, source: 'ready_made' } });
  if (!connection || !connection.providerToolkit) return { status: 'gone' };
  if (!(await appIsOn(connection.providerToolkit))) return { status: 'off' };
  if (!(await confirmReadyMade(connection))) return { status: 'unavailable' };
  const bot = await prisma.bot.findUnique({ where: { id: input.botId }, select: { roomId: true, ownerId: true } });
  if (!bot || bot.roomId !== null || bot.ownerId !== input.ownerId) return { status: 'not_owner' };
  if (method === 'tools/call') {
    const params = input.message.params && typeof input.message.params === 'object' ? (input.message.params as Record<string, unknown>) : {};
    if (typeof params.name !== 'string' || !params.name || !input.callId) return { status: 'refused' };
    const written = await meterUse({ botId: input.botId, ownerId: input.ownerId, toolkit: connection.providerToolkit, tool: params.name, callId: input.callId });
    if (!written.recorded) return { status: 'already_asked' };
  }
  try {
    return { status: 'done', answer: await adapter.callLink({ url: connection.serverUrl, message: input.message, sessionId: input.sessionId }) };
  } catch (error) {
    console.error('[ReadyMade] Link failed:', error instanceof AdapterError ? error.message : error instanceof Error ? error.message : 'unknown');
    return { status: 'unavailable' };
  }
}

export type ReadyMadeUseOutcome =
  | { status: 'done'; ok: boolean; data: unknown }
  | { status: 'off' | 'gone' | 'not_owner' | 'already_asked' | 'unavailable' };

/**
 * One use of a ready-made app for the person who owns it. The meter is written FIRST, under an event id taken from the call's
 * own id, so a retry never counts twice and never runs twice: a call id seen before answers `already_asked` and the provider is
 * not called again (an unclear outcome is looked up by the caller, never repeated). Paid by the universe: the cost is the super
 * admin's setting while it has one, else the built-in estimate (always `estimated`). Nothing is refused for the price.
 */
export async function useReadyMade(input: { botId: string; connectionId: string; ownerId: string; tool: string; arguments: Record<string, unknown>; callId: string }): Promise<ReadyMadeUseOutcome> {
  const adapter = getAdapter();
  if (!adapter) return { status: 'off' };
  const connection = await prisma.appConnection.findFirst({ where: { id: input.connectionId, ownerId: input.ownerId, source: 'ready_made' } });
  if (!connection || !connection.providerToolkit) return { status: 'gone' };
  if (!(await appIsOn(connection.providerToolkit))) return { status: 'off' };
  // Not signed in at the provider yet: nothing to use, and nothing is counted
  if (!(await confirmReadyMade(connection))) return { status: 'unavailable' };
  const bot = await prisma.bot.findUnique({ where: { id: input.botId }, select: { roomId: true, ownerId: true } });
  if (!bot || bot.roomId !== null || bot.ownerId !== input.ownerId) return { status: 'not_owner' };

  const written = await meterUse({ botId: input.botId, ownerId: input.ownerId, toolkit: connection.providerToolkit, tool: input.tool, callId: input.callId });
  if (!written.recorded) return { status: 'already_asked' };

  try {
    const result = await adapter.use({
      person: input.ownerId,
      toolkit: connection.providerToolkit,
      tool: input.tool,
      arguments: input.arguments,
      providerAccountId: connection.providerAccountId,
      callId: input.callId,
    });
    return { status: 'done', ok: result.ok, data: result.data };
  } catch (error) {
    if (error instanceof AdapterError) console.error('[ReadyMade] Provider failed:', error.message);
    else console.error('[ReadyMade] Could not use:', error instanceof Error ? error.message : 'unknown');
    return { status: 'unavailable' };
  }
}

export interface ReadyMadeTestResult {
  success: boolean;
  toolCount: number;
  toolNames: string[];
  error?: string;
  status?: number | null;
  statusText?: string | null;
  errorCode?: string | null;
  wwwAuthenticate?: string | null;
  errorBody?: string | null;
}

/** The JSON of a link's answer, which may be plain JSON or an event stream holding it. */
function linkJson(body: string, id?: number): Record<string, unknown> | null {
  const attempt = (text: string) => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const whole = attempt(body.trim());
  if (whole) return whole;
  // An event stream may carry notifications before the answer: the message that answers the question asked (its id) is the one wanted
  const messages: Record<string, unknown>[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) {
      const found = attempt(line.slice(5).trim());
      if (found) messages.push(found);
    }
  }
  if (id === undefined) return messages[0] ?? null;
  return messages.find((message) => message.id === id) ?? messages.find((message) => 'result' in message || 'error' in message) ?? null;
}

/** The text of a JSON-RPC error carried in an answer that came with a 2xx status, or null when there is none. */
function rpcError(body: string, id?: number): string | null {
  const error = linkJson(body, id)?.error;
  if (error === undefined || error === null) return null;
  const message = typeof error === 'object' ? (error as { message?: unknown }).message : error;
  return typeof message === 'string' && message ? (truncateDetail(message, 200) ?? 'the app refused') : 'the app refused';
}

/**
 * "Test" on a ready-made app's grant: the link needs the provider key, which only Orbit holds, so the test goes through the adapter
 * (open a session, list the tools) instead of a plain request that the link would turn away with 401. Counts nothing: listing is not a use.
 */
export async function testReadyMade(connection: { id: string; source: string; serverUrl: string; providerAccountId: string | null; providerConfirmedAt: Date | null; providerToolkit: string | null }): Promise<ReadyMadeTestResult> {
  const adapter = getAdapter();
  const failed = (error: string, status: number | null = null): ReadyMadeTestResult => ({ success: false, toolCount: 0, toolNames: [], error, status });
  if (!adapter) return failed('This app is not available right now.');
  if (!connection.providerToolkit || !(await appIsOn(connection.providerToolkit))) return failed('This app is not available right now.');
  if (!(await confirmReadyMade(connection))) return failed('Reconnect required: the sign-in for this app is not finished.');
  try {
    const opened = await adapter.callLink({
      url: connection.serverUrl,
      message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'orbit', version: '1' } } },
      sessionId: null,
    });
    if (opened.status >= 400) return failed(`The app answered ${opened.status}.`, opened.status);
    const openError = rpcError(opened.body, 1);
    if (openError) return failed(`Initialize error: ${openError}`, opened.status);
    await adapter.callLink({ url: connection.serverUrl, message: { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId: opened.sessionId });
    // Every page of the list of tools (ids 2, 3, ...): a long list comes in pages, each with the cursor of the next
    const names: string[] = [];
    const seenNames = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let lastStatus = opened.status;
    for (let page = 0; page < 20; page += 1) {
      const id = 2 + page;
      const listed = await adapter.callLink({ url: connection.serverUrl, message: { jsonrpc: '2.0', id, method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) }, sessionId: opened.sessionId });
      lastStatus = listed.status;
      if (listed.status >= 400) return failed(`The app answered ${listed.status}.`, listed.status);
      const listError = rpcError(listed.body, id);
      if (listError) return failed(`MCP error: ${listError}`, listed.status);
      const answer = linkJson(listed.body, id);
      // A 200 that is not an answer to the question is not a working app with no tools
      if (!answer || typeof answer.result !== 'object' || answer.result === null) return failed('The app did not answer the list of what it can do.', listed.status);
      // The answer to the list of tools has the list: no list is not an app with no tools (an empty list is)
      const result = answer.result as { tools?: unknown; nextCursor?: unknown };
      const tools = result.tools;
      if (!Array.isArray(tools) || tools.some((tool) => !tool || typeof tool !== 'object' || typeof (tool as { name?: unknown }).name !== 'string')) {
        return failed('The app did not answer the list of what it can do.', listed.status);
      }
      for (const tool of tools as { name: string }[]) {
        if (!seenNames.has(tool.name)) {
          seenNames.add(tool.name);
          names.push(tool.name);
        }
      }
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || seenCursors.has(result.nextCursor)) break;
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return { success: true, toolCount: names.length, toolNames: names, status: lastStatus };
  } catch (error) {
    console.error('[ReadyMade] Test failed:', error instanceof Error ? error.message : 'unknown');
    return failed('The app could not be reached.');
  }
}
