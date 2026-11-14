import type { Check, ComputerProvider, ExecOptions, ExecResult, MachineInfo, SavedCopy, TurnEvent, TurnInput, WatchSession } from '@/lib/computer-provider';
import { readTurn } from '@/lib/agent37/turn-events';
import { Agent37Client, Agent37Error, Agent37Unreached, type Instance } from '@/lib/agent37/client';
import { BRICK_SHAPE, awakeMicrosPerMinute, dayOfRunningMicros } from '@/lib/agent37/rates';
import { savedCopyOf, storeSavedCopy, type SavedCopyInfo } from '@/lib/agent37/saved-copies';
import { ensureImage, imageReady, type ImageState } from '@/lib/agent37/image';

/**
 * A Brick's computer on Agent37 (game #2000): the real provider behind the interface Universe already uses.
 *
 * What it keeps, and where each rule comes from (build handoff v2, 13 Nov, and Agent37's docs read 14 Nov):
 *  - ONE machine per Brick, even when an answer is lost. Every machine is made with the Brick's id in its metadata. After a create
 *    that got no clear answer, or a Brick that has a machine nobody wrote down, it is looked up and adopted before another is made.
 *  - The account key stays here. The machine gets no key, no token and no env from this provider.
 *  - The managed AI budget is $0 on every machine (set at creation and never raised), so Agent37's own paid model cannot be used.
 *  - Looking never wakes. `watch` asks the status first and answers nothing for a machine that is not running; the wake paths are
 *    `wake` and a save that finds the machine asleep with no fresh copy.
 *  - A rest is Agent37's sleep: memory, processes and disk kept, only the disk billed. Only `remove` takes the disk away.
 *  - The wallet is read before a machine is made or woken and compared with the room Universe has reserved for jobs, not just with zero.
 *  - What a minute costs is Agent37's published price for the shape (lib/agent37/rates.ts), never a number of ours.
 */

/** The image our CI builds from Agent37's `hermes-base` (build handoff v2, step 4). Hermes, a watchable screen, and Universe's commands. */
export const BRICK_TEMPLATE = 'universe-brick';

/** The screen's port in the image (Agent37's `hermes-vnc-desktop` recipe). */
export const DESKTOP_PORT = 6901;
/** Agent37 closes a signed link after this: Orbit's own gateway (a later step) is what a person's browser talks to. */
export const WATCH_LINK_SECONDS = 60;

/** A resting machine wakes in 5 to 15 seconds, a cold one in about two minutes, and its health answers 502 for a few seconds more. */
const READY_WITHIN_MS = 4 * 60_000;
const POLL_MS = 3_000;
/** A copy saved this long before the machine went to sleep, or later, is the machine as it was left. */
const FRESH_COPY_MS = 5 * 60_000;

/** The image the machines are made from is still being built (or its build failed): no machine is made until it is ready. */
export class ImageNotReady extends Error {
  constructor(message = 'The computer image is not ready yet') {
    super(message);
    this.name = 'ImageNotReady';
  }
}

/** The wallet cannot carry another machine: said plainly, and nothing is made or woken. */
export class Agent37FundsLow extends Error {
  constructor(message = 'The computer wallet is too low to start another computer') {
    super(message);
    this.name = 'Agent37FundsLow';
  }
}

export interface ProviderOptions {
  client: Agent37Client;
  /** Room Universe holds for jobs that are running or waiting, in micros. */
  outstandingReserveMicros: () => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  template?: string;
  /** Where the image stands (its build). Without it the image is taken to be there (tests). */
  image?: () => Promise<ImageState | null>;
  /** For tests: where the saved copy goes and what is saved. */
  copies?: { latest: (botId: string) => Promise<SavedCopyInfo | null>; store: (botId: string, archive: ReadableStream<Uint8Array>) => Promise<SavedCopyInfo> };
}

const creationId = (botId: string) => `brick:${botId}`;
const gone = (status: string) => status === 'deleting' || status === 'deleted' || status === 'failed';

export class Agent37ComputerProvider implements ComputerProvider {
  readonly kind = 'real' as const;
  private readonly client: Agent37Client;
  private readonly reserved: () => Promise<number>;
  private readonly pause: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly template: string;
  private readonly image: ProviderOptions['image'];
  private readonly copies: NonNullable<ProviderOptions['copies']>;
  /** Which machine belongs to which Brick, learned from the metadata we wrote: `save` needs the Brick of a machine. */
  private readonly brickOf = new Map<string, string>();

