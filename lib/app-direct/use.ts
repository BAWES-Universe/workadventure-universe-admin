import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { checkAppUse, type AppUseVerdict } from '@/lib/app-connections';
import { recordMeterEvent } from '@/lib/meter';
import { personKeyOf } from '@/lib/meter-values';
import { reportToolSignIn } from '@/lib/tool-signin';
import { definitionSchema, hashDefinition, type Definition } from '@/lib/app-direct/definition';
import { operationViews, headingOf, type KeyAppOperationView } from '@/lib/app-direct/describe';
import { guardedRequest, GuardError, type GuardDeps } from '@/lib/app-direct/guard';
import { buildRequest, pickFields, RequestError } from '@/lib/app-direct/request';
import { readKey } from '@/lib/app-direct/connect';
import { scrubDeep } from '@/lib/app-direct/scrub';
import { ensureKeyAppTools, fingerprintOf, toolNameOf } from '@/lib/app-direct/policy';

/**
 * Using a key app (game #2044). The bot server asks Orbit to run ONE operation of an app's definition with arguments the model
 * picked; Orbit sends it, with the key it alone holds, to the origin the owner confirmed, and gives back only the fields the
 * definition lists. What Orbit holds on every use, whatever the bot server decided about asking:
 *  - the app is the caller's Brick's own, on, and the asker is its owner (`checkAppUse`, checked at EVERY use, so taking it away,
 *    switching it off or disconnecting stops it at once, in a chat that is already open and a goal that is already running);
 *  - the definition is the one the person said yes to (`definitionHash`): a changed definition inherits no approval;
 *  - one call id is one use: a retry never sends twice;
 *  - requests an hour for the person and for everyone are Limits settings;
 *  - the model never picks the host, a header, a path outside the template or the key; the key is scrubbed from what comes back;
 *  - a raw error answer never reaches the model: it learns that the service said no, and its status.
 */

export type KeyAppOutcome =
  | { status: 'done'; ok: boolean; httpStatus: number; data: unknown; truncated: boolean }
  | { status: 'refused'; reason: 'gone' | 'off' | 'not_owner' | 'incomplete' }
  | { status: 'changed' }
  | { status: 'unknown_operation' }
  | { status: 'bad_arguments'; message: string }
  | { status: 'limit' }
  | { status: 'already_asked' }
  | { status: 'key_rejected'; httpStatus: number }
  | { status: 'unavailable' };

const DAY_MS = 24 * 3_600_000;

export interface RunKeyApp {
  botId: string;
  serverId: string;
  requesterKey?: string;
  forOwner?: boolean;
  /** The bot server's own id for this call: a retry is the same call and runs once. */
  callId: string;
  operation: string;
  arguments: unknown;
  /** The definition version the person's approval was for. */
  definitionHash: string;
}

