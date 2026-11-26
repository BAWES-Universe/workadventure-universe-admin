import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { extendHoldIn, leaseUntil } from '@/lib/computer-lease';

/**
 * What the game relay saw go wrong on a computer job's model calls, kept by Orbit (table computer_job_faults) so that Orbit, and not the memory of one
 * process, judges whether a failed job is given back (lib/computer-giveback). The relay writes one row per call (or per turn with no call: call id
 * `turn:<n>`) BEFORE the job finishes. The relay says what it saw; the CLASS of each reason is Orbit's:
 *
 *  - `ours`: a fault no job's words can cause. A relay-side fault (no route, the call could not be authorized, a key could not be read, the pool is full, the computer could not reach the relay)
 *    or the provider refusing OUR key or model (401, 402, 403, 404). Always given back, never counted. The relay must also say so (kind `fault`).
 *  - `person`: caused by the person, with evidence: their allowance or a spending rule stopped the call, the call ran on their own provider key, or the
 *    provider refused a request field the job itself set. Charged like any run. The relay must also say so (kind `not_ours`).
 *  - `unresolved`: could be a fault of ours or the job's own doing (a provider 5xx or 429, a stream that broke, a timeout, a 400 with no field named, a field
 *    only the relay sets, or a reason Orbit does not know). The bounded goodwill, and one provider failing for many people is an incident that is corrected
 *    together. A turn the runner judged failed that has no row at all is unresolved too (lib/computer-giveback).
 *
 * Judged by KIND and reason together: neither the relay's word nor a reason word alone makes a call ours or the person's. A reason Orbit maps to ours that the
 * relay did not confirm (kind `uncertain`) is unresolved; so is a confirmed kind on a reason Orbit does not map to that class.
 *
 * Rows carry a reason word, a status and a route, never any content of a call.
 */

export const FAULT_KINDS = ['fault', 'not_ours', 'uncertain', 'answered'] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];
export const FAULT_SOURCES = ['universe-ai', 'own-key'] as const;
export type FaultSource = (typeof FAULT_SOURCES)[number];
/**
 * Who made a row: the relay's rows say `universe-ai` or `own-key` (the only sources the route lets through), and the rows Orbit makes itself (its capacity refusals, its cutoff, its own-key marker) say `orbit`. That is the
 * PROVENANCE of a row: Orbit's own rows are told from the relay's by it, never by a call id the relay could also write, so no row the relay sends can pass for one of ours or be retired as one.
 */
export const ORBIT_SOURCE = 'orbit';
/** The call ids Orbit gives its own rows start with this. The relay's own ids that start so are kept under another key (`relayKeyOf`), so a relay row can never hold the key of one of Orbit's. */
const ORBIT_KEY_PREFIX = 'orbit:';
export type FaultClass = 'ours' | 'person' | 'unresolved';

/**
 * The computer could not reach the model relay at all (a wrong address, a relay that is down, a reply that is not the relay's): nothing about the job reached the relay, so there is no call to
 * write a row for. Written by Orbit itself from what the runner says at prepare, or from the absence of every call at a failed finish (lib/computer-giveback). Ours, always.
 */
export const RELAY_UNREACHABLE = 'relay_unreachable';
/**
 * The relay's own word that it was REACHED: for every request it authenticated (Orbit's identify answered ok) the game writes one durable row per job, run and turn (call id `arrival_<run>_<turn>`,
 * `arrival_<run>_` when the turn cannot be told), kind `answered`, this reason, source `universe-ai`, no route, no status. It carries no body, authorizes no spend and is never a fault (`answered` has no
 * fault class). It is read for one thing: a run that has one reached the relay, so Orbit never concludes from the absence of rows that it did not (`neverReachedRelay`).
 */
export const RELAY_REACHED = 'relay_reached';
/** The mark on the call id of the row Orbit keeps when it INFERRED that the relay was never reached (from the absence of every trace of a call). Its own observation at prepare has no such mark. */
const INFERRED_CALL_SUFFIX = ':inferred';
export const isInferredUnreachableRow = (row: { callId: string }): boolean => row.callId.startsWith('orbit:') && row.callId.endsWith(`${RELAY_UNREACHABLE}${INFERRED_CALL_SUFFIX}`);
/**
 * The rows the game's runner keeps when its computer could not reach the model relay, as it knows it (it has no call to name): a call id that starts `relay_unreachable_` (the marker it keeps when its prepare
 * could not) or `no_call_` (a turn in which no call reached the relay), with the reason `relay_down` (read only on a row of ours, so the relay's word `fault`: `faultClassOf`). The relay's own `relay_down` (its 503 "service busy": the computer DID
 * reach us) is always a real call's id, never one of these. Such a row says the same thing as Orbit's own `relay_unreachable` finding.
 */
