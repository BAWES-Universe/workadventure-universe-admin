import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { checkAppUse, type AppUseVerdict } from '@/lib/app-connections';
import { recordMeterEvent } from '@/lib/meter';
import { personKeyOf } from '@/lib/meter-values';
import { reportKeyNoAnswer, reportKeyWorked, reportToolSignIn } from '@/lib/tool-signin';
import { definitionSchema, hashDefinition, type Definition } from '@/lib/app-direct/definition';
import { operationViews, headingOf, type KeyAppOperationView } from '@/lib/app-direct/describe';
import { guardedRequest, GuardError, serviceDidNotAnswer, type GuardDeps } from '@/lib/app-direct/guard';
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
 *  - the person's own key is never limited or counted against anything by Universe (Khalid, 26 Nov 2026: a person's own keys,
 *    accounts and free plans come first and are never capped by us). Only the service itself may refuse, and its answer is passed on;
 *  - the model never picks the host, a header, a path outside the template or the key; the key is scrubbed from what comes back;
 *  - a raw error answer never reaches the model: it learns that the service said no, and its status.
 */

export type KeyAppOutcome =
  | { status: 'done'; ok: boolean; httpStatus: number; data: unknown; truncated: boolean }
  | { status: 'refused'; reason: 'gone' | 'off' | 'not_owner' | 'incomplete' }
  | { status: 'changed' }
  | { status: 'unknown_operation' }
  | { status: 'bad_arguments'; message: string }
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

export async function runKeyApp(input: RunKeyApp, deps: GuardDeps = {}, again = false): Promise<KeyAppOutcome> {
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
  // Take the use first: under the person's lock the check that this call id is new and its write happen together, so the same call id again
  // is refused before anything is sent. Nothing here counts or caps the person's own key: no hourly allowance, no share of a platform total
  const taken = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`key-calls:${ownerId}`}, 0))`;
    // What was read before the lock may have moved: the request was built from that key and that definition, and the grant may have been
    // switched off since the check. Read all of it again under the lock, so nothing is sent that a committed change has already ended
    const held = await tx.$queryRaw<{ id: string; keyVersion: number; definitionHash: string | null }[]>`SELECT "id", "key_version" AS "keyVersion", "definition_hash" AS "definitionHash" FROM "app_connections" WHERE "id" = ${connection.id} FOR SHARE`;
    if (held.length === 0) return 'gone' as const;
    const stillThere = await tx.$queryRaw<{ id: string; enabled: boolean }[]>`SELECT "id", "enabled" FROM "bot_mcp_servers" WHERE "id" = ${row.id} AND "bot_id" = ${input.botId} FOR SHARE`;
    if (stillThere.length === 0) return 'gone' as const;
    if (!stillThere[0].enabled) return 'off' as const;
    if (held[0].definitionHash !== connection.definitionHash) return 'changed' as const;
    if (held[0].keyVersion !== connection.keyVersion) return 'stale' as const;
    const already = await tx.appKeyCall.findUnique({ where: { botId_callId: { botId: input.botId, callId: input.callId } }, select: { id: true } });
    if (already) return 'again' as const;
    await tx.appKeyCall.create({ data: { connectionId: connection.id, ownerId, botId: input.botId, callId: input.callId, operation: operation.id } });
    // Old rows are kept long enough for a retry to be recognised, and no longer
    const old = await tx.appKeyCall.findMany({ where: { createdAt: { lt: new Date(Date.now() - 2 * DAY_MS) } }, select: { id: true }, take: 100 });
    if (old.length > 0) await tx.appKeyCall.deleteMany({ where: { id: { in: old.map((entry) => entry.id) } } });
    return 'ok' as const;
  });
  if (taken === 'gone') return { status: 'refused', reason: 'gone' };
  if (taken === 'off') return { status: 'refused', reason: 'off' };
  if (taken === 'changed') return { status: 'changed' };
  // The key was replaced while this call was being set up: build it again once with the new key, never send the old one
  if (taken === 'stale') return again ? { status: 'refused', reason: 'gone' } : runKeyApp(input, deps, true);
  if (taken === 'again') return { status: 'already_asked' };

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

  // Reports are ordered by when the request went out, not when the answer came back: a refusal for a key that was replaced meanwhile is old news
  const startedAt = new Date();
  let answer;
  try {
    answer = await guardedRequest({ ...built, timeoutMs: limits.keyCallSeconds * 1000, maxBytes: limits.keyAnswerKb * 1024 }, deps);
  } catch (error) {
    await finish(input, 'unreachable', null);
    // A service that did not answer is written on the App (cleared by the next good call, reportKeyWorked): a down own copy then no longer counts
    // as working for a while (lib/app-same.ts ownCopyWorks, KEY_NO_ANSWER_HOLDS_MS), so the ready-made copy of the same App is the Brick's way
    // meanwhile, never neither; after that while the own copy is tried again
    if (serviceDidNotAnswer(error)) await reportKeyNoAnswer(connection.id, startedAt);
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
    await reportToolSignIn(input.botId, input.serverId, { state: 'expired', status: answer.status, at: startedAt }).catch(() => undefined);
    return { status: 'key_rejected', httpStatus: answer.status };
  }
  const ok = answer.status >= 200 && answer.status < 300;
  await finish(input, ok ? 'ok' : 'failed', answer.status);
  if (ok) await reportKeyWorked(connection.id, connection.keyVersion, startedAt).catch(() => undefined);
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
  /** The app can take a payment for a page (its definition has a payment contract): the Brick may set one up through it. */
  payments: boolean;
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
    // One app whose tools cannot be made must not take the others down with it
    try {
      await ensureKeyAppTools(row.id);
    } catch (error) {
      console.error('[KeyApps] Could not make the tools of one app:', error instanceof Error ? error.message : 'unknown');
      continue;
    }
    const hash = connection.definitionHash as string;
    views.push({
      serverId: row.id,
      connectionId: connection.id,
      name: connection.name,
      short: parsed.data.short,
      definitionHash: connection.definitionHash as string,
      enabled: row.enabled,
      payments: !!parsed.data.payment,
      working: !connection.signInLostAt,
      settings: { looksUp: row.lookUpSetting, makesNew: row.makeSetting, changesThings: row.changeSetting, deletesOrSends: row.deleteSendSetting },
      operations: operationViews(parsed.data).map((operation) => ({ ...operation, tool: toolNameOf(parsed.data, operation.id, connection.id), fingerprint: fingerprintOf(hash, operation.id) })),
    });
  }
  return views;
}
