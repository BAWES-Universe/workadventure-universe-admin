import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getAdapter, AdapterError, type LinkAnswer } from '@/lib/app-adapter';
import { readReadyMadeApps } from '@/lib/app-adapter/settings';
import { createConnection } from '@/lib/app-connections';
import { confirmReadyMade } from '@/lib/app-adapter/confirm';
import { getMeterSettings } from '@/lib/meter';
import { recordAppUseWithinCap } from '@/lib/app-use-cap';
import { personKeyOf } from '@/lib/meter-values';
import { priceCall } from '@/lib/composio-rates';
import { readComposioBilling } from '@/lib/composio-billing';
import { truncateDetail, MAX_TOOL_PAGES } from '@/lib/mcp/test-result';
import { linkJson } from '@/lib/app-adapter/link-json';
import { answerCodeJobCall, boundAppAnswer, isCodeJobTool, sandboxRefusal, withCodeJobTools } from '@/lib/workbench/link';
import { touchesSandbox } from '@/lib/workbench/values';
import { getGitHubApp } from '@/lib/github/app';
import { appCallIsPaused } from '@/lib/capability-pause';
import { routeForRun, type RunRoute } from '@/lib/app-routes';
import type { OwnAppVersion } from '@/lib/app-routes/own-versions';
import { actionJudgeFor } from '@/lib/app-actions/grant';
import { actionsOfCall, offActions, offWords, refusalAnswer, withoutOffActions } from '@/lib/app-actions/link-guard';

/**
 * Ready-made apps through the adapter (game #2001, step 8). Everything here answers "not there" while the adapter is off (no
 * COMPOSIO_API_KEY), so nothing of it shows anywhere until the key is set. Connecting an app never makes a computer.
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
  // Once Universe's own GitHub App is made, GitHub is connected through it (game #2041), not offered here any more
  const ownGitHub = !!(await getGitHubApp());
  return apps.filter((app) => app.enabled && !(ownGitHub && app.key === 'github')).map((app) => ({ key: app.key, name: app.name, connectionId: connectionOf.get(app.key) ?? null }));
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
  // Once Universe's own GitHub App is made, no NEW ready-made GitHub connection is started (game #2041); an older one is still
  // looked up below, so a person whose sign-in was lost can still recover it
  const ownGitHub = key === 'github' && !!(await getGitHubApp());
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
        if (ownGitHub) return null;

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
 * The use is written to the meter, first, under an event id taken from the call's own id (a retry never counts twice). Paid by the
 * universe, at the provider's own list price for what the call is (lib/composio-rates.ts): a search or lookup is free (written
 * with 0 and no tool run), a sandbox run and a tool run are priced by app, a batch is the sum of the tools inside it, and the
 * zero data retention add-on is counted where it covers, and a single run sent outside a session (`runReadyMade`) carries the direct execution add-on. The figure is always `estimated` (the provider sends no cost back); the
 * month's free calls and the plan's credit are taken off at the account level (lib/composio-billing.ts), not here. A price a super
 * admin saved (`appUseMicros`) replaces the list price of each paid step.
 */