export const RUNNER_NO_RELAY_CALL_PREFIXES: readonly string[] = ['relay_unreachable_', 'no_call_'];
export const isRunnerNoRelayRow = (row: { callId: string; reason: string }): boolean =>
  row.reason === 'relay_down' && RUNNER_NO_RELAY_CALL_PREFIXES.some((prefix) => row.callId.startsWith(prefix));
export const OURS_REASONS: readonly string[] = ['relay_down', 'route_unknown', 'authorize_failed', 'key_decrypt_failed', 'pool_busy', 'provider_key_ours', RELAY_UNREACHABLE];
export const PERSON_REASONS: readonly string[] = ['field_job_set', 'allowance', 'rule', 'own_provider'];
export const UNRESOLVED_REASONS: readonly string[] = ['provider_5xx', 'provider_429', 'stream_cut', 'timeout_no_output', 'timeout_after_output', 'fieldless_400', 'field_relay_set', 'provider_403'];

/** The class of one row; null for a call that was answered (it says nothing about a failure). A reason Orbit does not know is unresolved, never ours. */
export function faultClassOf(row: { kind: string; reason: string; source: string }): FaultClass | null {
  if (row.kind === 'answered') return null;
  // The source alone never charges anyone: the game writes source own-key on EVERY row of a call on the person's own key, including our relay being down.
  // Their provider refusing their key is theirs, when the relay says it is not ours (kind `not_ours`): an unconfirmed row stays unresolved like any other, and a row that says
  // `fault` on a call made with their own key contradicts itself, so it is unresolved too. Everything else is read by kind and reason below, own key or not
  if (row.source === 'own-key' && row.reason === 'provider_key_ours') return row.kind === 'not_ours' ? 'person' : 'unresolved';
  // On the person's own key the relay says `not_ours / own_provider` only for what is theirs: their provider refusing their credential or credit (a status, or a key code inside a stream with
  // none) and their own key resting (a 503 the relay answers itself). A generic upstream 5xx, a 429, a cut stream, a timeout, an unreachable endpoint or a plain 403 is sent `uncertain` with the
  // reasons below (provider_5xx, provider_429, stream_cut, timeout_*, provider_403), which this reads as unresolved like the same failure on Universe's key
  // Ours or the person's only when the reason and the relay's own word agree; anything else could be either
  if (OURS_REASONS.includes(row.reason) && row.kind === 'fault') return 'ours';
  if (PERSON_REASONS.includes(row.reason) && row.kind === 'not_ours') return 'person';
  return 'unresolved';
}

export interface FaultInput {
  turn?: number | null;
  /** The runner's run the turn was numbered in; absent from a runner that names none. */
  run?: string | null;
  callId: string;
  kind: FaultKind;
  reason: string;
  source: FaultSource;
  route?: string | null;
  providerStatus?: number | null;
  at: Date;
}

/**
 * Keeps what the relay saw, once per (job, call): a row written again changes nothing, except that an `uncertain` one may be settled once (to what it turned
 * out to be). The Brick must own the job. Returns how many rows are kept for this job after the write that were new or settled, or null for an unknown job.
 */