export async function runKeyApp(input: RunKeyApp, deps: GuardDeps = {}): Promise<KeyAppOutcome> {
  const verdict: AppUseVerdict | null = await checkAppUse(input.botId, input.serverId, { requesterKey: input.requesterKey, forOwner: input.forOwner, callId: input.callId });
  if (!verdict) return { status: 'refused', reason: 'gone' };
  if (!verdict.allowed) return { status: 'refused', reason: (verdict.reason === 'not_owner' || verdict.reason === 'off' || verdict.reason === 'incomplete' ? verdict.reason : 'gone') };
  const row = await prisma.botMcpServer.findFirst({ where: { id: input.serverId, botId: input.botId }, include: { connection: true } });
  const connection = row?.connection;
  if (!row || !connection || connection.kind !== 'direct' || !connection.ownerId || !connection.definition) return { status: 'refused', reason: 'gone' };
  const ownerId = connection.ownerId;
  const parsed = definitionSchema.safeParse(connection.definition);
  if (!parsed.success || hashDefinition(parsed.data) !== connection.definitionHash) return { status: 'refused', reason: 'gone' };
  const definition: Definition = parsed.data;
  // The person said yes to a version; a definition that changed since (a new key form for the same app) is asked about again
  if (connection.definitionHash !== input.definitionHash) return { status: 'changed' };
  const operation = definition.operations.find((candidate) => candidate.id === input.operation);
  if (!operation) return { status: 'unknown_operation' };

  const key = readKey(connection);
  let built;
  try {
    built = buildRequest(definition, operation.id, input.arguments, key);
  } catch (error) {
    if (error instanceof RequestError) return error.code === 'unknown_operation' ? { status: 'unknown_operation' } : { status: 'bad_arguments', message: scrubDeep(error.message, key).slice(0, 400) };
    throw error;
  }

  const limits = await getBrickLimits();
  // Take the use first: under the person's lock (and a short one for everyone) the hour's count and this write happen together, so two
  // calls at once can never both take the last request, and the same call id again is refused before anything is sent
  const taken = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`key-calls:${ownerId}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('key-calls:everyone', 0))`;
    const held = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "app_connections" WHERE "id" = ${connection.id} FOR SHARE`;
    if (held.length === 0) return 'gone' as const;
    const stillThere = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "bot_mcp_servers" WHERE "id" = ${row.id} AND "bot_id" = ${input.botId} FOR SHARE`;
    if (stillThere.length === 0) return 'gone' as const;
    const again = await tx.appKeyCall.findUnique({ where: { botId_callId: { botId: input.botId, callId: input.callId } }, select: { id: true } });
    if (again) return 'again' as const;
    const since = new Date(Date.now() - 3_600_000);
    const [mine, everyone] = await Promise.all([tx.appKeyCall.count({ where: { ownerId, createdAt: { gte: since } } }), tx.appKeyCall.count({ where: { createdAt: { gte: since } } })]);
    if (mine >= limits.keyCallsPerPerson || everyone >= limits.keyCallsPlatform) return 'limit' as const;
    await tx.appKeyCall.create({ data: { connectionId: connection.id, ownerId, botId: input.botId, callId: input.callId, operation: operation.id } });
    // Old rows are kept long enough for a retry to be recognised, and no longer
    const old = await tx.appKeyCall.findMany({ where: { createdAt: { lt: new Date(Date.now() - 2 * DAY_MS) } }, select: { id: true }, take: 100 });
    if (old.length > 0) await tx.appKeyCall.deleteMany({ where: { id: { in: old.map((entry) => entry.id) } } });
    return 'ok' as const;
  });
  if (taken === 'gone') return { status: 'refused', reason: 'gone' };
  if (taken === 'again') return { status: 'already_asked' };
  if (taken === 'limit') return { status: 'limit' };

  // The books: one logical use, paid for by the person (their own key, their own bill at the service), never a cost to Universe
  await recordMeterEvent({
    eventId: `app:${input.botId}:${input.callId}`,
    kind: 'app_use',
    pool: 'chat',
    occurredAt: new Date(),
    personKey: personKeyOf({ personId: ownerId }),
    personId: ownerId,
    botId: input.botId,
    brick: true,
    payerKind: 'person',
    payerPersonId: ownerId,
    route: 'key-app',
    jobId: null,
    quantity: 1,
    unit: 'use',
    costMicros: null,
    basis: 'paid_by_other',
    sourceRef: null,
    // Which app and which operation, never the arguments or what came back
    detail: { app: connection.name, operation: operation.id, heading: headingOf(operation), verified: operation.verified },
  }).catch((error) => console.error('[KeyApps] Could not write the use to the books:', error instanceof Error ? error.message : 'unknown'));

  let answer;
  try {
    answer = await guardedRequest({ ...built, timeoutMs: limits.keyCallSeconds * 1000, maxBytes: limits.keyAnswerKb * 1024 }, deps);
  } catch (error) {
    await finish(input, 'unreachable', null);
    if (error instanceof GuardError) return { status: 'unavailable' };
    throw error;
  }
  // A redirect is never followed with a key, and says nothing about the key
  if (answer.redirected) {
    await finish(input, 'failed', answer.status);
    return { status: 'unavailable' };
  }
  const rejected = answer.status === 401 || answer.status === 403;
  if (rejected) {
    await finish(input, 'rejected', answer.status);
    // "Key stopped working": one place, for every Brick that uses it, cleared by a new key or a good call
    await reportToolSignIn(input.botId, input.serverId, { state: 'expired', status: answer.status }).catch(() => undefined);
    return { status: 'key_rejected', httpStatus: answer.status };
  }
  const ok = answer.status >= 200 && answer.status < 300;
  await finish(input, ok ? 'ok' : 'failed', answer.status);
  if (ok && connection.signInLostAt) await reportToolSignIn(input.botId, input.serverId, { state: 'ok' }).catch(() => undefined);
  if (!ok) return { status: 'done', ok: false, httpStatus: answer.status, data: null, truncated: false };

  let data: unknown = null;
  if (!answer.truncated) {
    try {
      data = scrubDeep(pickFields(JSON.parse(answer.body), operation.returns), key);
    } catch {
      data = null;
    }
  }
  return { status: 'done', ok: true, httpStatus: answer.status, data, truncated: answer.truncated };
}

