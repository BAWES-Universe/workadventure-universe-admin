import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';

/**
 * One control, one effect (GPT round 6, finding 4; Rule D, identity). Every control the person gives a computer job (Pause, Resume, Cancel, Stop all, Do this first, a note) carries a command id that is stable
 * for that one click or that one tool call of Brick's: the panel makes a uuid at the click and keeps it with the pending request (a resend reuses it); Brick's tools derive it from the chat event, the kind, the
 * job and the call's number in that turn (a retried turn gives the same ids, a new message new ones, so a deliberate second identical note still works).
 *
 * The id is written in `computer_job_commands` BEFORE its effect, in the transaction that applies it where the control has one (pause, resume, do this first, a note): the same id again finds the row and returns its
 * stored outcome, writing nothing at all (no second pause or time event, no note number, no provider cancel: the turn a note cancels is the one stored on its row, cancelled once by the request that kept it). The same
 * id with OTHER arguments is refused (`command_reused`). Cancel and Stop end jobs through the finalizer's own transactions: their row is committed first, naming the jobs it is for, so a replay can only ever finish
 * ending THOSE jobs (never one started after it), and returns the stored outcome once there is one.
 */

/** The request header that carries the command id (a uuid). Required on every new control route; the 0.4.3 game's Stop has none and is answered as before. */
export const COMMAND_HEADER = 'x-computer-command';
export const commandIdSchema = z.string().uuid();

export type CommandKind = 'pause' | 'resume' | 'cancel' | 'stop' | 'first' | 'note';

/** A command as the library takes it: its id (who gave it and what for are the control's own arguments, hashed into its row). */
export interface Command {
  id: string;
}

/** What a control came to, as it is kept and replayed (the computer view is read fresh on a replay: it is how things stand now). */
export type StoredOutcome = { ok: true; signInsKept?: boolean; note?: { seq: number; delivery: string }; targets?: string[]; /** Stop all with a confirmed set (round 8, D2): the live jobs not in the set, left alone, newest first. */ left?: Array<{ id: string; title: string }>; pending?: true } | { ok: false; reason: string };

export type Claimed =
  /** First time: apply the effect (and keep its outcome). */
  | { fresh: true }
  /** Seen before with the same arguments: its stored outcome (null while the first request has not kept one). Nothing is written. */
  | { replay: StoredOutcome | null; targets: string[] | null }
  /** Seen before with other arguments: refused, nothing written. */
  | { reused: true };

/** The hash of what a command asks: its kind, the job, and its arguments (a note's words, "pause what is running"). The same id must always ask the same thing. */
export function argsHashOf(kind: CommandKind, jobId: string | null, args: Record<string, unknown> = {}): string {
  const sorted = Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify({ kind, jobId, args: sorted })).digest('hex');
}

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Writes the command's row FIRST, inside the caller's transaction (so it commits with the effect, or not at all). A second request with the same id waits on the row the first wrote, then reads it.
 * `initial` is kept as its outcome when the effect's own transaction is not this one (Cancel, Stop: `{ ok: true, pending: true, targets }`).
 */
export async function claimCommandIn(db: Db, command: Command, row: { botId: string; personId: string; jobId: string | null; kind: CommandKind; argsHash: string; stretch?: number | null }, initial: StoredOutcome | null = null): Promise<Claimed> {
  const inserted = await db.$queryRaw<Array<{ command_id: string }>>`
    INSERT INTO "computer_job_commands" ("command_id", "bot_id", "job_id", "person_id", "kind", "args_hash", "outcome", "stretch", "created_at")
    VALUES (${command.id}::uuid, ${row.botId}, ${row.jobId}, ${row.personId}, ${row.kind}, ${row.argsHash}, ${initial === null ? null : JSON.stringify(initial)}::jsonb, ${row.stretch ?? null}, NOW())
    ON CONFLICT ("command_id") DO NOTHING
    RETURNING "command_id"`;
  if (inserted.length === 1) return { fresh: true };
  const seen = await db.$queryRaw<Array<{ args_hash: string; bot_id: string; person_id: string; outcome: StoredOutcome | null }>>`
    SELECT "args_hash", "bot_id", "person_id", "outcome" FROM "computer_job_commands" WHERE "command_id" = ${command.id}::uuid`;
  const found = seen[0];
  // Another Brick's or person's command under this id, or other arguments: never this one's outcome
  if (!found || found.args_hash !== row.argsHash || found.bot_id !== row.botId || found.person_id !== row.personId) return { reused: true };
  const outcome = found.outcome;
  return { replay: outcome && outcome.ok && outcome.pending ? null : outcome, targets: outcome && outcome.ok && outcome.targets ? outcome.targets : null };
}