export async function recordFaults(botId: string, jobId: string, rows: FaultInput[]): Promise<{ stored: number; conflicts: number } | null> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true, botId: true } });
  if (!job || job.botId !== botId) return null;
  if (rows.length === 0) return { stored: 0, conflicts: 0 };
  let stored = 0;
  let conflicts = 0;
  for (const row of rows) {
    const run = row.run ? row.run.slice(0, 40) : null;
    const data = {
      jobId,
      turn: row.turn ?? null,
      run,
      callId: keyOfCall(row.callId, run),
      kind: row.kind,
      reason: row.reason.slice(0, 32),
      source: row.source,
      route: row.route ? row.route.slice(0, 120) : null,
      providerStatus: row.providerStatus ?? null,
      at: row.at,
    };
    // An arrival row (the relay says this run reached it) is written under the lock the finish's inference takes, in its own transaction, so the two never interleave, whatever its call id is: that is checked FIRST,
    // so a runless arrival under a turn-only id (`turn:1`) takes the lock as well. Written with skipDuplicates (a duplicate inside a transaction would abort it)
    if (isArrivalRow(data)) {
      const outcome = await prisma.$transaction(async (tx) => {
        await lockRelayReach(tx, jobId);
        // A runless arrival under a turn-only id shares its key with the faults of every unnamed run: it takes the same slots they do
        if (!run && data.callId.startsWith('turn:')) {
          const slot = await recordUnnamedTurnRow(tx, jobId, data);
          return { stored: slot.stored, conflict: slot.conflict, unnamedSlots: true };
        }
        const made = await tx.computerJobFault.createMany({ data: [data], skipDuplicates: true });
        if (made.count > 0) return { stored: 1, conflict: false, unnamedSlots: false };
        // Already kept as an uncertain row of the SAME run and turn (the call was reported unsure and the relay now says the run did reach it): that row is settled, under the same lock and counted as stored. Another
        // run's or another turn's row under this call id is never touched (that is the conflict below)
        const settled = await tx.computerJobFault.updateMany({
          where: { jobId, callId: data.callId, kind: 'uncertain', run: data.run, turn: data.turn },
          data: { kind: data.kind, reason: data.reason, source: data.source, route: data.route, providerStatus: data.providerStatus, at: data.at, createdAt: new Date() },
        });
        if (settled.count > 0) return { stored: settled.count, conflict: false, unnamedSlots: false };
        const kept = await tx.computerJobFault.findUnique({ where: { jobId_callId: { jobId, callId: data.callId } }, select: { run: true, turn: true } });
        return { stored: 0, conflict: !!kept && (kept.run !== data.run || kept.turn !== data.turn), unnamedSlots: false };
      });
      stored += outcome.stored;
      if (outcome.conflict) {
        conflicts++;
        console.error(outcome.unnamedSlots ? '[Computer] A fault row could not be kept: too many different reports for one turn of unnamed runs. Job' : '[Computer] A fault row could not be kept: its call id is already used by another run or turn of the job. Job', jobId);
      }
      continue;
    }
    // A fault of a turn (no call id of its own: `turn:<n>`) from a runner that names no run: two runs of the job, both unnamed, number their turns from 1 again and would share this key, and the second
    // report of a different fault would be taken for the first said again and dropped. Each DIFFERENT report is kept under its own stable slot (`turn:1`, `turn:1~2`, ...); the same report said again is
    // the same slot, and changes nothing
    if (!run && data.callId.startsWith('turn:')) {
      const outcome = await recordUnnamedTurnRow(prisma, jobId, data);
      stored += outcome.stored;
      if (outcome.conflict) {
        conflicts++;
        console.error('[Computer] A fault row could not be kept: too many different reports for one turn of unnamed runs. Job', jobId);
      }
      continue;
    }
    try {
      await prisma.computerJobFault.create({ data });
      stored++;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      // Already kept: only an uncertain one may be settled, and only once
      if (row.kind !== 'uncertain') {
        const settled = await prisma.computerJobFault.updateMany({
          // Only the SAME run's and turn's uncertain row is settled by this one: another run's confirmed fault under the same call id never upgrades it (that falls to the conflict check)
          where: { jobId, callId: data.callId, kind: 'uncertain', run: data.run, turn: data.turn },
          // The row is new evidence from now on: `createdAt` is when Orbit learned it (the late-evidence sweep reads nothing else of it), so a confirmation of an old uncertain row is seen
          data: { kind: data.kind, reason: data.reason, source: data.source, route: data.route, providerStatus: data.providerStatus, at: data.at, createdAt: new Date() },
        });
        stored += settled.count;
        if (settled.count > 0) continue;
      }
      // A row that is not the one already kept (another run's, or another turn's, under the same call id) is never dropped silently: it is counted and said
      const kept = await prisma.computerJobFault.findUnique({ where: { jobId_callId: { jobId, callId: data.callId } }, select: { run: true, turn: true } });
      if (kept && (kept.run !== data.run || kept.turn !== data.turn)) {
        conflicts++;
        console.error('[Computer] A fault row could not be kept: its call id is already used by another run or turn of the job. Job', jobId);
      }
    }
  }
  return { stored, conflicts };
}

/** How many different reports one turn of unnamed runs may keep (the slots `turn:1`, `turn:1~2` ... of its key); a ninth different one is counted as a conflict and said in the log, never dropped silently. */
const UNNAMED_TURN_SLOTS = 8;

