/**
 * Where a Brick's computer really lives (game #2000). Everything in Universe talks to a computer through this one interface,
 * so the team can run the whole of it with the pretend provider on the dev server first, and the real one is wired and OFF.
 *
 * Four rules the interface keeps by its shape:
 *  - Nothing here creates or wakes a machine unless a job needs it: only `create` and `wake` do, and Universe calls them from
 *    one place (starting a job). `watch` can only look: it returns nothing for a machine that is not awake.
 *  - There is no way to copy or reset a machine. A second job never gets a second computer, and nothing here forks one.
 *  - `rest` and `stop` keep the disk. Only `remove` takes a machine away, and only after the person's files were saved.
 *  - What a minute costs is the provider's answer, never a number of ours.
 */

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

/** The real provider is wired and off until the owner of Universe says so, after a measured, bounded trial. */
export class ComputerProviderOff extends Error {
  constructor() {
    super('The real computer provider is not switched on');
    this.name = 'ComputerProviderOff';
  }
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

/** The real provider: wired so the team can see where it goes, and off. Every call says so. */
export class RealComputerProvider implements ComputerProvider {
  readonly kind = 'real' as const;
  microsPerMinute(): number | null {
    return null;
  }
  async create(): Promise<MachineInfo> {
    throw new ComputerProviderOff();
  }
  async wake(): Promise<void> {
    throw new ComputerProviderOff();
  }
  async rest(): Promise<void> {
    throw new ComputerProviderOff();
  }
  async stop(): Promise<void> {
    throw new ComputerProviderOff();
  }
  async remove(): Promise<void> {
    throw new ComputerProviderOff();
  }
  async watch(): Promise<WatchSession | null> {
    throw new ComputerProviderOff();
  }
  async saveFiles(): Promise<SavedCopy> {
    throw new ComputerProviderOff();
  }
}

/**
 * Which provider this server runs, from `COMPUTER_PROVIDER`: "fake" on the dev server and in tests, "real" only when Khalid has
 * said so. Anything else, and every server that was not told, has no computers at all: a Brick's page says so and nothing is made.
 */
export function computerProviderKind(env: NodeJS.ProcessEnv = process.env): 'fake' | 'real' | null {
  const value = (env.COMPUTER_PROVIDER ?? '').trim().toLowerCase();
  return value === 'fake' || value === 'real' ? value : null;
}

let shared: ComputerProvider | null = null;
let sharedKind: string | null = null;

export function getComputerProvider(env: NodeJS.ProcessEnv = process.env): ComputerProvider | null {
  const kind = computerProviderKind(env);
  if (kind === null) return null;
  if (!shared || sharedKind !== kind) {
    shared = kind === 'fake' ? new FakeComputerProvider() : new RealComputerProvider();
    sharedKind = kind;
  }
  return shared;
}

/** For tests: use this provider until told otherwise. */
export function setComputerProviderForTests(provider: ComputerProvider | null): void {
  shared = provider;
  sharedKind = provider ? provider.kind : null;
}