async function finish(input: RunKeyApp, outcome: 'ok' | 'rejected' | 'failed' | 'unreachable', httpStatus: number | null): Promise<void> {
  await prisma.appKeyCall.updateMany({ where: { botId: input.botId, callId: input.callId }, data: { state: 'done', outcome, httpStatus } }).catch(() => undefined);
}

export interface KeyAppToolView extends KeyAppOperationView {
  /** The tool's name as the model calls it, and its fingerprint: the same ones the tool policy of this grant holds. */
  tool: string;
  fingerprint: string;
}

export interface KeyAppView {
  /** The Brick's grant id: the id the bot server uses to ask whether a use is allowed and to run one. */
  serverId: string;
  connectionId: string;
  name: string;
  short: string;
  /** The version of the definition: approvals and remembered permissions are for one version. */
  definitionHash: string;
  /** The grant's switch (an explicit Off stays Off). */
  enabled: boolean;
  /** False while the service refuses the key ("Key stopped working"): the Brick says so and carries on without it. */
  working: boolean;
  /** What the Brick does under each heading for this app (rightAway | asksFirst | off). */
  settings: { looksUp: string; makesNew: string; changesThings: string; deletesOrSends: string };
  operations: KeyAppToolView[];
}

/** The key apps one Brick has, for the bot server. Never a key, a key's end, an address or anything of the definition beyond its operations. */
export async function keyAppsOf(botId: string): Promise<KeyAppView[]> {
  const rows = await prisma.botMcpServer.findMany({
    where: { botId, connection: { kind: 'direct' } },
    include: { connection: true },
    orderBy: { createdAt: 'asc' },
  });
  const views: KeyAppView[] = [];
  for (const row of rows) {
    const connection = row.connection;
    if (!connection?.definition) continue;
    const parsed = definitionSchema.safeParse(connection.definition);
    if (!parsed.success || hashDefinition(parsed.data) !== connection.definitionHash) continue;
    await ensureKeyAppTools(row.id);
    const hash = connection.definitionHash as string;
    views.push({
      serverId: row.id,
      connectionId: connection.id,
      name: connection.name,
      short: parsed.data.short,
      definitionHash: connection.definitionHash as string,
      enabled: row.enabled,
      working: !connection.signInLostAt,
      settings: { looksUp: row.lookUpSetting, makesNew: row.makeSetting, changesThings: row.changeSetting, deletesOrSends: row.deleteSendSetting },
      operations: operationViews(parsed.data).map((operation) => ({ ...operation, tool: toolNameOf(parsed.data, operation.id, connection.id), fingerprint: fingerprintOf(hash, operation.id) })),
    });
  }
  return views;
}
