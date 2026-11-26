/**
 * Where a Brick's computer really lives (game #2000). Everything in Universe talks to a computer through this one interface:
 * the pretend provider runs the whole of it on the dev server and in tests, and the real one (Agent37, lib/agent37) runs on prod.
 *
 * Four rules the interface keeps by its shape:
 *  - Nothing here creates or wakes a machine unless a job needs it: only `create` and `wake` do, and Universe calls them from
 *    one place (starting a job). `watch` can only look: it returns nothing for a machine that is not awake.
 *  - There is no way to copy or reset a machine. A second job never gets a second computer, and nothing here forks one.
 *  - `rest` and `stop` keep the disk. Only `remove` takes a machine away: when a Brick is deleted for good it goes without waiting for any copy.
 *  - What a minute costs is the provider's answer, never a number of ours.
 */

import { prisma } from '@/lib/db';
import { WakeReplaced } from '@/lib/computer-wake-replaced';
import type { OutsideManifest } from '@/lib/computer-outside';
import { Agent37Client } from '@/lib/agent37/client';
import { Agent37ComputerProvider } from '@/lib/agent37/provider';
import { dbImageStore } from '@/lib/agent37/image';
import type { ExecResult } from '@/lib/agent37/client';
import { isMarkCommand, isFenceCheckCommand } from '@/lib/computer-fence-script';
import type { MachineMark } from '@/lib/computer-fence-script';
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

/** One machine in the provider's bill for a day. `ref` is the provider's own id; `kind` says whose machine it is (a Brick's, another one on the same account, or one that is gone). */
export interface ProviderDayInstance {
  ref: string;
  /** A throwaway computer made to prove a restore is `scratch`: it is billed but is no Brick's. */
  kind: 'brick' | 'other' | 'gone' | 'scratch';
  /** The Brick it was made for, from what we wrote on it when we made it; null for `other` and `gone`. */
  botId: string | null;
  totalMicros: number;
  computeMicros: number;
  awakeMinutes: number;
  /** What the provider's own published rates make of this machine's awake minutes and resting disk for the day; null when they cannot say. */
  expectedMicros: number | null;
}

/** What the provider billed for one UTC day (`YYYY-MM-DD`). */
export interface ProviderDay {
  day: string;
  totalMicros: number;
  instances: ProviderDayInstance[];
}

/** What a computer holds besides its home folder that a copy must carry, and how big the home folder is: what `prepack` found. */
export interface PackInventory {
  homeFiles: number;
  homeBytes: number;
  /** Files outside the home folder that were changed since the image was built, copied into the home folder so they travel with it. */
  outsideFiles: number;
  outsideBytes: number;
  /** Software added to the computer after the image was built (their names), which a restore installs again. */
  packages: string[];
  /** Why this computer cannot be packed away yet (more outside the home folder than can be carried, or the image's own list is missing); null when it can. */
  blocked: string | null;
  /** What `prepack` copied outside the home folder, as the script saw it (see `OutsideManifest`); null or absent when nothing was verified. Kept on the copy's row, never taken from the home folder. */
  outside?: OutsideManifest | null;
}

/** Where a computer fetches a copy from when it is restored: Orbit's own address, a key that lasts a short while and only for this copy, and the SHA-256 the bytes must have. */
export interface RestoreSource {
  url: string;
  token: string;
  sha256: string;
  /** What `prepack` printed for this copy (kept on its row): handed to `finish`, which puts back only what matches it. Null (or absent) for a copy made before it was kept: nothing outside the home folder is put back. */
  outside?: OutsideManifest | null;
}

export interface RestoreResult {
  ok: boolean;
  /** Why it did not restore, in a few plain words (never a path or what a file held). */
  reason: string | null;
  /** How long the restore took on the computer, in milliseconds. */
  ms: number;
  /** `unverified`: the copy has no list of what was outside the home folder (it was made before the list was kept), so nothing outside the home folder was put back. */
  outside?: 'unverified';
}

