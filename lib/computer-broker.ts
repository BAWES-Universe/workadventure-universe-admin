import { prisma } from '@/lib/db';
import { providerFor } from '@/lib/computer';
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

export type Prepared = { ok: true; expiresAt: Date } | NotLive | { ok: false; reason: 'bad_relay' | 'failed' };

/**
 * Gives the job's computer what it needs to ask for a model: a new key and the relay's address, written where the image's local
 * model address reads them on every call (so Hermes itself never has to restart or learn a new key). Every earlier key of the job
 * ends first, so one key is good at a time. The key crosses only the exec call to the machine, which Agent37 carries over TLS.
 */
export async function prepareJob(jobId: string, relay: unknown, now: Date = new Date()): Promise<Prepared> {
  const address = relayAddressOf(relay);
  if (!address) return { ok: false, reason: 'bad_relay' };
  const live = await liveJob(jobId);
  if (!live.ok) return live;
  await revokeJobTokens(jobId, now);
  const minted = await mintJobToken(jobId, 'model', now);
  if (!minted.ok) return { ok: false, reason: minted.reason };
  const file = JSON.stringify({ url: address, token: minted.token });
  // Written whole to a new file and moved over the old one, so a call never reads half of it. Only the machine's own user can read it.
  const command = `umask 077 && d="$HOME/.universe" && mkdir -p "$d" && printf '%s' '${file}' > "$d/relay.json.new" && mv "$d/relay.json.new" "$d/relay.json"`;
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
  if (job.responseId && job.sessionId) {
    const active = await provider.activeTurn(job.ref, job.sessionId).catch(() => null);
    if (active) return { ok: false, reason: 'busy', responseId: active };
    // The turn we kept is over (the stream was lost before its end reached us): it is cleared and this one goes ahead
    await prisma.computerJob.updateMany({ where: { id: job.jobId, agentResponseId: job.responseId }, data: { agentResponseId: null } });
  }
  let events: AsyncGenerator<TurnEvent>;
  try {
    events = await provider.openTurn(job.ref, { text, sessionId: job.sessionId }, signal);
  } catch (error) {
    if (error instanceof Agent37Error && error.code === 'session_busy') return { ok: false, reason: 'busy', responseId: error.runningResponseId };
    console.error('[Computer] Could not start a turn:', error instanceof Error ? error.message : 'unknown');
    return { ok: false, reason: 'failed' };
  }
  return { ok: true, events: keeping(job, provider, events) };
}

/**
 * Keeps a turn's ids on its job while the turn runs, and clears them only when the turn itself ends (completed or failed). If the reader goes
 * away first (the runner dropped, Orbit restarted) the turn is still running on the machine, so its id stays: the runner can reconnect to it,
 * and ending the job or the take-over fence can still cancel it. A turn begun under an older control number is cancelled.
 */
async function* keeping(job: Live, provider: NonNullable<ReturnType<typeof providerFor>>, events: AsyncGenerator<TurnEvent>): AsyncGenerator<TurnEvent> {
  let responseId: string | null = null;
  let over = false;
  try {
    for await (const event of events) {
      if (event.type === 'created') {
        responseId = event.id;
        const kept = await prisma.computerJob.updateMany({
          where: { id: job.jobId, status: 'running', control: 'brick', controlGeneration: job.generation },
          data: { agentSessionId: event.sessionId ?? job.sessionId, agentResponseId: event.id },
        });
        if (kept.count === 0) {
          // The person took over (or the job ended) between asking and the agent starting: this turn must not run
          await provider.cancelTurn(job.ref, event.id).catch(() => undefined);
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
    if (responseId && over) await prisma.computerJob.updateMany({ where: { id: job.jobId, agentResponseId: responseId }, data: { agentResponseId: null } }).catch(() => undefined);
  }
}

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
