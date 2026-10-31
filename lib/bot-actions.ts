import crypto from 'crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';

/**
 * A saved record for each bot action that waits for a tap (#739).
 *
 * A request is what the card shows and what runs: the arguments are stored once, exactly as shown, and a tap names only the
 * request's id and the revision it saw. Every change is one conditional update on the status and revision the caller
 * saw, so two taps (a double tap, or two devices) give one winner and the other is told what the winner did.
 *
 *   waiting ─ approve ─▶ approved ─ claim ─▶ running ─▶ done | failed | couldntConfirm
 *      └─ decline / supersede / expire        └─ revoke / cancel / stale
 *
 * An approved request must be claimed within `startWithinSeconds` or it is stale and needs a fresh card. A run that may
 * already have happened is `couldntConfirm`: nothing here ever claims it again, a person looks at the destination and
 * `reconcile` records what they found. The database is the record; Redis, if the bot server uses it, only carries notices.
 *
 * Nothing here puts card text anywhere but the request's own (encrypted) row.
 */

/** Recommended values. Every one can be passed per call; the bot server decides what a given bot uses (see #738). */
export const DEFAULTS = {
  /** How long a card waits for an answer. A bot's own "A card waits" setting (#738) is what the caller normally passes. */
  reviewMinutes: 10,
  /** An approved action must be claimed within this long. */
  startWithinSeconds: 30,
  /** How long a dispatcher may hold a claim before its run counts as one we could not confirm. */
  leaseSeconds: 120,
  /** A remembered approval ends after this long without the asker's messages... */
  idleMinutes: 60,
  /** ...and after this long at most. */
  absoluteMinutes: 480,
} as const;

export const HEADINGS = ['looksUp', 'makesNew', 'changesThings', 'deletesOrSends'] as const;
export type ActionHeading = (typeof HEADINGS)[number];

export const STATUSES = ['waiting', 'approved', 'running', 'done', 'failed', 'couldntConfirm', 'closed'] as const;
export type ActionStatus = (typeof STATUSES)[number];

export const CLOSED_REASONS = ['declined', 'superseded', 'expired', 'stale', 'cancelled', 'revoked'] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

export const DECISIONS = ['approve', 'approveAndRemember', 'decline'] as const;
export type Decision = (typeof DECISIONS)[number];

