import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getAdapter } from '@/lib/app-adapter';
import { AdapterError, type ReadyMadeAdapter, type WorkbenchAdapter } from '@/lib/app-adapter/types';
import { SANDBOX_RUN_MICROS } from '@/lib/composio-rates';
import { getMeterSettings, recordMeterEvent } from '@/lib/meter';
import { personKeyOf } from '@/lib/meter-values';
import { keepResult, keptBytes as keptResultBytes, openResult, purgeOrphanedResults, removeResultsOf, resultsOfSource } from '@/lib/owned-results';
import { firstReadNotAllowed } from '@/lib/workbench/policy';
import { STATE_LOCK, getCodeJobLimits, getCodeJobPause, pauseCodeJobs } from '@/lib/workbench/state';
import { getOutputStore, type OutputStore } from '@/lib/workbench/store';
import {
  CELL_WAIT_GRACE_SECONDS,
  CODE_JOB_PROVIDER,
  IN_DIR,
  OUT_DIR,
  PROVIDER_CELL_SECONDS,
  REASON_WORDS,
  capabilitySet,
  clip,
  codeJobKey,
  contentTypeOf,
  filledLimits,
  isReadableText,
  isSafeFileName,
  providerUserIdFor,
  readJobRequest,
  sha256Hex,
  type CodeJobReason,
  type FilledLimits,
  type JobRequest,
} from '@/lib/workbench/values';

/**
 * The bounded code job executor. It is the ONLY way the provider's code sandbox runs.
 *
 * What makes it bounded, in the order it happens:
 *
 *  1. Admission: the Brick must be its owner's own, every Limit must be set (nothing is assumed in code), code jobs must not be paused,
 *     the request must fit the Limits, and the person and everyone must be under "jobs at once" and the person under "jobs a day".
 *  2. Reserve before anything runs, under one lock: what the job may cost (its runs times the price of a run) against the month's ceiling.
 *  3. The job row is written first (its deadline, its capability set, the Limits it was admitted under), and only then is anything sent.
 *  4. Its own provider session, with no App accounts, no tools, no raw requests, no connection tools and Instant off, read back as such
 *     before a byte of the person's data goes in. The person's accounts are never in it: data comes in as files, from what the Brick
 *     passed and from "reads" that Orbit does itself, one at a time, each counted as an App step.
 *  5. Every wait is cut at the job's own deadline, and the end of a job, however it comes (done, failed, cancelled, out of time, lost
 *     track of) DELETES the provider session, which shuts the sandbox down. A client timeout alone ends nothing here.
 *  6. Files left under out/ are checked against the Limits, copied into Universe's own storage and recorded, before the session goes.
 *  7. The job settles once, at what it used, in the meter; the provider's own log of the session is read for runs that were not ours.
 *
 * Every way it can end is a value, never a thrown business error. A caller that asks again with the same call id gets the same job back.
 */

const SECOND = 1000;
/** How often a running job says it is alive, and how long without that makes the sweep treat it as lost. Mechanics, not Limits. */
const HEARTBEAT_MS = 15 * SECOND;
const STALE_MS = 90 * SECOND;
/** After the deadline stops the code, the files still get this long to be copied before the sweep stops everything. */
export const INGEST_GRACE_MS = 60 * SECOND;
/** A finished job is given this long to write its own meter line before the sweep writes it. */
const METER_GRACE_MS = 60 * SECOND;
/** Bounds on single provider requests that are not runs of code. */
const REQUEST_MS = 60 * SECOND;
const FILE_MS = 120 * SECOND;
const CLOSE_RETRIES = 3;
const ACTIVE = ['starting', 'running'];
const DAY_MS = 24 * 60 * 60 * 1000;
const ADMISSION_LOCK = 'codejob:admission';

type Row = Prisma.CodeJobGetPayload<object>;