/** Whether two rows say the same thing about a call (when it was seen is not part of it). */
const sameReport = (a: { kind: string; reason: string; source: string; route: string | null; providerStatus: number | null }, b: { kind: string; reason: string; source: string; route: string | null; providerStatus: number | null }) =>
  a.kind === b.kind && a.reason === b.reason && a.source === b.source && a.route === b.route && a.providerStatus === b.providerStatus;

/**
 * Keeps one turn-only row from a runner that names no run. The first slot is the plain key; a report that says the same as a row already kept (a retry) changes nothing, and a report that says something else
 * goes to the next free slot. A row of an unnamed run is NEVER settled by another report: every unnamed row has no run and the same turn number, so there is no telling whether a confirmed report belongs to the
 * run of an uncertain row or to another run, and settling it would lose the evidence of the first (a person's row could turn an unresolved one into a charge). Both rows are kept and the ruling reads both (ours
 * wins; a person's row beside an unresolved one reads as unresolved). Returns what was stored, and whether every slot was taken by other reports (a conflict).
 */
async function recordUnnamedTurnRow(
  db: Pick<Prisma.TransactionClient, 'computerJobFault'>,
  jobId: string,
  data: { jobId: string; turn: number | null; run: string | null; callId: string; kind: string; reason: string; source: string; route: string | null; providerStatus: number | null; at: Date },
): Promise<{ stored: number; conflict: boolean }> {
  for (let slot = 1; slot <= UNNAMED_TURN_SLOTS; slot += 1) {
    const callId = slot === 1 ? data.callId : `${data.callId}~${slot}`.slice(0, 120);
    const kept = await db.computerJobFault.findUnique({ where: { jobId_callId: { jobId, callId } } });
    if (!kept) {
      // Written with skipDuplicates (a duplicate inside a transaction would abort it): nothing written means another report took the slot at the same moment, and that slot is looked at again
      const made = await db.computerJobFault.createMany({ data: [{ ...data, callId }], skipDuplicates: true });
      if (made.count > 0) return { stored: 1, conflict: false };
      slot -= 1;
      continue;
    }
    // Not the same series (another run or turn under this key): never the one this report belongs to
    if (kept.run !== data.run || kept.turn !== data.turn) continue;
    if (sameReport(kept, data)) return { stored: 0, conflict: false };
  }
  return { stored: 0, conflict: true };
}

/**
 * The key a call is kept under. A fault with no call is `turn:<n>`, and turns are numbered again by every run of a job (a restart), so a turn-only id is
 * qualified by the run that numbered it: two runs never share a key. A real call id is the model call's own and is kept as it is. A runner that names no run
 * has one numbering as far as Orbit can tell.
 */
function keyOfCall(callId: string, run: string | null): string {
  const key = run && callId.startsWith('turn:') ? `${run}:${callId}` : callId;
  // The `orbit:` keys are Orbit's own: an id the relay sends that starts so is kept under the relay's own key, so it can neither take the place of a row of ours (a second one of ours would then be dropped as already kept) nor pass for one
  return (key.startsWith(ORBIT_KEY_PREFIX) ? `relay:${key}` : key).slice(0, 120);
}

/**
 * Keeps that a job's computer could not reach the model relay, as a confirmed fault of ours (kind `fault`, reason `relay_unreachable`, no route: it is no provider's). One row per job and run
 * (the call id is Orbit's own, `orbit:<run>:relay_unreachable`, so it is never the relay's row of the same name), so saying it twice changes nothing. The job must exist. Never reads or writes anything of a call.
 */
export async function recordRelayUnreachable(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string, input: { run?: string | null; status?: number | null; at?: Date; inferred?: boolean } = {}): Promise<void> {
  const run = input.run ? input.run.slice(0, 40) : null;
  // `skipDuplicates` (ON CONFLICT DO NOTHING): inside a transaction a unique violation would abort the whole of it, and saying it twice must change nothing
  await db.computerJobFault.createMany({
    data: [{ jobId, turn: null, run, callId: `orbit:${run ? `${run}:` : ''}${RELAY_UNREACHABLE}${input.inferred ? INFERRED_CALL_SUFFIX : ''}`.slice(0, 120), kind: 'fault', reason: RELAY_UNREACHABLE, source: 'universe-ai', route: null, providerStatus: input.status ?? null, at: input.at ?? new Date() }],
    skipDuplicates: true,
  });
}