export interface ComputerProvider {
  readonly kind: 'fake' | 'real';
  /** What an awake minute costs, in millionths of a dollar, as the provider says; null when it has not said. */
  microsPerMinute(): number | null;
  /** How big the disk of a machine it makes is, in bytes, as the provider bills it (a disk is billed whole, asleep or not); null when it bills none. */
  diskBytes?(): number | null;
  /** Makes this Brick's one computer. Asked once for a Brick: a second ask for the same Brick is the same machine. */
  create(botId: string): Promise<MachineInfo>;
  /**
   * Wakes a resting or cold machine. `stillMine`: asked right before the call that starts the machine (a start can wait minutes for the machine to be down first): it renews the start's own wake (a fenced beat) and says whether the
   * start still owns it. When it says no, nothing is sent and `WakeReplaced` is thrown (Opus on #1040).
   */
  wake(ref: string, options?: { stillMine?: () => Promise<boolean> }): Promise<void>;
  /**
   * Brings a machine that was just made or woken to what a job needs: the current image, the screen and the browser, the local model
   * address. Safe to ask any number of times. Throws when it cannot be made ready (the job then does not start). Answers the mark the take-over fence
   * is told by (taken last, once the computer is as it should be; Orbit saves it, the computer keeps nothing): nothing (null) when this provider has no fence to mark, or when no mark
   * could be proved (a fresh boot that did not show a new boot id): the job runs and no mark is saved, so a take-over on that computer is not proved and stops it, and the next wake asks for the fresh boot again.
   * `freshBoot`: the computer is stopped and started first, so what it was running before is gone and the mark is the first of a boot nothing has run on. Asked for a
   * computer that has worked before and has no mark saved (made ready before marks were kept by Orbit): a mark taken on a boot that already ran jobs would name
   * their programs as the computer's own.
   * `stillMine`: asked right before EVERY call that stops or starts the machine (each restart waits for the machine to be down in between, and a start that lost its wake must never send one after the stop that replaced it was proved): it renews
   * the start's own wake (a fenced beat) and says whether the start still owns it. When it says no, nothing is sent and `WakeReplaced` is thrown (Opus on #1040).
   */
  ready(ref: string, options?: { freshBoot?: boolean; stillMine?: () => Promise<boolean> }): Promise<MachineMark | null | void>;
  /** What a job needs from the provider right now (the key works, the wallet carries a job, the image is built). Reads only; never throws. */
  checkup(): Promise<Check[]>;
  /** What the provider billed for a UTC day, by machine, for the daily check of our books against its bill. Reads only. Absent for a provider with no bill. */
  dayUsage?(day: string): Promise<ProviderDay>;
  /** Whatever the provider keeps up between jobs (the real one builds its image). Asked by the sweep; never throws. */
  maintain(): Promise<void>;
  /** Lets it rest after a job: the disk is kept, nothing else is billed. */
  rest(ref: string): Promise<void>;
  /** A stop of ours (usage used up, a safety stop, the Brick deleted). The disk is kept. */
  stop(ref: string): Promise<void>;
  /** Takes the machine away for good, its disk and everything on it. Never needs a saved copy first: a deleted Brick keeps nothing. */
  remove(ref: string): Promise<void>;
  /**
   * Takes away every machine made for this Brick, also one that was made and never written down (a make that was cut off). Asked after
   * a Brick was purged, with the Brick's own rows already gone. Nothing there is not an error. Absent: this provider keeps none of its own.
   */
  removeAllFor?(botId: string): Promise<void>;
  /** Whether the machine is running or on its way up (billed). A machine that is gone, stopped or asleep is not. Used to prove a stop. */
  awake(ref: string): Promise<boolean>;
  /** The same as `awake`, from ONE request with this timeout and no asking again (a renewal must answer its worker within a few seconds, post-0.5.0 B). Absent: `awake` is used under the caller's own cap. */
  awakeOnce?(ref: string, timeoutMs: number): Promise<boolean>;
  /** The screen of a machine that is awake and working; null when it is not. Never wakes a machine. */
  watch(ref: string): Promise<WatchSession | null>;
  /** Saves a copy of its home folder and says how big it is. */
  saveFiles(ref: string): Promise<SavedCopy>;
  /**
   * Cold storage, step by step (lib/computer-cold.ts). Only for a computer that is awake and that Universe holds (a pack-away or a return). A
   * provider without them keeps its computers where they are.
   * `prepack`: copies what is outside the home folder into it and says what is there. `streamFiles`: the home folder as a tar.gz stream (as `saveFiles`
   * reads it). `makeScratch`: a throwaway computer to prove a restore on (billed until it is removed). `restoreInto`: puts a copy onto a computer and
   * checks it file by file. `confirmRemoved`: asks again until the provider says the computer is gone and no longer billed. `removeScratches`: removes
   * throwaway computers older than this many milliseconds that were left behind.
   */
  prepack?(ref: string): Promise<PackInventory>;
  streamFiles?(ref: string): Promise<ReadableStream<Uint8Array>>;
  makeScratch?(): Promise<MachineInfo>;
  restoreInto?(ref: string, source: RestoreSource): Promise<RestoreResult>;
  confirmRemoved?(ref: string): Promise<'gone' | 'still_there'>;
  removeScratches?(olderThanMs: number): Promise<number>;
  /** Deletes the saved copy of a Brick's folder from our own storage for good (a Brick that was deleted keeps nothing). A copy that is not there is no error. Absent: this provider keeps no copy of its own. */
  deleteSavedCopy?(botId: string): Promise<void>;
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

/** What the mark command prints for a mark (the pretend computer's answer). */
function markAnswer(mark: MachineMark): string {
  const letter = { screen: 's', part: 'p', gateway: 'g' } as const;
  return [`boot=${mark.bootId}`, `ticks=${mark.ticks}`, ...mark.parts.map((part) => `part=${part.pid}:${part.start}:${letter[part.kind]}`), ...mark.runners.map((runner) => `runner=${runner}`), 'marked=1', ''].join('\n');
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
  failNext: Partial<Record<'create' | 'wake' | 'rest' | 'saveFiles' | 'stop' | 'ready', boolean>> = {};
  /** Every save fails until this is turned off. */
  failSaves = false;
  /** What a command run on the pretend machine answers with, by what it says; a test sets this. Without it every command succeeds with no output. */
  execAnswer: (command: string) => Partial<ExecResult> | Promise<Partial<ExecResult>> = (command) =>
    isFenceCheckCommand(command)
      ? { stdout: 'remaining=0\n' }
      : command.startsWith('universe-visits read')
        ? // The pretend computer's browser went nowhere: a clean, empty record
          { stdout: `now=${Date.now()}\nstate=none\nalive=1\nend=1\n` }
        : {};
  /** Every command is refused (the machine does not answer) while this is on. */
  failExec = false;
  /** The disk of a machine it makes, in bytes; a test sets this (the pretend one bills none). */
  disk: number | null = null;
  /** The turns the pretend agent will run, one list of events per turn, used in order. */
  turns: TurnEvent[][] = [];
  /** What was asked of the pretend agent, and what was cancelled. */
  openedTurns: { ref: string; input: TurnInput; signal?: AbortSignal }[] = [];
  cancelledTurns: string[] = [];
  /** Every cancel is refused (the machine does not answer) while this is on. */
  failCancel = false;
  /** A turn the pretend agent is running in a session: set by a test, read back by `activeTurn`. */
  running = new Map<string, string>();
  filesBytes = 1_288_490_188;
  /** The machines that were made ready for a job. */
  readied: string[] = [];
  /** Cold storage: what the pretend provider answers, and what a test can make it get wrong. */
  coldFail: Partial<Record<'prepack' | 'stream' | 'scratch' | 'restore' | 'remove' | 'confirm', boolean>> = {};
  inventory: PackInventory = { homeFiles: 12, homeBytes: 3_000_000, outsideFiles: 0, outsideBytes: 0, packages: [], blocked: null };
  /** The bytes the pretend home folder streams as its tar.gz. A test sets real gzip bytes so the saved copy's check passes. */
  homeArchive: Uint8Array = new Uint8Array(0);
  /** What each restore answers, in order (a test queues failures); without a queued answer a restore succeeds. */
  restoreResults: RestoreResult[] = [];
  restored: Array<{ ref: string; source: RestoreSource }> = [];
  scratches: string[] = [];
  /** The machines that were made, in order, with the Brick (made) or the pretend throwaway name. */
  made: string[] = [];
  /** `confirmRemoved` says "still there" this many times (for a Brick's own computer) before it says gone. */
  stillThere = 0;
  /** What the pretend wake time is, in milliseconds (a return from cold storage reads it). */
  restoreMs = 1_200;
  private rate: number | null;
  private awake_ = new Set<string>();

  constructor(microsPerMinute: number | null = PRETEND_MICROS_PER_MINUTE) {
    this.rate = microsPerMinute;
  }

  microsPerMinute(): number | null {
    return this.rate;
  }

  diskBytes(): number | null {
    return this.disk;
  }

  private note(name: string, ref?: string) {
    this.calls.push({ name, ref });
  }

  private fail(name: 'create' | 'wake' | 'rest' | 'saveFiles' | 'stop' | 'ready') {
    if (this.failNext[name]) {
      this.failNext[name] = false;
      throw new Error(`The pretend provider failed on ${name}`);
    }
  }

  async create(botId: string): Promise<MachineInfo> {
    this.note('create', botId);
    this.fail('create');
    this.made.push(botId);
    return { ref: `fake-${botId}`, region: 'pretend' };
  }

  async prepack(ref: string): Promise<PackInventory> {
    this.note('prepack', ref);
    if (this.coldFail.prepack) throw new Error('The pretend provider failed on prepack');
    return this.inventory;
  }

  async streamFiles(ref: string): Promise<ReadableStream<Uint8Array>> {
    this.note('streamFiles', ref);
    if (this.coldFail.stream) throw new Error('The pretend provider failed on streamFiles');
    const bytes = this.homeArchive;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async makeScratch(): Promise<MachineInfo> {
    this.note('makeScratch');
    if (this.coldFail.scratch) throw new Error('The pretend provider failed on makeScratch');
    const ref = `scratch-${this.scratches.length + 1}`;
    this.scratches.push(ref);
    return { ref, region: 'pretend' };
  }

  async restoreInto(ref: string, source: RestoreSource): Promise<RestoreResult> {
    this.note('restoreInto', ref);
    this.restored.push({ ref, source });
    if (this.coldFail.restore) throw new Error('The pretend provider failed on restoreInto');
    return this.restoreResults.shift() ?? { ok: true, reason: null, ms: this.restoreMs };
  }

  async confirmRemoved(ref: string): Promise<'gone' | 'still_there'> {
    this.note('confirmRemoved', ref);
    if (this.coldFail.confirm) throw new Error('The pretend provider failed on confirmRemoved');
    // A throwaway computer's removal is confirmed at once: `stillThere` is about the Brick's own computer
    if (this.stillThere > 0 && !ref.startsWith('scratch-')) {
      this.stillThere--;
      return 'still_there';
    }
    return 'gone';
  }

  async removeScratches(): Promise<number> {
    this.note('removeScratches');
    return 0;
  }

  /** The machines that were asked for a fresh boot, in order (a test reads it). */
  readonly freshBoots: string[] = [];
  /** A test sets it to pretend a restart that does not show a new boot: a fresh boot is asked for, no mark is proved, and `ready` answers null (the job still runs). */
  freshBootUnproved = false;

  async ready(ref: string, options?: { freshBoot?: boolean; stillMine?: () => Promise<boolean> }): Promise<MachineMark | null | void> {
    this.fail('ready');
    this.readied.push(ref);
    if (options?.freshBoot) {
      // The pretend restart is a stop and a start: it is only sent while the start still owns its wake
      if (options.stillMine && !(await options.stillMine())) throw new WakeReplaced();
      this.freshBoots.push(ref);
      if (this.freshBootUnproved) return null;
      this.rebootForTests(ref);
    }
    return this.markOf(ref);
  }

  /** The pretend computer's boots, by machine: a test moves one on to pretend the computer was stopped and started. */
  private boots = new Map<string, number>();
  private reads = 0;
  rebootForTests(ref: string): void {
    this.boots.set(ref, (this.boots.get(ref) ?? 0) + 1);
  }

  /** What the pretend computer's mark is: one boot id for each boot, the same clock reading, and no parts (a test may set them). */
  parts: MachineMark['parts'] = [];
  markOf(ref: string): MachineMark {
    const boot = this.boots.get(ref) ?? 0;
    let hash = 7;
    for (const char of `${ref}`) hash = (hash * 31 + char.charCodeAt(0)) % 0xffffffffffff;
    const tail = (hash + boot).toString(16).padStart(12, '0');
    // The clock reading moves on with every read, so a test can tell the first reading of a boot from a later one
    return { bootId: `00000000-0000-4000-8000-${tail}`, ticks: 1000 + this.reads++, parts: this.parts, runners: [] };
  }

  async maintain(): Promise<void> {}

  async checkup(): Promise<Check[]> {
    return [{ name: 'provider', ok: true, detail: 'The pretend provider (development only)' }];
  }

  async wake(ref: string, options?: { stillMine?: () => Promise<boolean> }): Promise<void> {
    this.note('wake', ref);
    this.fail('wake');
    // The pretend start is only sent while the start still owns its wake
    if (options?.stillMine && !(await options.stillMine())) throw new WakeReplaced();
    this.awake_.add(ref);
  }

  async rest(ref: string): Promise<void> {
    this.note('rest', ref);
    this.fail('rest');
    this.awake_.delete(ref);
  }

  async stop(ref: string): Promise<void> {
    this.note('stop', ref);
    this.fail('stop');
    this.awake_.delete(ref);
  }

  /** Make the removing of a machine fail while this is on (a provider that is down). */
  failRemove = false;

  async remove(ref: string): Promise<void> {
    this.note('remove', ref);
    if (this.coldFail.remove || this.failRemove) throw new Error('The pretend provider failed on remove');
    this.awake_.delete(ref);
  }

  async removeAllFor(botId: string): Promise<void> {
    this.note('removeAllFor', botId);
    if (this.failRemove) throw new Error('The pretend provider failed on removeAllFor');
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

  /** Make the deleting of a saved copy fail while this is on. */
  failDeleteCopy = false;

  async deleteSavedCopy(botId: string): Promise<void> {
    this.note('deleteSavedCopy', botId);
    if (this.failDeleteCopy) throw new Error('The pretend provider failed on deleteSavedCopy');
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
    // The mark command is answered like a real computer would unless a test says otherwise: this boot's id, the clock, the parts a test set
    const marked = isMarkCommand(command) && answer.stdout === undefined ? { stdout: markAnswer(this.markOf(ref)) } : {};
    return { exitCode: 0, stdout: '', stderr: '', truncated: false, ...marked, ...answer };
  }
  /** The commands that were run, in order. */
  readonly commands: { ref: string; command: string }[] = [];

  async openTurn(ref: string, input: TurnInput, signal?: AbortSignal): Promise<AsyncGenerator<TurnEvent>> {
    this.note('openTurn', ref);
    this.openedTurns.push({ ref, input, signal });
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
    if (this.failCancel) throw new Error('The machine did not answer');
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
