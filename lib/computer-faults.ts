import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

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
export type FaultClass = 'ours' | 'person' | 'unresolved';

/**
 * The computer could not reach the model relay at all (a wrong address, a relay that is down, a reply that is not the relay's): nothing about the job reached the relay, so there is no call to
 * write a row for. Written by Orbit itself from what the runner says at prepare, or from the absence of every call at a failed finish (lib/computer-giveback). Ours, always.
 */
export const RELAY_UNREACHABLE = 'relay_unreachable';
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

/**
 * The key a call is kept under. A fault with no call is `turn:<n>`, and turns are numbered again by every run of a job (a restart), so a turn-only id is
 * qualified by the run that numbered it: two runs never share a key. A real call id is the model call's own and is kept as it is. A runner that names no run
 * has one numbering as far as Orbit can tell.
 */
function keyOfCall(callId: string, run: string | null): string {
  return (run && callId.startsWith('turn:') ? `${run}:${callId}` : callId).slice(0, 120);
}

/**
 * Keeps that a job's computer could not reach the model relay, as a confirmed fault of ours (kind `fault`, reason `relay_unreachable`, no route: it is no provider's). One row per job and run
 * (the call id is Orbit's own, `orbit:<run>:relay_unreachable`, so it is never the relay's row of the same name), so saying it twice changes nothing. The job must exist. Never reads or writes anything of a call.
 */
export async function recordRelayUnreachable(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string, input: { run?: string | null; status?: number | null; at?: Date } = {}): Promise<void> {
  const run = input.run ? input.run.slice(0, 40) : null;
  // `skipDuplicates` (ON CONFLICT DO NOTHING): inside a transaction a unique violation would abort the whole of it, and saying it twice must change nothing
  await db.computerJobFault.createMany({
    data: [{ jobId, turn: null, run, callId: `orbit:${run ? `${run}:` : ''}${RELAY_UNREACHABLE}`.slice(0, 120), kind: 'fault', reason: RELAY_UNREACHABLE, source: 'universe-ai', route: null, providerStatus: input.status ?? null, at: input.at ?? new Date() }],
    skipDuplicates: true,
  });
}

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
