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
export type StoredOutcome = { ok: true; signInsKept?: boolean; note?: { seq: number; delivery: string }; targets?: string[]; /** Stop all with a confirmed set (round 8, D2): the live jobs not in the set, left alone, newest first. */ left?: Array<{ id: string; title: string }>; /** The pause each paused job's pending answer rests on (its number), so a copy reads exactly those rows however many pauses the job has had since. */ held?: Array<{ jobId: string; n: number }>; pending?: true; /** A Resume's own start attempt has decided (N6, N21, N22, N23 of the d522f4b3 pass): what THAT attempt came to, written by its own `tryStart` the moment it returned, once. A pending Resume is settled from this and from nothing a different try, a newer Resume or a pause did to the job. */ decided?: StoredOutcome } | { ok: false; reason: string };

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
    VALUES (${command.id}::uuid, ${row.botId}, ${row.jobId}, ${row.personId}, ${row.kind}, ${row.argsHash}, ${initial === null ? null : JSON.stringify(initial)}::jsonb, ${row.stretch ?? null}, (NOW() AT TIME ZONE 'UTC'))
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

/**
 * Keeps a FINAL outcome only while the command's stored outcome is still pending (or none): the first final outcome stays, so two copies of one command that finish together answer, and later replay, the same thing
 * (CodeRabbit on #1038). Answers the outcome that was already stored when this write lost (the caller returns it), or null when this write landed.
 */