/** How an attempt ended, as the dispatcher established it. See the table in `finishAttempt`. */
export const OUTCOMES = ['succeeded', 'failed', 'notSent', 'uncertain'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const ARGUMENTS_MAX_BYTES = 100_000;

export class BotActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Db = Prisma.TransactionClient;

/** Remembering what a tap allowed: which arguments stay as they are, and which fields may be different next time. */
export const rememberScopeSchema = z
  .object({
    fixed: z.record(z.string(), z.unknown()),
    varies: z.array(z.string().min(1).max(100)).max(50),
  })
  .strict();
export type RememberScope = z.infer<typeof rememberScopeSchema>;

/* ---------------------------------- pieces ---------------------------------- */

/** JSON with object keys in order, so the same arguments always give the same digest. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function digestOf(toolName: string, connectionRef: string | null, args: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson({ tool: toolName, connection: connectionRef, arguments: args })).digest('hex');
}

/**
 * Whether new arguments fit what a remembered approval allows: every fixed field is exactly as approved, and any other
 * field is one that may vary. A field that is neither is a different action.
 */
export function argumentsFitScope(args: unknown, scope: RememberScope): boolean {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  const given = args as Record<string, unknown>;
  const fixed = Object.keys(scope.fixed);
  for (const key of fixed) {
    if (canonicalJson(given[key]) !== canonicalJson(scope.fixed[key])) return false;
  }
  const allowed = new Set([...fixed, ...scope.varies]);
  return Object.keys(given).every((key) => given[key] === undefined || allowed.has(key));
}

const minutes = (n: number) => n * 60_000;
const seconds = (n: number) => n * 1000;

export interface ActionView {
  id: string;
  botId: string;
  status: ActionStatus;
  closedReason: ClosedReason | null;
  revision: number;
  requesterKey: string;
  conversationKey: string;
  connectionRef: string | null;
  toolName: string;
  heading: ActionHeading;
  toolFingerprint: string;
  policyRevision: number;
  /** The exact arguments that were shown, and run. */
  arguments: unknown;
  argumentsDigest: string;
  /** What "allow more" would remember; null when the card does not offer it. */
  rememberScope: RememberScope | null;
  reviewExpiresAt: Date;
  approvedAt: Date | null;
  startBy: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  attempts: { id: string; attemptNo: number; state: string; leaseExpiresAt: Date; providerRequestId: string | null; outcomeClass: string | null }[];
}

type RequestRow = Prisma.BotActionRequestGetPayload<{ include: { attempts: true } }>;

function toView(row: RequestRow): ActionView {
  const attempts = row.attempts;
  return {
    id: row.id,
    botId: row.botId,
    status: row.status as ActionStatus,
    closedReason: (row.closedReason as ClosedReason | null) ?? null,
    revision: row.revision,
    requesterKey: row.requesterKey,
    conversationKey: row.conversationKey,
    connectionRef: row.connectionRef,
    toolName: row.toolName,
    heading: row.heading as ActionHeading,
    toolFingerprint: row.toolFingerprint,
    policyRevision: row.policyRevision,
    arguments: JSON.parse(decryptApiKey(row.arguments)),
    argumentsDigest: row.argumentsDigest,
    rememberScope: (row.rememberScope as RememberScope | null) ?? null,
    reviewExpiresAt: row.reviewExpiresAt,
    approvedAt: row.approvedAt,
    startBy: row.startBy,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    attempts: [...attempts]
      .sort((a, b) => a.attemptNo - b.attemptNo)
      .map((a) => ({ id: a.id, attemptNo: a.attemptNo, state: a.state, leaseExpiresAt: a.leaseExpiresAt, providerRequestId: a.providerRequestId, outcomeClass: a.outcomeClass })),
  };
}

async function load(db: Db, botId: string, id: string): Promise<RequestRow> {
  const row = await db.botActionRequest.findFirst({ where: { id, botId }, include: { attempts: true } });
  if (!row) throw new BotActionError(404, 'not_found', 'No such action');
  return row;
}

/**
 * One conditional move: only if the row is still in one of `from` and still at the revision the caller saw. Returns
 * whether this call made the move; the decision log gets a row only for the winner.
 */
async function move(
  db: Db,
  row: { id: string; revision: number },
  from: readonly ActionStatus[],
  data: Prisma.BotActionRequestUncheckedUpdateManyInput,
  event: string,
  actorKey: string | null,
  extraWhere: Prisma.BotActionRequestWhereInput = {},
): Promise<boolean> {
  const moved = await db.botActionRequest.updateMany({
    where: { id: row.id, status: { in: [...from] }, revision: row.revision, ...extraWhere },
    data: { ...data, revision: { increment: 1 } },
  });
  if (moved.count !== 1) return false;
  await db.botActionDecision.create({ data: { requestId: row.id, event, actorKey, fromRevision: row.revision, toRevision: row.revision + 1 } });
  return true;
}

/* --------------------------------- creating --------------------------------- */

export const createRequestSchema = z
  .object({
    proposalKey: z.string().trim().min(1).max(200),
    requesterKey: z.string().trim().min(1).max(400),
    conversationKey: z.string().trim().min(1).max(400),
    connectionRef: z.string().trim().min(1).max(200).nullish(),
    toolName: z.string().trim().min(1).max(255),
    heading: z.enum(HEADINGS),
    toolFingerprint: z.string().trim().min(1).max(128),
    policyRevision: z.number().int().min(1),
    arguments: z.record(z.string(), z.unknown()),
    rememberScope: rememberScopeSchema.nullish(),
    reviewMinutes: z.number().int().min(1).max(24 * 60).optional(),
  })
  .strict();
export type CreateRequestInput = z.infer<typeof createRequestSchema>;

/**
 * Save a request that waits for a tap. The same `proposalKey` again returns the request already saved (a bot server that
 * restarted between saving and showing the card must not make a second one); the same key with different content (the
 * arguments, requester, conversation, heading, tool fingerprint, policy revision or what may be remembered) is refused. Remembering is never offered for deleting or sending.
 */
export async function createRequest(
  botId: string,
  input: CreateRequestInput,
  now: Date = new Date(),
): Promise<{ action: ActionView; created: boolean }> {
  if (input.rememberScope && input.heading === 'deletesOrSends') {
    throw new BotActionError(400, 'remember_not_allowed', 'Remembering is not offered for deleting or sending');
  }
  const encoded = canonicalJson(input.arguments);
  if (Buffer.byteLength(encoded) > ARGUMENTS_MAX_BYTES) throw new BotActionError(400, 'arguments_too_large', 'The arguments are too large');
  const connectionRef = input.connectionRef ?? null;
  const digest = digestOf(input.toolName, connectionRef, input.arguments);

  const existing = await prisma.botActionRequest.findUnique({ where: { botId_proposalKey: { botId, proposalKey: input.proposalKey } }, include: { attempts: true } });
  const again = (row: NonNullable<typeof existing>) => {
    // The same card: what is asked, by whom, in which conversation, under which heading and policy, and what may be remembered
    const same =
      row.argumentsDigest === digest &&
      row.requesterKey === input.requesterKey &&
      row.conversationKey === input.conversationKey &&
      row.heading === input.heading &&
      row.toolFingerprint === input.toolFingerprint &&
      row.policyRevision === input.policyRevision &&
      canonicalJson(row.rememberScope ?? null) === canonicalJson(input.rememberScope ?? null);
    if (!same) {
      throw new BotActionError(409, 'proposal_key_reused', 'That key was used for a different action');
    }
    return { action: toView(row), created: false };
  };
  if (existing) return again(existing);

  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) throw new BotActionError(404, 'bot_not_found', 'Bot not found');

  try {
    const row = await prisma.botActionRequest.create({
      data: {
        botId,
        proposalKey: input.proposalKey,
        requesterKey: input.requesterKey,
        conversationKey: input.conversationKey,
        connectionRef,
        toolName: input.toolName,
        heading: input.heading,
        toolFingerprint: input.toolFingerprint,
        policyRevision: input.policyRevision,
        arguments: encryptApiKey(encoded),
        argumentsDigest: digest,
        rememberScope: (input.rememberScope as Prisma.InputJsonValue | null | undefined) ?? undefined,
        reviewExpiresAt: new Date(now.getTime() + minutes(input.reviewMinutes ?? DEFAULTS.reviewMinutes)),
      },
      include: { attempts: true },
    });
    return { action: toView(row), created: true };
  } catch (error) {
    // Two saves with the same key at once: the second finds the first
    if ((error as { code?: string }).code === 'P2002') {
      const winner = await prisma.botActionRequest.findUnique({ where: { botId_proposalKey: { botId, proposalKey: input.proposalKey } }, include: { attempts: true } });
      if (winner) return again(winner);
    }
    throw error;
  }
}