const asNumber = (value: bigint | number | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface StartInput {
  botId: string;
  /** The person who asked: the Brick's owner. Checked against the Brick here, whatever the caller did. */
  personId: string;
  /** The App link the job was asked through, and its App: the only App its reads may use. */
  connectionId: string | null;
  toolkit: string | null;
  /** The bot server's own id for this call: a retry is the same call and never starts or pays twice. */
  callId: string;
  /** The request exactly as the Brick sent it. */
  args: unknown;
  /** Runs one App tool for the job (a read), as the person's own App use: counted and checked like any App step. Bound by the caller to this link. */
  read: ReadRunner | null;
}

export type ReadRunner = (input: { tool: string; arguments: Record<string, unknown>; callId: string }) => Promise<{ ok: boolean; data: unknown } | null>;

export interface Deps {
  adapter?: ReadyMadeAdapter | null;
  store?: OutputStore;
  now?: () => Date;
  /** Where the job's work runs after the start answers. The default lets it run on its own; tests hold on to it. */
  background?: (work: Promise<void>) => void;
}

/** What a caller (the link) is told about a job: fixed words, never a provider message. */
export interface JobView {
  jobId: string;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  reason: CodeJobReason | null;
  message: string;
  deadlineAt: string;
  runsUsed: number;
  runs: { n: number; ok: boolean; printed: string; errors: string; value: string; error: string | null }[];
  reads: { tool: string; file: string; ok: boolean; bytes: number }[];
  files: { id: string; name: string; bytes: number; contentType: string; preview?: string; path: string }[];
  notKept: { name: string; why: string }[];
  clipped: boolean;
}

export type StartOutcome =
  | { status: 'started' | 'existing'; job: JobView }
  | { status: 'refused'; reason: CodeJobReason; message: string };

const refuse = (reason: CodeJobReason, message: string = REASON_WORDS[reason]): StartOutcome => ({ status: 'refused', reason, message });

/** Jobs working in THIS process, so a cancel here stops the wait at once and the sweep does not call a live job lost. */
const live = new Map<string, AbortController>();

const adapterOf = (adapter?: ReadyMadeAdapter | null): WorkbenchAdapter | null => (adapter === undefined ? getAdapter() : adapter)?.workbench ?? null;

/** The price of one run of code: the super admin's saved price of a paid App step when there is one, else the provider's list price. */
async function runPriceMicros(): Promise<number> {
  const settings = await getMeterSettings();
  return settings.appUseMicros ?? SANDBOX_RUN_MICROS;
}

const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * Jobs whose provider workspace is, as far as anyone knows, still standing: going, or ended with the delete not yet confirmed. Code may still
 * be running in it, so it counts as running and as owed at what was held, never at what a job settled at: a pause or a later delete limits
 * further loss but cannot undo a fee already incurred.
 */
export const STANDING: Prisma.CodeJobWhereInput = { OR: [{ state: { in: ACTIVE } }, { providerState: { in: ['open', 'unknown'] } }] };

/** What code jobs may still owe the provider this month: each job counts at what it settled at once its workspace is confirmed gone, and at what it holds until then. */
export async function exposureIn(db: Pick<Prisma.TransactionClient, 'codeJob'>, now: Date): Promise<number> {
  const rows = await db.codeJob.findMany({ where: { createdAt: { gte: monthStart(now) } }, select: { reservedMicros: true, settledMicros: true, providerState: true } });
  return rows.reduce((sum, row) => sum + asNumber(row.providerState === 'open' || row.providerState === 'unknown' ? row.reservedMicros : (row.settledMicros ?? row.reservedMicros)), 0);
}

// ---------- Starting ----------

/**
 * One job, from admission until it is running in the background. Never throws for a business reason. The same call id again answers with the
 * same job, in the state it is now.
 */
export async function startCodeJob(input: StartInput, deps: Deps = {}): Promise<StartOutcome> {
  const now = deps.now ?? (() => new Date());
  const adapter = adapterOf(deps.adapter);
  const key = codeJobKey(input.botId, input.callId);

  const known = await prisma.codeJob.findUnique({ where: { jobKey: key } });
  if (known) return known.personId === input.personId ? { status: 'existing', job: await viewOf(known) } : refuse('not_owner');

  if (!adapter) return refuse('unavailable');
  const bot = await prisma.bot.findUnique({ where: { id: input.botId }, select: { roomId: true, ownerId: true, deletedAt: true } });
  // Always the Brick's owner's own, on their own Brick: no room, the owner is who asked, not deleted
  if (!bot || bot.roomId !== null || bot.deletedAt !== null || bot.ownerId !== input.personId) return refuse('not_owner');
  const limits = filledLimits(await getCodeJobLimits());
  if (!limits) return refuse('not_set');
  if ((await getCodeJobPause()).paused) return refuse('paused');

  const request = readJobRequest(input.args, limits, input.toolkit);
  if (!request.ok) return refuse(request.reason, request.error);
  if (request.value.reads.length > 0 && (!input.read || !input.connectionId)) return refuse('bad_request', 'Reading from the App is not possible here.');
  // Reads go through the gate every App tool has: a tool that is off, asks first, changes things or was never confirmed is not run for a job
  const blocked = await firstReadNotAllowed(input.botId, input.connectionId, request.value.reads.map((read) => read.tool));
  if (blocked) return refuse('not_allowed', `${blocked} is not set to run right away for this Brick, so a job cannot read with it.`);
  const files = prepareInputs(request.value, limits);
  if (!files.ok) return refuse(files.reason, files.error);

  const price = await runPriceMicros();
  const steps = request.value.steps.length;
  // Every step, and the run that makes the folder for files
  const reserved = (steps + PREPARE_RUNS) * price;
  const started = now();
  const id = crypto.randomUUID();
  const codeHash = sha256Hex(request.value.steps.join('\n\u0000\n'));

  const admitted = await prisma
    .$transaction(
      async (tx): Promise<{ kind: 'job'; row: Row } | { kind: 'known'; row: Row } | { kind: 'refused'; outcome: StartOutcome }> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ADMISSION_LOCK}))`;
        // The pause is looked at again here, under the lock a pause is written under (always admission first, then state): one that landed while
        // this request was being read is seen, and nothing is admitted after it
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${STATE_LOCK}))`;
        if ((await getCodeJobPause(tx)).paused) return { kind: 'refused', outcome: refuse('paused') };
        const again = await tx.codeJob.findUnique({ where: { jobKey: key } });
        if (again) return { kind: 'known', row: again };
        const [mine, everyone, today] = await Promise.all([
          tx.codeJob.count({ where: { personId: input.personId, ...STANDING } }),
          tx.codeJob.count({ where: STANDING }),
          tx.codeJob.count({ where: { personId: input.personId, createdAt: { gte: new Date(started.getTime() - DAY_MS) } } }),
        ]);
        if (mine >= limits.atOncePerPerson || everyone >= limits.atOnceAll) return { kind: 'refused', outcome: refuse('busy') };
        if (today >= limits.jobsPerPersonPerDay) return { kind: 'refused', outcome: refuse('daily_limit') };
        if ((await exposureIn(tx, started)) + reserved > limits.exposureCeilingMicros) return { kind: 'refused', outcome: refuse('exposure_full') };
        const row = await tx.codeJob.create({
          data: {
            id,
            jobKey: key,
            botId: input.botId,
            personId: input.personId,
            connectionId: input.connectionId,
            state: 'starting',
            capabilities: capabilitySet(request.value, input.toolkit) as unknown as Prisma.InputJsonValue,
            limits: limits as unknown as Prisma.InputJsonValue,
            reservedMicros: BigInt(reserved),
            codeHash,
            steps,
            providerUserId: providerUserIdFor(id),
            deadlineAt: new Date(started.getTime() + limits.maxSeconds * SECOND),
            heartbeatAt: started,
            createdAt: started,
          },
        });
        return { kind: 'job', row };
      },
      { maxWait: 15_000, timeout: 30_000 },
    )
    .catch(async (error) => {
      // A second ask for the same call id at the same moment: the first one's job is the answer
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await prisma.codeJob.findUnique({ where: { jobKey: key } });
        if (winner) return { kind: 'known' as const, row: winner };
      }
      throw error;
    });
  if (admitted.kind === 'refused') return admitted.outcome;
  if (admitted.kind === 'known') return { status: 'existing', job: await viewOf(admitted.row) };

  const work = runJob(admitted.row, { request: request.value, files: files.files, read: input.read, toolkit: input.toolkit, price }, { adapter, store: deps.store ?? getOutputStore(), now });
  // The work answers for itself: it never leaves an error unhandled, and a crash here is closed by the sweep
  (deps.background ?? ((promise) => void promise))(work);
  return { status: 'started', job: await viewOf(admitted.row) };
}

