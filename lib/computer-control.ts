import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Who may act on a Brick's computer, kept as ONE durable state per computer (audit F02, A17/A18). The mouse and keyboard never belong
 * to the person and to the agent at once, and a change of hands is a transition that every request joins, never one it skips:
 *
 *   agent  ──take over──▶  fencing  ──fence proved──▶  human_ready  ──hand back──▶  returning  ──person's input drained──▶  agent
 *
 *  - `agent`: Brick may act. No input socket is authorized.
 *  - `fencing`: the person asked to take over. Brick may not act (its keys end, its turn is cancelled, what it started is stopped and
 *    proved gone), and the person has no input yet: the screen's input is only authorized in `human_ready`.
 *  - `human_ready`: the fence was proved. The person's input is authorized; Brick may not act.
 *  - `returning`: the person handed back. Their input is no longer authorized (the epoch moved) and Brick still may not act: it
 *    resumes only once every input socket that was authorized has been told no or has lapsed.
 *
 * `controlEpoch` goes up with every transition that begins, so a screen ticket, or a late check, made under an older number is dead.
 * A transition is led by one request (a compare-and-set on the row, so two tabs or two app servers cannot both lead); the others
 * wait for it. The leader holds a lease; if it dies the lease runs out and the next request, or the sweep, finishes the same
 * transition (every stage is safe to run again).
 *
 * This file only keeps the state. The stages themselves (what a fence is, what a hand back does to jobs) are in lib/computer.ts.
 */

export type ControlState = 'agent' | 'fencing' | 'human_ready' | 'returning';
export type Transition = 'fencing' | 'returning';

/** Tunable only so tests need not wait in real time. */
export const CONTROL_TIMING = {
  /**
   * How long a leader holds a transition before another request may finish it. A leader pushes its lease on (`renewTransition`, through the fence's `stillLeader`) before each try of the fence
   * and about every 30 seconds while it waits for the clean or files claim (those waits may last about 3 and 4 minutes, longer than this lease together). The longest gap between two renewals is
   * one try of the fence: two commands of 30 s each, about 60 s, or the stop after the last try; the lease only has to outlast that. A leader that is slower than that, or whose server stopped, is
   * taken over by the next request, and one that learns it lost the transition sends nothing more (the fence answers `lost`).
   */
  leaseMs: 5 * 60 * 1000,
  /** How long a request that joins a transition waits for it before it says it is still going. */
  joinMs: 45_000,
  pollMs: 150,
  /** How long a person's input stays authorized after the gateway last asked (it asks every 5 s). A socket not confirmed within this must be closed by the gateway. */
  inputLeaseMs: 8_000,
  /** The same, for a socket that has just been opened and not yet asked: the gateway has this long to connect and ask. */
  openLeaseMs: 10_000,
};

export interface Control {
  state: ControlState;
  epoch: number;
  leaseUntil: Date | null;
  humanInputUntil: Date | null;
}

const asState = (value: string): ControlState => (value === 'fencing' || value === 'human_ready' || value === 'returning' ? value : 'agent');

/** The computer's control as it stands; null when the Brick has no computer row. */
export async function readControl(botId: string): Promise<Control | null> {
  const row = await prisma.brickComputer.findUnique({ where: { botId }, select: { controlState: true, controlEpoch: true, controlLeaseUntil: true, humanInputUntil: true } });
  return row ? { state: asState(row.controlState), epoch: row.controlEpoch, leaseUntil: row.controlLeaseUntil, humanInputUntil: row.humanInputUntil } : null;
}

/**
 * The control and the take-over check as ONE read: a request that reads them in two steps can see the control from before another request's step and the check from after it, and so
 * answer a second tap "not offered" while the first is starting the restart (CodeRabbit on #1034, finding 3).
 */
export async function readControlAndCheck(botId: string): Promise<(Control & { check: string | null }) | null> {
  const row = await prisma.brickComputer.findUnique({ where: { botId }, select: { controlState: true, controlEpoch: true, controlLeaseUntil: true, humanInputUntil: true, takeOverCheck: true } });
  return row ? { state: asState(row.controlState), epoch: row.controlEpoch, leaseUntil: row.controlLeaseUntil, humanInputUntil: row.humanInputUntil, check: row.takeOverCheck ?? null } : null;
}