/** The request as it stands. A card that waited too long, or an approval nobody started, is closed first. */
export async function readRequest(botId: string, id: string, now: Date = new Date()): Promise<ActionView> {
  const row = await load(prisma, botId, id);
  await closeIfLapsed(prisma, row, now);
  return toView(await load(prisma, botId, id));
}

/** Close a request whose time has run out. Server clock only: a button that looks disabled is not enforcement. */
async function closeIfLapsed(
  db: Db,
  row: { id: string; status: string; revision: number; reviewExpiresAt: Date; startBy: Date | null },
  now: Date,
): Promise<boolean> {
  if (row.status === 'waiting' && row.reviewExpiresAt <= now) {
    return move(db, row, ['waiting'], { status: 'closed', closedReason: 'expired', finishedAt: now }, 'expire', null);
  }
  if (row.status === 'approved' && row.startBy && row.startBy <= now) {
    return move(db, row, ['approved'], { status: 'closed', closedReason: 'stale', finishedAt: now }, 'stale', null);
  }
  return false;
}

/* --------------------------------- deciding --------------------------------- */

export type DecideResult =
  | { outcome: 'decided'; action: ActionView; grantId: string | null }
  /** Someone else's tap, an expiry or a replacement got there first; `action` shows what it is now. */
  | { outcome: 'already_decided' | 'expired'; action: ActionView };