/** Whether a row (as the relay sends it, or as it is kept) is the relay's arrival row: answered / relay_reached from the relay. Such a row is invisible to every ruling about money except the one question it answers (`neverReachedRelay`) and the re-labelling of a reason. */
export const isArrivalRow = (row: { kind: string; reason: string; source: string }): boolean => row.kind === 'answered' && row.reason === RELAY_REACHED && row.source === 'universe-ai';

/**
 * The rows that apply to a ruling on one run: those that name that run and those that name none (they cannot be told apart, so they count for every run). A ruling that knows NO run (an older runner
 * named none) is scoped to the rows that name none: another run's row never counts for it (what is not known favours the person: it is never taken for a trace or an arrival of a run nobody named).
 */
export const rowsOfRun = (run: string | null | undefined): Prisma.ComputerJobFaultWhereInput => (run ? { OR: [{ run: null }, { run }] } : { run: null });

/** Whether the relay said it was reached by this run of the job (an arrival row of the run, or one that names no run): then the run is never judged to have missed the relay for want of a row. */
export async function relayReachedInRun(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string, run: string | null | undefined): Promise<boolean> {
  return (await db.computerJobFault.count({ where: { jobId, kind: 'answered', reason: RELAY_REACHED, source: 'universe-ai', ...rowsOfRun(run) } })) > 0;
}

/**
 * The lock an arrival row's write and the finish's inference that the relay was never reached both take (per job, held to the end of the transaction), so one never lands between the other's two reads:
 * the finish reads the arrival, then the trace of calls, and an arrival that committed between those two reads would be missed and an outage given back for a run that reached the relay. Taken before any
 * read it protects, never while holding the person's lock the other way round (the arrival write takes only this one).
 */