export async function keepFinalOutcome(command: Command, outcome: StoredOutcome): Promise<StoredOutcome | null> {
  const written = await prisma.$queryRaw<Array<{ command_id: string }>>`
    UPDATE "computer_job_commands" SET "outcome" = ${JSON.stringify(outcome)}::jsonb
    WHERE "command_id" = ${command.id}::uuid AND ("outcome" IS NULL OR "outcome"->>'pending' = 'true')
    RETURNING "command_id"`;
  if (written.length === 1) return null;
  const rows = await prisma.$queryRaw<Array<{ outcome: StoredOutcome | null }>>`SELECT "outcome" FROM "computer_job_commands" WHERE "command_id" = ${command.id}::uuid`;
  return rows[0]?.outcome ?? null;
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

/**
 * What a Resume came to, from a job as it stands and the pause number its command was taken at (CodeRabbit on #1025, N1): the refusal its month or a limit made of the start, a browser that could not be settled, or success.
 * A job that has been paused again since the command was taken (more pauses than the command's stretch) has run: only a job that held the machine is paused with a number, so the command's own start succeeded and a
 * later pause's reason is never its answer. The browser's state (`prepState`) is read only for a job that has NOT been paused since: a pause settles every pending Resume of the job from the job as it stands (`settlePendingResumesIn`,
 * called by the pause itself under the job's lock), so a Resume's browser outcome is recorded per attempt at the moment a later pause or restore could mask it, never inferred afterwards (CodeRabbit on #1025, d522f4b3 pass, N14).
 */
export function resumeOutcomeFrom(job: { status: string; queuedFor: string | null; pausedWhy: string | null; prepState: string | null; pauses: number } | null, stretch: number | null): StoredOutcome {
  if (job && stretch !== null && job.pauses > stretch) return { ok: true };
  if (job?.status === 'queued' && job.queuedFor === 'paused' && (job.pausedWhy === 'allowance' || job.pausedWhy === 'rule')) return { ok: false, reason: job.pausedWhy };
  if (job?.prepState !== null && job?.prepState !== undefined) return { ok: false, reason: 'not_ready' };
  return { ok: true };
}

/**
 * Called, under the job's lock, by every write that takes a job out of `paused` (a Resume, a carry-on of the month or a limit): the Resumes of this job still pending (taken earlier, their request stopped before it kept an answer)
 * are settled NOW from the job as it stands, before the write changes it. A later start then never decides them: a pending Resume only ever answers its own start, never the one a newer Resume or a carry-on makes
 * (CodeRabbit on #1025, N1). Written once: an answer that was already kept stays.
 *
 * Also called by every ENDING of the job (before the ending write, in its transaction) and by every pause. The policy for a Resume with NO recorded decision whose job ends is decided (Opus, 24 Nov): it is settled from the job as it stood just
 * before the ending, and that is FINAL, since no later decision can come for an ended job. A job that ran with its browser settled (`running` or `waiting`, no `prep_state`) answers ok: the Resume asked for the job to carry on and it did (only a
 * start that passes the month and the rules makes a job run, and a carry-on settles pending Resumes first). A browser still `restoring` or in `recover` answers `not_ready`. A RECORDED decision (`row.decided`) always wins over the job row,
 * whatever state the job is in when it ends (CodeRabbit on #1025, 14c4e407 pass, N7).
 */
export async function settlePendingResumesIn(tx: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>, jobId: string, except: string | null = null): Promise<number> {
  const pending = await tx.$queryRaw<Array<{ command_id: string; stretch: number | null; decided: StoredOutcome | null; status: string; queued_for: string | null; paused_why: string | null; prep_state: string | null; pauses: number }>>`
    SELECT c."command_id", c."stretch", c."outcome"->'decided' AS "decided", j."status", j."queued_for", j."paused_why", j."prep_state", j."pauses"
    FROM "computer_job_commands" c JOIN "computer_jobs" j ON j."id" = c."job_id"
    WHERE c."job_id" = ${jobId} AND c."kind" IN ('resume', 'first') AND c."outcome"->>'pending' = 'true' AND c."outcome"->'targets' IS NULL AND (${except}::text IS NULL OR c."command_id" <> ${except}::uuid)`;
  let settled = 0;
  for (const row of pending) {
    // What the Resume's OWN start attempt came to, when it recorded that: never re-read from a job that other tries, a newer Resume or a pause have changed since. Only a Resume that never recorded one (its request stopped inside its
    // start) is read from the job as it stands now
    const outcome = row.decided ?? resumeOutcomeFrom({ status: row.status, queuedFor: row.queued_for, pausedWhy: row.paused_why, prepState: row.prep_state, pauses: row.pauses }, row.stretch);
    settled += await tx.$executeRaw`UPDATE "computer_job_commands" SET "outcome" = ${JSON.stringify(outcome)}::jsonb WHERE "command_id" = ${row.command_id}::uuid AND "outcome"->>'pending' = 'true'`;
  }
  return settled;
}

/** The pause number a command was taken at (its `stretch`): null for a command that has none. */
export async function stretchOfCommand(command: Command): Promise<number | null> {
  const rows = await prisma.$queryRaw<Array<{ stretch: number | null }>>`SELECT "stretch" FROM "computer_job_commands" WHERE "command_id" = ${command.id}::uuid`;
  return rows[0]?.stretch ?? null;
}

/**
 * Records what a Resume's OWN start attempt came to, on its own command, at the moment its `tryStart` returned (once: the first record stays). A pending Resume is read from this alone: another try of the same job (the queue sweep, which
 * can write its own decision for the same place in line), a newer Resume, a pause or a Cancel never decides it, so a copy never stores a success the Resume's own start may still turn into a refusal, and never returns a different
 * attempt's outcome (CodeRabbit on #1025, d522f4b3 pass, N6, N21, N22, N23). The outcome is read from the job right after the attempt's own try, with the pause number the command was taken at.
 */
export async function recordResumeDecision(commandId: string, jobId: string, stretch: number | null): Promise<void> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { status: true, queuedFor: true, pausedWhy: true, prepState: true, pauses: true } });
  const outcome = resumeOutcomeFrom(job, stretch);
  await prisma.$executeRaw`
    UPDATE "computer_job_commands" SET "outcome" = jsonb_set("outcome", '{decided}', ${JSON.stringify(outcome)}::jsonb)
    WHERE "command_id" = ${commandId}::uuid AND "outcome"->>'pending' = 'true' AND "outcome"->'decided' IS NULL`;
}

/** What a pending Resume's own start attempt recorded (see `recordResumeDecision`), or null while it has not. */
export async function decidedOfCommand(command: Command): Promise<StoredOutcome | null> {
  const rows = await prisma.$queryRaw<Array<{ decided: StoredOutcome | null }>>`SELECT "outcome"->'decided' AS "decided" FROM "computer_job_commands" WHERE "command_id" = ${command.id}::uuid`;
  return rows[0]?.decided ?? null;
}