async function meterUse(input: { botId: string; ownerId: string; toolkit: string; tool: string; arguments?: unknown; callId: string; direct?: boolean; route?: RunRoute }) {
  const [settings, app, billing] = await Promise.all([getMeterSettings(), readyMadeApp(input.toolkit), readComposioBilling()]);
  const priced = priceCall({ toolkit: input.toolkit, tool: input.tool, arguments: input.arguments, ownAuth: !!app?.authConfigId, zdrOn: billing.zdrOn, direct: input.direct === true });
  const steps = priced.executions + priced.sandboxRuns;
  // Which route this run takes (spec section 21), written on its line. What a PERSON is priced is never read from here: `listMicros`
  // is the same figure on either route, so a move changes only what the run costs us.
  const provider = input.route?.provider === 'universe' ? 'universe' : 'composio';
  const ownTop = input.route?.provider === 'universe' ? input.route.own?.topPriceMicros ?? null : null;
  const cost = provider === 'universe' ? (ownTop === null ? null : steps * ownTop) : settings.appUseMicros === null ? priced.listMicros : steps * settings.appUseMicros;
  const eventId = `app:${input.botId}:${input.callId}`;
  const recorded = await recordAppUseWithinCap({
    // Per Brick: a call id is only known to be unique for the one that made it, so two Bricks never count as one call
    eventId,
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
    // A free lookup is not an app step: it is written (so a repeated call id is still refused) with quantity 0 and cost 0
    quantity: steps,
    unit: 'use',
    costMicros: cost,
    basis: 'estimated',
    sourceRef: null,
    // What was asked is the person's: which app and which tool, and how it was priced; never the arguments. The monthly bill reads these.
    detail: {
      toolkit: input.toolkit,
      tool: input.tool,
      kind: priced.kind,
      provider,
      listMicros: priced.listMicros,
      tier: priced.tier,
      tierVerified: priced.tierVerified,
      ownAuth: !!app?.authConfigId,
      executions: priced.executions,
      sandboxRuns: priced.sandboxRuns,
      zdrCalls: priced.zdrCalls,
      directCalls: priced.directCalls,
      ...(Object.keys(priced.inner).length > 0 ? { inner: priced.inner } : {}),
    },
  });
  return { ...recorded, eventId, provider: provider as 'composio' | 'universe', steps };
}

/**
 * How a run ended, written once beside its meter line (the books are never edited). Never a reason a run fails: if it cannot be
 * written the run's answer still goes back, and the demand page simply has no outcome for it.
 */
async function recordOutcome(eventId: string, appKey: string, provider: 'composio' | 'universe', ok: boolean): Promise<void> {
  try {
    await prisma.appUseOutcome.createMany({ data: [{ eventId, appKey, provider, outcome: ok ? 'ok' : 'failed' }], skipDuplicates: true });
  } catch (error) {
    console.error('[ReadyMade] Could not write how a run ended:', error instanceof Error ? error.message : 'unknown');
  }
}

/** The app as listed, or null when it is not on the list. */
async function readyMadeApp(toolkit: string) {
  return (await readReadyMadeApps()).find((app) => app.key === toolkit) ?? null;
}

/** Whether the app is on the list and not turned off: a super admin turning one off stops every use of it at once, connections included. */
async function appIsOn(toolkit: string): Promise<boolean> {
  return (await readyMadeApp(toolkit))?.enabled === true;
}

/** What a person is told when the month's spending stop holds a use back: plain words, and nothing was asked of the App. */
export const APP_STOPPED_WORDS = 'Apps are resting right now: the month’s limit for using them has been reached. Nothing was done. Try again later.';

