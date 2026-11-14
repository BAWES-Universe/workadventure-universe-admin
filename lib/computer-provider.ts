/**
 * Where a Brick's computer really lives (game #2000). Everything in Universe talks to a computer through this one interface:
 * the pretend provider runs the whole of it on the dev server and in tests, and the real one (Agent37, lib/agent37) runs on prod.
 *
 * Four rules the interface keeps by its shape:
 *  - Nothing here creates or wakes a machine unless a job needs it: only `create` and `wake` do, and Universe calls them from
 *    one place (starting a job). `watch` can only look: it returns nothing for a machine that is not awake.
 *  - There is no way to copy or reset a machine. A second job never gets a second computer, and nothing here forks one.
 *  - `rest` and `stop` keep the disk. Only `remove` takes a machine away, and only after the person's files were saved.
 *  - What a minute costs is the provider's answer, never a number of ours.
 */

import { prisma } from '@/lib/db';
import { Agent37Client } from '@/lib/agent37/client';
import { Agent37ComputerProvider } from '@/lib/agent37/provider';
import { dbImageStore } from '@/lib/agent37/image';
import type { ExecResult } from '@/lib/agent37/client';
import type { TurnEvent } from '@/lib/agent37/turn-events';

export type { ExecResult, TurnEvent };

export interface ExecOptions {
  /** Only "root" is allowed, for what the image's own user cannot do. */
  user?: 'root';
  /** The same name asked again returns the first result and does not run the command again. */
  name?: string;
  background?: boolean;
  timeoutMs?: number;
}

export interface TurnInput {
  text: string;
  /** The conversation the turn belongs to; empty for the first turn of a job, which makes one. */
  sessionId?: string | null;
}

export interface MachineInfo {
  ref: string;
  region: string;
}

export interface WatchSession {
  /** Where the screen is shown. Expires: a link that is old shows nothing and wakes nothing. */
  url: string;
  expiresAt: Date;
}

export interface SavedCopy {
  bytes: number;
  savedAt: Date;
}