interface PreparedFile {
  path: string;
  bytes: Uint8Array;
}

/** The files that go into the workspace: what was passed, decoded, counted against the Limit. Reads are added as they come. */
function prepareInputs(request: JobRequest, limits: FilledLimits): { ok: true; files: PreparedFile[] } | { ok: false; reason: CodeJobReason; error: string } {
  const files: PreparedFile[] = [];
  let total = 0;
  for (const input of request.inputs) {
    let bytes: Buffer;
    if (input.base64) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.content.replace(/\s+/g, ''))) return { ok: false, reason: 'bad_request', error: `Input ${input.name} is not valid base64.` };
      bytes = Buffer.from(input.content, 'base64');
    } else bytes = Buffer.from(input.content, 'utf8');
    total += bytes.byteLength;
    if (total > limits.maxInputBytes) return { ok: false, reason: 'too_big', error: 'The data is over what a job may be given.' };
    files.push({ path: `${IN_DIR}/${input.name}`, bytes });
  }
  return { ok: true, files };
}

// ---------- Running ----------

interface Plan {
  request: JobRequest;
  files: PreparedFile[];
  read: ReadRunner | null;
  toolkit: string | null;
  price: number;
}

interface Ctx {
  adapter: WorkbenchAdapter;
  store: OutputStore;
  now: () => Date;
}

type Printed = { n: number; ok: boolean; printed: string; errors: string; value: string; error: string | null };

interface Collected {
  runs: Printed[];
  reads: JobView['reads'];
  files: JobView['files'];
  notKept: JobView['notKept'];
  clipped: boolean;
}

