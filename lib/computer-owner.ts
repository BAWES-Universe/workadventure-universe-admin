/**
 * One owner per computer job (GPT round 5, E1-E6). A job has an ownership epoch (`computer_jobs.owner_epoch`): a runner CLAIMS the job saying the epoch it last saw, and only the one that saw the current one wins; every
 * request it makes afterwards names the epoch it won. The rule is checked IN the write that takes effect (a transaction under the job's cutoff lock with its row locked, or the `WHERE` of the conditional update that lands
 * it), never in an earlier read: an older worker's request that was in flight when a newer one claimed meets the newer epoch there and does nothing.
 *
 * A request that names NO epoch is a worker of a version that does not know epochs: it is accepted only while the job has none (epoch 0, a job nobody claimed), exactly as before, and by nobody after a claim.
 */
import { Prisma } from '@prisma/client';
import { ORBIT_SOURCE, POOL_CUTOFF_CALL, lockCutoff } from '@/lib/computer-faults';

/** What a request says about the epoch it acts under: a number, or nothing (a worker that knows none). */
export type EpochSaid = number | null | undefined;

/** Whether a worker that says `said` owns a job at `jobEpoch`: it must name exactly that epoch, or name none while the job has none. */
export const epochMatches = (jobEpoch: number, said: EpochSaid): boolean => (said === undefined || said === null ? jobEpoch === 0 : jobEpoch === said);

/** The answer every superseded worker gets, on every route: the game reads `run: 'superseded'` and exits (no cancel, no ending). */
export const SUPERSEDED = { ok: false as const, reason: 'stale' as const, run: 'superseded' as const };

/** What the job's row says under its lock. */
export interface OwnedRow {
  id: string;
  botId: string;
  personId: string;
  status: string;
  control: string;
  controlGeneration: number;
  ownerEpoch: number;
  leaseVersion: number;
  agentResponseId: string | null;
  /** How long the owner's hold on the job stands without another beat from it: while it is in the future nobody else may claim the job (GPT round 6, finding 3). Null = nobody holds it (never claimed, or the owner let it go). */
  ownerLeaseUntil: Date | null;
  /** How far a job that carried on is from being ready to be worked on: null = ready, `restoring` = its browser is coming back, `recover` = it could not be settled and the sweep owns it (GPT round 6, finding 7). */
  prepState: string | null;
}

/**
 * How long one beat from the owner holds the job for. A runner beats every 30 s, so two beats may be lost before anyone else may take it; a worker that died is taken over within this, plus the sweep.
 * Short enough that a crash does not strand a job for long, long enough that a slow turn, a garbage collection or a rolling deploy never makes two workers run one job.
 */
export const OWNER_LEASE_MS = 90_000;

/** When the owner's hold stands until, from a beat (or a claim) at `now`. */
export const leaseUntil = (now: Date): Date => new Date(now.getTime() + OWNER_LEASE_MS);

/** Reads the job's row and locks it (`FOR UPDATE`). Call it AFTER the job's cutoff lock (and the person's give-back lock, when one is taken): the order used everywhere. */
export async function lockJobRow(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, jobId: string): Promise<OwnedRow | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; bot_id: string; person_id: string; status: string; control: string; control_generation: number; owner_epoch: number; lease_version: number; agent_response_id: string | null; owner_lease_until: Date | null; prep_state: string | null }>>(
    Prisma.sql`SELECT "id", "bot_id", "person_id", "status", "control", "control_generation", "owner_epoch", "lease_version", "agent_response_id", "owner_lease_until", "prep_state" FROM "computer_jobs" WHERE "id" = ${jobId} FOR UPDATE`,
  );
  const row = rows[0];
  return row
    ? { id: row.id, botId: row.bot_id, personId: row.person_id, status: row.status, control: row.control, controlGeneration: row.control_generation, ownerEpoch: row.owner_epoch, leaseVersion: row.lease_version, agentResponseId: row.agent_response_id, ownerLeaseUntil: row.owner_lease_until, prepState: row.prep_state }
    : null;
}

/** The cutoff lock, then the job's row locked: for a decision that needs only these two. */
export async function lockJob(tx: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>, jobId: string): Promise<OwnedRow | null> {
  await lockCutoff(tx, jobId);
  return lockJobRow(tx, jobId);
}

/** The body of a refusal a broker route answers (HTTP 409): a worker that is not the owner gets the game's `superseded` shape, every other reason its own word. */
export const refusalBody = (reason: string): { ok: false; reason: string; run?: 'superseded' } => (reason === 'superseded' ? SUPERSEDED : { ok: false, reason });

/** The `where` of a conditional write that only the job's owner may land: the epoch is the one the worker says (none = a worker that knows none: only while the job has none). */
export const ownerWhere = (epoch: EpochSaid): { ownerEpoch: number } => ({ ownerEpoch: epoch ?? 0 });

/** The `where` of a conditional write that must find no ending decided: no finish intent kept and no pool cutoff (then the finalizer owns the ending). */
export const noEndingWhere = { finishIntent: { is: null }, faults: { none: { callId: POOL_CUTOFF_CALL, source: ORBIT_SOURCE } } } as const;