export type ReadyMadeLinkOutcome =
  | { status: 'done'; answer: LinkAnswer }
  | { status: 'off' | 'gone' | 'not_owner' | 'already_asked' | 'unavailable' | 'refused' | 'paused' };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

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
  // The team paused Apps: a call (a use) is refused before it is counted or sent. Opening a session and listing what an App can do are not uses.
  if (method === 'tools/call' && (await appCallIsPaused(input.botId, input.callId))) return { status: 'paused' };
  const connection = await prisma.appConnection.findFirst({ where: { id: input.connectionId, ownerId: input.ownerId, source: 'ready_made' } });
  if (!connection || !connection.providerToolkit) return { status: 'gone' };
  if (!(await appIsOn(connection.providerToolkit))) return { status: 'off' };
  if (!(await confirmReadyMade(connection))) return { status: 'unavailable' };
  const bot = await prisma.bot.findUnique({ where: { id: input.botId }, select: { roomId: true, ownerId: true, name: true } });
  if (!bot || bot.roomId !== null || bot.ownerId !== input.ownerId) return { status: 'not_owner' };
  // What this Brick may do with each of the App's actions (lib/app-actions): read for a run and for what the App lists or looks up, so an
  // action that is Off never runs and is never shown. Opening a session needs none of it.
  const judge = method === 'tools/call' || method === 'tools/list' ? await actionJudgeFor(input.botId, input.connectionId) : null;
  // One route for the whole message, read once (see runReadyMade); our own version answers the link itself, never a mix of the two
  const toolkit = connection.providerToolkit;
  const route = await routeForRun(toolkit);
  if (route.provider === 'universe' && !route.own) return { status: 'unavailable' };
  let written: Awaited<ReturnType<typeof meterUse>> | null = null;
  let callParams: { name: string; arguments: Record<string, unknown> } | null = null;
  if (method === 'tools/call') {
    const params = input.message.params && typeof input.message.params === 'object' ? (input.message.params as Record<string, unknown>) : {};
    if (typeof params.name !== 'string' || !params.name || !input.callId) return { status: 'refused' };
    // Code runs only as a code job (lib/workbench): Orbit's own three tools are answered here, and the provider's own sandbox tools, alone or
    // inside a batch, are refused on every link (a run sent that way has no deadline, no Limits and no cancel, and could reach the person's accounts).
    // Neither is counted here: a job is counted once, when it ends, and a refusal runs nothing.
    if (isCodeJobTool(params.name)) {
      const answer = await answerCodeJobCall({
        botId: input.botId,
        personId: input.ownerId,
        connectionId: input.connectionId,
        toolkit,
        name: params.name,
        args: params.arguments,
        callId: input.callId,
        messageId: input.message.id,
        read: async ({ tool, arguments: args, callId }) => {
          const used = await runReadyMade({ botId: input.botId, connectionId: input.connectionId, ownerId: input.ownerId, tool, arguments: args, callId });
          return used.status === 'done' ? { ok: used.ok, data: used.data } : null;
        },
      });
      return { status: 'done', answer };
    }
    if (touchesSandbox(params.name, params.arguments)) return { status: 'done', answer: sandboxRefusal(input.message.id) };
    // An action that is Off for this Brick, alone or anywhere in a batch: nothing of the call runs and nothing is counted
    if (judge) {
      const off = offActions(judge, actionsOfCall(params.name, params.arguments));
      if (off.length > 0) return { status: 'done', answer: refusalAnswer(input.message.id, offWords(off, bot.name, connection.name)) };
    }
    callParams = { name: params.name, arguments: params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {} };
    written = await meterUse({ botId: input.botId, ownerId: input.ownerId, toolkit, tool: params.name, arguments: params.arguments, callId: input.callId, route });
    if (written.stopped) return { status: 'done', answer: stoppedAnswer(input.message.id) };
    if (!written.recorded) return { status: 'already_asked' };
  }
  try {
    const sent =
      route.provider === 'universe' && route.own
        ? await answerFromOwnVersion(route.own, input.message, callParams, { person: input.ownerId, providerAccountId: connection.providerAccountId, callId: input.callId ?? '' })
        : await adapter.callLink({ url: connection.serverUrl, message: input.message, sessionId: input.sessionId });
    // The list of tools: the provider's sandbox tools come out (a link made before code jobs may still list them) and the code job tools go in
    const listed = method === 'tools/list' ? await withCodeJobTools(sent, input.message.id, !(isObject(input.message.params) && typeof (input.message.params as { cursor?: unknown }).cursor === 'string')) : sent;
    // What the App lists and looks up never names an action that is Off for this Brick (a batch's own answer is left as it came)
    const answer = judge && !(callParams && actionsOfCall(callParams.name, callParams.arguments).length > 0) ? withoutOffActions(listed, input.message.id, judge) : listed;
    if (written) await recordOutcome(written.eventId, toolkit, written.provider, answer.status < 400 && !rpcError(answer.body, typeof input.message.id === 'number' || typeof input.message.id === 'string' ? input.message.id : undefined) && !/"isError"\s*:\s*true/.test(answer.body));
    // A big answer is never cut and never passed on half: the Brick is told it ran, how big it was, and what to do (already counted above)
    return { status: 'done', answer: callParams ? await boundAppAnswer(answer, input.message.id, callParams.name, callParams.arguments) : answer };
  } catch (error) {
    console.error('[ReadyMade] Link failed:', error instanceof AdapterError ? error.message : error instanceof Error ? error.message : 'unknown');
    if (written) await recordOutcome(written.eventId, toolkit, written.provider, false);
    return { status: 'unavailable' };
  }
}