/** A transition with no lease, or a lease that ran out, is one whose leader is gone (or gave up): anyone may finish it. */
export const leaseLapsed = (control: Control, at: number = Date.now()): boolean => !control.leaseUntil || control.leaseUntil.getTime() <= at;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Begins a transition: one compare-and-set on the state and epoch that were seen. Returns the new epoch to the one request that won,
 * null to everyone else (they join the winner's transition).
 */
export async function beginTransition(botId: string, from: ControlState, expectedEpoch: number, to: Transition): Promise<number | null> {
  const { count } = await prisma.brickComputer.updateMany({
    where: { botId, controlState: from, controlEpoch: expectedEpoch },
    data: { controlState: to, controlEpoch: expectedEpoch + 1, controlLeaseUntil: new Date(Date.now() + CONTROL_TIMING.leaseMs) },
  });
  return count === 1 ? expectedEpoch + 1 : null;
}

/**
 * A leader that is gone left its lease behind: one request takes it over (only the lease that was seen), and finishes the same transition.
 * The epoch moves with the take over, so a leader that only seemed gone (it stalled past its lease and is still running) can no longer renew,
 * finish or release this transition: every one of its writes names the old epoch. Returns the epoch the new leader works under, null when
 * another request took it first or there is nothing to resume.
 */
export async function resumeTransition(botId: string, control: Control): Promise<number | null> {
  if (control.state !== 'fencing' && control.state !== 'returning') return null;
  const { count } = await prisma.brickComputer.updateMany({
    where: { botId, controlState: control.state, controlEpoch: control.epoch, controlLeaseUntil: control.leaseUntil },
    data: { controlEpoch: control.epoch + 1, controlLeaseUntil: new Date(Date.now() + CONTROL_TIMING.leaseMs) },
  });
  return count === 1 ? control.epoch + 1 : null;
}

/** The leader is still working: its lease is pushed on. False when the transition is no longer its own (another finished it). */
export async function renewTransition(botId: string, state: Transition, epoch: number, db: Pick<typeof prisma, 'brickComputer'> = prisma): Promise<boolean> {
  const { count } = await db.brickComputer.updateMany({ where: { botId, controlState: state, controlEpoch: epoch }, data: { controlLeaseUntil: new Date(Date.now() + CONTROL_TIMING.leaseMs) } });
  return count === 1;
}

/**
 * The transition ends in its next state. Only the epoch it began with can end it, so a leader that was taken over cannot undo a later one.
 * `check` (when given) is the take-over check the row has from now on, written in the SAME update: a leader that dies cannot leave the new state with the old check
 * (a stale `anyway` or `running` that a later fence would read as a choice nobody made).
 */
export async function finishTransition(botId: string, state: Transition, epoch: number, to: 'agent' | 'human_ready', check?: string | null): Promise<boolean> {
  const { count } = await prisma.brickComputer.updateMany({
    where: { botId, controlState: state, controlEpoch: epoch },
    data: { controlState: to, controlLeaseUntil: null, ...(check === undefined ? {} : { takeOverCheck: check }) },
  });
  return count === 1;
}

/** A leader that could not finish (a fence that could not be proved) lets go, so the next request or sweep tries again. The state stays closed. */
export async function releaseLease(botId: string, state: Transition, epoch: number): Promise<void> {
  await prisma.brickComputer.updateMany({ where: { botId, controlState: state, controlEpoch: epoch }, data: { controlLeaseUntil: null } });
}

/** Waits for the state to leave `waitingOn` (or for the transition's leader to be gone). Null when the deadline ran out first. */
export async function waitForTransition(botId: string, waitingOn: Transition, deadline: number): Promise<Control | null> {
  for (;;) {
    const control = await readControl(botId);
    if (!control || control.state !== waitingOn || leaseLapsed(control)) return control;
    if (Date.now() >= deadline) return null;
    await sleep(CONTROL_TIMING.pollMs);
  }
}

/**
 * Authorizes the person's input for this epoch AND records how long it is good for, in one write. Either the computer is `human_ready`
 * under this epoch (the person has it, and a hand back that comes next will wait out the lease), or it is not and the answer is no.
 * There is no moment where input is allowed but the hand back cannot see it.
 */
export async function authorizeHumanInput(botId: string, epoch: number, leaseMs: number): Promise<boolean> {
  // The later of what was already granted and this one, in the same write: a shorter check that comes just after a longer grant (a socket just
  // opened, then another one asking) never takes the grant back, so a hand back always waits for the longest one given
  const until = new Date(Date.now() + leaseMs);
  const count = await prisma.$executeRaw(Prisma.sql`
    UPDATE "brick_computers" SET "human_input_until" = GREATEST(COALESCE("human_input_until", ${until}), ${until})
    WHERE "bot_id" = ${botId} AND "control_state" = 'human_ready' AND "control_epoch" = ${epoch}`);
  return count === 1;
}

/** Whether the person's input is authorized now (reads only; a ticket is only worth asking for if this holds). */
export async function humanInputAllowed(botId: string, epoch: number): Promise<boolean> {
  const control = await readControl(botId);
  return !!control && control.state === 'human_ready' && control.epoch === epoch;
}

/**
 * After a hand back has ended the person's authorization, waits out what was already granted: the gateway asks every few seconds and is told
 * no, or the lease lapses. Only then may Brick resume. Nothing can extend the lease any more (it is only extended while `human_ready`).
 */
export async function drainHumanInput(botId: string): Promise<void> {
  const control = await readControl(botId);
  const until = control?.humanInputUntil?.getTime() ?? 0;
  const left = until - Date.now();
  if (left > 0) await sleep(left + 25);
}

/** Whether the person has the computer for real: the fence was proved and nothing is changing hands. A computer with no row has nothing to fence. */
export async function humanHasControl(botId: string): Promise<boolean> {
  const row = await prisma.brickComputer.findUnique({ where: { botId }, select: { controlState: true } });
  return !row || row.controlState === 'human_ready';
}

/**
 * Whether Brick may act on this computer. A computer with no row has nothing to act on and is treated as Brick's. Used by every way
 * the agent is authorized (a key, a turn), on top of the job's own state.
 */
export async function agentMayAct(botId: string, db: Pick<Prisma.TransactionClient, 'brickComputer'> = prisma): Promise<boolean> {
  const row = await db.brickComputer.findUnique({ where: { botId }, select: { controlState: true } });
  return !row || row.controlState === 'agent';
}

/**
 * A computer left `human_ready` after its jobs are over has no person holding it: it goes back to Brick's so the next job can start. It goes
 * the same way a hand back does (through `returning`, its lease running to the end of whatever input was granted), so Brick is not admitted
 * while a screen socket the person had open can still be sending input. A transition with a leader alive is never touched. Returns whether
 * the computer is Brick's now; when not (a lease still draining) the sweep or the next ask finishes it.
 */
export async function releaseIfUnheld(botId: string): Promise<boolean> {
  let control = await readControl(botId);
  if (!control) return true;
  if (control.state === 'agent') return true;
  if ((await prisma.computerJob.count({ where: { botId, status: { in: ['running', 'waiting'] } } })) > 0) return false;
  // The grant that was read is the one the lease is built on, and the write only holds if it is still the latest: an input check that recorded a
  // newer grant between the read and the write makes the write miss, and the lease is built again from the newer grant
  for (let tries = 0; tries < 5 && control.state === 'human_ready'; tries++) {
    const granted = control.humanInputUntil?.getTime() ?? 0;
    const until = granted > Date.now() ? granted + 25 : Date.now();
    // The epoch moves: an input ticket made for the person who was holding it is dead, and nothing can extend what was granted
    const { count } = await prisma.brickComputer.updateMany({
      where: { botId, controlState: 'human_ready', controlEpoch: control.epoch, humanInputUntil: control.humanInputUntil },
      data: { controlState: 'returning', controlEpoch: control.epoch + 1, controlLeaseUntil: new Date(until) },
    });
    const now = await readControl(botId);
    if (!now) return true;
    control = now;
    if (count === 1) break;
  }
  // No jobs to hand back: only a hand back whose lease has run out (nobody is finishing it) is ended here
  if (control.state === 'returning' && leaseLapsed(control)) {
    const { count } = await prisma.brickComputer.updateMany({ where: { botId, controlState: 'returning', controlEpoch: control.epoch, controlLeaseUntil: control.leaseUntil }, data: { controlState: 'agent', controlLeaseUntil: null, takeOverCheck: null } });
    if (count === 1) return true;
  }
  return (await readControl(botId))?.state === 'agent';
}
