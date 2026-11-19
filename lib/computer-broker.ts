import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { agentCannotRun, providerFor, fenceMachine, finishJob, settleTurnHold, underTurnHold, wakeIfStopped } from '@/lib/computer';
import { mintJobToken, revokeJobTokens, revokeToken } from '@/lib/computer-token';
import { jobTagOf } from '@/lib/computer-values';
import { withoutTags } from '@/lib/computer-turn-tags';
import { Agent37Error, TurnNotSent } from '@/lib/agent37/client';
import type { TurnEvent } from '@/lib/agent37/turn-events';

/**
 * The broker (build handoff v2, section 5): how the bot server's runner reaches a computer without ever holding Agent37's key.
 * The runner asks Orbit; Orbit checks the job from its own records, and only then talks to the machine. Nothing here takes a job id,
 * a turn id or a machine from the caller as authority: the job decides which machine, which conversation and which turn.
 *
 * Who may act: only a job that is RUNNING with Brick holding the keyboard. A job that waits for its person, is over, or is in line has
 * no turn, and a person who has taken over is never talked over.
 */

type Live = { jobId: string; botId: string; generation: number; ref: string; sessionId: string | null; responseId: string | null; firstTurnSentAt: Date | null };

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
  return { ok: true, job: { jobId: job.id, botId: job.botId, generation: job.controlGeneration, ref: row.providerRef, sessionId: job.agentSessionId, responseId: job.agentResponseId, firstTurnSentAt: job.firstTurnSentAt }, provider };
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
  // The mark is made by the database's clock, never a server's: servers' clocks differ, and a claim's mark is also what a later claim is told apart from
  // (the machine keeps the write whose claim is later) and when a left claim lapses. One clock decides all of it. Kept to the millisecond the column holds.
  const column = field === 'prepareClaimedAt' ? Prisma.raw('"prepare_claimed_at"') : Prisma.raw('"turn_claimed_at"');
  for (;;) {
    const marks = await prisma.$queryRaw<Array<{ mark: Date }>>(Prisma.sql`
      UPDATE "computer_jobs" SET ${column} = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id" = ${jobId} AND (${column} IS NULL OR ${column} < date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${staleMs / 1000}))
      RETURNING ${column} AS "mark"`);
    if (marks.length === 1) return marks[0].mark;
    if (!(await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true } }))) return 'gone';
    if (Date.now() >= deadline) return 'busy';
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const releaseOnJob = (jobId: string, field: Claim, mark: Date) => prisma.computerJob.updateMany({ where: { id: jobId, [field]: mark }, data: { [field]: null } }).catch(() => undefined);

/** Writing a key takes at most the machine's own limit and a little more. */
const PREPARE_CLAIM_STALE_MS = 45_000;
// The runner gives up each call after 8 seconds and ends the job after 3 tries, so a second prepare waits only a little for the first
// and then says "preparing": the runner asks again without counting it as a failure
const PREPARE_CLAIM_WAIT_MS = 5_000;
// A turn's id is kept within the agent's own start limit (30 s) and a little more; a claim left by a server that stopped lapses soon after, so
// the runner is not told to wait for minutes behind it
const TURN_CLAIM_STALE_MS = 45_000;
/** The most a start's claim is kept fresh while the agent has not said its turn's id: long past the agent's own start limit (30 s), so a turn that is only slow is covered. */
const TURN_CLAIM_RENEW_MAX_MS = 5 * 60_000;

export type Prepared =
  | { ok: true; expiresAt: Date }
  | NotLive
  /** Another prepare of the job holds its claim: the caller waits a few seconds and asks again, it is not a failure. */
  | { ok: false; reason: 'preparing' }
  | { ok: false; reason: 'bad_relay' | 'failed' };

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
  if (claim === 'busy') return { ok: false, reason: 'preparing' };
  try {
    return await prepareClaimed(jobId, address, now, claim);
  } finally {
    await releaseOnJob(jobId, 'prepareClaimedAt', claim);
  }
}