  constructor(options: ProviderOptions) {
    this.client = options.client;
    this.reserved = options.outstandingReserveMicros;
    this.pause = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.template = options.template ?? BRICK_TEMPLATE;
    this.image = options.image;
    this.copies = options.copies ?? { latest: savedCopyOf, store: storeSavedCopy };
  }

  microsPerMinute(): number {
    return awakeMicrosPerMinute(BRICK_SHAPE);
  }

  /**
   * The wallet must hold what Agent37 asks for a new machine (a day of running) on top of every room Universe has reserved for jobs
   * that are working, so a computer is never started that the wallet cannot carry. An unreadable wallet is a no.
   */
  private async checkFunds(): Promise<void> {
    let balance;
    try {
      balance = await this.client.billing();
    } catch {
      throw new Agent37FundsLow('The computer wallet could not be read');
    }
    if (balance.past_due) throw new Agent37FundsLow('The computer wallet is overdrawn');
    const have = Math.round(balance.balance_usd * 1_000_000);
    if (!Number.isFinite(have)) throw new Agent37FundsLow('The computer wallet could not be read');
    if (have < (await this.reserved()) + dayOfRunningMicros(BRICK_SHAPE)) throw new Agent37FundsLow();
  }

  /** For the team's readiness page: whether a job could run now, in plain words. Reads only (nothing is made or woken). */
  async checkup(): Promise<Check[]> {
    const checks: Check[] = [];
    const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
    try {
      const balance = await this.client.billing();
      checks.push({ name: 'agent37 key', ok: true, detail: 'The Agent37 key works' });
      const have = Math.round(balance.balance_usd * 1_000_000);
      const need = (await this.reserved()) + dayOfRunningMicros(BRICK_SHAPE);
      if (balance.past_due) checks.push({ name: 'agent37 wallet', ok: false, detail: 'The wallet is overdrawn' });
      else if (!Number.isFinite(have)) checks.push({ name: 'agent37 wallet', ok: false, detail: 'The wallet could not be read' });
      else checks.push({ name: 'agent37 wallet', ok: have >= need, detail: have >= need ? `The wallet holds ${dollars(have)}; ${dollars(need)} is needed to start a computer` : `The wallet holds ${dollars(have)} but ${dollars(need)} is needed to start a computer` });
    } catch (error) {
      checks.push({ name: 'agent37 key', ok: false, detail: error instanceof Agent37Error && (error.status === 401 || error.status === 403) ? 'Agent37 refused the key' : 'Agent37 could not be reached' });
    }
    if (this.image) {
      const state = await this.image().catch(() => null);
      if (imageReady(state)) checks.push({ name: 'computer image', ok: true, detail: `The computer image is built (revision ${state?.revision ?? 'unknown'})` });
      else if (state?.state === 'building') checks.push({ name: 'computer image', ok: false, detail: 'The computer image is being built' });
      else if (state?.state === 'failed') checks.push({ name: 'computer image', ok: false, detail: `The computer image did not build: ${state.error ?? 'no reason given'} (tried ${state.failures} time${state.failures === 1 ? '' : 's'})` });
      else checks.push({ name: 'computer image', ok: false, detail: 'The computer image has not been started yet (the next sweep starts it)' });
    }
    return checks;
  }

  private remember(instance: Instance, botId?: string) {
    const id = botId ?? (typeof instance.metadata?.creation_id === 'string' ? instance.metadata.creation_id.replace(/^brick:/, '') : null);
    if (id) this.brickOf.set(instance.id, id);
  }

  /** The machine that was made for this Brick, if one exists whether or not Universe wrote it down. */
  private async findFor(botId: string): Promise<Instance | null> {
    const found = (await this.client.listInstances()).find((instance) => instance.metadata?.creation_id === creationId(botId) && !gone(String(instance.status)));
    return found ?? null;
  }

  async create(botId: string): Promise<MachineInfo> {
    const adopted = await this.findFor(botId);
    if (adopted) {
      this.remember(adopted, botId);
      return { ref: adopted.id, region: adopted.region ?? 'us' };
    }
    // A machine is only made from an image that was built: a job that comes first waits for it, the sweep builds it
    if (this.image && !imageReady(await this.image())) throw new ImageNotReady();
    await this.checkFunds();
    let made: Instance;
    try {
      made = await this.client.createInstance({
        template: this.template,
        name: `brick-${botId.slice(0, 8)}`,
        region: 'us',
        resources: { cpu: BRICK_SHAPE.cpu, memory: BRICK_SHAPE.memory, disk: BRICK_SHAPE.disk },
        metadata: { creation_id: creationId(botId) },
        budget: { monthly_cap_micros: 0, credit_micros: 0 },
        auto_sleep: true,
        idle_timeout_seconds: 900,
      });
    } catch (error) {
      // No answer, or a gateway failure: the machine may exist. Look for it before saying it does not
      if (error instanceof Agent37Unreached || (error instanceof Agent37Error && error.status >= 500)) {
        const late = await this.findFor(botId).catch(() => null);
        if (late) {
          this.remember(late, botId);
          return { ref: late.id, region: late.region ?? 'us' };
        }
      }
      throw error;
    }
    this.remember(made, botId);
    await this.untilHealthy(made.id, made.url);
    return { ref: made.id, region: made.region ?? 'us' };
  }