export const lockRelayReach = (tx: Pick<Prisma.TransactionClient, '$executeRaw'>, jobId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`computer:relay-reach:${jobId}`}))`;

export interface FaultRow {
  turn: number | null;
  callId: string;
  kind: string;
  reason: string;
  source: string;
  route: string | null;
  cls: FaultClass;
}

type Db = Pick<Prisma.TransactionClient, 'computerJobFault'>;

/**
 * The rows that count for a ruling: the ones for the turns the runner judged failed IN THE RUN it names (a restart makes a new run that numbers turns again; no
 * run matches no run), or every row of the job when it named no turns. A row with no turn applies to the whole job, so it counts for a ruling on a run only when it
 * names no run or names that very run: another named run's row never does. Answered calls are not read at all (they say nothing about a failure, and they must
 * never fill a page ahead of a fault), and every matching row is read, a page at a time, so what the verdict rests on never depends on a limit.
 */
export async function readFaultRows(db: Db, jobId: string, turns: readonly number[] | null | undefined, run: string | null | undefined = null, options: { turnlessOnly?: boolean } = {}): Promise<FaultRow[]> {
  const named = run ?? null;
  const turnless: Prisma.ComputerJobFaultWhereInput = named ? { turn: null, OR: [{ run: null }, { run: named }] } : { turn: null, run: null };
  // `turnlessOnly`: a ruling that judged no turn (there is no numbered row to judge) rests on the rows that apply to the whole job, never on the numbered rows of other runs, which an
  // empty list of turns would also read
  const where: Prisma.ComputerJobFaultWhereInput = {
    jobId,
    kind: { not: 'answered' },
    ...(options.turnlessOnly ? turnless : turns && turns.length > 0 ? { OR: [{ turn: { in: [...turns] }, run: named }, turnless] } : {}),
  };
  const out: FaultRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.computerJobFault.findMany({ where, orderBy: [{ at: 'asc' }, { callId: 'asc' }, { id: 'asc' }], take: FAULT_PAGE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    for (const row of page) {
      const cls = faultClassOf(row);
      if (cls) out.push({ turn: row.turn, callId: row.callId, kind: row.kind, reason: row.reason, source: row.source, route: row.route, cls });
    }
    if (page.length < FAULT_PAGE) return out;
    cursor = page[page.length - 1].id;
  }
}

const FAULT_PAGE = 500;

/** The prefix of the call ids Orbit gives its own pool-refusal rows (never the relay's). */
export const ORBIT_POOL_CALL_PREFIX = 'orbit:pool:';

/** The rows that are Orbit's own capacity refusals: Orbit's provenance AND its key. A row of the relay with a call id like one of ours is neither counted nor retired. */
const poolRefusalRows = (jobId: string): Prisma.ComputerJobFaultWhereInput => ({ jobId, source: ORBIT_SOURCE, callId: { startsWith: ORBIT_POOL_CALL_PREFIX } });

/**
 * Keeps that one model call of a job was refused for OUR capacity (the pool has no room, or its route is paused), as a confirmed fault of ours (kind `fault`, reason `pool_busy`, 503). One row per call
 * (the call id is Orbit's own, so a retried call counts once and it is never the relay's row). Answers how many calls of this job are refused so far. The job must exist.
 */
export async function recordPoolRefusal(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string, callId: string, input: { route?: string | null; at?: Date } = {}): Promise<number> {
  await db.computerJobFault.createMany({
    data: [{ jobId, turn: null, run: null, callId: `${ORBIT_POOL_CALL_PREFIX}${callId}`.slice(0, 120), kind: 'fault', reason: 'pool_busy', source: ORBIT_SOURCE, route: input.route ? input.route.slice(0, 120) : null, providerStatus: 503, at: input.at ?? new Date() }],
    skipDuplicates: true,
  });
  // Only the refusals that still count: one that a later authorized call recovered (kind `answered`, `pool_recovered`) is evidence only, and must not add to the number the cutoff stands on
  return db.computerJobFault.count({ where: { ...poolRefusalRows(jobId), kind: 'fault' } });
}

/** Whether the job has a pool refusal of Orbit's own that still counts (one that no later authorized call has recovered). Reads only. */
export async function hasPoolRefusals(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string): Promise<boolean> {
  return (await db.computerJobFault.count({ where: { ...poolRefusalRows(jobId), kind: 'fault' } })) > 0;
}

/**
 * A call of the job was authorized after capacity was refused: the refusal is recovered, and stops deciding anything. Its rows are turnless (Orbit knows no turn at the moment it refuses a call), so
 * left as they were they would apply to EVERY turn the runner judges later, and a turn that failed for the agent's own reason would read as a fault of ours. The refused call's own turn is still
 * covered by the relay's own turn-scoped row for that call, which is never touched here: only the rows Orbit itself made are retired. The rows stay as evidence (kind `answered`, which no ruling reads); safe to say twice.
 */
export async function retirePoolRefusals(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string): Promise<number> {
  const retired = await db.computerJobFault.updateMany({ where: { ...poolRefusalRows(jobId), kind: 'fault' }, data: { kind: 'answered', reason: 'pool_recovered' } });
  return retired.count;
}

/** The call id of the one row per job that says Orbit decided to end it for its own capacity. */
export const POOL_CUTOFF_CALL = 'orbit:pool-cutoff';

/**
 * Keeps that Orbit decided to end this job for its own capacity (its calls were all refused, twice), made in the very transaction that ends the job's keys, so the decision and the end of its keys are one
 * piece. It is the record the rest stands on: the job is ended from it if the request that decided could not end it (the sweep), a key is never made for the job after it, and a call is never authorized after it.
 * Kind `answered`: it says nothing about a failure, so no ruling reads it as one. One row per job; safe to say twice.
 */
export async function recordPoolCutoff(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string, at: Date = new Date()): Promise<void> {
  await db.computerJobFault.createMany({
    data: [{ jobId, turn: null, run: null, callId: POOL_CUTOFF_CALL, kind: 'answered', reason: 'pool_cutoff', source: ORBIT_SOURCE, route: null, providerStatus: null, at }],
    skipDuplicates: true,
  });
}

/** Whether Orbit decided to end this job for its own capacity (the record above). Reads only. */
export async function hasPoolCutoff(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string): Promise<boolean> {
  return (await db.computerJobFault.count({ where: { jobId, callId: POOL_CUTOFF_CALL, source: ORBIT_SOURCE } })) > 0;
}

/** The lock a cutoff for our own capacity, an authorization that may be deciding at the same moment and the making of a model key take one after the other. */
export const cutoffLockKey = (jobId: string): string => `computer-call-cutoff:${jobId}`;

/** The call id of Orbit's one marker per job that a call on the person's OWN key was authorized. */
export const OWN_KEY_CALL_MARK = 'orbit:own-key-call';

/**
 * Keeps that a call on the person's OWN key was authorized for this job (kind `answered`, so it says nothing about any failure: it is read as no row by every ruling and every count of faults). A call on
 * the person's own key takes no room and prices nothing, so without this Orbit would hold no trace of it, and a failed finish that arrives before the call's own report would read "readied, and not one call
 * ever asked", which is ours (`neverReachedRelay`). One row per job, so asking again changes nothing. The job must exist. Throws when it could not be kept: a call is not authorized without it.
 */
export async function recordOwnKeyCall(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string, at: Date = new Date()): Promise<void> {
  await db.computerJobFault.createMany({
    data: [{ jobId, turn: null, run: null, callId: OWN_KEY_CALL_MARK, kind: 'answered', reason: 'own_key_call', source: ORBIT_SOURCE, route: null, providerStatus: null, at }],
    skipDuplicates: true,
  });
}

/** Whether the runner committed to ending this job (its finish intent, kept before it gave up). Reads only. */
export async function hasFinishIntent(db: Pick<Prisma.TransactionClient, 'computerFinishIntent'>, jobId: string): Promise<boolean> {
  return (await db.computerFinishIntent.count({ where: { jobId } })) > 0;
}

/** The lock a cutoff for our own capacity, a finish's terminal write, an authorization that may be deciding at the same moment and the making of a model key take one after the other (taken BEFORE the person's lock and the relay-reach lock, never after). */
export const lockCutoff = (tx: Pick<Prisma.TransactionClient, '$executeRaw'>, jobId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${cutoffLockKey(jobId)}, 0))`;