/** Whether the prepare that made this claim still holds it (another takes a claim that was left too long). */
const holdsPrepareClaim = async (jobId: string, claim: Date) => (await prisma.computerJob.count({ where: { id: jobId, prepareClaimedAt: claim } })) === 1;

/**
 * A key whose write failed ends: every key of the job while this still holds the claim (as before), and in any case this one's own, so a prepare that lost its
 * claim meanwhile never leaves the key it made good next to the one that took the claim over. (A key is only ever usable from the machine's relay file, which holds one:
 * the key crosses only the write, so a key that was not written, or was written over, reaches no call.)
 */
async function endOwnKey(jobId: string, token: string, now: Date, claim: Date): Promise<void> {
  await revokeJobTokens(jobId, now, { prepareClaim: claim });
  await revokeToken(token, now);
}

async function prepareClaimed(jobId: string, address: string, now: Date, claim: Date): Promise<Prepared> {
  const live = await liveJob(jobId);
  if (!live.ok) return live;
  // A prepare that was held up past its claim (a stopped process, a database that did not answer) finds another one has it now: it changes no key and
  // writes nothing, and the caller asks again. The keys end only while the claim is still this one's, in the very statement that checks it
  if (!(await holdsPrepareClaim(jobId, claim))) return { ok: false, reason: 'preparing' };
  await revokeJobTokens(jobId, now, { prepareClaim: claim });
  if (!(await holdsPrepareClaim(jobId, claim))) return { ok: false, reason: 'preparing' };
  // Only for the job as it stands now: a take-over after the look above gets no key
  const minted = await mintJobToken(jobId, 'model', now, { generation: live.job.generation });
  if (!minted.ok) return { ok: false, reason: minted.reason };
  // Not written when the claim went to another while the key was made: that one makes and writes its own, and this key is ended
  if (!(await holdsPrepareClaim(jobId, claim))) {
    await revokeToken(minted.token, now);
    return { ok: false, reason: 'preparing' };
  }
  const file = JSON.stringify({ url: address, token: minted.token });
  // Written whole to a new file and moved over the old one, so a call never reads half of it. Only the machine's own user can read it.
  // Under a lock, and only over a key of an older or the same control number: a write that was delayed past a take-over and a hand-back
  // finds a newer key there and leaves it alone. Of two writes under the same control number the one whose claim was made later wins (a claim is
  // made later than any it replaced), so a write that was delayed past its claim never puts its ended key over the newer one.
  const generation = live.job.generation;
  const mark = claim.getTime();
  // What was last written is noted as "job number claim" (one job's later write is not stopped by another job's number)
  const command =
    `umask 077 && d="$HOME/.universe" && mkdir -p "$d" && ( flock 9 || exit 1; ` +
    // The job's own newer write is looked for FIRST, before anything is written: a write that is stale for this job (an older control number, or an older claim
    // of the same number) changes nothing at all, not even the key last written, whichever job wrote last
    `read -r jg jm < "$d/jobs/${jobId}.gen" 2>/dev/null; ` +
    `if [ -n "$jg" ] && { [ ${generation} -lt "$jg" ] || { [ ${generation} -eq "$jg" ] && [ -n "$jm" ] && [ ${mark} -lt "$jm" ]; }; } 2>/dev/null; then exit 0; fi; ` +
    `read -r who cur mk < "$d/relay.gen" 2>/dev/null; ` +
    `if [ "$who" = '${jobId}' ] && [ -n "$cur" ] && { [ "$cur" -gt ${generation} ] || { [ "$cur" -eq ${generation} ] && [ -n "$mk" ] && [ "$mk" -gt ${mark} ]; }; } 2>/dev/null; then exit 0; fi; ` +
    `printf '%s' '${file}' > "$d/relay.json.new" && mv "$d/relay.json.new" "$d/relay.json" && printf '%s %s %s' '${jobId}' ${generation} ${mark} > "$d/relay.gen" && ` +
    // The job's own key goes where the model address looks for the job a call belongs to (its turns carry the job's tag). Another job's key beside it is never
    // touched, so jobs that run at once each call on their own. Files a week old are removed.
    `mkdir -p "$d/jobs" && printf '%s' '${file}' > "$d/jobs/${jobId}.json.new" && mv "$d/jobs/${jobId}.json.new" "$d/jobs/${jobId}.json" && printf '%s %s' ${generation} ${mark} > "$d/jobs/${jobId}.gen" && ` +
    `{ find "$d/jobs" -type f -mtime +7 -delete 2>/dev/null || :; } ) 9>"$d/relay.lock"`;
  try {
    const done = await live.provider.exec(live.job.ref, command, { timeoutMs: 30_000 });
    if (done.exitCode !== 0) {
      await endOwnKey(jobId, minted.token, now, claim);
      return { ok: false, reason: 'failed' };
    }
  } catch (error) {
    console.error('[Computer] Could not prepare a machine:', error instanceof Error ? error.message : 'unknown');
    await endOwnKey(jobId, minted.token, now, claim);
    return { ok: false, reason: 'failed' };
  }
  // The person may have taken over while the key was being written: the key is then of an older control number (it is refused), and the
  // runner is told the job is not its to act on
  const after = await liveJob(jobId);
  if (!after.ok) return after;
  if (after.job.generation !== generation) return { ok: false, reason: 'not_running' };
  // The claim went to another while the key was being written: that one's key is the one that stays, and the caller asks again
  if (!(await holdsPrepareClaim(jobId, claim))) {
    await revokeToken(minted.token, now);
    return { ok: false, reason: 'preparing' };
  }
  return { ok: true, expiresAt: minted.expiresAt };
}

