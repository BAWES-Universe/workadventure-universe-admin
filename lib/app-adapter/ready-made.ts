import { prisma } from '@/lib/db';
import { getAdapter, AdapterError, type LinkAnswer } from '@/lib/app-adapter';
import { readReadyMadeApps } from '@/lib/app-adapter/settings';
import { createConnection } from '@/lib/app-connections';
import { confirmReadyMade } from '@/lib/app-adapter/confirm';
import { getMeterSettings, recordMeterEvent } from '@/lib/meter';
import { APP_USE_MICROS_DEFAULT, personKeyOf } from '@/lib/meter-values';

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
  const existing = await prisma.appConnection.findFirst({ where: { ownerId, providerToolkit: key } });
  if (existing) return restartIfNotSignedIn(ownerId, existing, key, returnUrl, adapter);

  const start = await adapter.startConnect({ person: ownerId, toolkit: key, returnUrl });
  const link = await adapter.appLink({ person: ownerId, toolkits: [key] });
  try {
    const connection = await createConnection(ownerId, {
      name: app.name,
      serverUrl: link.url,
      authType: Object.keys(link.headers).length > 0 ? 'api-key' : 'none',
      authConfig: undefined,
      headers: Object.keys(link.headers).length > 0 ? link.headers : undefined,
      source: 'ready_made',
      providerToolkit: key,
      providerAccountId: start.providerAccountId,
    });
    return { id: connection.id, redirectUrl: start.redirectUrl, created: true };
  } catch (error) {
    // Two taps at once: the other one made it
    const again = await prisma.appConnection.findFirst({ where: { ownerId, providerToolkit: key } });
    if (again) return { id: again.id, redirectUrl: null, created: false };
    throw error;
  }
}

async function restartIfNotSignedIn(
  ownerId: string,
  existing: { id: string; source: string; providerAccountId: string | null; providerConfirmedAt: Date | null; signInLostAt: Date | null },
  key: string,
  returnUrl: string,
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
): Promise<{ id: string; redirectUrl: string | null; created: false }> {
  // Signed in and not lost: nothing to do. A sign-in the bot server saw lost (`signInLostAt`) is asked for again even though it was
  // once confirmed, otherwise it could never be recovered.
  if (!existing.signInLostAt && (await confirmReadyMade(existing))) return { id: existing.id, redirectUrl: null, created: false };
  // Not signed in yet, or lost: a new sign-in replaces the old one, so a repeat tap always gets a page that works. What was seen
  // lost is cleared with it, and the app reads connected again only when the provider confirms the new sign-in.
  const start = await adapter.startConnect({ person: ownerId, toolkit: key, returnUrl });
  await prisma.appConnection.update({
    where: { id: existing.id },
    data: { providerAccountId: start.providerAccountId, providerConfirmedAt: null, signInLostAt: null, signInLostStatus: null, noAnswerAt: null },
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
    eventId: `app:${input.callId}`,
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
function linkJson(body: string): Record<string, unknown> | null {
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
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) {
      const found = attempt(line.slice(5).trim());
      if (found) return found;
    }
  }
  return null;
}

/**
 * "Test" on a ready-made app's grant: the link needs the provider key, which only Orbit holds, so the test goes through the adapter
 * (open a session, list the tools) instead of a plain request that the link would turn away with 401. Counts nothing: listing is not a use.
 */
export async function testReadyMade(connection: { id: string; source: string; serverUrl: string; providerAccountId: string | null; providerConfirmedAt: Date | null; providerToolkit: string | null }): Promise<ReadyMadeTestResult> {
  const adapter = getAdapter();
  const failed = (error: string, status: number | null = null): ReadyMadeTestResult => ({ success: false, toolCount: 0, toolNames: [], error, status });
  if (!adapter) return failed('This app is not available right now.');
  if (!(await confirmReadyMade(connection))) return failed('Reconnect required: the sign-in for this app is not finished.');
  try {
    const opened = await adapter.callLink({
      url: connection.serverUrl,
      message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'orbit', version: '1' } } },
      sessionId: null,
    });
    if (opened.status >= 400) return failed(`The app answered ${opened.status}.`, opened.status);
    await adapter.callLink({ url: connection.serverUrl, message: { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId: opened.sessionId });
    const listed = await adapter.callLink({ url: connection.serverUrl, message: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId: opened.sessionId });
    if (listed.status >= 400) return failed(`The app answered ${listed.status}.`, listed.status);
    const result = linkJson(listed.body)?.result as { tools?: unknown } | undefined;
    const names = Array.isArray(result?.tools) ? (result.tools as { name?: unknown }[]).map((tool) => tool.name).filter((name): name is string => typeof name === 'string') : [];
    return { success: true, toolCount: names.length, toolNames: names, status: listed.status };
  } catch (error) {
    console.error('[ReadyMade] Test failed:', error instanceof Error ? error.message : 'unknown');
    return failed('The app could not be reached.');
  }
}
