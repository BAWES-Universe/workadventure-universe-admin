import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * What the game relay saw go wrong on a computer job's model calls, kept by Orbit (table computer_job_faults) so that Orbit, and not the memory of one
 * process, judges whether a failed job is given back (lib/computer-giveback). The relay writes one row per call (or per turn with no call: call id
 * `turn:<n>`) BEFORE the job finishes. The relay says what it saw; the CLASS of each reason is Orbit's:
 *
 *  - `ours`: a fault no job's words can cause. A relay-side fault (no route, the call could not be authorized, a key could not be read, the pool is full)
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

export const OURS_REASONS: readonly string[] = ['relay_down', 'route_unknown', 'authorize_failed', 'key_decrypt_failed', 'pool_busy', 'provider_key_ours'];
export const PERSON_REASONS: readonly string[] = ['field_job_set', 'allowance', 'rule', 'own_provider'];
export const UNRESOLVED_REASONS: readonly string[] = ['provider_5xx', 'provider_429', 'stream_cut', 'timeout_no_output', 'timeout_after_output', 'fieldless_400', 'field_relay_set'];

/** The class of one row; null for a call that was answered (it says nothing about a failure). A reason Orbit does not know is unresolved, never ours. */
export function faultClassOf(row: { kind: string; reason: string; source: string }): FaultClass | null {
  if (row.kind === 'answered') return null;
  // The source alone never charges anyone: the game writes source own-key on EVERY row of a call on the person's own key, including our relay being down.
  // Their provider refusing their key is theirs; everything else is read by kind and reason below, own key or not
  if (row.source === 'own-key' && row.reason === 'provider_key_ours') return 'person';
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
export async function recordFaults(botId: string, jobId: string, rows: FaultInput[]): Promise<{ stored: number } | null> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true, botId: true } });
  if (!job || job.botId !== botId) return null;
  if (rows.length === 0) return { stored: 0 };
  let stored = 0;
  for (const row of rows) {
    const data = {
      jobId,
      turn: row.turn ?? null,
      run: row.run ? row.run.slice(0, 40) : null,
      callId: row.callId.slice(0, 120),
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
          where: { jobId, callId: data.callId, kind: 'uncertain' },
          data: { kind: data.kind, reason: data.reason, source: data.source, route: data.route, providerStatus: data.providerStatus, at: data.at },
        });
        stored += settled.count;
      }
    }
  }
  return { stored };
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

/** The rows that count for a ruling: the ones for the turns the runner judged failed IN THE RUN it names (a restart makes a new run that numbers turns again; no run matches no run), or every row of the job when it named no turns. Answered calls are left out. */
export async function readFaultRows(db: Db, jobId: string, turns: readonly number[] | null | undefined, run: string | null | undefined = null): Promise<FaultRow[]> {
  const rows = await db.computerJobFault.findMany({
    where: { jobId, ...(turns && turns.length > 0 ? { OR: [{ turn: { in: [...turns] }, run: run ?? null }, { turn: null }] } : {}) },
    orderBy: [{ at: 'asc' }, { callId: 'asc' }],
    take: 500,
  });
  const out: FaultRow[] = [];
  for (const row of rows) {
    const cls = faultClassOf(row);
    if (cls) out.push({ turn: row.turn, callId: row.callId, kind: row.kind, reason: row.reason, source: row.source, route: row.route, cls });
  }
  return out;
}
