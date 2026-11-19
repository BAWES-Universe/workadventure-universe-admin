import { prisma } from '@/lib/db';
import { providerFor, fenceMachine } from '@/lib/computer';
import { mintJobToken, revokeJobTokens } from '@/lib/computer-token';
import { Agent37Error } from '@/lib/agent37/client';
import type { TurnEvent } from '@/lib/agent37/turn-events';

/**
 * The broker (build handoff v2, section 5): how the bot server's runner reaches a computer without ever holding Agent37's key.
 * The runner asks Orbit; Orbit checks the job from its own records, and only then talks to the machine. Nothing here takes a job id,
 * a turn id or a machine from the caller as authority: the job decides which machine, which conversation and which turn.
 *
 * Who may act: only a job that is RUNNING with Brick holding the keyboard. A job that waits for its person, is over, or is in line has
 * no turn, and a person who has taken over is never talked over.
 */

type Live = { jobId: string; botId: string; generation: number; ref: string; sessionId: string | null; responseId: string | null };

export type NotLive = { ok: false; reason: 'not_found' | 'not_running' | 'person_has_it' | 'no_machine' };

/** The job as it stands, when Brick may act on it. */
async function liveJob(jobId: string): Promise<{ ok: true; job: Live; provider: NonNullable<ReturnType<typeof providerFor>> } | NotLive> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, reason: 'not_found' };
  if (job.status === 'waiting' && job.control === 'person') return { ok: false, reason: 'person_has_it' };
  if (job.status !== 'running' || job.control !== 'brick') return { ok: false, reason: 'not_running' };
  const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
  const provider = providerFor(row);
  if (!row?.providerRef || !provider || row.machine !== 'working') return { ok: false, reason: 'no_machine' };
  return { ok: true, job: { jobId: job.id, botId: job.botId, generation: job.controlGeneration, ref: row.providerRef, sessionId: job.agentSessionId, responseId: job.agentResponseId }, provider };
}

/** Where the model relay is: an https address with no login, query or fragment, ending where /v1 begins. */
export function relayAddressOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '');
  // Whatever is put in a command is only characters of a plain address
  const address = `${url.origin}${path}`;
  return /^[A-Za-z0-9:/._-]+$/.test(address) ? address : null;
}

type Claim = 'prepareClaimedAt' | 'turnClaimedAt';

/**
 * A short claim on one thing a job does, kept in its row so it holds across servers. `waitMs` is how long to wait for a claim someone
 * else holds (0: do not wait). A claim nobody released lapses after `staleMs`. Returns the mark to release it with, 'busy' when it is
 * held, or 'gone' when there is no such job.
 */
async function claimOnJob(jobId: string, field: Claim, staleMs: number, waitMs: number): Promise<Date | 'busy' | 'gone'> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const mark = new Date();
    const claimed = await prisma.computerJob.updateMany({ where: { id: jobId, OR: [{ [field]: null }, { [field]: { lt: new Date(mark.getTime() - staleMs) } }] }, data: { [field]: mark } });
    if (claimed.count === 1) return mark;
    if (!(await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true } }))) return 'gone';
    if (Date.now() >= deadline) return 'busy';
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const releaseOnJob = (jobId: string, field: Claim, mark: Date) => prisma.computerJob.updateMany({ where: { id: jobId, [field]: mark }, data: { [field]: null } }).catch(() => undefined);

/** Writing a key takes at most the machine's own limit and a little more. */
const PREPARE_CLAIM_STALE_MS = 90_000;
const PREPARE_CLAIM_WAIT_MS = 60_000;
const TURN_CLAIM_STALE_MS = 120_000;

export type Prepared = { ok: true; expiresAt: Date } | NotLive | { ok: false; reason: 'bad_relay' | 'failed' };

/**
 * Gives the job's computer what it needs to ask for a model: a new key and the relay's address, written where the image's local
 * model address reads them on every call (so Hermes itself never has to restart or learn a new key). Every earlier key of the job
 * ends first, so one key is good at a time. The key crosses only the exec call to the machine, which Agent37 carries over TLS.
 */
