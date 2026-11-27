import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { agentCannotRun, providerFor, fenceMachine, finishJobUnder, settleTurnHold, underTurnHold, wakeIfStopped } from '@/lib/computer';
import { hasFinishIntent, hasPoolCutoff, lockRelayReach, recordRelayUnreachable } from '@/lib/computer-faults';
import { epochMatches, lockJob, lockJobRow, type EpochSaid } from '@/lib/computer-owner';
import { mintJobToken, revokeJobTokens, revokeToken } from '@/lib/computer-token';
import { agentMayAct } from '@/lib/computer-control';
import { jobTagOf } from '@/lib/computer-values';
import { withoutTags } from '@/lib/computer-turn-tags';
import { powerTiming } from '@/lib/computer-power';
import { Agent37Error, TurnNotSent } from '@/lib/agent37/client';
import type { TurnEvent } from '@/lib/agent37/turn-events';
import { gitLoginCommand, jobGitAccess, NO_GIT_COMMAND, relayBase } from '@/lib/github/git-login';
import { carriedOnFrom } from '@/lib/computer-continue';

/**
 * The broker (build handoff v2, section 5): how the bot server's runner reaches a computer without ever holding Agent37's key.
 * The runner asks Orbit; Orbit checks the job from its own records, and only then talks to the machine. Nothing here takes a job id,
 * a turn id or a machine from the caller as authority: the job decides which machine, which conversation and which turn.
 *
 * Who may act: only a job that is RUNNING with Brick holding the keyboard. A job that waits for its person, is over, or is in line has
 * no turn, and a person who has taken over is never talked over.
 */

type Live = { jobId: string; botId: string; generation: number; ownerEpoch: number; ref: string; sessionId: string | null; responseId: string | null; firstTurnSentAt: Date | null; /** "Try again" (piece 8): the ended job whose conversation this one carries on, or null. */ continuesJobId: string | null };

export type NotLive = { ok: false; reason: 'not_found' | 'not_running' | 'person_has_it' | 'no_machine' | 'finish_pending' | 'superseded' };

/** The job as it stands, when Brick may act on it. `owner` is the worker that asks (the epoch it says): another worker's job is not its to act on (`superseded`); left out, for Orbit's own looks. */
async function liveJob(jobId: string, owner?: { epoch: EpochSaid }): Promise<{ ok: true; job: Live; provider: NonNullable<ReturnType<typeof providerFor>> } | NotLive> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, reason: 'not_found' };
  if (job.status === 'waiting' && job.control === 'person') return { ok: false, reason: 'person_has_it' };
  if (job.status !== 'running' || job.control !== 'brick') return { ok: false, reason: 'not_running' };
  if (owner && !epochMatches(job.ownerEpoch, owner.epoch)) return { ok: false, reason: 'superseded' };
  // The runner committed to ending this job (its finish intent): nothing is prepared and no turn is started for it any more; the finish is what is still to be completed
  if (await hasFinishIntent(prisma, jobId)) return { ok: false, reason: 'finish_pending' };
  // Control is Brick's only once a change of hands is over: a hand back is still being completed, or a take over is being fenced, until then
  if (!(await agentMayAct(job.botId))) return { ok: false, reason: 'person_has_it' };
  const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
  const provider = providerFor(row);
  if (!row?.providerRef || !provider || row.machine !== 'working') return { ok: false, reason: 'no_machine' };
  return { ok: true, job: { jobId: job.id, botId: job.botId, generation: job.controlGeneration, ownerEpoch: job.ownerEpoch, ref: row.providerRef, sessionId: job.agentSessionId, responseId: job.agentResponseId, firstTurnSentAt: job.firstTurnSentAt, continuesJobId: job.continuesJobId }, provider };
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
  | { ok: true; expiresAt: Date; git: boolean }
  | NotLive
  /** Another prepare of the job holds its claim: the caller waits a few seconds and asks again, it is not a failure. */
  | { ok: false; reason: 'preparing' }
  | { ok: false; reason: 'bad_relay' | 'failed' }
  /** The key was written, but the computer could not get the relay's model list with it (no connection, a timeout, a reply that is not the relay's): a confirmed fault of ours, kept for the job. */
  | { ok: false; reason: 'relay_unreachable' };

/**
 * Gives the job's computer what it needs to ask for a model: a new key and the relay's address, written where the image's local
 * model address reads them on every call (so Hermes itself never has to restart or learn a new key). Every earlier key of the job
 * ends first, so one key is good at a time. The key crosses only the exec call to the machine, which Agent37 carries over TLS.
 *
 * It also gives the computer its git login when the job may have one (the owner's own job, on a Brick the owner let use their
 * GitHub): a second key of scope "git" and the files that make plain `git clone https://github.com/owner/repo` go through Orbit's git
 * relay (see lib/github/git-login.ts). Without it the old git files are removed. `git` in the answer says whether the computer has it.
 */