/**
 * A tap. The caller names the request, the revision the card showed and the choice, and who tapped (the bot server has
 * authenticated them); nothing else about the action can come with it. Only the person who asked may decide. The
 * decision and the start deadline are written together, so an approval is never half saved.
 *
 * Approve and remember also saves the remembered approval the card offered; a card that did not offer it refuses.
 */
export async function decide(
  botId: string,
  id: string,
  input: { actorKey: string; revision: number; decision: Decision; startWithinSeconds?: number; idleMinutes?: number; absoluteMinutes?: number },
  now: Date = new Date(),
): Promise<DecideResult> {
  return prisma.$transaction(async (tx) => {
    const row = await load(tx, botId, id);
    if (row.requesterKey !== input.actorKey) {
      throw new BotActionError(403, 'not_requester', 'Only the person who asked can answer');
    }
    if (input.decision === 'approveAndRemember' && (!row.rememberScope || row.heading === 'deletesOrSends')) {
      throw new BotActionError(400, 'remember_not_offered', 'This card does not offer to remember');
    }

    if (await closeIfLapsed(tx, row, now)) return { outcome: 'expired' as const, action: toView(await load(tx, botId, id)) };

    const lost = async () => ({ outcome: 'already_decided' as const, action: toView(await load(tx, botId, id)) });
    if (row.status !== 'waiting' || row.revision !== input.revision) return lost();

    const declined = input.decision === 'decline';
    const won = await move(
      tx,
      row,
      ['waiting'],
      declined
        ? { status: 'closed', closedReason: 'declined', finishedAt: now }
        : { status: 'approved', approvedAt: now, startBy: new Date(now.getTime() + seconds(input.startWithinSeconds ?? DEFAULTS.startWithinSeconds)) },
      input.decision,
      input.actorKey,
      { reviewExpiresAt: { gt: now } },
    );
    if (!won) return lost();

    let grantId: string | null = null;
    if (input.decision === 'approveAndRemember') {
      const idle = input.idleMinutes ?? DEFAULTS.idleMinutes;
      const grant = await tx.botActionGrant.create({
        data: {
          botId,
          requesterKey: row.requesterKey,
          conversationKey: row.conversationKey,
          connectionRef: row.connectionRef,
          toolName: row.toolName,
          heading: row.heading,
          toolFingerprint: row.toolFingerprint,
          policyRevision: row.policyRevision,
          scope: row.rememberScope as Prisma.InputJsonValue,
          fromRequestId: row.id,
          idleMinutes: idle,
          idleExpiresAt: new Date(now.getTime() + minutes(idle)),
          absoluteExpiresAt: new Date(now.getTime() + minutes(input.absoluteMinutes ?? DEFAULTS.absoluteMinutes)),
        },
      });
      grantId = grant.id;
    }
    return { outcome: 'decided' as const, action: toView(await load(tx, botId, id)), grantId };
  });
}

/**
 * The asker sent a replacement instruction (or left): their request still waiting for a tap, or approved and not yet
 * claimed, is closed as superseded. Another person's message, or another bot's, never reaches this.
 */