/** The answer of a link to a call that was held back: a tool result that says so (an error the Brick reads and tells the person), as the link itself would send one. */
function stoppedAnswer(id: unknown): LinkAnswer {
  const body = { jsonrpc: '2.0', id: typeof id === 'number' || typeof id === 'string' ? id : null, result: { content: [{ type: 'text', text: APP_STOPPED_WORDS }], isError: true } };
  return { status: 200, contentType: 'application/json', sessionId: null, body: JSON.stringify(body) };
}

/**
 * The link's own protocol, answered by Universe's own version of the App: the same four messages the Composio link takes, and nothing more.
 * Our own version keeps no session, so it never gives a session id: one made up here could be sent back later to Composio's link, which
 * would refuse it.
 */
async function answerFromOwnVersion(
  own: OwnAppVersion,
  message: Record<string, unknown>,
  call: { name: string; arguments: Record<string, unknown> } | null,
  who: { person: string; providerAccountId: string | null; callId: string },
): Promise<LinkAnswer> {
  const reply = (body: Record<string, unknown> | null): LinkAnswer => ({ status: body ? 200 : 202, contentType: body ? 'application/json' : null, sessionId: null, body: body ? JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, ...body }) : '' });
  switch (message.method) {
    case 'initialize':
      return reply({ result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: `universe-${own.key}`, version: '1' } } });
    case 'tools/list':
      return reply({ result: { tools: own.tools().map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: { type: 'object' } })) } });
    case 'tools/call': {
      if (!call) return reply({ error: { code: -32602, message: 'No tool named' } });
      const result = await own.use({ person: who.person, tool: call.name, arguments: call.arguments, providerAccountId: who.providerAccountId, callId: who.callId });
      return reply({ result: { content: [{ type: 'text', text: JSON.stringify(result.data ?? null) }], isError: !result.ok } });
    }
    default:
      return reply(null);
  }
}

export type ReadyMadeUseOutcome =
  | { status: 'done'; ok: boolean; data: unknown }
  | { status: 'off' | 'gone' | 'not_owner' | 'already_asked' | 'unavailable' | 'paused' };

/**
 * One use of a ready-made app for the person who owns it. The meter is written FIRST, under an event id taken from the call's
 * own id, so a retry never counts twice and never runs twice: a call id seen before answers `already_asked` and the provider is
 * not called again (an unclear outcome is looked up by the caller, never repeated). Paid by the universe: the cost is the super
 * admin's setting while it has one, else the built-in estimate (always `estimated`). Nothing is refused for the price.
 */