  async maintain(): Promise<void> {
    await ensureImage(this.client);
  }

  /**
   * A machine made ready for a job: moved to the image's current revision if it was made from an older one (its files are kept), then
   * `universe-up` brings the screen, the browser and the local model address up. The first time on a machine it also writes Hermes' config,
   * and Hermes only reads that when it starts: so the machine is stopped and started once, and `universe-up` is run again.
   */
  async ready(ref: string): Promise<void> {
    const state = this.image ? await this.image() : null;
    let instance = await this.client.getInstance(ref);
    const behind = state && imageReady(state) && state.revision !== null && typeof instance.template_revision === 'number' && instance.template_revision < state.revision;
    if (behind) {
      await this.client.updateInstance(ref);
      instance = await this.untilHealthy(ref, instance.url);
    }
    let up = await this.up(ref);
    if (up.restart) {
      await this.client.stopInstance(ref);
      await this.untilDown(ref);
      await this.client.startInstance(ref);
      await this.untilHealthy(ref, instance.url);
      up = await this.up(ref);
    }
    if (!up.ready) throw new Error(`The computer is not ready${up.reason ? ` (${up.reason})` : ''}`);
  }

  /** Runs `universe-up` and reads what it says. */
  private async up(ref: string): Promise<{ ready: boolean; restart: boolean; reason: string | null }> {
    const done = await this.client.exec(ref, 'universe-up', { timeoutMs: 90_000 });
    const ready = /(^|\n)ready=1\b/.test(done.stdout);
    const reason = /(^|\n)ready=0 reason=([a-z_]+)/.exec(done.stdout)?.[2] ?? null;
    if (!ready) console.error('[Computer] A machine was not ready:', reason ?? `exit ${done.exitCode}`, done.stderr.slice(-300));
    return { ready, restart: /\brestart=1\b/.test(done.stdout), reason };
  }

  /** Waits until Agent37 says the instance runs and its agent answers. Throws if it does not within a few minutes. */
  private async untilHealthy(id: string, knownUrl?: string): Promise<Instance> {
    const until = this.now() + READY_WITHIN_MS;
    let url = knownUrl;
    for (;;) {
      const instance = await this.client.getInstance(id);
      url = instance.url || url;
      if (gone(String(instance.status))) throw new Error(`The computer is ${instance.status}`);
      if (instance.status === 'running' && url && (await this.client.healthy(url))) return instance;
      if (this.now() >= until) throw new Error('The computer did not become ready in time');
      await this.pause(POLL_MS);
    }
  }

  async wake(ref: string): Promise<void> {
    let instance = await this.client.getInstance(ref);
    // A machine that is still going down cannot be started yet: wait for it to be down (or asleep), then wake it as any other
    if (instance.status === 'stopping') instance = await this.untilDown(ref);
    const status = String(instance.status);
    if (gone(status)) throw new Error(`The computer is ${status}`);
    if (status === 'sleeping' || status === 'stopped') {
      await this.checkFunds();
      await this.client.startInstance(ref);
    }
    // Running, starting, waking or provisioning: it is on its way, and asking again would only queue a second wake
    await this.untilHealthy(ref, instance.url);
  }

  /** Waits for a machine that is stopping to be stopped or asleep. Throws if it goes away, or does not settle in time. */
  private async untilDown(ref: string): Promise<Instance> {
    const until = this.now() + READY_WITHIN_MS;
    for (;;) {
      const instance = await this.client.getInstance(ref);
      if (instance.status !== 'stopping') return instance;
      if (this.now() >= until) throw new Error('The computer did not become ready in time');
      await this.pause(POLL_MS);
    }
  }