export async function supersedeWaiting(
  botId: string,
  input: { requesterKey: string; conversationKey: string; reason?: 'superseded' | 'cancelled' },
  now: Date = new Date(),
): Promise<{ closed: string[] }> {
  const reason = input.reason ?? 'superseded';
  return prisma.$transaction(async (tx) => {
    const rows = await tx.botActionRequest.findMany({
      where: { botId, requesterKey: input.requesterKey, conversationKey: input.conversationKey, status: { in: ['waiting', 'approved'] } },
    });
    const closed: string[] = [];
    for (const row of rows) {
      const ok = await move(tx, row, ['waiting', 'approved'], { status: 'closed', closedReason: reason, finishedAt: now }, reason === 'cancelled' ? 'cancel' : 'supersede', input.requesterKey);
      if (ok) closed.push(row.id);
    }
    return { closed };
  });
}

/* --------------------------------- running ---------------------------------- */

export type ClaimResult =
  | { claimed: true; action: ActionView; attemptId: string; attemptNo: number; idempotencyKey: string }
  | { claimed: false; reason: 'stale' | ActionStatus; action: ActionView };

/**
 * A dispatcher takes the one go at running an approved request. Only an approved request still inside its start window
 * can be claimed, and only once at a time; a request marked couldn't confirm, running, done or closed never can. The
 * claim and its attempt are written together. The caller rechecks the person, the connection, the policy revision and the
 * arguments' freshness right before it calls the tool.
 */
export async function claim(
  botId: string,
  id: string,
  input: { leaseSeconds?: number } = {},
  now: Date = new Date(),
): Promise<ClaimResult> {
  return prisma.$transaction(async (tx) => {
    const row = await load(tx, botId, id);
    if (await closeIfLapsed(tx, row, now)) return { claimed: false as const, reason: 'stale' as const, action: toView(await load(tx, botId, id)) };
    if (row.status !== 'approved') return { claimed: false as const, reason: row.status as ActionStatus, action: toView(row) };

    const attemptNo = row.attempts.length + 1;
    const won = await move(tx, row, ['approved'], { status: 'running' }, 'claim', null, { startBy: { gt: now } });
    if (!won) return { claimed: false as const, reason: 'approved' as const, action: toView(await load(tx, botId, id)) };

    const attempt = await tx.botActionAttempt.create({
      data: { requestId: id, attemptNo, idempotencyKey: id, leaseExpiresAt: new Date(now.getTime() + seconds(input.leaseSeconds ?? DEFAULTS.leaseSeconds)) },
    });
    return { claimed: true as const, action: toView(await load(tx, botId, id)), attemptId: attempt.id, attemptNo, idempotencyKey: id };
  });
}

export const finishSchema = z
  .object({
    attemptId: z.string().trim().min(1).max(100),
    outcome: z.enum(OUTCOMES),
    providerRequestId: z.string().trim().min(1).max(200).nullish(),
    outcomeClass: z.string().trim().min(1).max(60).nullish(),
  })
  .strict();

/**
 * The dispatcher says how the attempt ended. Only what it can prove counts:
 *
 *   succeeded  a valid response confirms it            → done
 *   failed     a response confirms it did not happen   → failed (never replayed on its own)
 *   notSent    proven not to have been dispatched      → approved again, while it is still inside its start window
 *   uncertain  delivery or effect cannot be established → couldn't confirm; never claimed again by itself
 *
 * An HTTP status alone does not decide this; the caller's reading of the tool's own contract does.
 */