/**
 * Authorizes a call on the person's own key. In ONE transaction, under the job's cutoff lock and then the lock a finish's inference takes: a cutoff for our own capacity that is already decided refuses the call
 * BEFORE any marker is written (a refused call leaves no trace: a marker would read the job as one that had an own-key call), the job must still be on (running or waiting), and `stillGood` (the key, looked at
 * with the time read after the waits) must say yes. Only then is the marker kept, so a finish and the marker can never both succeed on a stale view of each other: a finish that took the lock first has ended
 * the job (refused); a marker kept first is seen by the finish, which then reads "a call was made" and never gives the job back as ours, and by a cutoff, which then never decides. Returns whether the call may
 * go on; throws when it could not be kept (a call is not authorized without it). The admission for the call's turn is written in the same transaction as the marker, and nothing is looked at after it commits: a call is
 * refused with no trace, or authorized with both.
 */
export async function authorizeOwnKeyCall(jobId: string, at: Date = new Date(), stillGood?: (tx: Prisma.TransactionClient) => Promise<boolean>, admitted?: { turn?: number | null; run?: string | null }, clock?: () => Date): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      await lockCutoff(tx, jobId);
      await lockRelayReach(tx, jobId);
      if (await hasPoolCutoff(tx, jobId)) return false;
      // The runner committed to ending this job: no call is authorized from then on, and no marker is kept for one that is refused
      if (await hasFinishIntent(tx, jobId)) return false;
      const job = await tx.computerJob.findUnique({ where: { id: jobId }, select: { status: true, prepState: true } });
      if (!job || (job.status !== 'running' && job.status !== 'waiting')) return false;
      // While the job's browser is being restored or its sign-ins are unproven, no call is authorized, whatever key it holds (as a funded call is refused: `authorizedPastCutoff`), under this same lock (CodeRabbit on #1025)
      if (job.prepState !== null) return false;
      if (stillGood && !(await stillGood(tx))) return false;
      await recordOwnKeyCall(tx, jobId, at);
      // The admission for its turn, in the same transaction and under the same lock: the marker, the turn and the decision never part, so a call refused after the marker is impossible (there is no look after this commit)
      await recordTurnAdmitted(tx, jobId, { turn: admitted?.turn, run: admitted?.run, at });
      // A call the job made on its own key after a pool refusal shows it carried on: the refusal is retired in this same transaction, as the funded path does (N13), so a later unrelated agent failure is never given back as our fault from it. A retirement that cannot be written rolls the admission back (CodeRabbit on #1025, 14c4e407 pass, N1)
      await retirePoolRefusals(tx, jobId);
      // A call admitted on the owner's own key is a beat too: the hold stands another 90 s, so a replacement never claims the job while it works (a refused call returned above and renews nothing; CodeRabbit on #1025)
      // ...for 90 s from the moment it is admitted: the time is read after the waits for the locks (a long wait must not shorten the hold the owner is promised), and a hold that stands longer is never moved back
      await extendHoldIn(tx, jobId, leaseUntil(clock ? clock() : at));
      return true;
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
}