export async function prepareJob(jobId: string, relay: unknown, now: Date = new Date()): Promise<Prepared> {
  const address = relayAddressOf(relay);
  if (!address) return { ok: false, reason: 'bad_relay' };
  // One key is made and written at a time for a job: ending the old keys, making the new one and writing it are one piece, so a second
  // prepare at the same moment cannot end this one's key after it was written, or write an older key over a newer one
  const claim = await claimOnJob(jobId, 'prepareClaimedAt', PREPARE_CLAIM_STALE_MS, PREPARE_CLAIM_WAIT_MS);
  if (claim === 'gone') return { ok: false, reason: 'not_found' };
  if (claim === 'busy') return { ok: false, reason: 'failed' };
  try {
    return await prepareClaimed(jobId, address, now);
  } finally {
    await releaseOnJob(jobId, 'prepareClaimedAt', claim);
  }
}

async function prepareClaimed(jobId: string, address: string, now: Date): Promise<Prepared> {
  const live = await liveJob(jobId);
  if (!live.ok) return live;
  await revokeJobTokens(jobId, now);
  // Only for the job as it stands now: a take-over after the look above gets no key
  const minted = await mintJobToken(jobId, 'model', now, { generation: live.job.generation });
  if (!minted.ok) return { ok: false, reason: minted.reason };
  const file = JSON.stringify({ url: address, token: minted.token });
  // Written whole to a new file and moved over the old one, so a call never reads half of it. Only the machine's own user can read it.
  // Under a lock, and only over a key of an older or the same control number: a write that was delayed past a take-over and a hand-back
  // finds a newer key there and leaves it alone.
  const generation = live.job.generation;
  // What was last written is noted as "job number" (one job's later write is not stopped by another job's number)
  const command =
    `umask 077 && d="$HOME/.universe" && mkdir -p "$d" && ( flock 9 || exit 1; read -r who cur < "$d/relay.gen" 2>/dev/null; ` +
    `if [ "$who" = '${jobId}' ] && [ -n "$cur" ] && [ "$cur" -gt ${generation} ] 2>/dev/null; then exit 0; fi; ` +
    `printf '%s' '${file}' > "$d/relay.json.new" && mv "$d/relay.json.new" "$d/relay.json" && printf '%s %s' '${jobId}' ${generation} > "$d/relay.gen" ) 9>"$d/relay.lock"`;
  try {
    const done = await live.provider.exec(live.job.ref, command, { timeoutMs: 30_000 });
    if (done.exitCode !== 0) {
      await revokeJobTokens(jobId, now);
      return { ok: false, reason: 'failed' };
    }
  } catch (error) {
    console.error('[Computer] Could not prepare a machine:', error instanceof Error ? error.message : 'unknown');
    await revokeJobTokens(jobId, now);
    return { ok: false, reason: 'failed' };
  }
  // The person may have taken over while the key was being written: the key is then of an older control number (it is refused), and the
  // runner is told the job is not its to act on
  const after = await liveJob(jobId);
  if (!after.ok) return after;
  if (after.job.generation !== generation) return { ok: false, reason: 'not_running' };
  return { ok: true, expiresAt: minted.expiresAt };
}

export type StartedTurn =
  | { ok: true; events: AsyncGenerator<TurnEvent> }
  | NotLive
  /** The agent is already working on a turn: its id is given, so the caller reconnects to it instead of starting another. */
  | { ok: false; reason: 'busy'; responseId: string | null }
  | { ok: false; reason: 'failed' };

/**
 * Sends the agent a message and gives its events as they come. The turn's ids are kept on the job the moment they are known, and only
 * while the job is still the one that was asked: if the person took over in between, the turn is cancelled at once and the stream says it
 * was fenced. A second turn is never started on a conversation that is still working.
 */