/** One job's work, from its provider session to its last file. Never throws. */
async function runJob(initial: Row, plan: Plan, ctx: Ctx): Promise<void> {
  const jobId = initial.id;
  const limits = initial.limits as unknown as FilledLimits;
  const controller = new AbortController();
  live.set(jobId, controller);
  const collected: Collected = { runs: [], reads: [], files: [], notKept: [], clipped: false };
  const beat = setInterval(() => {
    void prisma.codeJob.updateMany({ where: { id: jobId, state: { in: ACTIVE } }, data: { heartbeatAt: ctx.now() } }).catch(() => undefined);
  }, HEARTBEAT_MS);
  beat.unref?.();

  let end: { state: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'; reason: CodeJobReason | null } = { state: 'failed', reason: 'unavailable' };
  try {
    end = await work(initial, limits, plan, ctx, controller.signal, collected);
  } catch (error) {
    console.error('[CodeJob] A job could not be run:', error instanceof Error ? error.message : 'unknown');
  } finally {
    clearInterval(beat);
    live.delete(jobId);
  }
  await finishJob(jobId, end, collected, limits, plan.price, ctx).catch((error) => console.error('[CodeJob] A job could not be closed here, the sweep will:', error instanceof Error ? error.message : 'unknown'));
}

const remainingMs = (job: { deadlineAt: Date }, ctx: Ctx): number => job.deadlineAt.getTime() - ctx.now().getTime();

/**
 * Claims one run for a job, and only while the job is going: the same row that carries the state carries the counters, so a run is never claimed
 * after the job has moved to its end (a cancel and a claim at the same moment settle one way: either the run is claimed and charged, or it is
 * refused and never sent). Null when claimed; otherwise how the job ended.
 */
async function claimRun(jobId: string, data: Prisma.CodeJobUpdateManyMutationInput): Promise<{ state: 'cancelled' | 'timed_out' | 'interrupted'; reason: CodeJobReason } | null> {
  const claimed = await prisma.codeJob.updateMany({ where: { id: jobId, state: { in: ACTIVE } }, data });
  if (claimed.count === 1) return null;
  const elsewhere = (await endedElsewhere(jobId)) ?? 'interrupted';
  return { state: elsewhere, reason: elsewhere };
}

/** Whether this job was ended by someone else (a cancel, the sweep) while it was working. */
async function endedElsewhere(jobId: string): Promise<'cancelled' | 'timed_out' | 'interrupted' | null> {
  const row = await prisma.codeJob.findUnique({ where: { id: jobId }, select: { state: true } });
  if (!row) return 'interrupted';
  if (ACTIVE.includes(row.state)) return null;
  return row.state === 'cancelled' ? 'cancelled' : row.state === 'timed_out' ? 'timed_out' : 'interrupted';
}

async function work(job: Row, limits: FilledLimits, plan: Plan, ctx: Ctx, signal: AbortSignal, out: Collected): Promise<{ state: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'; reason: CodeJobReason | null }> {
  const wb = ctx.adapter;
  const moved = await prisma.codeJob.updateMany({ where: { id: job.id, state: 'starting' }, data: { state: 'running', startedAt: ctx.now() } });
  if (moved.count === 0) return { state: 'interrupted', reason: 'interrupted' };

  // The job's own session, made restricted and read back so; saved at once so whoever ends the job can delete it
  let sessionId: string;
  try {
    sessionId = (await wb.open({ jobUserId: job.providerUserId })).sessionId;
  } catch (error) {
    console.error('[CodeJob] The workspace could not be made:', error instanceof Error ? error.message : 'unknown');
    // The provider's own limit (too many requests, or its funds): nothing ran and nothing is charged, and the Brick is told it is the provider's limit
    return { state: 'failed', reason: error instanceof AdapterError && (error.status === 429 || error.status === 402) ? 'provider_limit' : 'unavailable' };
  }
  const saved = await prisma.codeJob.updateMany({ where: { id: job.id, state: { in: ACTIVE } }, data: { providerSessionId: sessionId, providerState: 'open' } });
  if (saved.count === 0) {
    // Ended before the workspace was written down: nobody else knows it, so it is deleted here. A delete that fails writes the id down as one
    // not confirmed deleted, so the sweep says it again: a workspace is never left standing because its id was lost
    const closed = await wb.close(sessionId).then(
      () => true,
      () => false,
    );
    if (!closed) await prisma.codeJob.updateMany({ where: { id: job.id, providerSessionId: null }, data: { providerSessionId: sessionId, providerState: 'unknown' } });
    return { state: (await endedElsewhere(job.id)) ?? 'interrupted', reason: 'interrupted' };
  }
  const stopped = async (): Promise<{ state: 'cancelled' | 'timed_out' | 'interrupted'; reason: CodeJobReason } | null> => {
    const elsewhere = await endedElsewhere(job.id);
    if (elsewhere) return { state: elsewhere, reason: elsewhere };
    if (signal.aborted) return { state: 'cancelled', reason: 'cancelled' };
    if (remainingMs(job, ctx) <= 0) return { state: 'timed_out', reason: 'timed_out' };
    return null;
  };

  // Reads: Orbit runs them itself, one at a time, as the person's own App use. Nothing in the workspace can.
  const files = [...plan.files];
  let total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  for (const [index, read] of plan.request.reads.entries()) {
    const halt = await stopped();
    if (halt) return halt;
    const answered = plan.read ? await plan.read({ tool: read.tool, arguments: read.arguments, callId: `${job.jobKey}:read:${index}` }).catch(() => null) : null;
    if (!answered || !answered.ok) {
      out.reads.push({ tool: read.tool, file: read.as, ok: false, bytes: 0 });
      return { state: 'failed', reason: 'read_failed' };
    }
    const bytes = Buffer.from(JSON.stringify(answered.data ?? null), 'utf8');
    total += bytes.byteLength;
    out.reads.push({ tool: read.tool, file: read.as, ok: true, bytes: bytes.byteLength });
    if (total > limits.maxInputBytes) return { state: 'failed', reason: 'too_big' };
    files.push({ path: `${IN_DIR}/${read.as}`, bytes });
  }

  for (const file of files) {
    const halt = await stopped();
    if (halt) return halt;
    try {
      await wb.put({ sessionId, path: file.path, bytes: file.bytes, timeoutMs: Math.max(1, Math.min(FILE_MS, remainingMs(job, ctx))) });
    } catch (error) {
      console.error('[CodeJob] A file could not be put in the workspace:', error instanceof Error ? error.message : 'unknown');
      return { state: 'failed', reason: 'unavailable' };
    }
  }

  // The folder for files is made by a run of its own, never by a line put in front of the person's code: a line before the code would be
  // a syntax error for code that begins with `from __future__ import ...`, and would shift the line numbers in its errors.
  const ended = async (run: { kind: 'timeout' | 'gone' }): Promise<{ state: 'failed' | 'cancelled' | 'timed_out' | 'interrupted'; reason: CodeJobReason }> => {
    // Whoever ended the job (a cancel, the sweep) says how; otherwise the wait ending is the job running out of time, and a session the provider no longer has is a failure
    const elsewhere = await endedElsewhere(job.id);
    if (elsewhere) return { state: elsewhere, reason: elsewhere };
    if (signal.aborted) return { state: 'cancelled', reason: 'cancelled' };
    return run.kind === 'timeout' ? { state: 'timed_out', reason: 'timed_out' } : { state: 'failed', reason: 'unavailable' };
  };
  {
    const halt = await stopped();
    if (halt) return halt;
    // Counted before it goes out, like a step: a run that may have started is a run that was used. Claimed only while the job is going.
    const refused = await claimRun(job.id, { preparedRuns: PREPARE_RUNS });
    if (refused) return refused;
    const prepared = await wb.run({ sessionId, code: PREPARE_OUT_DIR, timeoutMs: Math.max(1, Math.min(remainingMs(job, ctx), (PREPARE_SECONDS + CELL_WAIT_GRACE_SECONDS) * SECOND)), signal });
    if (prepared.kind === 'timeout' || prepared.kind === 'gone') return ended(prepared);
    if (prepared.kind === 'failed' || !prepared.cell.ok) return { state: 'failed', reason: 'unavailable' };
  }

  // The runs of code, in order, in the same workspace
  let budget = limits.maxResultChars;
  for (const [index, code] of plan.request.steps.entries()) {
    const halt = await stopped();
    if (halt) return halt;
    const left = remainingMs(job, ctx);
    // Counted before it goes out: a run that may have started is a run that was used. Claimed only while the job is going.
    const refused = await claimRun(job.id, { cellsRun: { increment: 1 } });
    if (refused) return refused;
    const timeoutMs = Math.max(1, Math.min(left, (PROVIDER_CELL_SECONDS + CELL_WAIT_GRACE_SECONDS) * SECOND));
    // Cancelling in this process ends the wait at once; deleting the session (below) is what ends the code itself
    const run = await wb.run({ sessionId, code, timeoutMs, signal });
    if (run.kind === 'timeout' || run.kind === 'gone') return ended(run);
    if (run.kind === 'failed') return { state: 'failed', reason: 'unavailable' };
    const shaped = shape(run.cell, index + 1, budget);
    budget = shaped.left;
    if (shaped.clipped) out.clipped = true;
    out.runs.push(shaped.run);
    if (!run.cell.ok) {
      // The code did not work: what it left is still kept (the person may want the partial work), and the job says so
      await keepFiles(job, wb, sessionId, limits, ctx, out, budget);
      return { state: 'failed', reason: 'code_failed' };
    }
  }
  const halt = await stopped();
  if (halt) return halt;
  await keepFiles(job, wb, sessionId, limits, ctx, out, budget);
  return { state: 'succeeded', reason: null };
}

function shape(cell: { ok: boolean; stdout: string; stderr: string; results: string; error: string | null }, n: number, budget: number): { run: Printed; left: number; clipped: boolean } {
  let left = budget;
  let clipped = false;
  const take = (text: string): string => {
    const part = clip(text, Math.max(0, left));
    left -= part.text.length;
    if (part.clipped) clipped = true;
    return part.text;
  };
  const printed = take(cell.stdout);
  const errors = take(cell.stderr);
  const value = take(cell.results);
  const error = cell.error === null ? null : take(cell.error);
  return { run: { n, ok: cell.ok, printed, errors, value, error }, left, clipped };
}

/** What a run was priced at when the job was admitted: the reserve covers every step and the run that makes the folder for files. */
const PREPARE_RUNS = 1;
const priceOfJob = (row: { steps: number; reservedMicros: bigint }): number => Math.max(1, Math.floor(asNumber(row.reservedMicros) / (Math.max(row.steps, 1) + PREPARE_RUNS)));

/** The run that makes the folder for files, before any of the person's code. */
export const PREPARE_OUT_DIR = `import os\nos.makedirs("/mnt/files/${OUT_DIR}", exist_ok=True)`;
const PREPARE_SECONDS = 30;

/** How many files past the number kept are listed, so some of the ones left out can be named. */
const LISTED_PAST_KEPT = 50;

/** The files the code left under out/, copied into Universe's storage within the Limits. One that is over a Limit is named and not kept. */
async function keepFiles(job: Row, wb: WorkbenchAdapter, sessionId: string, limits: FilledLimits, ctx: Ctx, out: Collected, budget: number): Promise<void> {
  let listed: { path: string; bytes: number | null }[];
  try {
    listed = await wb.list({ sessionId, prefix: `${OUT_DIR}/`, timeoutMs: REQUEST_MS, limit: limits.maxOutputFiles + LISTED_PAST_KEPT + 1 });
  } catch (error) {
    console.error('[CodeJob] The files could not be listed:', error instanceof Error ? error.message : 'unknown');
    out.notKept.push({ name: '(all)', why: 'could not be read from the workspace' });
    return;
  }
  // One more than is looked at was asked for, so there is a way to tell "that was all of them" from "there are more"
  const looked = limits.maxOutputFiles + LISTED_PAST_KEPT;
  const more = listed.length > looked;
  const candidates = listed
    .slice(0, looked)
    .map((file) => ({ ...file, name: file.path.startsWith(`${OUT_DIR}/`) ? file.path.slice(OUT_DIR.length + 1) : '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // A listing that stopped at its limit has more behind it: say so instead of pretending those files were never there
  if (more) out.notKept.push({ name: '(more files)', why: 'over the number of files a job keeps' });
  let kept = 0;
  let keptBytes = 0;
  let previewBudget = Math.floor(budget);
  // What the person already keeps counts against the Limit for one person, so files kept for good never grow without a bound
  const maker = await prisma.bot.findUnique({ where: { id: job.botId }, select: { name: true } });
  let personKept = await keptResultBytes(job.personId);
  for (const file of candidates) {
    const name = file.name;
    if (!isSafeFileName(name)) {
      out.notKept.push({ name: name || file.path, why: 'its name is not a plain file name' });
      continue;
    }
    if (kept >= limits.maxOutputFiles) {
      out.notKept.push({ name, why: 'over the number of files a job keeps' });
      continue;
    }
    if (file.bytes === null) {
      out.notKept.push({ name, why: 'its size could not be read, so it cannot be kept within a limit' });
      continue;
    }
    if (keptBytes + file.bytes > limits.maxOutputBytes) {
      out.notKept.push({ name, why: 'over the size a job keeps' });
      continue;
    }
    if (personKept + file.bytes > limits.maxKeptBytesPerPerson) {
      out.notKept.push({ name, why: 'your kept files are full: delete some to make room' });
      continue;
    }
    if (ctx.now().getTime() > job.deadlineAt.getTime() + INGEST_GRACE_MS) {
      out.notKept.push({ name, why: 'no time left to copy it' });
      continue;
    }
    let read;
    // Bounded by what is left of the job's own allowance AND of the owner's room: a file that turns out bigger than it was listed is never read past either
    const ownerRoom = Math.max(0, limits.maxKeptBytesPerPerson - personKept);
    const jobRoom = limits.maxOutputBytes - keptBytes;
    try {
      read = await wb.read({ sessionId, path: file.path, maxBytes: Math.min(jobRoom, ownerRoom), timeoutMs: FILE_MS });
    } catch (error) {
      console.error('[CodeJob] A file could not be read:', error instanceof Error ? error.message : 'unknown');
      out.notKept.push({ name, why: 'could not be read from the workspace' });
      continue;
    }
    if (read.kind !== 'ok') {
      out.notKept.push({ name, why: read.kind === 'too_big' ? (ownerRoom < jobRoom ? 'your kept files are full: delete some to make room' : 'over the size a job keeps') : 'was not there when it was read' });
      continue;
    }
    const contentType = contentTypeOf(name);
    let saved;
    try {
      // The limit is applied by keepResult itself, in one step with the insert and from the bytes really received
      saved = await keepResult({ ownerId: job.personId, sourceKind: 'code_job', sourceId: job.id, makerBotId: job.botId, makerName: maker?.name ?? 'Brick', name, contentType, bytes: read.bytes, limitBytes: limits.maxKeptBytesPerPerson }, ctx.store);
    } catch (error) {
      console.error('[CodeJob] A file could not be kept:', error instanceof Error ? error.message : 'unknown');
      out.notKept.push({ name, why: 'could not be saved' });
      continue;
    }
    if (saved.status === 'over_limit') {
      out.notKept.push({ name, why: 'your kept files are full: delete some to make room' });
      personKept = saved.keptBytes;
      continue;
    }
    const id = saved.row.id;
    personKept += read.bytes.byteLength;
    kept += 1;
    keptBytes += read.bytes.byteLength;
    const view: JobView['files'][number] = { id, name, bytes: read.bytes.byteLength, contentType, path: `/api/workbench/outputs/${id}` };
    if (isReadableText(contentType) && previewBudget > 0) {
      // A short look at a text file in the answer, out of the same budget as what the code printed
      const share = clip(Buffer.from(read.bytes).toString('utf8'), Math.min(previewBudget, Math.max(1, Math.floor(limits.maxResultChars / 4))));
      view.preview = share.text;
      previewBudget -= share.text.length;
    }
    out.files.push(view);
  }
}

// ---------- Ending ----------

type End = { state: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'; reason: CodeJobReason | null };

/**
 * Ends a job exactly once: only a job that is still going moves, so a cancel, the sweep and the job's own end never both settle it. Whoever
 * wins deletes the provider session and settles. Returns false when someone else had already ended it (the session is still deleted).
 */
async function finishJob(jobId: string, end: End, collected: Collected, limits: FilledLimits, price: number, ctx: Ctx): Promise<boolean> {
  const now = ctx.now();
  const result = {
    runs: collected.runs,
    reads: collected.reads,
    files: collected.files,
    notKept: collected.notKept,
    clipped: collected.clipped,
  };
  // The move to the end and the settlement are one step: the move locks the row, runs are only claimed while the row is going (claimRun), so the
  // counters read right after it are final and the job is settled at what it really claimed, never at an earlier reading
  const won = await prisma.$transaction(async (tx) => {
    const moved = await tx.codeJob.updateMany({
      where: { id: jobId, state: { in: ACTIVE } },
      data: {
        state: end.state,
        reason: end.reason,
        finishedAt: now,
        result: result as unknown as Prisma.InputJsonValue,
        expiresAt: limits.keepDays === null ? null : new Date(now.getTime() + limits.keepDays * DAY_MS),
      },
    });
    if (moved.count === 0) return false;
    const row = await tx.codeJob.findUniqueOrThrow({ where: { id: jobId } });
    // A job nobody saw end is charged as if every run was used, the folder run included
    const used = Math.max(row.cellsRun, end.state === 'interrupted' ? row.steps : 0) + (end.state === 'interrupted' ? PREPARE_RUNS : row.preparedRuns);
    const settled = Math.min(asNumber(row.reservedMicros), Math.max(used, 0) * price);
    await tx.codeJob.update({ where: { id: jobId }, data: { settledMicros: BigInt(settled) } });
    return true;
  });
  // A job that did not end normally must not leave kept files behind. Also when someone else ended it first (a cancel or the sweep) while this
  // worker was still copying files: what it kept after their clean-up is removed here, at the end of its own work. A removal that fails is
  // found again by the sweep (a cancelled, timed out or lost job that still has results), never forgotten.
  const finalState = won ? end.state : (await prisma.codeJob.findUnique({ where: { id: jobId }, select: { state: true } }))?.state;
  if (finalState && ['cancelled', 'timed_out', 'interrupted'].includes(finalState)) await dropOutputs(jobId, ctx.store).catch(() => undefined);
  await closeSession(jobId, ctx);
  // A line the meter did not take now is written by the sweep (jobs with no `meteredAt`), never lost
  if (won) await settle(jobId, ctx.now).catch((error) => console.error('[CodeJob] A job could not be written to the meter yet:', error instanceof Error ? error.message : 'unknown'));
  return won;
}

async function dropOutputs(jobId: string, store: OutputStore): Promise<void> {
  await removeResultsOf('code_job', jobId, store);
}

/**
 * Deletes the job's provider session and records that it is gone, then reads the provider's log of it for runs that were not ours. A delete
 * that cannot be confirmed leaves the job marked `unknown`, which the sweep says again until the provider answers: a workspace is never
 * left standing on a guess.
 */
async function closeSession(jobId: string, ctx: Ctx): Promise<void> {
  const row = await prisma.codeJob.findUnique({ where: { id: jobId }, select: { providerSessionId: true, providerState: true, startedAt: true, createdAt: true, nestedCheckedAt: true } });
  if (!row || !row.providerSessionId || (row.providerState === 'closed' && row.nestedCheckedAt !== null)) return;
  // Said first, whatever comes of it: a session the provider keeps failing on goes behind the ones not tried yet, and never keeps them out of the sweep's batch
  await prisma.codeJob.updateMany({ where: { id: jobId }, data: { nestedTriedAt: ctx.now() } });
  let confirmed = row.providerState === 'closed';
  for (let attempt = 0; attempt < CLOSE_RETRIES && !confirmed; attempt += 1) {
    try {
      await ctx.adapter.close(row.providerSessionId);
      confirmed = true;
    } catch (error) {
      console.error('[CodeJob] The workspace could not be deleted yet:', error instanceof Error ? error.message : 'unknown');
    }
  }
  await prisma.codeJob.updateMany({ where: { id: jobId, providerState: { not: 'closed' } }, data: { providerState: confirmed ? 'closed' : 'unknown' } });
  // The provider's log is read whether or not the delete was confirmed: a workspace that would not be deleted may still be running something,
  // and the check must not wait for the provider to answer a delete. It is read again once the delete is confirmed (the log may have grown),
  // and until one read after that has worked, the sweep tries again.
  const nested = await ctx.adapter.nestedRuns({ sessionId: row.providerSessionId, sinceMs: (row.startedAt ?? row.createdAt).getTime() }).catch(() => null);
  // Whether what the log showed has been acted on: a run that was not ours is acted on only once the pause is written
  let acted = true;
  if (nested !== null && nested > 0) {
    await prisma.codeJob.update({ where: { id: jobId }, data: { nestedCalls: nested } });
    // The session has no tools, so a run that was not ours means the restrictions are not doing what they were read back as: stop new jobs
    acted = await pauseCodeJobs('provider_ran_tools').then(
      () => true,
      (error) => {
        console.error('[CodeJob] Code jobs could not be paused yet, the sweep will say it again:', error instanceof Error ? error.message : 'unknown');
        return false;
      },
    );
  }
  // Checked only when the delete was confirmed, the log was read, and anything it showed is paused for: otherwise the sweep comes back to it
  if (confirmed && nested !== null && acted) await prisma.codeJob.updateMany({ where: { id: jobId, nestedCheckedAt: null }, data: { nestedCheckedAt: ctx.now() } });
}

/** The meter line of a finished job, once (its id is the job's). Paid by the universe, like any App step; always an estimate. */
async function settle(jobId: string, now: () => Date): Promise<void> {
  const row = await prisma.codeJob.findUnique({ where: { id: jobId } });
  if (!row) return;
  // Every run at the provider, the folder run included
  const cells = row.cellsRun + row.preparedRuns;
  const cost = asNumber(row.settledMicros);
  await recordMeterEvent({
    eventId: `codejob:${row.id}`,
    kind: 'app_use',
    pool: 'chat',
    occurredAt: row.finishedAt ?? now(),
    personKey: personKeyOf({ personId: row.personId }),
    personId: row.personId,
    botId: row.botId,
    brick: true,
    payerKind: 'universe',
    payerPersonId: null,
    route: 'app',
    jobId: null,
    quantity: cells,
    unit: 'use',
    costMicros: cost,
    basis: 'estimated',
    sourceRef: `codejob:${row.id}`,
    // What ran, never what it was given or printed
    detail: { kind: 'code_job', provider: CODE_JOB_PROVIDER, state: row.state, runs: cells, stepRuns: row.cellsRun, steps: row.steps, nestedCalls: row.nestedCalls, listMicrosPerRun: cells > 0 ? Math.round(cost / cells) : null },
  });
  await prisma.codeJob.updateMany({ where: { id: jobId, meteredAt: null }, data: { meteredAt: now() } });
}

// ---------- Asking about a job ----------

const POLL_MS = 1000;

/** The job as a caller may know it: only its owner, only through the Brick it was made for. */
async function loadOwned(jobId: string, botId: string, personId: string): Promise<Row | null> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const row = await prisma.codeJob.findUnique({ where: { id: jobId } });
  return row && row.botId === botId && row.personId === personId ? row : null;
}

/** A job's state, waiting up to `waitSeconds` for it to end (never longer than the Limit). Not found looks the same for a job that is not theirs. */
export async function getCodeJob(input: { jobId: string; botId: string; personId: string; waitSeconds?: number }, deps: Deps = {}): Promise<{ status: 'ok'; job: JobView } | { status: 'refused'; reason: CodeJobReason; message: string }> {
  const now = deps.now ?? (() => new Date());
  let row = await loadOwned(input.jobId, input.botId, input.personId);
  if (!row) return { status: 'refused', reason: 'not_found', message: REASON_WORDS.not_found };
  const limits = await getCodeJobLimits();
  const wait = Math.min(Math.max(0, input.waitSeconds ?? limits.waitSeconds ?? 0), limits.waitSeconds ?? 0);
  const until = now().getTime() + wait * SECOND;
  while (ACTIVE.includes(row.state) && now().getTime() < until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const again = await loadOwned(input.jobId, input.botId, input.personId);
    if (!again) return { status: 'refused', reason: 'not_found', message: REASON_WORDS.not_found };
    row = again;
  }
  return { status: 'ok', job: await viewOf(row) };
}

/** Cancels a job that is still going: it ends as cancelled, its workspace is deleted (which stops the code), and it settles at what it used. */
export async function cancelCodeJob(input: { jobId: string; botId: string; personId: string }, deps: Deps = {}): Promise<{ status: 'ok'; job: JobView } | { status: 'refused'; reason: CodeJobReason; message: string }> {
  const row = await loadOwned(input.jobId, input.botId, input.personId);
  if (!row) return { status: 'refused', reason: 'not_found', message: REASON_WORDS.not_found };
  const adapter = adapterOf(deps.adapter);
  if (ACTIVE.includes(row.state) && adapter) {
    const ctx: Ctx = { adapter, store: deps.store ?? getOutputStore(), now: deps.now ?? (() => new Date()) };
    const limits = row.limits as unknown as FilledLimits;
    const price = priceOfJob(row);
    live.get(row.id)?.abort();
    await finishJob(row.id, { state: 'cancelled', reason: 'cancelled' }, { runs: [], reads: [], files: [], notKept: [], clipped: false }, limits, price, ctx);
  }
  const fresh = await loadOwned(input.jobId, input.botId, input.personId);
  return { status: 'ok', job: await viewOf(fresh ?? row) };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function headline(state: JobView['state'], reason: CodeJobReason | null): string {
  if (state === 'running') return 'The job is still running.';
  if (state === 'succeeded') return 'The job finished.';
  return reason ? REASON_WORDS[reason] : 'The job ended.';
}

/**
 * Which steps really ran, said plainly and never more than is known: how many of the runs of code started, which one did not work, which
 * did not run, how many App reads were done, and what was kept. A run that was cut short (cancelled, out of time, lost) is said to have
 * started, not to have finished, because nobody saw it end.
 */
function whatRan(row: Row, result: Record<string, unknown>, files: JobView['files']): string {
  const runs = (Array.isArray(result.runs) ? result.runs : []) as JobView['runs'];
  const reads = (Array.isArray(result.reads) ? result.reads : []) as JobView['reads'];
  const caps = isObject(row.capabilities) ? row.capabilities : {};
  const plannedReads = Array.isArray(caps.reads) ? caps.reads.length : 0;
  const notKept = Array.isArray(result.notKept) ? (result.notKept as unknown[]).length : 0;
  const parts: string[] = [];
  if (plannedReads > 0) {
    const done = reads.filter((read) => read.ok).length;
    parts.push(done === plannedReads ? `All ${plural(plannedReads, 'App read')} were done.` : `${done} of ${plural(plannedReads, 'App read')} were done${done < plannedReads ? ', so the code did not run' : ''}.`);
  }
  const ended = ACTIVE.includes(row.state) ? 'running' : row.state;
  const started = Math.max(row.cellsRun, runs.length);
  const finished = runs.length;
  if (started === 0) {
    parts.push(ended === 'running' ? 'No step has started yet.' : `None of the ${plural(row.steps, 'step')} ran.`);
  } else {
    const failed = runs.find((run) => !run.ok);
    const cutShort = started > finished;
    const sentence = [`${started} of ${plural(row.steps, 'step')} ${ended === 'running' ? 'have started' : cutShort ? 'started' : 'ran'}`];
    if (failed) sentence.push(`step ${failed.n} did not work`);
    if (cutShort && ended !== 'running') sentence.push(`step ${started} was stopped before it finished, so what it did is not known`);
    const never = ended === 'running' ? 0 : row.steps - started;
    if (never > 0) sentence.push(`${plural(never, 'step')} did not run`);
    parts.push(`${sentence.join('; ')}.`);
  }
  if (ended !== 'running') {
    if (files.length > 0 || notKept > 0) parts.push(`${plural(files.length, 'file')} kept${notKept > 0 ? `, ${notKept} not kept` : ''}.`);
  }
  return parts.join(' ');
}

async function viewOf(row: Row): Promise<JobView> {
  const result = isObject(row.result) ? row.result : {};
  const state = ACTIVE.includes(row.state) ? 'running' : (row.state as JobView['state']);
  const reason = (row.reason as CodeJobReason | null) ?? null;
  // The files are the person's own and outlive this record: listed from what is kept, with a preview where the record still has one
  const previews = new Map((Array.isArray(result.files) ? (result.files as JobView['files']) : []).map((file) => [file.id, file.preview]));
  const files: JobView['files'] = (await resultsOfSource('code_job', row.id)).map((kept) => ({
    id: kept.id,
    name: kept.name,
    bytes: kept.sizeBytes,
    contentType: kept.contentType,
    path: `/api/workbench/outputs/${kept.id}`,
    ...(previews.get(kept.id) ? { preview: previews.get(kept.id) } : {}),
  }));
  return {
    jobId: row.id,
    state,
    reason,
    message: `${headline(state, reason)} ${whatRan(row, result, files)}`,
    deadlineAt: row.deadlineAt.toISOString(),
    runsUsed: row.cellsRun,
    runs: Array.isArray(result.runs) ? (result.runs as JobView['runs']) : [],
    reads: Array.isArray(result.reads) ? (result.reads as JobView['reads']) : [],
    files,
    notKept: Array.isArray(result.notKept) ? (result.notKept as JobView['notKept']) : [],
    clipped: result.clipped === true,
  };
}

// ---------- The sweep ----------

export interface SweepResult {
  /** Results of deleted accounts removed. */
  orphansRemoved?: number;
  /** Jobs that were cancelled, timed out or lost whose files were removed by the sweep (a removal that failed when they ended). */
  outputsRemoved: number;
  /** Finished jobs whose meter line was written late. */
  metered: number;
  stopped: number;
  closed: number;
  purged: number;
}

const SWEEP_BATCH = 50;

/**
 * Looks after what a crash or a closed connection could leave behind: a job still "running" past its deadline (and the time to copy files)
 * or whose process stopped saying it is alive is ended and its workspace deleted; a job whose workspace could not be deleted is deleted
 * again; a job's result and files past "days kept" are removed. Safe to run twice at once and from any process.
 */
export async function sweepCodeJobs(deps: Deps = {}): Promise<SweepResult> {
  const now = deps.now ?? (() => new Date());
  const adapter = adapterOf(deps.adapter);
  const store = deps.store ?? getOutputStore();
  const at = now();
  const result: SweepResult = { stopped: 0, closed: 0, purged: 0, metered: 0, outputsRemoved: 0 };

  if (adapter) {
    const ctx: Ctx = { adapter, store, now };
    const active = await prisma.codeJob.findMany({ where: { state: { in: ACTIVE } }, orderBy: { heartbeatAt: 'asc' }, take: SWEEP_BATCH });
    for (const job of active) {
      const late = at.getTime() > job.deadlineAt.getTime() + INGEST_GRACE_MS;
      const lost = at.getTime() - job.heartbeatAt.getTime() > STALE_MS && !live.has(job.id);
      if (!late && !lost) continue;
      const limits = job.limits as unknown as FilledLimits;
      const price = priceOfJob(job);
      live.get(job.id)?.abort();
      const won = await finishJob(job.id, late ? { state: 'timed_out', reason: 'timed_out' } : { state: 'interrupted', reason: 'interrupted' }, { runs: [], reads: [], files: [], notKept: [], clipped: false }, limits, price, ctx);
      if (won) result.stopped += 1;
    }
    const open = await prisma.codeJob.findMany({ where: { state: { notIn: ACTIVE }, providerSessionId: { not: null }, OR: [{ providerState: { in: ['open', 'unknown'] } }, { nestedCheckedAt: null }] }, orderBy: [{ nestedTriedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }], take: SWEEP_BATCH, select: { id: true } });
    for (const job of open) {
      await closeSession(job.id, ctx);
      const after = await prisma.codeJob.findUnique({ where: { id: job.id }, select: { providerState: true } });
      if (after?.providerState === 'closed') result.closed += 1;
    }
  }

  // Jobs that ended without their meter line (the meter did not answer, or the process stopped between the two): written now, once (the event id is the job's)
  const unmetered = await prisma.codeJob.findMany({ where: { state: { notIn: ACTIVE }, meteredAt: null, finishedAt: { lt: new Date(at.getTime() - METER_GRACE_MS) } }, orderBy: { finishedAt: 'asc' }, take: SWEEP_BATCH, select: { id: true } });
  for (const job of unmetered) {
    try {
      await settle(job.id, now);
      result.metered += 1;
    } catch (error) {
      console.error('[CodeJob] A finished job could not be written to the meter yet:', error instanceof Error ? error.message : 'unknown');
    }
  }

  // The job's printed result is kept for the days Limit and then emptied. Its files are the person's own and are not touched here: they stay until the owner deletes them
  const expired = await prisma.codeJob.findMany({ where: { expiresAt: { lt: at } }, orderBy: { expiresAt: 'asc' }, take: SWEEP_BATCH, select: { id: true } });
  for (const job of expired) {
    try {
      // Emptied once: the row stays for the books (what it cost), and is not looked at again
      await prisma.codeJob.update({ where: { id: job.id }, data: { result: Prisma.DbNull, expiresAt: null } });
      result.purged += 1;
    } catch (error) {
      console.error('[CodeJob] A kept job could not be removed yet:', error instanceof Error ? error.message : 'unknown');
    }
  }
  // A cancelled, timed out or lost job keeps no files. A removal that failed when it ended, or a file saved while it was ending, is removed here
  const stray = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT j."id" FROM "code_jobs" j
    JOIN "owned_results" r ON r."source_kind" = 'code_job' AND r."source_id" = j."id"
    WHERE j."state" IN ('cancelled', 'timed_out', 'interrupted')
    LIMIT ${SWEEP_BATCH}`;
  for (const job of stray) {
    try {
      await dropOutputs(job.id, store);
      result.outputsRemoved += 1;
    } catch (error) {
      console.error('[CodeJob] The files of a stopped job could not be removed yet:', error instanceof Error ? error.message : 'unknown');
    }
  }
  // Results whose owner's account is gone
  result.orphansRemoved = await purgeOrphanedResults(store).catch((error) => {
    console.error('[CodeJob] Results of a deleted account could not be removed yet:', error instanceof Error ? error.message : 'unknown');
    return 0;
  });
  return result;
}

/** One kept file for its owner: the bytes, the name and the type it is served as. Null for anyone else, and for a file that has gone. */
export async function openOutput(outputId: string, personId: string, deps: Deps = {}): Promise<{ name: string; contentType: string; bytes: Uint8Array } | null> {
  return openResult(outputId, personId, deps.store ?? getOutputStore());
}

/** Jobs working in this process (for the tests and the status screen). */
export const liveJobCount = (): number => live.size;
