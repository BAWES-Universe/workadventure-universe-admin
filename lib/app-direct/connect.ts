import { domainToUnicode } from 'node:url';
import type { AppConnection } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getBrickLimits } from '@/lib/bot-limits';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';
import { catalogDefinition } from '@/lib/app-direct/catalog';
import { definitionSchema, hashDefinition, keyMode, normalizeOrigin, siteOf, type Definition } from '@/lib/app-direct/definition';
import { GuardError, guardedRequest, type GuardDeps } from '@/lib/app-direct/guard';
import { buildRequest, RequestError } from '@/lib/app-direct/request';
import { lastFour, scrubSecret } from '@/lib/app-direct/scrub';
import { grantKeyAppToBricks } from '@/lib/app-direct/grants';

/**
 * Connecting a key app (game #2044): the safe form's two halves. A request is opened for ONE person, ONE service definition and
 * ONE moment (it ends after "How long the safe form stays open" and after a number of tries, both Limits settings). The key is
 * typed into the form, goes straight here, is checked with the definition's own non-changing request, and is stored encrypted.
 * It is never read back, never logged, never copied to a Brick's row, and never sent anywhere but the origin the form showed.
 *
 * Nobody reviews a connection. The owner decides; the code bounds what the key can do after (the origin, the operations).
 */

export class KeyFormError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'not_found' | 'expired' | 'used' | 'too_many' | 'invalid_key' | 'rejected' | 'unreachable' | 'mode_change' | 'unknown_service' | 'invalid_definition' | 'not_yours',
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface KeyFormView {
  id: string;
  /** `prefilled`: a service we ship, with its copy. `custom`: a draft a Brick made from the service's docs, which says where it came from. */
  mode: 'prefilled' | 'custom';
  name: string;
  short: string;
  /** The label of the one field: "Tap key". */
  keyLabel: string;
  keyHint: string | null;
  helpUrl: string | null;
  /** Where the key will be sent: the host as written for browsers (ASCII), and as people read it when that differs (an internationalized name). */
  host: string;
  hostReadable: string | null;
  /** Custom only: the site the setup was read from. */
  source: string | null;
  /** Custom only: true when that site and the destination are different sites. A match is never shown as a trust badge. */
  differentSite: boolean;
  /** What the form will do to prove the key ("Looks up one payment"), or null when nothing is checked. */
  check: string | null;
  /** When it replaces the key of an app the person already has: how that one ends, and its mode. */
  replacing: { keyLast4: string | null; mode: string | null } | null;
  triesLeft: number;
  expiresAt: Date;
}

const PLAIN_KEY = /^[\x21-\x7e]{8,500}$/;

/** Is this something the form can take as a key: 8 to 500 visible characters, no spaces or line breaks. Never says what is wrong with it. */
export const looksLikeAKey = (value: unknown): value is string => typeof value === 'string' && PLAIN_KEY.test(value);