export async function prepareJob(jobId: string, relay: unknown, now: Date = new Date(), options: { run?: string | null; /** The ownership epoch the runner won by its claim; none = a worker that knows none (good only while the job has none). */ epoch?: EpochSaid; /** False: the bot server's own look at the relay got a reply that is not the relay's. */ relayReached?: boolean; relayStatus?: number | null } = {}): Promise<Prepared> {
  const address = relayAddressOf(relay);
  if (!address) return { ok: false, reason: 'bad_relay' };
  // One key is made and written at a time for a job: ending the old keys, making the new one and writing it are one piece, so a second
  // prepare at the same moment cannot end this one's key after it was written, or write an older key over a newer one
  // A worker that does not own the job does not even take the claim (it would hold the real owner's prepare off for nothing): decided again, in the key's own transaction, below
  const first = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { ownerEpoch: true } });
  if (!first) return { ok: false, reason: 'not_found' };
  if (!epochMatches(first.ownerEpoch, options.epoch)) return { ok: false, reason: 'superseded' };
  const claim = await claimOnJob(jobId, 'prepareClaimedAt', PREPARE_CLAIM_STALE_MS, PREPARE_CLAIM_WAIT_MS);
  if (claim === 'gone') return { ok: false, reason: 'not_found' };
  if (claim === 'busy') return { ok: false, reason: 'preparing' };
  try {
    // The bot server itself found that the address answers something that is not the relay: a confirmed fault of ours, kept (once per run) and told at once, with no key made for a relay that is not there
    if (options.relayReached === false) {
      // Only for a job that is running under Brick's control: a job in line (no machine yet), over, or the person's keeps no such fault (a row with no run named would apply to every later run of the job)
      // The look and the write are ONE transaction under the lock a relay-reach write takes and the job's row lock: the fault is recorded only while the job still is what the look found (this worker's, running, Brick's)
      const recorded = await prisma.$transaction(async (tx) => {
        await lockRelayReach(tx, jobId);
        const now_ = await lockJobRow(tx, jobId);
        if (!now_) return { ok: false as const, reason: 'not_found' as const };
        if (!epochMatches(now_.ownerEpoch, options.epoch)) return { ok: false as const, reason: 'superseded' as const };
        if (now_.status === 'waiting' && now_.control === 'person') return { ok: false as const, reason: 'person_has_it' as const };
        if (now_.status !== 'running' || now_.control !== 'brick') return { ok: false as const, reason: 'not_running' as const };
        // A kept finish intent does not change the job's status or its epoch: the ordinary prepare answers `finish_pending` for it, and so does this one, before any fault is written (CodeRabbit on #1025)
        if (await hasFinishIntent(tx, jobId)) return { ok: false as const, reason: 'finish_pending' as const };
        await recordRelayUnreachable(tx, jobId, { run: options.run ?? null, status: options.relayStatus ?? null, at: now });
        return { ok: false as const, reason: 'relay_unreachable' as const };
      });
      return recorded;
    }
    return await prepareClaimed(jobId, address, now, claim, options.run ?? null, options.epoch);
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
async function endOwnKey(jobId: string, token: string, now: Date, claim: Date, epoch: number): Promise<void> {
  // The keys of THIS owner's epoch only: another owner's key is never ended by a prepare of this one
  await revokeJobTokens(jobId, now, { prepareClaim: claim, epoch });
  await revokeToken(token, now);
}

async function prepareClaimed(jobId: string, address: string, now: Date, claim: Date, run: string | null, epoch: EpochSaid): Promise<Prepared> {
  const live = await liveJob(jobId, { epoch });
  if (!live.ok) return live;
  const ownerEpoch = live.job.ownerEpoch;
  // A prepare that was held up past its claim (a stopped process, a database that did not answer) finds another one has it now: it changes no key and
  // writes nothing, and the caller asks again. The keys end only while the claim is still this one's, in the very statement that checks it
  if (!(await holdsPrepareClaim(jobId, claim))) return { ok: false, reason: 'preparing' };
  // Only for the job as it stands now: a take-over after the look above gets no key. The key is made ONLY while this owner owns the job and this prepare still holds the claim (decided in the key's own transaction); the
  // older keys of this owner end with it, in the same commit (never another owner's)
  const minted = await mintJobToken(jobId, 'model', now, { generation: live.job.generation }, { epoch, prepareClaim: claim });
  if (!minted.ok) return { ok: false, reason: minted.reason };
  // Not written when the claim went to another while the key was made: that one makes and writes its own, and this key is ended
  if (!(await holdsPrepareClaim(jobId, claim))) {
    await revokeToken(minted.token, now);
    return { ok: false, reason: 'preparing' };
  }
  // The computer asks the relay for its model list with the key it was just given, the very thing its model address does on each call (asked BEFORE the key is written, so a computer that cannot reach the
  // relay is never given a key that cannot be used). A computer that cannot (the address answers a page that is not the relay's, nothing answers, the key is refused) would fail every call before one
  // reaches the relay, with nothing recorded: it is a confirmed fault of ours, kept before anything else is said, and the runner is told. A check that could not be made at all (no curl on the machine, a
  // command that did not run) says nothing and changes nothing
  if ((await relayProbe(live.provider, live.job.ref, address, minted.token)) === 'down') {
    // A prepare held up during the probe may have lost its claim, and a newer prepare then ended this key: the probe failed on a key that was refused, not on the relay. Only the prepare that still holds the claim says a fault
    if (!(await holdsPrepareClaim(jobId, claim))) {
      await revokeToken(minted.token, now);
      return { ok: false, reason: 'preparing' };
    }
    await recordRelayUnreachable(prisma, jobId, { run, at: now });
    await endOwnKey(jobId, minted.token, now, claim, ownerEpoch);
    return { ok: false, reason: 'relay_unreachable' };
  }
  const file = JSON.stringify({ url: address, token: minted.token });
  // A job that carries on an ended one ("try again", piece 8) talks in that job's conversation, which holds the OLD jobs' tags too, and the model address reads the first tag it finds: this job's key is
  // also written under the id of every job it carries on from, so every call of the conversation goes with THIS job's key (theirs ended with them). Ids are Orbit's own (uuid characters only)
  const aliases = live.job.continuesJobId ? (await carriedOnFrom(jobId)).filter((id) => /^[A-Za-z0-9-]{8,64}$/.test(id)) : [];
  // Every file a key is written to has its own order, kept in a stamp beside it (the claim time of the prepare that last wrote it, whichever job's prepare that was): a prepare writes a file only when no later prepare wrote it
  // already, so a delayed predecessor never puts its revoked key over the file of a successor that carries on its conversation, and a later valid prepare still refreshes it (CodeRabbit on #1025)
  const mark0 = claim.getTime();
  // `sm` is emptied before every read: the same shell runs this once for the job's own file and once per alias, and a read of a stamp file that does not exist does not run at all, so without it an alias with no stamp would inherit the
  // previous file's (newer) value and be skipped, leaving a revoked key in its file (Sentry on #1025, S2). The other reads below run once per command, but their variables are emptied too
  const writeTo = (dest: string): string =>
    `{ sm=; read -r sm < "$d/jobs/${dest}.stamp" 2>/dev/null; if [ -n "$sm" ] && [ "$sm" -gt ${mark0} ] 2>/dev/null; then :; else printf '%s' '${file}' > "$d/jobs/${dest}.json.new" && mv "$d/jobs/${dest}.json.new" "$d/jobs/${dest}.json" && printf '%s' ${mark0} > "$d/jobs/${dest}.stamp"; fi; } && `;
  const aliasPart = aliases.map((id) => writeTo(id)).join('');
  const gitPart = await gitLoginFor(jobId, live.job.generation, now, epoch);
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
    `jg=; jm=; read -r jg jm < "$d/jobs/${jobId}.gen" 2>/dev/null; ` +
    `if [ -n "$jg" ] && { [ ${generation} -lt "$jg" ] || { [ ${generation} -eq "$jg" ] && [ -n "$jm" ] && [ ${mark} -lt "$jm" ]; }; } 2>/dev/null; then exit 0; fi; ` +
    `who=; cur=; mk=; read -r who cur mk < "$d/relay.gen" 2>/dev/null; ` +
    `if [ "$who" = '${jobId}' ] && [ -n "$cur" ] && { [ "$cur" -gt ${generation} ] || { [ "$cur" -eq ${generation} ] && [ -n "$mk" ] && [ "$mk" -gt ${mark} ]; }; } 2>/dev/null; then exit 0; fi; ` +
    // The shared file is also left alone when ANOTHER job's claim that wrote it is later than this one (control numbers are of one job, so only the claims are compared): a delayed prepare of an older job never puts its key over a newer claim's. Its own files below are still written
    `if [ "$who" != '${jobId}' ] && [ -n "$mk" ] && [ "$mk" -gt ${mark} ] 2>/dev/null; then :; else printf '%s' '${file}' > "$d/relay.json.new" && mv "$d/relay.json.new" "$d/relay.json" && printf '%s %s %s' '${jobId}' ${generation} ${mark} > "$d/relay.gen"; fi && ` +
    // The job's own key goes where the model address looks for the job a call belongs to (its turns carry the job's tag). Another job's key beside it is never
    // touched, so jobs that run at once each call on their own. Files a week old are removed.
    `mkdir -p "$d/jobs" && ` +
    writeTo(jobId) +
    `printf '%s %s' ${generation} ${mark} > "$d/jobs/${jobId}.gen" && ` +
    aliasPart +
    `{ find "$d/jobs" -type f -mtime +7 -delete 2>/dev/null || :; } && ` +
    `{ ${gitPart.command}; } ) 9>"$d/relay.lock"`;
  try {
    const done = await live.provider.exec(live.job.ref, command, { timeoutMs: 30_000 });
    if (done.exitCode !== 0) {
      await endOwnKey(jobId, minted.token, now, claim, ownerEpoch);
      return { ok: false, reason: 'failed' };
    }
  } catch (error) {
    console.error('[Computer] Could not prepare a machine:', error instanceof Error ? error.message : 'unknown');
    await endOwnKey(jobId, minted.token, now, claim, ownerEpoch);
    return { ok: false, reason: 'failed' };
  }
  // The person may have taken over while the key was being written: the key is then of an older control number (it is refused), and the
  // runner is told the job is not its to act on
  const after = await liveJob(jobId, { epoch });
  if (!after.ok) {
    if (after.reason === 'superseded') await revokeJobTokens(jobId, now, { epoch: ownerEpoch });
    return after;
  }
  if (after.job.generation !== generation) return { ok: false, reason: 'not_running' };
  // The claim went to another while the key was being written: that one's key is the one that stays, and the caller asks again
  if (!(await holdsPrepareClaim(jobId, claim))) {
    await revokeToken(minted.token, now);
    return { ok: false, reason: 'preparing' };
  }
  return { ok: true, expiresAt: minted.expiresAt, git: gitPart.on };
}

/** How long the machine waits before it asks a second time, when the first ask found the address definitely wrong. */
const PROBE_RETRY_WAIT_SECONDS = 2;

/**
 * Whether the computer can get the relay's model list (`GET <relay>/v1/models` with the job's key: a 200 whose body has `data`; the game's relay answers exactly that, bots/server/ComputerModelRelay.ts
 * `router.get('/v1/models')`). Only a DEFINITE wrong address is `down`: a name that does not resolve or a connection refused (curl 6, 7), a 404 or 410, a 401 or 403 for a key that was just made, a 200
 * with no model list, any other answer that is a page and not JSON. It is asked ONCE more after a short wait before it is believed; an answer that is fine the second time is fine. Everything else is
 * `unknown`, which never counts against anyone: a timeout (curl 28) or any other curl error, a redirect, a 429 or 5xx (a blip, a busy relay), a JSON error answer that is none of the above, a
 * machine with no curl, a command that did not run or said nothing.
 */
async function relayProbe(provider: NonNullable<ReturnType<typeof providerFor>>, ref: string, address: string, token: string): Promise<'ok' | 'down' | 'unknown'> {
  const command =
    `command -v curl >/dev/null 2>&1 || { echo reach=nocurl; exit 0; }; ` +
    // ask: 0 = the relay's list, 2 = a definite wrong address, 1 = anything else (nothing is learned)
    `ask() { r=$(curl -sS -m 10 -H 'Authorization: Bearer ${token}' -w '\n%{http_code}' '${address}/v1/models' 2>/dev/null); rc=$?; code=$(printf '%s' "$r" | tail -n 1); ` +
    `if [ "$rc" -eq 6 ] || [ "$rc" -eq 7 ]; then return 2; fi; [ "$rc" -eq 0 ] || return 1; ` +
    `case "$code" in 200) printf '%s' "$r" | grep -q '"data"' && return 0 || return 2;; 404|410|401|403) return 2;; 3??|429|5??) return 1;; esac; ` +
    `printf '%s' "$r" | sed '$d' | grep -q '^[[:space:]]*[{[]' && return 1 || return 2; }; ` +
    `ask; a=$?; if [ "$a" -eq 2 ]; then sleep ${PROBE_RETRY_WAIT_SECONDS}; ask; a=$?; fi; ` +
    `case "$a" in 0) echo reach=ok;; 2) echo reach=down;; *) echo reach=unknown;; esac`;
  try {
    const done = await provider.exec(ref, command, { timeoutMs: 40_000 });
    if (done.exitCode !== 0) return 'unknown';
    if (/(^|\n)reach=down\s*($|\n)/.test(done.stdout)) return 'down';
    return /(^|\n)reach=ok\s*($|\n)/.test(done.stdout) ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The git half of preparing a job: a "git" key and the shell that writes the login, when the job may have one; otherwise the shell
 * that removes it. Never fails the preparing: a computer without git still works, and the reason is only logged.
 */
async function gitLoginFor(jobId: string, generation: number, now: Date, epoch: EpochSaid): Promise<{ on: boolean; command: string }> {
  const off = { on: false, command: NO_GIT_COMMAND };
  try {
    const access = await jobGitAccess(jobId);
    const base = relayBase();
    if (!access || !base) return off;
    // Checked before a key is made: a name or address that is not plain characters gets no key at all
    if (!gitLoginCommand(`cjt_${'x'.repeat(43)}`, base, access)) return off;
    const minted = await mintJobToken(jobId, 'git', now, { generation }, { epoch });
    if (!minted.ok) return off;
    const command = gitLoginCommand(minted.token, base, access);
    return command ? { on: true, command } : off;
  } catch (error) {
    console.error('[Computer] Could not prepare a git login:', error instanceof Error ? error.message : 'unknown');
    return off;
  }
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
export async function startTurn(jobId: string, text: unknown, signal?: AbortSignal, owner: { epoch: EpochSaid } = { epoch: undefined }): Promise<StartedTurn> {
  if (typeof text !== 'string' || text.trim() === '' || text.length > 200_000) return { ok: false, reason: 'failed' };
  let live = await liveJob(jobId, owner);
  // A job that is Brick's and running on a machine that is stopped: a hand back that could not wake it yet (a stop of ours was still in flight) left it so, and nothing else will wake it before the next renewal finds it asleep. It is woken
  // here, waiting only for a live stop as a start does, and looked at again; a stop that still can land answers "starting", so the caller asks again (Opus on #1040)
  // The same for a job banked while its machine was stopped (no stretch, its awake proof kept) whose machine another path has woken since: nothing else starts its stretch again, and a job with no stretch is never admitted (below), so it would
  // answer "starting" for good. Woken or found working here, its stretch starts again at once (Opus and Sentry on #1040)
  const banked = live.ok || live.reason === 'no_machine' ? await prisma.computerJob.findFirst({ where: { id: jobId, status: 'running', control: 'brick', stretchStarted: null, prepState: null, NOT: { awakeProvedAt: null } }, select: { botId: true } }) : null;
  if ((!live.ok && live.reason === 'no_machine') || banked) {
    const row = banked ?? (await prisma.computerJob.findUnique({ where: { id: jobId }, select: { botId: true } }));
    if (row && (await wakeIfStopped(row.botId, { ms: powerTiming().waitMs, dead: false })) === 'pending') return { ok: false, reason: 'starting' };
    live = await liveJob(jobId, owner);
  }
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
    await prisma.computerJob.updateMany({ where: { id: job.jobId, ownerEpoch: job.ownerEpoch, agentResponseId: job.responseId }, data: { agentResponseId: null } });
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
  // The time of the mark THIS start put on the job's row for a first turn (null: none): the mark it lets go of when nothing was sent, and no other
  let markedAt: Date | null = null;
  try {
    // Looked at again now that the claim is held: the job was read before it, and a start that kept its turn's id (or a take-over) in between changed what
    // is true. A turn the job holds now is busy (its id is given, to reconnect to), and the conversation to start on is the one it has now
    let fresh = await liveJob(job.jobId, owner);
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
      if ((await wakeIfStopped(fresh.job.botId, { ms: powerTiming().waitMs, dead: false })) === 'pending') {
        // A stop of ours may still land: the machine is not woken under it and the job is not ended. The caller asks again: the turn start above wakes a machine that is still stopped for a job that is Brick's and running
        await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
        return { ok: false, reason: 'starting' };
      }
      fresh = await liveJob(job.jobId, owner);
      if (!fresh.ok) {
        await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
        return fresh;
      }
    }
    sessionId = fresh.job.sessionId;
    // A job's very first turn has no conversation to be found by, and the agent has no way to be asked for "the turn this request started" (a request
    // carries no key of ours and sessions cannot be listed). So the turn is marked in the job's row BEFORE it is sent (below, after the last look at the job and right before the provider is called: a mark that is written earlier would stand for a turn that was never sent), and a start that finds the mark
    // with no turn id and no conversation (the server stopped after the agent accepted the turn, or the stream failed before its id came) never opens
    // a second one beside it: the job ends, visibly, as it does when the turn never says its id. In a conversation the agent knows, a second turn is
    // refused by the agent itself, atomically, so only the first turn needs the mark.
    if (!sessionId) {
      if (fresh.job.firstTurnSentAt) {
        const ended = await endJobOfUnknownTurn(job.jobId, job.ownerEpoch);
        await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
        return ended === 'superseded' ? { ok: false, reason: 'superseded' } : { ok: false, reason: ended === 'ended' ? 'not_running' : 'failed' };
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
      // Nothing was sent, and nothing is marked yet (the mark is written right before the provider is called)
      await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
      return { ok: false, reason: 'failed' };
    }
    // The last look before the provider hears of the turn is made under the job's cutoff lock and its row lock, the two a claim of the job (a new owner), a finish intent and a pause write under: this worker is still the owner (its
    // epoch), the job is still running in Brick's hands under the same control number, and no finish intent or pool cutoff is kept. A new owner's claim that lands first is seen here and the turn is never opened; a claim that lands
    // after this look finds a turn that was admitted before it, which the id fence and the cancellation cover as before (CodeRabbit on #1025). No provider call is made inside the lock
    const mark = new Date();
    let wroteMark = false;
    const standing = await prisma
      .$transaction(
        async (tx) => {
          const row = await lockJob(tx, job.jobId);
          if (!row) return 'gone' as const;
          if (row.ownerEpoch !== job.ownerEpoch) return 'superseded' as const;
          if (row.status !== 'running' || row.control !== 'brick' || row.controlGeneration !== ready.job.generation) return 'not_running' as const;
          if ((await hasFinishIntent(tx, job.jobId)) || (await hasPoolCutoff(tx, job.jobId))) return 'finish_pending' as const;
          // The job is not ready to be worked on: its browser is being brought back (`restoring`) or could not be (`recover`), or it is fresh and its ready write has not landed. No turn is opened on it, whoever asks and whatever epoch they
          // say (a service-token caller can read the epoch from `getJob`); the caller waits and asks again (CodeRabbit on #1025, F4 and O44)
          if (row.prepState !== null || row.stretchStarted === null) return 'starting' as const;
          // The claim this start took is still the job's, read under the row's lock: a start that stalled past the claim's life and was replaced (the replacement opened a turn and stored its id, which clears the first-turn mark) must not
          // admit itself again on a mark that is null once more. A turn stored by the replacement is busy, its id given to reconnect to (CodeRabbit on #1025, I3)
          if (row.agentResponseId) return { busy: row.agentResponseId };
          const held = await tx.$queryRaw<Array<{ turn_claimed_at: Date | null }>>`SELECT "turn_claimed_at" FROM "computer_jobs" WHERE "id" = ${job.jobId}`;
          if (held[0]?.turn_claimed_at?.getTime() !== claim.getTime()) return 'starting' as const;
          // A job's first turn is marked here, in the same decision that admits it and not before: a mark found later with no turn id means the turn was admitted and may have reached the agent. The mark is this attempt's (its time)
          if (!sessionId) {
            const wrote = await tx.computerJob.updateMany({ where: { id: job.jobId, firstTurnSentAt: null }, data: { firstTurnSentAt: mark } });
            if (wrote.count !== 1) return 'not_running' as const;
            wroteMark = true;
          }
          return 'ok' as const;
        },
        { timeout: 15_000, maxWait: 15_000 },
      )
      .catch(() => 'failed' as const);
    // The mark is kept only if the transaction that wrote it committed
    if (standing === 'ok' && wroteMark) markedAt = mark;
    if (standing !== 'ok') {
      clearTimeout(timer);
      // Nothing was sent, and nothing is marked yet: the claim is let go of
      await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
      if (standing === 'finish_pending') return { ok: false, reason: 'finish_pending' };
      if (standing === 'starting') return { ok: false, reason: 'starting' };
      if (typeof standing === 'object') return { ok: false, reason: 'busy', responseId: standing.busy };
      if (standing === 'gone') return { ok: false, reason: 'not_found' };
      if (standing === 'failed') return { ok: false, reason: 'failed' };
      // Superseded (or no longer Brick's to run): the same answer the worker gets on every other route
      const now_ = await liveJob(job.jobId, owner);
      return now_.ok ? { ok: false, reason: 'not_running' } : now_;
    }
    // The request was cut while the admission waited for the job's lock: nothing is sent, the claim is let go of and this attempt's own mark goes (the request's own signal is not handed on once the turn is dispatched, so a runner that goes
    // away later cannot stop the id being kept)
    if (signal?.aborted) {
      clearTimeout(timer);
      if (markedAt) await prisma.computerJob.updateMany({ where: { id: job.jobId, firstTurnSentAt: markedAt, agentResponseId: null, agentSessionId: null }, data: { firstTurnSentAt: null } }).catch(() => undefined);
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
      if (notSent && markedAt) await prisma.computerJob.updateMany({ where: { id: job.jobId, firstTurnSentAt: markedAt }, data: { firstTurnSentAt: null } }).catch(() => undefined);
      else await endJobOfUnknownTurn(job.jobId, job.ownerEpoch);
    }
    // A job that carries on an ended one's conversation ("try again", piece 8) on a computer that no longer has it (a new machine, an older copy brought back): the agent says it does
    // not know the conversation. Nothing was sent, so the job starts a conversation of its own at its next turn (its first words already say all of the job); only that job's own copy
    // of the conversation id is let go, and only while this owner still holds the job
    if (sessionId && ready.job.continuesJobId && error instanceof Agent37Error && error.status === 404 && error.code !== 'session_busy') {
      await prisma.computerJob.updateMany({ where: { id: job.jobId, ownerEpoch: job.ownerEpoch, agentSessionId: sessionId, agentResponseId: null }, data: { agentSessionId: null } }).catch(() => undefined);
    }
    await releaseOnJob(job.jobId, 'turnClaimedAt', claim);
    if (error instanceof Agent37Error && error.code === 'session_busy') return { ok: false, reason: 'busy', responseId: error.runningResponseId };
    return { ok: false, reason: 'failed' };
  }
  return { ok: true, events: withoutTags(keeping(ready.job, ready.provider, events, { timer, controller: own, claim, markedAt })) };
}

/**
 * The job's first turn may be running on the machine with nothing to find it by: the job ends as failed (its keys revoked, its time settled, the
 * machine given back, which rests the turn). Says what really happened: `ended` (the job is over, as a kept intent said when one was kept), `superseded` (another worker owns the job now: the ending was
 * refused and nothing was ended) or `unresolved` (the ending could not be made now: the job keeps its mark, so the next start ends it). Never claims an ending the finalizer refused (CodeRabbit on #1025).
 */
export type UnknownTurnEnd = 'ended' | 'superseded' | 'unresolved';
async function endJobOfUnknownTurn(jobId: string, epoch: number): Promise<UnknownTurnEnd> {
  try {
    // Ends the job only while the worker that is starting the turn still owns it (decided in the ending's own write), and as a kept intent says when one is kept: a job another owner holds is not ended by this one's turn
    const done = await finishJobUnder(jobId, null, 'failed', new Date(), null, null, null, null, epoch);
    if (done.superseded) return 'superseded';
    return done.job && ['done', 'failed', 'stopped'].includes(done.job.status) && !done.stale ? 'ended' : 'unresolved';
  } catch (error) {
    console.error('[Computer] Could not end a job whose first turn has no id:', error instanceof Error ? error.message : 'unknown');
    return 'unresolved';
  }
}

/** What the stream says when a first turn never named itself: the terminal message only when the job did end; supersession and an unresolved ending are said as what they are. */
const noTurnIdEvent = (end: UnknownTurnEnd): TurnEvent =>
  end === 'ended'
    ? { type: 'failed', code: 'no_turn_id', message: 'The agent never said its turn had started, so the job was ended' }
    : end === 'superseded'
      ? { type: 'failed', code: 'superseded', message: 'Another worker owns this job now, so it was not ended here' }
      : { type: 'failed', code: 'turn_unresolved', message: 'The agent never said its turn had started and the job could not be ended yet; it is ended on the next start' };

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
  start?: { timer: ReturnType<typeof setTimeout>; controller: AbortController; claim?: Date; /** The first-turn mark this start wrote (null when it wrote none): the only mark it clears, whoever owns the job now. */ markedAt?: Date | null },
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
  let gaveUpEnd: UnknownTurnEnd = 'unresolved';
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
                gaveUpEnd = await endJobOfUnknownTurn(job.jobId, job.ownerEpoch);
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
          const end = await endJobOfUnknownTurn(job.jobId, job.ownerEpoch);
          over = true;
          yield noTurnIdEvent(end);
          return;
        } else throw error;
      }
      if (next === 'gave-up') {
        over = true;
        // The give-up's own ending is waited for, so what is said is what happened to the job
        await renewing;
        yield noTurnIdEvent(gaveUpEnd);
        return;
      }
      if (next.done) {
        if (unnamed) {
          const end = await endJobOfUnknownTurn(job.jobId, job.ownerEpoch);
          over = true;
          yield noTurnIdEvent(end);
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
            // Still this owner's job: a worker that was replaced after it opened the turn records nothing (the turn is cancelled below, by its own id)
            ownerEpoch: job.ownerEpoch,
            // A finish intent kept since the turn was opened: the turn is not the job's, it is cancelled below (nothing starts after the runner committed to ending)
            finishIntent: { is: null },
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
            if (start?.markedAt) await prisma.computerJob.updateMany({ where: { id: job.jobId, firstTurnSentAt: start.markedAt, agentResponseId: null }, data: { firstTurnSentAt: null } }).catch(() => undefined);
          }
          responseId = null;
          over = true;
          yield { type: 'failed', code: 'fenced', message: (await hasFinishIntent(prisma, job.jobId)) ? 'The turn was stopped because the job is ending' : 'The turn was stopped because the person took over' };
          return;
        }
      }
      if (event.type === 'completed' || event.type === 'failed') {
        over = true;
        // The turn is over without its id having been kept: nothing runs that nothing names
        if (start?.markedAt && !responseId) await prisma.computerJob.updateMany({ where: { id: job.jobId, firstTurnSentAt: start.markedAt }, data: { firstTurnSentAt: null } }).catch(() => undefined);
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
    if (responseId && over) await prisma.computerJob.updateMany({ where: { id: job.jobId, ownerEpoch: job.ownerEpoch, agentResponseId: responseId }, data: { agentResponseId: null } }).catch(() => undefined);
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

export type Cancelled = { ok: true; cancelled: boolean; /** `not_current`: the turn the caller named is not the job's now (nothing was cancelled). */ reason?: 'not_current' } | NotLive | { ok: false; reason: 'failed' };

/**
 * Cancels the turn a worker NAMES (`responseId`), if it is still the job's own and the worker still owns the job. Orbit checks the owner and the turn in one read and cancels that response id only, outside any lock: a turn
 * that is not the one named (another owner's, a newer one) is left running (`not_current`), never "whichever is current". A worker that knows no epoch (a legacy runner) is served only while the job has none, and then cancels
 * the job's current turn as before.
 */
export async function cancelJobTurn(jobId: string, owner: { epoch: EpochSaid; responseId?: string | null } = { epoch: undefined }): Promise<Cancelled> {
  const job = await prisma.computerJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, reason: 'not_found' };
  if (!epochMatches(job.ownerEpoch, owner.epoch)) return { ok: false, reason: 'superseded' };
  if (!job.agentResponseId) return { ok: true, cancelled: false };
  // The turn named is the turn that is cancelled; with a claimed job a request that names none cancels nothing
  const named = owner.responseId ?? (job.ownerEpoch === 0 ? job.agentResponseId : null);
  if (named === null || named !== job.agentResponseId) return { ok: true, cancelled: false, reason: 'not_current' };
  const row = await prisma.brickComputer.findUnique({ where: { botId: job.botId } });
  const provider = providerFor(row);
  if (!row?.providerRef || !provider) return { ok: false, reason: 'no_machine' };
  try {
    await provider.cancelTurn(row.providerRef, named);
  } catch (error) {
    console.error('[Computer] Could not cancel a turn:', error instanceof Error ? error.message : 'unknown');
    return { ok: false, reason: 'failed' };
  }
  return { ok: true, cancelled: true };
}

export type Reattached = { ok: true; events: AsyncGenerator<TurnEvent> } | NotLive | { ok: false; reason: 'no_turn' | 'failed' };

/** Reconnects to the job's own turn from its start, after the runner or Orbit lost the stream. A turn that is gone (30 minutes after it ends) says so. */
export async function reattachJobTurn(jobId: string, signal?: AbortSignal, owner: { epoch: EpochSaid } = { epoch: undefined }): Promise<Reattached> {
  const live = await liveJob(jobId, owner);
  if (!live.ok) return live;
  if (!live.job.responseId) return { ok: false, reason: 'no_turn' };
  try {
    const events = await live.provider.reattachTurn(live.job.ref, live.job.responseId, signal);
    return { ok: true, events: withoutTags(keeping(live.job, live.provider, events)) };
  } catch (error) {
    if (error instanceof Agent37Error && error.status === 404) {
      await prisma.computerJob.updateMany({ where: { id: jobId, ownerEpoch: live.job.ownerEpoch, agentResponseId: live.job.responseId }, data: { agentResponseId: null } });
      return { ok: false, reason: 'no_turn' };
    }
    console.error('[Computer] Could not reconnect to a turn:', error instanceof Error ? error.message : 'unknown');
    return { ok: false, reason: 'failed' };
  }
}