export async function finishAttempt(
  botId: string,
  id: string,
  input: z.infer<typeof finishSchema>,
  now: Date = new Date(),
): Promise<ActionView> {
  return prisma.$transaction(async (tx) => {
    const row = await load(tx, botId, id);
    const attempt = row.attempts.find((a) => a.id === input.attemptId);
    if (!attempt) throw new BotActionError(404, 'attempt_not_found', 'No such attempt');
    if (row.status !== 'running' || attempt.state !== 'claimed') {
      throw new BotActionError(409, 'not_running', 'This attempt is no longer the one running');
    }

    const marked = await tx.botActionAttempt.updateMany({
      where: { id: attempt.id, state: 'claimed' },
      data: { state: input.outcome, finishedAt: now, providerRequestId: input.providerRequestId ?? null, outcomeClass: input.outcomeClass ?? null },
    });
    if (marked.count !== 1) throw new BotActionError(409, 'not_running', 'This attempt is no longer the one running');

    const lapsed = !row.startBy || row.startBy <= now;
    const next: Prisma.BotActionRequestUncheckedUpdateManyInput =
      input.outcome === 'succeeded'
        ? { status: 'done', finishedAt: now }
        : input.outcome === 'failed'
          ? { status: 'failed', finishedAt: now }
          : input.outcome === 'uncertain'
            ? { status: 'couldntConfirm' }
            : lapsed
              ? { status: 'closed', closedReason: 'stale', finishedAt: now }
              : { status: 'approved' };
    if (!(await move(tx, row, ['running'], next, input.outcome === 'notSent' ? 'unsent' : 'finish', null))) {
      throw new BotActionError(409, 'not_running', 'This attempt is no longer the one running');
    }
    return toView(await load(tx, botId, id));
  });
}

/**
 * A person or an authoritative lookup established what happened to a request marked couldn't confirm (for example the
 * destination's own record of the operation). It becomes done or failed; it is never run again.
 */
export async function reconcile(
  botId: string,
  id: string,
  input: { outcome: 'succeeded' | 'failed' },
  now: Date = new Date(),
): Promise<ActionView> {
  return prisma.$transaction(async (tx) => {
    const row = await load(tx, botId, id);
    if (row.status !== 'couldntConfirm') throw new BotActionError(409, 'not_unconfirmed', 'This action is not waiting to be confirmed');
    const ok = await move(tx, row, ['couldntConfirm'], { status: input.outcome === 'succeeded' ? 'done' : 'failed', finishedAt: now }, 'reconcile', null);
    if (!ok) throw new BotActionError(409, 'not_unconfirmed', 'This action is not waiting to be confirmed');
    return toView(await load(tx, botId, id));
  });
}

/**
 * Housekeeping for one bot, safe to run any time and as often as wanted:
 * - cards that waited too long close as expired, approvals nobody started close as stale;
 * - a run whose claim ran out (the dispatcher died) becomes couldn't confirm. The action may have happened, so it is
 *   never claimed again by itself.
 */
export async function sweep(botId: string, now: Date = new Date()): Promise<{ expired: number; stale: number; unconfirmed: number }> {
  return prisma.$transaction(async (tx) => {
    const counts = { expired: 0, stale: 0, unconfirmed: 0 };

    const waiting = await tx.botActionRequest.findMany({ where: { botId, status: 'waiting', reviewExpiresAt: { lte: now } } });
    for (const row of waiting) if (await closeIfLapsed(tx, row, now)) counts.expired += 1;

    const approved = await tx.botActionRequest.findMany({ where: { botId, status: 'approved', startBy: { lte: now } } });
    for (const row of approved) if (await closeIfLapsed(tx, row, now)) counts.stale += 1;

    const running = await tx.botActionRequest.findMany({
      where: { botId, status: 'running', attempts: { some: { state: 'claimed', leaseExpiresAt: { lte: now } } } },
      include: { attempts: true },
    });
    for (const row of running) {
      const attempt = row.attempts.find((a) => a.state === 'claimed');
      if (!attempt) continue;
      const marked = await tx.botActionAttempt.updateMany({
        where: { id: attempt.id, state: 'claimed', leaseExpiresAt: { lte: now } },
        data: { state: 'uncertain', finishedAt: now, outcomeClass: 'lease_expired' },
      });
      if (marked.count === 1 && (await move(tx, row, ['running'], { status: 'couldntConfirm' }, 'finish', null))) counts.unconfirmed += 1;
    }
    return counts;
  });
}

/* ------------------------------ remembered approvals ------------------------------ */