export type StartedTurn =
  | { ok: true; events: AsyncGenerator<TurnEvent> }
  | NotLive
  /** The agent is already working on a turn: its id is given, so the caller reconnects to it instead of starting another. */
  | { ok: false; reason: 'busy'; responseId: string | null }
  /** Another start of a turn on the job holds its claim (it may be on its way, or left by a server that stopped): there is no turn to reconnect to, the caller waits a few seconds and asks again, it is not a failure. */
  | { ok: false; reason: 'starting' }
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
  // Held by a start still on its way, or left by a server that stopped: there is no turn id to hand back (and one just cleared must never be
  // sent as "busy"), so the caller is told "starting": it waits a few seconds and asks again, and the claim lapses by itself
  if (claim === 'busy') return { ok: false, reason: 'starting' };
  // Everything between the claim and the start's own try below runs under this one: a read that throws (the database, the provider) must not leave the
  // claim held for its whole lapse, with every start in that time told "starting". The claim goes back on any throw here, before a turn could be open: the
  // first-turn mark is written at the very end of this part, and a throw after it is the next try's, which keeps the mark rules
  let ready!: { job: Live; provider: NonNullable<ReturnType<typeof providerFor>> };
  let sessionId: string | null;
  try {
    // Looked at again now that the claim is held: the job was read before it, and a start that kept its turn's id (or a take-over) in between changed what
    // is true. A turn the job holds now is busy (its id is given, to reconnect to), and the conversation to start on is the one it has now
    let fresh = await liveJob(job.jobId);
    if (!fresh.ok) {
      await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
      return fresh;
    }
    if (fresh.job.responseId) {
      await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
      return { ok: false, reason: 'busy', responseId: fresh.job.responseId };
    }
    // A job that ended on this machine may have left its first turn running there, with nothing to cancel it by: no turn is opened beside it until the
    // machine is proved asleep. The caller waits and asks again; the hold is lifted by the end of the jobs that hold the machine, or by the sweep.
    // (Asked after the busy answer above: a job's own named turn is never stopped by this.)
    if (await underTurnHold(fresh.job.botId)) {
      if (!(await settleTurnHold(fresh.job.botId, job.jobId))) {
        await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
        return { ok: false, reason: 'starting' };
      }
      // The machine may have been put to sleep to prove it, with this job the only one holding it: it is woken for this job (and the job ends as an error
      // if it will not come back, its room given back), so the job goes on instead of failing for nothing
      await wakeIfStopped(fresh.job.botId);
      fresh = await liveJob(job.jobId);
      if (!fresh.ok) {
        await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
        return fresh;
      }
    }
    sessionId = fresh.job.sessionId;
    // A job's very first turn has no conversation to be found by, and the agent has no way to be asked for "the turn this request started" (a request
    // carries no key of ours and sessions cannot be listed). So the turn is marked in the job's row BEFORE it is sent, and a start that finds the mark
    // with no turn id and no conversation (the server stopped after the agent accepted the turn, or the stream failed before its id came) never opens
    // a second one beside it: the job ends, visibly, as it does when the turn never says its id. In a conversation the agent knows, a second turn is
    // refused by the agent itself, atomically, so only the first turn needs the mark.
    if (!sessionId) {
      if (fresh.job.firstTurnSentAt) {
        const ended = await endJobOfUnknownTurn(job.jobId);
        await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
        return { ok: false, reason: ended ? 'not_running' : 'failed' };
      }
      const marked = await prisma.computerJob
        .updateMany({ where: { id: job.jobId, status: 'running', control: 'brick', firstTurnSentAt: null }, data: { firstTurnSentAt: new Date() } })
        .catch(() => null);
      if (!marked || marked.count !== 1) {
        await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
        return { ok: false, reason: marked ? 'not_running' : 'failed' };
      }
    }
    ready = fresh;
  } catch (error) {
    console.error('[Computer] Could not get a turn ready to start:', error instanceof Error ? error.message : 'unknown');
    await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
    return { ok: false, reason: 'failed' };
  }
  // The runner's connection must not cut the turn off before its id is kept: once the agent has accepted it, it runs on the machine, and
  // an id that was never stored leaves nothing to cancel or reconnect to. So the request's own signal is not handed on; the start has its
  // own limit instead, for the agent's answer only: once it has accepted the turn the limit is lifted, because cutting the stream before its id arrived would leave a turn running on the machine with nothing to cancel.
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(), TURN_START_LIMIT_MS);
  let events: AsyncGenerator<TurnEvent>;
  try {
    if (signal?.aborted) {
      clearTimeout(timer);
      // Nothing was sent: the mark goes too
      if (!sessionId) await prisma.computerJob.updateMany({ where: { id: job.jobId }, data: { firstTurnSentAt: null } }).catch(() => undefined);
      await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
      return { ok: false, reason: 'failed' };
    }
    events = await provider.openTurn(ready.job.ref, { text: `${jobTagOf(job.jobId)}\n${text}`, sessionId }, own.signal);
    // The agent has answered, so the turn is accepted: the limit was for that answer. Its id follows on the stream, however long that takes.
    clearTimeout(timer);
  } catch (error) {
    clearTimeout(timer);
    console.error('[Computer] Could not start a turn:', error instanceof Error ? error.message : 'unknown');
    if (!sessionId) {
      // The agent said no (an answer that is not a stream), or the machine was never reached: no turn was opened, the mark goes and the start can be
      // asked again. Anything else (a connection that broke, a limit that ran out, a server error) may have left a turn running that nothing names:
      // the job ends, and if it cannot be ended now the mark stays, so the next start ends it and never opens a second turn
      // An answer below 500 is a refusal, and `try_again` is Agent37 saying so itself. A 502/503/504 is not: it can come from a gateway after the agent
      // accepted the turn, so it ends the job rather than let a retry open a second first turn beside one that runs (the person would pay for both)
      const notSent = error instanceof TurnNotSent || (error instanceof Agent37Error && (error.status < 500 || error.code === 'try_again'));
      if (notSent) await prisma.computerJob.updateMany({ where: { id: job.jobId }, data: { firstTurnSentAt: null } }).catch(() => undefined);
      else await endJobOfUnknownTurn(job.jobId);
    }
    await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
    if (error instanceof Agent37Error && error.code === 'session_busy') return { ok: false, reason: 'busy', responseId: error.runningResponseId };
    return { ok: false, reason: 'failed' };
  }
  return { ok: true, events: withoutTags(keeping(ready.job, ready.provider, events, { timer, controller: own, claim })) };
}