/** One thing a computer needs before work can run on it, as a person on the team reads it. `detail` never carries a key. */
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ComputerProvider {
  readonly kind: 'fake' | 'real';
  /** What an awake minute costs, in millionths of a dollar, as the provider says; null when it has not said. */
  microsPerMinute(): number | null;
  /** Makes this Brick's one computer. Asked once for a Brick: a second ask for the same Brick is the same machine. */
  create(botId: string): Promise<MachineInfo>;
  /** Wakes a resting or cold machine. */
  wake(ref: string): Promise<void>;
  /**
   * Brings a machine that was just made or woken to what a job needs: the current image, the screen and the browser, the local model
   * address. Safe to ask any number of times. Throws when it cannot be made ready (the job then does not start).
   */
  ready(ref: string): Promise<void>;
  /** What a job needs from the provider right now (the key works, the wallet carries a job, the image is built). Reads only; never throws. */
  checkup(): Promise<Check[]>;
  /** Whatever the provider keeps up between jobs (the real one builds its image). Asked by the sweep; never throws. */
  maintain(): Promise<void>;
  /** Lets it rest after a job: the disk is kept, nothing else is billed. */
  rest(ref: string): Promise<void>;
  /** A stop of ours (usage used up, a safety stop, the Brick deleted). The disk is kept. */
  stop(ref: string): Promise<void>;
  /** Takes the machine away for good. Only after the person's files were saved. */
  remove(ref: string): Promise<void>;
  /** Whether the machine is running or on its way up (billed). A machine that is gone, stopped or asleep is not. Used to prove a stop. */
  awake(ref: string): Promise<boolean>;
  /** The screen of a machine that is awake and working; null when it is not. Never wakes a machine. */
  watch(ref: string): Promise<WatchSession | null>;
  /** Saves a copy of its home folder and says how big it is. */
  saveFiles(ref: string): Promise<SavedCopy>;
  /**
   * Runs a shell command on the machine. Only for a machine a job holds: a sleeping machine is woken by it. A non-zero exit is an
   * answer, not an error; a command that could not be asked at all throws.
   */
  exec(ref: string, command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Starts a turn of the agent on the machine and gives its events as they come. Ends with a `completed` or a `failed`. */
  openTurn(ref: string, input: TurnInput, signal?: AbortSignal): Promise<AsyncGenerator<TurnEvent>>;
  /** The events of a turn already running (or just finished), from its start. */
  reattachTurn(ref: string, responseId: string, signal?: AbortSignal): Promise<AsyncGenerator<TurnEvent>>;
  /** Cancels a turn. One that is already over is not an error. */
  cancelTurn(ref: string, responseId: string): Promise<void>;
  /** The id of the turn running in a session, or null when none is. */
  activeTurn(ref: string, sessionId: string): Promise<string | null>;
}

/** The pretend provider's pretend price: test data on the dev server only, never read as what a minute really costs. */
const PRETEND_MICROS_PER_MINUTE = 6000;

/**
 * The pretend provider. It keeps no machines of its own: a "machine" is a reference that is the same for the same Brick, so
 * `create` twice is one computer. What it did is kept in `calls` so a test can prove a thing woke nothing.
 */
export class FakeComputerProvider implements ComputerProvider {
  readonly kind = 'fake' as const;
  readonly calls: { name: string; ref?: string }[] = [];
  /** A test sets these to make the next call fail, the way a real one can. */
  failNext: Partial<Record<'create' | 'wake' | 'rest' | 'saveFiles', boolean>> = {};
  /** Every save fails until this is turned off. */
  failSaves = false;
  /** What a command run on the pretend machine answers with, by what it says; a test sets this. Without it every command succeeds with no output. */
  execAnswer: (command: string) => Partial<ExecResult> | Promise<Partial<ExecResult>> = (command) => (command.startsWith('universe-fence --check') ? { stdout: 'remaining=0\n' } : {});
  /** Every command is refused (the machine does not answer) while this is on. */
  failExec = false;
  /** The turns the pretend agent will run, one list of events per turn, used in order. */
  turns: TurnEvent[][] = [];
  /** What was asked of the pretend agent, and what was cancelled. */
  openedTurns: { ref: string; input: TurnInput }[] = [];
  cancelledTurns: string[] = [];
  /** A turn the pretend agent is running in a session: set by a test, read back by `activeTurn`. */
  running = new Map<string, string>();
  filesBytes = 1_288_490_188;
  /** The machines that were made ready for a job. */
  readied: string[] = [];
  private rate: number | null;
  private awake_ = new Set<string>();

  constructor(microsPerMinute: number | null = PRETEND_MICROS_PER_MINUTE) {
    this.rate = microsPerMinute;
  }

  microsPerMinute(): number | null {
    return this.rate;
  }

  private note(name: string, ref?: string) {
    this.calls.push({ name, ref });
  }

  private fail(name: 'create' | 'wake' | 'rest' | 'saveFiles') {
    if (this.failNext[name]) {
      this.failNext[name] = false;
      throw new Error(`The pretend provider failed on ${name}`);
    }
  }

  async create(botId: string): Promise<MachineInfo> {
    this.note('create', botId);
    this.fail('create');
    return { ref: `fake-${botId}`, region: 'pretend' };
  }

  async ready(ref: string): Promise<void> {
    this.readied.push(ref);
  }

  async maintain(): Promise<void> {}

  async checkup(): Promise<Check[]> {
    return [{ name: 'provider', ok: true, detail: 'The pretend provider (development only)' }];
  }

  async wake(ref: string): Promise<void> {
    this.note('wake', ref);
    this.fail('wake');
    this.awake_.add(ref);
  }

  async rest(ref: string): Promise<void> {
    this.note('rest', ref);
    this.fail('rest');
    this.awake_.delete(ref);
  }

  async stop(ref: string): Promise<void> {
    this.note('stop', ref);
    this.awake_.delete(ref);
  }

  async remove(ref: string): Promise<void> {
    this.note('remove', ref);
    this.awake_.delete(ref);
  }

  /** A test sets the machines that stay awake whatever is asked of them (a stop that did not take). */
  readonly stuckAwake = new Set<string>();

  async awake(ref: string): Promise<boolean> {
    return this.awake_.has(ref) || this.stuckAwake.has(ref);
  }

  async watch(ref: string): Promise<WatchSession | null> {
    this.note('watch', ref);
    // Only a machine that is awake has a screen: looking never wakes it
    if (!this.awake_.has(ref)) return null;
    return { url: `https://computer.pretend.invalid/screen/${encodeURIComponent(ref)}`, expiresAt: new Date(Date.now() + 5 * 60_000) };
  }

  async saveFiles(ref: string): Promise<SavedCopy> {
    this.note('saveFiles', ref);
    if (this.failSaves) throw new Error('The pretend provider failed on saveFiles');
    this.fail('saveFiles');
    return { bytes: this.filesBytes, savedAt: new Date() };
  }

  async exec(ref: string, command: string): Promise<ExecResult> {
    this.note('exec', ref);
    this.commands.push({ ref, command });
    if (this.failExec) throw new Error('The pretend provider failed on exec');
    const answer = await this.execAnswer(command);
    return { exitCode: 0, stdout: '', stderr: '', truncated: false, ...answer };
  }
  /** The commands that were run, in order. */
  readonly commands: { ref: string; command: string }[] = [];

  async openTurn(ref: string, input: TurnInput): Promise<AsyncGenerator<TurnEvent>> {
    this.note('openTurn', ref);
    this.openedTurns.push({ ref, input });
    const events = this.turns.shift() ?? [{ type: 'created', id: `resp-${this.openedTurns.length}`, sessionId: input.sessionId ?? 'session-1' }, { type: 'completed', outputText: 'done', usage: null }];
    return (async function* () {
      for (const event of events) yield event;
    })();
  }

  async reattachTurn(ref: string, responseId: string): Promise<AsyncGenerator<TurnEvent>> {
    this.note('reattachTurn', ref);
    return (async function* () {
      yield { type: 'created', id: responseId, sessionId: null } as TurnEvent;
      yield { type: 'completed', outputText: '', usage: null } as TurnEvent;
    })();
  }

  async cancelTurn(ref: string, responseId: string): Promise<void> {
    this.note('cancelTurn', ref);
    this.cancelledTurns.push(responseId);
  }

  async activeTurn(ref: string, sessionId: string): Promise<string | null> {
    this.note('activeTurn', ref);
    return this.running.get(sessionId) ?? null;
  }
}

/**
 * Which provider this server runs. A server that holds an Agent37 key (`AGENT37_API_KEY`) runs real computers: the key being there is
 * the whole of turning them on, and there is no switch (Khalid, 13 Nov). `COMPUTER_PROVIDER=fake` is for the dev server and tests, and
 * wins over the key so a test server never spends. Without either, this server has no computers at all: a Brick's page says so and
 * nothing is made. Never set "fake" on production.
 */
export function computerProviderKind(env: NodeJS.ProcessEnv = process.env): 'fake' | 'real' | null {
  if ((env.COMPUTER_PROVIDER ?? '').trim().toLowerCase() === 'fake') return 'fake';
  return (env.AGENT37_API_KEY ?? '').trim() ? 'real' : null;
}

/** Room Universe holds for computer jobs that are working: what the Agent37 wallet has to cover on top of a new machine. */
async function outstandingJobRoom(): Promise<number> {
  const held = await prisma.meterReservation.aggregate({ where: { state: 'held', reservationKey: { startsWith: 'computer:' } }, _sum: { amountMicros: true } });
  return Number(held._sum.amountMicros ?? 0);
}

let shared: ComputerProvider | null = null;
let sharedKind: string | null = null;

export function getComputerProvider(env: NodeJS.ProcessEnv = process.env): ComputerProvider | null {
  const kind = computerProviderKind(env);
  if (kind === null) return null;
  if (!shared || sharedKind !== kind) {
    shared = kind === 'fake' ? new FakeComputerProvider() : new Agent37ComputerProvider({ client: new Agent37Client({ key: env.AGENT37_API_KEY as string }), outstandingReserveMicros: outstandingJobRoom, image: () => dbImageStore.get() });
    sharedKind = kind;
  }
  return shared;
}

/** For tests: use this provider until told otherwise. */
export function setComputerProviderForTests(provider: ComputerProvider | null): void {
  shared = provider;
  sharedKind = provider ? provider.kind : null;
}