export async function runReadyMade(input: { botId: string; connectionId: string; ownerId: string; tool: string; arguments: Record<string, unknown>; callId: string }): Promise<ReadyMadeUseOutcome> {
  const adapter = getAdapter();
  if (!adapter) return { status: 'off' };
  // The team paused Apps: nothing is counted or sent
  if (await appCallIsPaused(input.botId, input.callId)) return { status: 'paused' };
  const connection = await prisma.appConnection.findFirst({ where: { id: input.connectionId, ownerId: input.ownerId, source: 'ready_made' } });
  if (!connection || !connection.providerToolkit) return { status: 'gone' };
  if (!(await appIsOn(connection.providerToolkit))) return { status: 'off' };
  // Not signed in at the provider yet: nothing to use, and nothing is counted
  if (!(await confirmReadyMade(connection))) return { status: 'unavailable' };
  const bot = await prisma.bot.findUnique({ where: { id: input.botId }, select: { roomId: true, ownerId: true, name: true } });
  if (!bot || bot.roomId !== null || bot.ownerId !== input.ownerId) return { status: 'not_owner' };
  // The provider's own sandbox is never reached, here as on the link (alone or inside a batch): nothing is counted
  if (touchesSandbox(input.tool, input.arguments)) return { status: 'done', ok: false, data: { error: 'This App does not run code itself.' } };
  // An action that is Off for this Brick never runs, and nothing is counted
  const judge = await actionJudgeFor(input.botId, input.connectionId);
  if (judge) {
    const off = offActions(judge, actionsOfCall(input.tool, input.arguments));
    if (off.length > 0) return { status: 'done', ok: false, data: { error: offWords(off, bot.name, connection.name), off: off.map((verdict) => verdict.slug) } };
  }

  // The route is read once, here, and this run keeps it to the end (a move made meanwhile applies to the next run). Our own version
  // that is not there or not ready is a refusal, never a quiet run on Composio, which could bill a second time.
  const toolkit = connection.providerToolkit;
  const route = await routeForRun(toolkit);
  if (route.provider === 'universe' && !route.own) return { status: 'unavailable' };

  const written = await meterUse({ botId: input.botId, ownerId: input.ownerId, toolkit, tool: input.tool, arguments: input.arguments, callId: input.callId, direct: true, route });
  if (written.stopped) return { status: 'done', ok: false, data: { error: APP_STOPPED_WORDS, stopped: true } };
  if (!written.recorded) return { status: 'already_asked' };

  try {
    const request = { person: input.ownerId, tool: input.tool, arguments: input.arguments, providerAccountId: connection.providerAccountId, callId: input.callId };
    const result = route.provider === 'universe' && route.own ? await route.own.use(request) : await adapter.use({ ...request, toolkit });
    await recordOutcome(written.eventId, toolkit, written.provider, result.ok);
    return { status: 'done', ok: result.ok, data: result.data };
  } catch (error) {
    if (error instanceof AdapterError) console.error('[ReadyMade] Provider failed:', error.message);
    else console.error('[ReadyMade] Could not use:', error instanceof Error ? error.message : 'unknown');
    await recordOutcome(written.eventId, toolkit, written.provider, false);
    return { status: 'unavailable' };
  }
}

export interface ReadyMadeTestResult {
  success: boolean;
  toolCount: number;
  toolNames: string[];
  /** True when the app has more pages of tools than are read: the list is the first pages, not everything. */
  incomplete?: boolean;
  /** Said beside a result that worked (the MCP check: a protocol version it does not know). */
  note?: string;
  error?: string;
  status?: number | null;
  statusText?: string | null;
  errorCode?: string | null;
  wwwAuthenticate?: string | null;
  errorBody?: string | null;
}

/** The text of a JSON-RPC error carried in an answer that came with a 2xx status, or null when there is none. */
function rpcError(body: string, id?: number | string): string | null {
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
    // An answer to something else (another id, or no answer at all) is not an answer to this: an error in it would pass unseen, and the list below could then make the app look like it works
    if (!linkJson(opened.body, 1)) return failed('The app did not answer the start of a session.', opened.status);
    await adapter.callLink({ url: connection.serverUrl, message: { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId: opened.sessionId });
    // Every page of the list of tools (ids 2, 3, ...): a long list comes in pages, each with the cursor of the next
    const names: string[] = [];
    const seenNames = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let lastStatus = opened.status;
    let incomplete = false;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
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
      if (!Array.isArray(tools) || tools.some((tool) => !tool || typeof tool !== 'object' || typeof (tool as { name?: unknown }).name !== 'string' || !(tool as { name: string }).name.trim())) {
        return failed('The app did not answer the list of what it can do.', listed.status);
      }
      for (const tool of tools as { name: string }[]) {
        if (!seenNames.has(tool.name)) {
          seenNames.add(tool.name);
          names.push(tool.name);
        }
      }
      if (typeof result.nextCursor !== 'string' || !result.nextCursor) break;
      // A page is still offered but is not read (a cursor already followed, or past the last page that is read): the list says so
      // rather than pass for everything
      if (seenCursors.has(result.nextCursor) || page === MAX_TOOL_PAGES - 1) {
        incomplete = true;
        break;
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return { success: true, toolCount: names.length, toolNames: names, ...(incomplete ? { incomplete: true } : {}), status: lastStatus };
  } catch (error) {
    console.error('[ReadyMade] Test failed:', error instanceof Error ? error.message : 'unknown');
    return failed('The app could not be reached.');
  }
}