/**
 * The job's first turn may be running on the machine with nothing to find it by: the job ends as failed (its keys revoked, its time settled, the
 * machine given back, which rests the turn). True when it ended; a job that cannot be ended now keeps its mark, so the next start ends it.
 */
async function endJobOfUnknownTurn(jobId: string): Promise<boolean> {
  try {
    await finishJob(jobId, 'failed');
    return true;
  } catch (error) {
    console.error('[Computer] Could not end a job whose first turn has no id:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
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
  // The start's claim is kept fresh while the turn is waited for: the agent may take longer than the claim's lapse to say its id (the start limit is
  // lifted once it has accepted the turn), and a second start must not take the claim and open another turn meanwhile. A server that stops stops
  // renewing it, and it lapses as before. The mark changes with each renewal, so it is the latest one that is let go of.
  let mark = start?.claim ?? null;
  let renewing: Promise<void> | null = null;
  const began = Date.now();
  // Set when the start is given up for good (see the cap below): the wait for the agent's answer ends at once
  let gaveUpAt: number | null = null;
  let gaveUp: (() => void) | null = null;
  const givenUp = new Promise<'gave-up'>((resolve) => (gaveUp = () => resolve('gave-up')));
  const beat =
    mark !== null && start
      ? setInterval(() => {
          // Never for ever: an agent that accepts the turn and neither says its id nor ends the stream would keep the claim for good, and every start
          // after it would be told "starting" for good. After the cap the claim lapses by itself, as one left by a server that stopped does
          if (Date.now() - began > TURN_CLAIM_RENEW_MAX_MS) {
            if (beat) clearInterval(beat);
            // What a replacement start would do next depends on whether the conversation is known. In one the agent knows, a second turn is refused by the
            // agent itself (409 session_busy, answered "busy" with the running turn's id), atomically, so the lapse is safe. For a job's very first turn
            // no conversation and no id are known, Agent37 has no way to ask for "the turn started by this request" (a request carries no key of ours and
            // sessions cannot be listed), so a replacement could run next to a turn that is still going. It must not: the job ends, visibly, and the
            // person is told it failed, instead of two agents silently working on one machine. (The turn that never said its id is cancelled by the
            // machine's own fence if it ever does, or rests with the machine.)
            if (!responseId && !job.sessionId && !over) {
              gaveUpAt = Date.now();
              renewing = (async () => {
                await finishJob(job.jobId, 'failed').catch((error) => console.error('[Computer] Could not end a job whose turn never said its id:', error instanceof Error ? error.message : 'unknown'));
                gaveUp?.();
                start?.controller.abort();
              })();
              return renewing;
            }
            return undefined;
          }
          renewing = (async () => {
            if (mark === null) return;
            // The new mark is the database's, as the claim's was
            const renewed = await prisma.$queryRaw<Array<{ mark: Date }>>(Prisma.sql`
              UPDATE "computer_jobs" SET "turn_claimed_at" = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
              WHERE "id" = ${job.jobId} AND "turn_claimed_at" = ${mark}
              RETURNING "turn_claimed_at" AS "mark"`);
            if (renewed.length === 1) mark = renewed[0].mark;
          })().catch(() => undefined);
          return renewing;
        }, TURN_CLAIM_STALE_MS / 3)
      : null;
  beat?.unref?.();
  // Stops the renewing (and waits for one in flight) and lets go of the claim as it stands now
  const letGoOfClaim = async () => {
    if (beat) clearInterval(beat);
    await renewing;
    if (mark !== null) {
      await releaseOnJob(job.jobId, 'turnClaimedAt', mark);
      mark = null;
    }
  };
  try {
    for (;;) {
      // Read one event at a time: a reader that goes away while this waits for the id is only heard after the id is kept
      let next: IteratorResult<TurnEvent> | 'gave-up';
      // A start of the job's first turn (no conversation known) that ends or fails before the turn's id came leaves a turn nothing can name
      const unnamed = !!start && !responseId && !job.sessionId;
      try {
        next = await Promise.race([events.next(), givenUp]);
      } catch (error) {
        // The stream was cut by the give-up itself: the same end as when it is seen first
        if (gaveUpAt !== null) next = 'gave-up';
        else if (unnamed) {
          // The stream failed before the id: the job ends here (its mark stays if it cannot), never a second turn beside one that may run
          await endJobOfUnknownTurn(job.jobId);
          over = true;
          yield { type: 'failed', code: 'no_turn_id', message: 'The agent never said its turn had started, so the job was ended' };
          return;
        } else throw error;
      }
      if (next === 'gave-up') {
        over = true;
        yield { type: 'failed', code: 'no_turn_id', message: 'The agent never said its turn had started, so the job was ended' };
        return;
      }
      if (next.done) {
        if (unnamed) {
          await endJobOfUnknownTurn(job.jobId);
          over = true;
          yield { type: 'failed', code: 'no_turn_id', message: 'The agent never said its turn had started, so the job was ended' };
        }
        return;
      }
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
          data: { agentSessionId: event.sessionId ?? job.sessionId, agentResponseId: event.id, firstTurnSentAt: null },
        });
        // The id is kept (or the turn is refused): the start is over, and the next one is decided by the job's own turn from here
        await letGoOfClaim();
        if (kept.count === 0) {
          // The person took over (or the job ended) between asking and the agent starting, or another turn holds the job: this turn must not run
          const cancelled = await cancelOrFence(job, provider, event.id);
          // The turn was cancelled by its id: nothing runs that nothing names, so the first-turn mark goes (not while the job holds another turn's id, which is
          // what a start looks at first). When the cancel could not be made, the machine's fence took its place, and that keeps the agent's gateway, where the
          // turn runs: the mark stays (the next start ends the job and opens no second turn) unless the machine itself is proved asleep
          if (cancelled || (await agentCannotRun(job.botId).catch(() => false))) {
            await prisma.computerJob.updateMany({ where: { id: job.jobId, agentResponseId: null }, data: { firstTurnSentAt: null } }).catch(() => undefined);
          }
          responseId = null;
          over = true;
          yield { type: 'failed', code: 'fenced', message: 'The turn was stopped because the person took over' };
          return;
        }
      }
      if (event.type === 'completed' || event.type === 'failed') {
        over = true;
        // The turn is over without its id having been kept: nothing runs that nothing names
        if (start && !responseId) await prisma.computerJob.updateMany({ where: { id: job.jobId }, data: { firstTurnSentAt: null } }).catch(() => undefined);
      }
      yield event;
      if (over) return;
    }
  } finally {
    if (start) clearTimeout(start.timer);
    // The turn's id is kept by now, or the stream ended without one: the start is over either way
    await letGoOfClaim();
    // The stream is let go of: the turn itself goes on on the machine unless it ended
    await events.return(undefined).catch(() => undefined);
    if (responseId && over) await prisma.computerJob.updateMany({ where: { id: job.jobId, agentResponseId: responseId }, data: { agentResponseId: null } }).catch(() => undefined);
  }
}