/** Whether a call on the person's own key was authorized for this job (the marker above). Reads only. */
export async function hasOwnKeyCall(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string): Promise<boolean> {
  return (await db.computerJobFault.count({ where: { jobId, callId: OWN_KEY_CALL_MARK, source: ORBIT_SOURCE } })) > 0;
}

/** The lock one model call's admission and the rollback of its room take one after the other (per job and call id). Taken before the pool's lock, never while holding it. */
export const admitLockKey = (jobId: string, callId: string): string => `computer-call-admit:${jobId}:${callId}`;

/** The prefix of the call ids of Orbit's markers that a call was handed back as authorized to a second request that asked for it again (never the relay's). */
export const ORBIT_ADMIT_PREFIX = 'orbit:admit:';

/**
 * Keeps that a request asking AGAIN for a model call whose room was taken by an earlier request was answered with its authorization (kind `answered`: no ruling reads it). The request that took the room may
 * still be deciding whether the call stands, and gives the room back when it does not: with this kept, under the call's lock, it leaves the room to the call that was authorized. One row per call; safe to say twice.
 */
export async function recordCallAdmission(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string, callId: string, at: Date = new Date()): Promise<void> {
  await db.computerJobFault.createMany({
    data: [{ jobId, turn: null, run: null, callId: `${ORBIT_ADMIT_PREFIX}${callId}`.slice(0, 120), kind: 'answered', reason: 'call_admitted', source: ORBIT_SOURCE, route: null, providerStatus: null, at }],
    skipDuplicates: true,
  });
}

/** The prefix of the call ids of Orbit's markers that a call was ADMITTED for a turn of a run (never the relay's): one row per run and turn. */
export const ORBIT_TURN_ADMIT_PREFIX = 'orbit:turn-admit:';

/**
 * Keeps that a model call was admitted (authorized, its room held or its own-key marker kept) for this turn of this run (kind `answered`: no ruling reads it). Written inside the admission's final check, under the job's
 * cutoff lock, so a stop for our capacity that is deciding at the same moment either sees it (and answers stale) or won (and this call was refused at its key): never both. One row per (run, turn): a call whose turn
 * the relay did not name leaves one row per run that names none (`turn` null), which the stop reads as an admission for ANY turn (the cautious side: the work goes on). Safe to say twice.
 */
export async function recordTurnAdmitted(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string, input: { turn?: number | null; run?: string | null; at?: Date }): Promise<void> {
  const turn = input.turn ?? null;
  const run = input.run ?? null;
  await db.computerJobFault.createMany({
    data: [{ jobId, turn, run, callId: `${ORBIT_TURN_ADMIT_PREFIX}${run ?? '-'}:${turn ?? 'none'}`.slice(0, 120), kind: 'answered', reason: 'turn_admitted', source: ORBIT_SOURCE, route: null, providerStatus: null, at: input.at ?? new Date() }],
    skipDuplicates: true,
  });
}

/**
 * Whether a call was admitted for the turn a stop for our capacity rests on, or a LATER one, in the same run: then capacity came back and the work is going on, and the stop is stale. `fromTurn` is the earliest turn the stop
 * names (none named: any admission of the run counts). A run named on both sides must be the same one; a side that names none matches any (the cautious side). A row that names no turn counts as an admission for the stop's
 * turn. An admission on an EARLIER turn never counts: a call that went well long ago does not disable a later stop. Reads only; call it under the job's cutoff lock.
 */
export async function hasTurnAdmitted(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string, input: { fromTurn?: number | null; run?: string | null }): Promise<boolean> {
  const and: Prisma.ComputerJobFaultWhereInput[] = [];
  if (input.run) and.push({ OR: [{ run: null }, { run: input.run }] });
  if (input.fromTurn !== undefined && input.fromTurn !== null) and.push({ OR: [{ turn: null }, { turn: { gte: input.fromTurn } }] });
  return (await db.computerJobFault.count({ where: { jobId, source: ORBIT_SOURCE, reason: 'turn_admitted', callId: { startsWith: ORBIT_TURN_ADMIT_PREFIX }, AND: and } })) > 0;
}

/** Whether another request was answered with the authorization of this call (the marker above). Reads only. */
export async function hasCallAdmission(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string, callId: string): Promise<boolean> {
  return (await db.computerJobFault.count({ where: { jobId, callId: `${ORBIT_ADMIT_PREFIX}${callId}`.slice(0, 120), source: ORBIT_SOURCE } })) > 0;
}