/** Keeps what the command came to (in the caller's transaction, or after it for the steps that follow a commit). `turnResponseId`: the one turn a note may cancel. */
export async function keepOutcome(db: Pick<Prisma.TransactionClient, '$executeRaw'>, command: Command, outcome: StoredOutcome, extra: { turnResponseId?: string | null } = {}): Promise<void> {
  await db.$executeRaw`
    UPDATE "computer_job_commands" SET "outcome" = ${JSON.stringify(outcome)}::jsonb, "turn_response_id" = COALESCE(${extra.turnResponseId ?? null}, "turn_response_id")
    WHERE "command_id" = ${command.id}::uuid`;
}

/** Claims a command in a transaction of its own (Cancel, Stop: their effect runs in the finalizer's transactions). */
export const claimCommand = (command: Command, row: CommandRow, initial: StoredOutcome) =>
  prisma.$transaction((tx) => claimCommandIn(tx, command, row, initial), { timeout: 15_000, maxWait: 15_000 });

/** The row a command is kept under, as a control makes it. */
export type CommandRow = Parameters<typeof claimCommandIn>[2];

/** The row of a control of one job (or of the whole computer, for Stop: `jobId` null). `args`: what else the control asks (a note's words, "pause what is running"). */
export const commandRow = (botId: string, personId: string, jobId: string | null, kind: CommandKind, args: Record<string, unknown> = {}, stretch: number | null = null): CommandRow => ({
  botId,
  personId,
  jobId,
  kind,
  argsHash: argsHashOf(kind, jobId, args),
  stretch,
});

/**
 * A command seen before, read before anything else is (the look a control takes outside its transaction can differ from the first request's: a "do this first" replayed after its job started must still be ITS answer).
 * Null: never seen (the control goes on, and claims it in its transaction, which settles a race of two copies). Reads only.
 */
export async function seenCommand(command: Command, row: CommandRow): Promise<Exclude<Claimed, { fresh: true }> | null> {
  const seen = await prisma.$queryRaw<Array<{ args_hash: string; bot_id: string; person_id: string; outcome: StoredOutcome | null }>>`
    SELECT "args_hash", "bot_id", "person_id", "outcome" FROM "computer_job_commands" WHERE "command_id" = ${command.id}::uuid`;
  const found = seen[0];
  if (!found) return null;
  if (found.args_hash !== row.argsHash || found.bot_id !== row.botId || found.person_id !== row.personId) return { reused: true };
  const outcome = found.outcome;
  return { replay: outcome && outcome.ok && outcome.pending ? null : outcome, targets: outcome && outcome.ok && outcome.targets ? outcome.targets : null };
}

/** A refusal found before the control's own transaction (the job is over, or not in the state the tap was for): kept as the command's outcome, so the same command always answers the same. */
export const refuseUnder = (command: Command, row: CommandRow, reason: string) => claimCommand(command, row, { ok: false, reason });

/** The command id a request carries: null when the header is absent (the 0.4.3 game's Stop), `invalid` when it is there and is not a uuid, an empty one included: a panel that sent it empty must never be answered as an unkeyed request (CodeRabbit on #1025, 46). */
export function commandOf(request: Request): Command | null | 'invalid' {
  const raw = request.headers.get(COMMAND_HEADER);
  if (raw === null) return null;
  const parsed = commandIdSchema.safeParse(raw.trim());
  return parsed.success ? { id: parsed.data.toLowerCase() } : 'invalid';
}