export const grantLookupSchema = z
  .object({
    requesterKey: z.string().trim().min(1).max(400),
    conversationKey: z.string().trim().min(1).max(400),
    connectionRef: z.string().trim().min(1).max(200).nullish(),
    toolName: z.string().trim().min(1).max(255),
    heading: z.enum(HEADINGS),
    toolFingerprint: z.string().trim().min(1).max(128),
    policyRevision: z.number().int().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * The remembered approval that covers this call, if one does: same asker, conversation, connection, tool as reviewed,
 * policy revision and heading, still inside both its idle and absolute time, not revoked, and the arguments fit what it
 * allows. Deleting or sending is never covered. Finding one does not renew it; only the asker's own message does (`touchGrants`).
 */
export async function findGrant(
  botId: string,
  input: z.infer<typeof grantLookupSchema>,
  now: Date = new Date(),
): Promise<{ grantId: string; scope: RememberScope } | null> {
  if (input.heading === 'deletesOrSends') return null;
  const candidates = await prisma.botActionGrant.findMany({
    where: {
      botId,
      requesterKey: input.requesterKey,
      conversationKey: input.conversationKey,
      connectionRef: input.connectionRef ?? null,
      toolName: input.toolName,
      heading: input.heading,
      toolFingerprint: input.toolFingerprint,
      policyRevision: input.policyRevision,
      revokedAt: null,
      idleExpiresAt: { gt: now },
      absoluteExpiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
  });
  for (const grant of candidates) {
    const scope = rememberScopeSchema.safeParse(grant.scope);
    if (scope.success && argumentsFitScope(input.arguments, scope.data)) return { grantId: grant.id, scope: scope.data };
  }
  return null;
}

/**
 * The asker sent a message to the bot in this conversation: their remembered approvals there stay alive another idle
 * period, never past their absolute end. Bot events and other people's messages do not call this.
 */
export async function touchGrants(
  botId: string,
  input: { requesterKey: string; conversationKey: string },
  now: Date = new Date(),
): Promise<{ renewed: number }> {
  const grants = await prisma.botActionGrant.findMany({
    where: { botId, ...input, revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
  });
  let renewed = 0;
  for (const grant of grants) {
    const idleEnd = new Date(now.getTime() + minutes(grant.idleMinutes));
    const next = idleEnd < grant.absoluteExpiresAt ? idleEnd : grant.absoluteExpiresAt;
    const done = await prisma.botActionGrant.updateMany({ where: { id: grant.id, revokedAt: null }, data: { idleExpiresAt: next } });
    renewed += done.count;
  }
  return { renewed };
}

export const REVOKE_REASONS = ['ask_again', 'signed_out', 'connection_changed', 'policy_changed', 'lost_permission', 'left'] as const;

export const revokeSchema = z
  .object({
    requesterKey: z.string().trim().min(1).max(400),
    conversationKey: z.string().trim().min(1).max(400).nullish(),
    reason: z.enum(REVOKE_REASONS),
  })
  .strict();

/**
 * End the asker's remembered approvals for this bot (in one conversation, or all of theirs) because they asked to be
 * asked again, signed out, the connection or policy changed, they lost permission, or they left. Requests still
 * waiting from them close too when they left or signed out.
 */
export async function revokeGrants(
  botId: string,
  input: z.infer<typeof revokeSchema>,
  now: Date = new Date(),
): Promise<{ revoked: number }> {
  const done = await prisma.botActionGrant.updateMany({
    where: { botId, requesterKey: input.requesterKey, ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}), revokedAt: null },
    data: { revokedAt: now, revokedReason: input.reason },
  });
  if (input.reason === 'left' || input.reason === 'signed_out') {
    const waiting = await prisma.botActionRequest.findMany({
      where: { botId, requesterKey: input.requesterKey, ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}), status: { in: ['waiting', 'approved'] } },
    });
    for (const row of waiting) await move(prisma, row, ['waiting', 'approved'], { status: 'closed', closedReason: 'revoked', finishedAt: now }, 'revoke', input.requesterKey);
  }
  return { revoked: done.count };
}
