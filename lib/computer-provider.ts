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

export interface ComputerProvider {
  readonly kind: 'fake' | 'real';
  /** What an awake minute costs, in millionths of a dollar, as the provider says; null when it has not said. */
  microsPerMinute(): number | null;
  /** Makes this Brick's one computer. Asked once for a Brick: a second ask for the same Brick is the same machine. */
  create(botId: string): Promise<MachineInfo>;
  /** Wakes a resting or cold machine. */
  wake(ref: string): Promise<void>;
  /** Lets it rest after a job: the disk is kept, nothing else is billed. */
  rest(ref: string): Promise<void>;
  /** A stop of ours (usage used up, a safety stop, the Brick deleted). The disk is kept. */
  stop(ref: string): Promise<void>;
  /** Takes the machine away for good. Only after the person's files were saved. */
  remove(ref: string): Promise<void>;
  /** The screen of a machine that is awake and working; null when it is not. Never wakes a machine. */
  watch(ref: string): Promise<WatchSession | null>;
  /** Saves a copy of its home folder and says how big it is. */
  saveFiles(ref: string): Promise<SavedCopy>;
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
  filesBytes = 1_288_490_188;
  private rate: number | null;
  private awake = new Set<string>();

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

  async wake(ref: string): Promise<void> {
    this.note('wake', ref);
    this.fail('wake');
    this.awake.add(ref);
  }

  async rest(ref: string): Promise<void> {
    this.note('rest', ref);
    this.fail('rest');
    this.awake.delete(ref);
  }

  async stop(ref: string): Promise<void> {
    this.note('stop', ref);
    this.awake.delete(ref);
  }

  async remove(ref: string): Promise<void> {
    this.note('remove', ref);
    this.awake.delete(ref);
  }

  async watch(ref: string): Promise<WatchSession | null> {
    this.note('watch', ref);
    // Only a machine that is awake has a screen: looking never wakes it
    if (!this.awake.has(ref)) return null;
    return { url: `https://computer.pretend.invalid/screen/${encodeURIComponent(ref)}`, expiresAt: new Date(Date.now() + 5 * 60_000) };
  }

  async saveFiles(ref: string): Promise<SavedCopy> {
    this.note('saveFiles', ref);
    if (this.failSaves) throw new Error('The pretend provider failed on saveFiles');
    this.fail('saveFiles');
    return { bytes: this.filesBytes, savedAt: new Date() };
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
  const held = await prisma.meterReservation.aggregate({ where: { state: 'held', reservationKey: { startsWith: 'computer:job:' } }, _sum: { amountMicros: true } });
  return Number(held._sum.amountMicros ?? 0);
}

let shared: ComputerProvider | null = null;
let sharedKind: string | null = null;

export function getComputerProvider(env: NodeJS.ProcessEnv = process.env): ComputerProvider | null {
  const kind = computerProviderKind(env);
  if (kind === null) return null;
  if (!shared || sharedKind !== kind) {
    shared = kind === 'fake' ? new FakeComputerProvider() : new Agent37ComputerProvider({ client: new Agent37Client({ key: env.AGENT37_API_KEY as string }), outstandingReserveMicros: outstandingJobRoom });
    sharedKind = kind;
  }
  return shared;
}

/** For tests: use this provider until told otherwise. */
export function setComputerProviderForTests(provider: ComputerProvider | null): void {
  shared = provider;
  sharedKind = provider ? provider.kind : null;
}