  async rest(ref: string): Promise<void> {
    const instance = await this.client.getInstance(ref);
    const status = String(instance.status);
    if (status === 'sleeping' || status === 'stopped' || status === 'stopping') return;
    if (gone(status)) return;
    try {
      await this.client.sleepInstance(ref);
    } catch (error) {
      // A 400 means it was not running after all: if it is resting now, that is what was asked for
      if (error instanceof Agent37Error && error.status === 400) {
        const after = await this.client.getInstance(ref);
        if (['sleeping', 'stopped', 'stopping'].includes(String(after.status))) return;
      }
      throw error;
    }
  }

  async stop(ref: string): Promise<void> {
    const instance = await this.client.getInstance(ref);
    if (instance.status === 'stopped' || instance.status === 'stopping' || gone(String(instance.status))) return;
    await this.client.stopInstance(ref);
  }

  async remove(ref: string): Promise<void> {
    try {
      await this.client.deleteInstance(ref);
    } catch (error) {
      // Already gone is what was asked for
      if (error instanceof Agent37Error && error.status === 404) return;
      throw error;
    }
    this.brickOf.delete(ref);
  }

  async awake(ref: string): Promise<boolean> {
    try {
      const status = String((await this.client.getInstance(ref)).status);
      return ['running', 'starting', 'restarting', 'updating', 'waking', 'provisioning'].includes(status);
    } catch (error) {
      // A machine that is not there is not running; any other answer is not known, and "not known" is never taken for "stopped"
      if (error instanceof Agent37Error && error.status === 404) return false;
      throw error;
    }
  }

  async watch(ref: string): Promise<WatchSession | null> {
    // Looking never wakes: only a machine that is running has a screen
    const instance = await this.client.getInstance(ref);
    if (instance.status !== 'running') return null;
    const link = await this.client.signedUrl(ref, DESKTOP_PORT, WATCH_LINK_SECONDS);
    return { url: link.url, expiresAt: new Date(this.now() + WATCH_LINK_SECONDS * 1000) };
  }

  async saveFiles(ref: string): Promise<SavedCopy> {
    const instance = await this.client.getInstance(ref);
    const botId = typeof instance.metadata?.creation_id === 'string' ? instance.metadata.creation_id.replace(/^brick:/, '') : this.brickOf.get(ref);
    if (!botId) throw new Error('This computer does not say which Brick it belongs to');
    if (gone(String(instance.status))) throw new Error(`The computer is ${instance.status}`);
    // A machine that rests has not changed since it was put to rest: a copy saved before that is still the folder. Asking its address
    // would wake it, and nothing here wakes a machine that already has a copy to show. A sleeping machine says when it slept, and the
    // copy must be from then; a stopped one says nothing of when (and is only ever stopped by us, after a save), so its copy stands
    if (instance.status !== 'running') {
      const existing = await this.copies.latest(botId);
      const sleptAt = instance.slept_at ? instance.slept_at * 1000 : null;
      if (existing && (instance.status === 'stopped' || (sleptAt !== null && existing.savedAt.getTime() >= sleptAt - FRESH_COPY_MS))) return existing;
      // No copy that is as the machine was left: it is woken once, for this
      await this.wake(ref);
    }
    const url = (await this.client.getInstance(ref)).url || instance.url;
    const archive = await this.client.archive(url);
    const saved = await this.copies.store(botId, archive.body as ReadableStream<Uint8Array>);
    return { bytes: saved.bytes, savedAt: saved.savedAt };
  }

  /** The address of a machine's own agent. Asked of Agent37 each time (a few ms), so a machine that moved host is still found. */
  private async urlOf(ref: string): Promise<string> {
    const instance = await this.client.getInstance(ref);
    if (gone(String(instance.status)) || !instance.url) throw new Error(`The computer is ${instance.status}`);
    return instance.url;
  }

  exec(ref: string, command: string, options?: ExecOptions): Promise<ExecResult> {
    return this.client.exec(ref, command, options);
  }

  async openTurn(ref: string, input: TurnInput, signal?: AbortSignal): Promise<AsyncGenerator<TurnEvent>> {
    const response = await this.client.openTurn(await this.urlOf(ref), input, signal);
    return readTurn(response.body as ReadableStream<Uint8Array>);
  }

  async reattachTurn(ref: string, responseId: string, signal?: AbortSignal): Promise<AsyncGenerator<TurnEvent>> {
    const response = await this.client.reattachTurn(await this.urlOf(ref), responseId, signal);
    return readTurn(response.body as ReadableStream<Uint8Array>);
  }

  async cancelTurn(ref: string, responseId: string): Promise<void> {
    await this.client.cancelTurn(await this.urlOf(ref), responseId);
  }

  async activeTurn(ref: string, sessionId: string): Promise<string | null> {
    return this.client.activeTurn(await this.urlOf(ref), sessionId);
  }
}