export async function startTurn(jobId: string, text: unknown, signal?: AbortSignal): Promise<StartedTurn> {
  if (typeof text !== 'string' || text.trim() === '' || text.length > 200_000) return { ok: false, reason: 'failed' };
  const live = await liveJob(jobId);
  if (!live.ok) return live;
  const { job, provider } = live;
  // A turn is kept but its conversation is not known (the agent did not say it): whether it still runs cannot be asked, so the caller is
  // sent to reconnect to it; a turn that is gone says so there and its id is cleared
  if (job.responseId && !job.sessionId) return { ok: false, reason: 'busy', responseId: job.responseId };
  if (job.responseId && job.sessionId) {
    // A check that could not be made is not an answer: the turn may still be running, so its id stays and this one is tried again later
    let unsure = false;
    const active = await provider.activeTurn(job.ref, job.sessionId).catch(() => {
      unsure = true;
      return null;
    });
    if (unsure) return { ok: false, reason: 'failed' };
    if (active) return { ok: false, reason: 'busy', responseId: active };
    // The turn we kept is over (the stream was lost before its end reached us): it is cleared and this one goes ahead
    await prisma.computerJob.updateMany({ where: { id: job.jobId, agentResponseId: job.responseId }, data: { agentResponseId: null } });
  }
  // Only one turn is started at a time on a job: it is claimed before the agent is asked, so two starts at the same moment never both open
  // one. The claim is let go when the turn's id is kept (or the start fails); one nobody released lapses by itself.
  const claim = await claimOnJob(job.jobId, 'turnClaimedAt', TURN_CLAIM_STALE_MS, 0);
  if (claim === 'gone') return { ok: false, reason: 'not_found' };
  if (claim === 'busy') return { ok: false, reason: 'busy', responseId: job.responseId };
  // The runner's connection must not cut the turn off before its id is kept: once the agent has accepted it, it runs on the machine, and
  // an id that was never stored leaves nothing to cancel or reconnect to. So the request's own signal is not handed on; the start has its
  // own limit instead, for the agent's answer only: once it has accepted the turn the limit is lifted, because cutting the stream before its id arrived would leave a turn running on the machine with nothing to cancel.
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(), TURN_START_LIMIT_MS);
  let events: AsyncGenerator<TurnEvent>;
  try {
    if (signal?.aborted) {
      clearTimeout(timer);
      await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
      return { ok: false, reason: 'failed' };
    }
    events = await provider.openTurn(job.ref, { text, sessionId: job.sessionId }, own.signal);
    // The agent has answered, so the turn is accepted: the limit was for that answer. Its id follows on the stream, however long that takes.
    clearTimeout(timer);
  } catch (error) {
    clearTimeout(timer);
    await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
    if (error instanceof Agent37Error && error.code === 'session_busy') return { ok: false, reason: 'busy', responseId: error.runningResponseId };
    console.error('[Computer] Could not start a turn:', error instanceof Error ? error.message : 'unknown');
    return { ok: false, reason: 'failed' };
  }
  return { ok: true, events: keeping(job, provider, events, { timer, controller: own, claim }) };
}

/** How long the agent has to accept a turn and say its id. */
const TURN_START_LIMIT_MS = 30_000;

/**
 * Keeps a turn's ids on its job while the turn runs, and clears them only when the turn itself ends (completed or failed). If the reader goes
 * away first (the runner dropped, Orbit restarted) the turn is still running on the machine, so its id stays: the runner can reconnect to it,
 * and ending the job or the take-over fence can still cancel it. A turn begun under an older control number is cancelled.
 */