/** A draft the Brick made from a service's docs, as data: forced to be a custom service whose every operation is unverified. */
export function parseDraft(raw: unknown): Definition {
  const object = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  object.service = 'custom';
  if (Array.isArray(object.operations)) object.operations = object.operations.map((operation) => (operation && typeof operation === 'object' ? { ...(operation as object), verified: false } : operation));
  const parsed = definitionSchema.safeParse(object);
  if (!parsed.success) throw new KeyFormError(400, 'invalid_definition', 'The setup is not valid', { issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`) });
  return parsed.data;
}

/** The host a source link names, or null. */
function sourceHost(source: string | null | undefined): string | null {
  if (!source) return null;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export interface OpenKeyForm {
  ownerId: string;
  /** A service from the shipped list... */
  service?: string;
  /** ...or a draft a Brick made (with the address of the docs it read), or the app whose key is being replaced. */
  draft?: unknown;
  source?: string | null;
  botId?: string | null;
  connectionId?: string | null;
}

/** Opens a safe form. For a service the person already has, it replaces that app's key. */
export async function openKeyForm(input: OpenKeyForm): Promise<{ id: string; replacing: boolean }> {
  let definition: Definition;
  let connectionId = input.connectionId ?? null;
  let source: string | null = null;
  if (connectionId) {
    const existing = await prisma.appConnection.findFirst({ where: { id: connectionId, ownerId: input.ownerId, kind: 'direct' } });
    // Someone else's app looks exactly like one that does not exist
    if (!existing || !existing.definition) throw new KeyFormError(404, 'not_found', 'App not found');
    definition = definitionSchema.parse(existing.definition);
    const fresh = definition.service === 'custom' ? null : catalogDefinition(definition.service);
    if (fresh) definition = fresh;
  } else if (input.service) {
    const shipped = catalogDefinition(input.service);
    if (!shipped) throw new KeyFormError(404, 'unknown_service', 'App not found');
    definition = shipped;
    const have = await findExisting(input.ownerId, definition);
    connectionId = have?.id ?? null;
  } else if (input.draft !== undefined) {
    definition = parseDraft(input.draft);
    source = input.source ? input.source.slice(0, 255) : null;
    const have = await findExisting(input.ownerId, definition);
    connectionId = have?.id ?? null;
  } else {
    throw new KeyFormError(400, 'unknown_service', 'Say which app');
  }
  const limits = await getBrickLimits();
  const row = await prisma.appKeyRequest.create({
    data: {
      ownerId: input.ownerId,
      botId: input.botId ?? null,
      connectionId,
      definition: definition as object,
      definitionHash: hashDefinition(definition),
      source,
      expiresAt: new Date(Date.now() + limits.keyFormMinutes * 60_000),
    },
  });
  return { id: row.id, replacing: connectionId !== null };
}

/** How a shipped key service is kept in `catalogKey`: apart from the super admin's list of app links, which never has a key like this. */
const directKey = (service: string): string => `direct:${service}`;

/** The person's own key app for this service (a shipped one by its key, a custom one by its origin), or null. */
async function findExisting(ownerId: string, definition: Definition, db: Pick<typeof prisma, 'appConnection'> = prisma): Promise<AppConnection | null> {
  if (definition.service !== 'custom') return db.appConnection.findFirst({ where: { ownerId, kind: 'direct', catalogKey: directKey(definition.service) } });
  return db.appConnection.findFirst({ where: { ownerId, kind: 'direct', catalogKey: null, serverUrl: definition.origin } });
}

function readDefinition(row: { definition: unknown; definitionHash: string }): Definition {
  const parsed = definitionSchema.safeParse(row.definition);
  if (!parsed.success || hashDefinition(parsed.data) !== row.definitionHash) throw new KeyFormError(410, 'expired', 'This form is no longer valid');
  return parsed.data;
}

/** What the form shows. Only the person it was opened for can read it; anyone else gets "not found". */
export async function readKeyForm(requestId: string, ownerId: string): Promise<KeyFormView> {
  const row = await prisma.appKeyRequest.findFirst({ where: { id: requestId, ownerId } });
  if (!row) throw new KeyFormError(404, 'not_found', 'Form not found');
  if (row.usedAt) throw new KeyFormError(410, 'used', 'This form was already used');
  if (row.expiresAt.getTime() <= Date.now()) throw new KeyFormError(410, 'expired', 'This form has closed');
  const definition = readDefinition(row);
  const limits = await getBrickLimits();
  const origin = normalizeOrigin(definition.origin);
  const host = origin.ok ? origin.host : '';
  const readable = domainToUnicode(host);
  const custom = definition.service === 'custom';
  const from = sourceHost(row.source);
  const checkOperation = definition.check ? definition.operations.find((operation) => operation.id === definition.check?.operation) : null;
  const replacing = row.connectionId ? await prisma.appConnection.findFirst({ where: { id: row.connectionId, ownerId }, select: { keyLast4: true, keyMode: true } }) : null;
  return {
    id: row.id,
    mode: custom ? 'custom' : 'prefilled',
    name: definition.name,
    short: definition.short,
    keyLabel: `${definition.short} key`,
    keyHint: definition.keyHint ?? null,
    helpUrl: definition.helpUrl ?? null,
    host,
    hostReadable: readable && readable !== host ? readable : null,
    source: custom ? (from ?? null) : null,
    differentSite: custom && !!from && siteOf(from) !== siteOf(host),
    check: checkOperation ? checkOperation.label : null,
    replacing: replacing ? { keyLast4: replacing.keyLast4, mode: replacing.keyMode } : null,
    triesLeft: Math.max(0, limits.keyTries - row.tries),
    expiresAt: row.expiresAt,
  };
}

export interface KeyConnected {
  id: string;
  name: string;
  created: boolean;
}

/**
 * The key is typed. Checked with the definition's own look-up (never a charge or a send), then stored encrypted. Replacing is
 * atomic: the new key is checked first, and the old one stops being used in the same step the new one starts. Switching between
 * a test and a real key asks first (`mode_change`, sent again with `confirmChange`).
 */
export async function submitKey(input: { requestId: string; ownerId: string; key: unknown; confirmChange?: boolean }, deps: GuardDeps = {}): Promise<KeyConnected> {
  const row = await prisma.appKeyRequest.findFirst({ where: { id: input.requestId, ownerId: input.ownerId } });
  if (!row) throw new KeyFormError(404, 'not_found', 'Form not found');
  if (row.usedAt) throw new KeyFormError(410, 'used', 'This form was already used');
  if (row.expiresAt.getTime() <= Date.now()) throw new KeyFormError(410, 'expired', 'This form has closed');
  const limits = await getBrickLimits();
  if (row.tries >= limits.keyTries) throw new KeyFormError(429, 'too_many', 'Too many tries');
  // What is wrong with the key is never said: only that it is not one this form can take
  // A pasted key often carries a trailing space or line break; that is never part of it
  const typed = typeof input.key === 'string' ? input.key.trim() : input.key;
  if (!looksLikeAKey(typed)) throw new KeyFormError(400, 'invalid_key', 'That does not look like a key');
  const key = typed;
  const definition = readDefinition(row);

  // Prove the key with the definition's own non-changing request. A key the service refuses costs a try.
  if (definition.check) {
    let status: number;
    try {
      const request = buildRequest(definition, definition.check.operation, definition.check.arguments, key);
      const answer = await guardedRequest({ ...request, timeoutMs: limits.keyCallSeconds * 1000, maxBytes: 4096 }, deps);
      // A redirect is never followed with a key; it is not an answer about the key either
      if (answer.redirected) throw new KeyFormError(502, 'unreachable', 'The service did not answer as expected');
      status = answer.status;
    } catch (error) {
      if (error instanceof KeyFormError) throw error;
      if (error instanceof GuardError || error instanceof RequestError) throw new KeyFormError(502, 'unreachable', 'The service could not be reached');
      throw error;
    }
    if (definition.check.rejected.includes(status)) {
      await prisma.appKeyRequest.update({ where: { id: row.id }, data: { tries: { increment: 1 } } });
      throw new KeyFormError(422, 'rejected', "The service didn't accept this key");
    }
    if (status >= 500) throw new KeyFormError(502, 'unreachable', 'The service could not be reached');
  }

  const mode = keyMode(definition, key);
  const encrypted = encryptApiKey(key);
  const tail = lastFour(key);

  const connected = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`direct-key:${input.ownerId}:${definition.service}:${definition.origin}`}, 0))`;
    // One use of the form, whatever happens next: a second submit at the same moment finds it used
    const taken = await tx.appKeyRequest.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (taken.count !== 1) throw new KeyFormError(410, 'used', 'This form was already used');
    const existing = row.connectionId
      ? await tx.appConnection.findFirst({ where: { id: row.connectionId, ownerId: input.ownerId, kind: 'direct' } })
      : await findExisting(input.ownerId, definition, tx);
    if (existing) {
      if (existing.keyMode && mode && existing.keyMode !== mode && !input.confirmChange) {
        // Nothing is changed and the form stays open for the answer: the use above is undone by the throw
        throw new KeyFormError(409, 'mode_change', existing.keyMode === 'test' ? 'This switches from a test key to a real one' : 'This switches from a real key to a test one', { from: existing.keyMode, to: mode });
      }
      const updated = await tx.appConnection.update({
        where: { id: existing.id },
        data: {
          name: definition.name,
          serverUrl: definition.origin,
          definition: definition as object,
          definitionHash: hashDefinition(definition),
          keyCipher: encrypted,
          keyLast4: tail,
          keyMode: mode,
          keyVersion: { increment: 1 },
          // A new key that works ends "Key stopped working" for every Brick at once
          signInLostAt: null,
          signInLostStatus: null,
          noAnswerAt: null,
          reconnectedAt: new Date(),
        },
      });
      return { id: updated.id, name: updated.name, created: false };
    }
    const created = await tx.appConnection.create({
      data: {
        ownerId: input.ownerId,
        connectedById: input.ownerId,
        name: definition.name,
        serverUrl: definition.origin,
        authType: 'none',
        source: 'direct',
        kind: 'direct',
        catalogKey: definition.service === 'custom' ? null : directKey(definition.service),
        definition: definition as object,
        definitionHash: hashDefinition(definition),
        keyCipher: encrypted,
        keyLast4: tail,
        keyMode: mode,
      },
    });
    return { id: created.id, name: created.name, created: true };
  }, { maxWait: 10_000, timeout: 30_000 });
  // Available to all the owner's Bricks as soon as it is connected (default access); a replaced key changes nobody's grants
  if (connected.created) await grantKeyAppToBricks(input.ownerId, { id: connected.id, name: connected.name });
  return connected;
}

/** The key of a key app, for the call route only. Throws for anything that is not a key app; never logged, never returned to a person. */
export function readKey(connection: Pick<AppConnection, 'kind' | 'keyCipher'>): string {
  if (connection.kind !== 'direct' || !connection.keyCipher) throw new Error('Not a key app');
  return decryptApiKey(connection.keyCipher);
}

/** A message about a failure with any key taken out, for the rare place that has to write one down. */
export const safeMessage = (message: string, key: string): string => scrubSecret(message, key);