/**
 * Cancels a turn that must not run. A cancel that cannot be made is tried again; if it still cannot, the turn would run untracked (its id is
 * not the job's), so the machine's own fence stops what the agent started instead. True when the turn was cancelled by its id; false when it was
 * not (the fence does not know that id and keeps the agent's gateway, so the turn may still be running). Never throws.
 */
async function cancelOrFence(job: Live, provider: NonNullable<ReturnType<typeof providerFor>>, id: string): Promise<boolean> {
  for (let attempt = 0; attempt < CANCEL_TRIES; attempt++) {
    try {
      await provider.cancelTurn(job.ref, id);
      return true;
    } catch (error) {
      console.error('[Computer] Could not cancel a turn:', error instanceof Error ? error.message : 'unknown');
    }
  }
  await fenceMachine(job.botId);
  return false;
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
    return { ok: true, events: withoutTags(keeping(live.job, live.provider, events)) };
  } catch (error) {
    if (error instanceof Agent37Error && error.status === 404) {
      await prisma.computerJob.updateMany({ where: { id: jobId, agentResponseId: live.job.responseId }, data: { agentResponseId: null } });
      return { ok: false, reason: 'no_turn' };
    }
    console.error('[Computer] Could not reconnect to a turn:', error instanceof Error ? error.message : 'unknown');
    return { ok: false, reason: 'failed' };
  }
}