async function* keeping(
  job: Live,
  provider: NonNullable<ReturnType<typeof providerFor>>,
  events: AsyncGenerator<TurnEvent>,
  start?: { timer: ReturnType<typeof setTimeout>; controller: AbortController; claim?: Date },
): AsyncGenerator<TurnEvent> {
  let responseId: string | null = null;
  let over = false;
  try {
    for (;;) {
      // Read one event at a time: a reader that goes away while this waits for the id is only heard after the id is kept
      const next = await events.next();
      if (next.done) return;
      const event = next.value;
      // Until the turn's id is kept, nothing is passed on (a keep-alive included): the reader is only heard at a hand-over, and a reader that
      // went away at one would end this before the id was stored
      if (start && !responseId && event.type !== 'created' && event.type !== 'completed' && event.type !== 'failed') continue;
      if (event.type === 'created') {
        if (start) clearTimeout(start.timer);
        responseId = event.id;
        // Only the first turn id to arrive is kept: a second turn that started at the same moment on this conversation is not the job's
        // own, and a stored id is never replaced by another one
        const kept = await prisma.computerJob.updateMany({
          where: {
            id: job.jobId,
            status: 'running',
            control: 'brick',
            controlGeneration: job.generation,
            OR: [{ agentResponseId: null }, { agentResponseId: event.id }],
          },
          data: { agentSessionId: event.sessionId ?? job.sessionId, agentResponseId: event.id },
        });
        // The id is kept (or the turn is refused): the start is over, and the next one is decided by the job's own turn from here
        if (start?.claim) await releaseOnJob(job.jobId, 'turnClaimedAt', start.claim);
        if (kept.count === 0) {
          // The person took over (or the job ended) between asking and the agent starting, or another turn holds the job: this turn must not run
          await cancelOrFence(job, provider, event.id);
          responseId = null;
          over = true;
          yield { type: 'failed', code: 'fenced', message: 'The turn was stopped because the person took over' };
          return;
        }
      }
      if (event.type === 'completed' || event.type === 'failed') over = true;
      yield event;
      if (over) return;
    }
  } finally {
    if (start) clearTimeout(start.timer);
    // The turn's id is kept by now, or the stream ended without one: the start is over either way
    if (start?.claim) await releaseOnJob(job.jobId, 'turnClaimedAt', start.claim);
    // The stream is let go of: the turn itself goes on on the machine unless it ended
    await events.return(undefined).catch(() => undefined);
    if (responseId && over) await prisma.computerJob.updateMany({ where: { id: job.jobId, agentResponseId: responseId }, data: { agentResponseId: null } }).catch(() => undefined);
  }
}

/**
 * Cancels a turn that must not run. A cancel that cannot be made is tried again; if it still cannot, the turn would run untracked (its id is
 * not the job's), so the machine's own fence stops what the agent started instead. Never throws.
 */
async function cancelOrFence(job: Live, provider: NonNullable<ReturnType<typeof providerFor>>, id: string): Promise<void> {
  for (let attempt = 0; attempt < CANCEL_TRIES; attempt++) {
    try {
      await provider.cancelTurn(job.ref, id);
      return;
    } catch (error) {
      console.error('[Computer] Could not cancel a turn:', error instanceof Error ? error.message : 'unknown');
    }
  }
  await fenceMachine(job.botId);
}

const CANCEL_TRIES = 3;

export type Cancelled = { ok: true; cancelled: boolean } | NotLive | { ok: false; reason: 'failed' };

/** Cancels the job's own running turn, if any. Which turn is the job's: the caller cannot name another. */
export async function cancelJobTurn(jobId: string): Promise<Cancelled> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, reason: 'not_found' };
  if (!job.agentResponseId) return { ok: true, cancelled: false };
  const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
  const provider = providerFor(row);
  if (!row?.providerRef || !provider) return { ok: false, reason: 'no_machine' };
  try {
    await provider.cancelTurn(row.providerRef, job.agentResponseId);
  } catch (error) {
    console.error('[Computer] Could not cancel a turn:', error instanceof Error ? error.message : 'unknown');
    return { ok: false, reason: 'failed' };
  }
  return { ok: true, cancelled: true };
}

export type Reattached = { ok: true; events: AsyncGenerator<TurnEvent> } | NotLive | { ok: false; reason: 'no_turn' | 'failed' };

/** Reconnects to the job's own turn from its start, after the runner or Orbit lost the stream. A turn that is gone (30 minutes after it ends) says so. */
export async function reattachJobTurn(jobId: string, signal?: AbortSignal): Promise<Reattached> {
  const live = await liveJob(jobId);
  if (!live.ok) return live;
  if (!live.job.responseId) return { ok: false, reason: 'no_turn' };
  try {
    const events = await live.provider.reattachTurn(live.job.ref, live.job.responseId, signal);
    return { ok: true, events: keeping(live.job, live.provider, events) };
  } catch (error) {
    if (error instanceof Agent37Error && error.status === 404) {
      await prisma.computerJob.updateMany({ where: { id: jobId, agentResponseId: live.job.responseId }, data: { agentResponseId: null } });
      return { ok: false, reason: 'no_turn' };
    }
    console.error('[Computer] Could not reconnect to a turn:', error instanceof Error ? error.message : 'unknown');
    return { ok: false, reason: 'failed' };
  }
}
