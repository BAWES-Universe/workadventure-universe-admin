import { randomUUID } from 'node:crypto';
import type { Check, ComputerProvider, ExecOptions, ExecResult, MachineInfo, PackInventory, ProviderDay, RestoreResult, RestoreSource, SavedCopy, TurnEvent, TurnInput, WatchSession } from '@/lib/computer-provider';
import { readTurn } from '@/lib/agent37/turn-events';
import { Agent37Client, Agent37Error, Agent37Unreached, type Instance, type NetworkPolicy } from '@/lib/agent37/client';
import { BRICK_SHAPE, awakeMicrosPerMinute, dayOfRunningMicros, restingMicrosPerMinute } from '@/lib/agent37/rates';
import { deleteSavedCopy, savedCopyOf, storeSavedCopy, type SavedCopyInfo } from '@/lib/agent37/saved-copies';
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

/**
 * What a Brick's computer may reach: the open internet, directly (Agent37's `allow-all`, which never reaches private ranges, other machines or the
 * host: docs agents-api/instance-network). It is written on every machine we make and checked each time one is made ready, so a machine that drifted
 * is put right before a job runs on it. Whether a computer may SPEND Universe's money does not depend on this rule: that is decided by the Orbit broker
 * (job tokens, reservations, the AI relay), which holds every platform credential; no raw key is ever put on a computer, and when Orbit is down a paid
 * action waits or fails: there is no fallback that hands a computer a provider key. Agent37's own managed services are kept shut by their budget:
 * the monthly cap AND the remaining one-time credit must both be zero (`budgetClosed`), checked on create, adoption, readiness and restore.
 */
export const BRICK_NETWORK: NetworkPolicy = 'allow-all';

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
  copies?: { latest: (botId: string) => Promise<SavedCopyInfo | null>; store: (botId: string, archive: ReadableStream<Uint8Array>) => Promise<SavedCopyInfo>; remove?: (botId: string) => Promise<void> };
}

const creationId = (botId: string) => `brick:${botId}`;
/** A throwaway computer made to prove a restore carries this in its metadata, so the daily check knows it and a sweep can remove one that was left behind. */
export const SCRATCH_PREFIX = 'scratch:';
/** A listing this long may be one page of more (Agent37's docs say nothing about pages, only "newest first"), so it cannot prove a machine is not there. */
export const LISTING_MAY_BE_CUT = 100;

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

  /** The Orbit broker's needs: the key its job tokens and restore keys are signed with, and the address a computer reaches Orbit at. A computer holds no provider key; without these a paid action waits or fails. */
  private brokerCheck(): Check {
    const missing: string[] = [];
    if (!process.env.ENCRYPTION_KEY) missing.push('the key that signs job tokens (ENCRYPTION_KEY)');
    if (!process.env.NEXT_PUBLIC_API_URL && !process.env.ADMIN_API_URL) missing.push('Orbit’s own address (ADMIN_API_URL)');
    if (missing.length > 0) return { name: 'orbit broker', ok: false, detail: `Paid actions cannot run: ${missing.join(' and ')} is not set` };
    return {
      name: 'orbit broker',
      ok: true,
      detail: 'Computers have the open internet directly (allow-all). Paid actions and Universe AI go only through Orbit’s broker with a job token; no provider key is put on a computer and nothing falls back to one when Orbit is down',
    };
  }

  /**
   * Agent37's managed budget of the machines we have: monthly cap and remaining one-time credit, both zero. Looks at up to 30 machines of ours (the
   * newest), so it is a sample on a big account; every machine is also read when it is made, adopted, made ready and restored onto.
   */
  private async budgetCheck(): Promise<Check> {
    try {
      const ours = (await this.client.listInstances()).filter((instance) => typeof instance.metadata?.creation_id === 'string' && !gone(String(instance.status)));
      const sample = ours.slice(0, 30);
      const open: string[] = [];
      for (const instance of sample) {
        const budget = await this.client.getBudget(instance.id);
        if (budget.monthlyCapMicros !== 0 || budget.monthlyRemainingMicros > 0 || budget.creditRemainingMicros > 0) open.push(instance.id);
      }
      if (open.length > 0) return { name: 'agent37 managed budget', ok: false, detail: `${open.length} of ${sample.length} machines still have managed budget (monthly cap or one-time credit above zero); each is closed when it is made ready, and credit has to be removed by Agent37` };
      return { name: 'agent37 managed budget', ok: true, detail: `Monthly cap and remaining one-time credit are zero on ${sample.length === ours.length ? `all ${sample.length}` : `${sample.length} of ${ours.length}`} machines, so Agent37’s managed paid services cannot spend` };
    } catch {
      return { name: 'agent37 managed budget', ok: false, detail: 'The managed budget of the machines could not be read' };
    }
  }

  /**
   * Agent37's managed services (its model router, Brave, Composio, Perflo) are paid from a machine's budget, and its injected token reaches them
   * on every instance. Two numbers keep them shut: the monthly cap and the REMAINING ONE-TIME CREDIT; a $0 cap alone leaves any credit usable.
   * Reads both back (`GET /v1/instances/{id}/budget`), sets a cap that is not zero back to zero, and says when anything is left that this
   * account key cannot take away (credit): that machine is not handed to anything, and the one-time credit is never "spent down" to clear it.
   */
  private async budgetClosed(ref: string): Promise<void> {
    let budget = await this.client.getBudget(ref);
    if (budget.monthlyCapMicros !== 0) {
      await this.client.setMonthlyCap(ref, 0);
      budget = await this.client.getBudget(ref);
    }
    if (budget.monthlyCapMicros !== 0 || budget.monthlyRemainingMicros > 0 || budget.creditRemainingMicros > 0) {
      throw new Error('The computer is not ready (its Agent37 managed budget is not zero: it can still spend; ask Agent37 to remove it)');
    }
  }

  microsPerMinute(): number {
    return awakeMicrosPerMinute(BRICK_SHAPE);
  }

  /** Agent37 bills the whole disk of the shape for as long as the machine exists, awake or asleep (a gigabyte is 10^9 bytes). */
  diskBytes(): number {
    return BRICK_SHAPE.disk * 1_000_000_000;
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
    let balance: Awaited<ReturnType<Agent37Client['billing']>> | null = null;
    try {
      balance = await this.client.billing();
      checks.push({ name: 'agent37 key', ok: true, detail: 'The Agent37 key works' });
    } catch (error) {
      checks.push({ name: 'agent37 key', ok: false, detail: error instanceof Agent37Error && (error.status === 401 || error.status === 403) ? 'Agent37 refused the key' : 'Agent37 could not be reached' });
    }
    if (balance) {
      try {
        const have = Math.round(balance.balance_usd * 1_000_000);
        const need = (await this.reserved()) + dayOfRunningMicros(BRICK_SHAPE);
        if (balance.past_due) checks.push({ name: 'agent37 wallet', ok: false, detail: 'The wallet is overdrawn' });
        else if (!Number.isFinite(have)) checks.push({ name: 'agent37 wallet', ok: false, detail: 'The wallet could not be read' });
        else checks.push({ name: 'agent37 wallet', ok: have >= need, detail: have >= need ? `The wallet holds ${dollars(have)}; ${dollars(need)} is needed to start a computer` : `The wallet holds ${dollars(have)} but ${dollars(need)} is needed to start a computer` });
      } catch {
        checks.push({ name: 'agent37 wallet', ok: false, detail: 'What is already set aside could not be read' });
      }
    }
    // Direct network: the computers keep the open internet (`allow-all`); nothing here depends on a gateway. What decides whether a computer may spend
    // Universe's money is the Orbit broker, so the broker's two needs are looked at: the key that signs job tokens and restore keys, and Orbit's public address
    checks.push(this.brokerCheck());
    checks.push(await this.budgetCheck());
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
      // A machine nobody wrote down may have been topped up or changed by hand: its budget is read before it is taken
      await this.budgetClosed(adopted.id);
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
        network: BRICK_NETWORK,
      });
    } catch (error) {
      // No answer, or a gateway failure: the machine may exist. Look for it before saying it does not
      if (error instanceof Agent37Unreached || (error instanceof Agent37Error && error.status >= 500)) {
        const late = await this.findFor(botId).catch(() => null);
        if (late) {
          this.remember(late, botId);
          await this.budgetClosed(late.id);
          return { ref: late.id, region: late.region ?? 'us' };
        }
      }
      throw error;
    }
    this.remember(made, botId);
    await this.untilHealthy(made.id, made.url);
    await this.budgetClosed(made.id);
    return { ref: made.id, region: made.region ?? 'us' };
  }

  /**
   * Agent37's bill for one UTC day, by machine. A machine is a Brick's when we wrote its Brick on it (`brick:<id>`), "other" when it is on the
   * account but not made by us (the account also holds machines that are not Bricks), and "gone" when the bill has it and it no longer exists.
   * `expectedMicros` is the bill the published rates make of its awake minutes (the rest of the day at the resting disk's rate); a machine made
   * or removed that day was billed for less than a whole day of resting, so this is the most it can be.
   */
  async dayUsage(day: string): Promise<ProviderDay> {
    const bill = await this.client.usageForDay(day);
    const present = new Map((await this.client.listInstances()).map((instance) => [instance.id, instance]));
    // The list holds the newest machines and the docs say nothing of pages, so a billed machine that is not on it is looked up by its id:
    // only an answer that it does not exist makes it gone. Any other answer (Agent37 down) stops the day's check, which is tried again later.
    for (const entry of bill.instances) {
      if (present.has(entry.id)) continue;
      try {
        present.set(entry.id, await this.client.getInstance(entry.id));
      } catch (error) {
        if (!(error instanceof Agent37Error && error.status === 404)) throw error;
      }
    }
    const awake = awakeMicrosPerMinute(BRICK_SHAPE);
    const resting = restingMicrosPerMinute(BRICK_SHAPE);
    return {
      day: bill.day,
      totalMicros: bill.totalMicros,
      instances: bill.instances.map((entry) => {
        const instance = present.get(entry.id);
        const creation = typeof instance?.metadata?.creation_id === 'string' ? instance.metadata.creation_id : null;
        const botId = creation && creation.startsWith('brick:') ? creation.slice('brick:'.length) : null;
        const scratch = creation !== null && creation.startsWith(SCRATCH_PREFIX);
        const kind: 'brick' | 'other' | 'gone' | 'scratch' = !instance ? 'gone' : scratch ? 'scratch' : botId ? 'brick' : 'other';
        const minutes = Math.min(entry.awakeMinutes, 1440);
        return { ref: entry.id, kind, botId, totalMicros: entry.totalMicros, computeMicros: entry.computeMicros, awakeMinutes: entry.awakeMinutes, expectedMicros: Math.round(minutes * awake + (1440 - minutes) * resting) };
      }),
    };
  }

  async maintain(): Promise<void> {
    await ensureImage(this.client);
  }

  /**
   * Puts a machine in order before anything runs on it (for a job and for a restore): its network rule is ours (read back, and set again when it is
   * not), it is moved to the image's current revision when it was made from an older one (its files are kept), and its Agent37 managed budget is read
   * back and must be zero in both parts (`budgetClosed`). A rule or a budget that cannot be put right means the machine is not handed to anything.
   */
  private async settle(ref: string): Promise<Instance> {
    const state = this.image ? await this.image() : null;
    let instance = await this.client.getInstance(ref);
    // Only a rule Agent37 says is already ours is left alone: one it does not say, or another one, is set again (asking again is safe)
    if (instance.network !== BRICK_NETWORK) {
      try {
        await this.client.setNetwork(ref, BRICK_NETWORK);
      } catch {
        throw new Error('The computer is not ready (its network rule could not be set)');
      }
    }
    const behind = state && imageReady(state) && state.revision !== null && typeof instance.template_revision === 'number' && instance.template_revision < state.revision;
    if (behind) {
      await this.client.updateInstance(ref);
      instance = await this.untilHealthy(ref, instance.url);
    }
    await this.budgetClosed(ref);
    return instance;
  }

  /**
   * A machine made ready for a job: put in order (`settle`), then `universe-up` brings the screen, the browser and the local model address up.
   * The first time on a machine it also writes Hermes' config, and Hermes only reads that when it starts: so the machine is stopped and started
   * once, and `universe-up` is run again.
   */
  async ready(ref: string): Promise<void> {
    let instance = await this.settle(ref);
    // A part that was still coming up (a browser right after a machine woke or restarted): `universe-up` is safe to run again, so it is
    // asked once more, after the first ask and after the restart
    const again = async (state: { ready: boolean; restart: boolean; reason: string | null }) => {
      if (state.ready || state.restart) return state;
      await this.pause(5_000);
      return this.up(ref);
    };
    let up = await again(await this.up(ref));
    if (up.restart) {
      await this.client.stopInstance(ref);
      await this.untilDown(ref, true);
      await this.client.startInstance(ref);
      await this.untilHealthy(ref, instance.url);
      up = await again(await this.up(ref));
    }
    if (!up.ready) throw new Error(`The computer is not ready${up.reason ? ` (${up.reason})` : ''}`);
    // Last, once the computer is as it should be and before any job has used it: the note the take-over fence tells the agent's processes by
    // (everything already running is the computer's own, everything started after is the agent's). As root, so the agent cannot write it.
    // Run again on the same boot it keeps the first note. A computer that cannot be marked cannot be fenced, so it is not ready.
    const marked = await this.client.exec(ref, 'universe-mark', { user: 'root', timeoutMs: 30_000 });
    if (!/(^|\n)marked=1\b/.test(marked.stdout)) throw new Error(`The computer could not be marked${/marked=0 reason=([a-z_]+)/.exec(marked.stdout)?.[1] ? ` (${/marked=0 reason=([a-z_]+)/.exec(marked.stdout)?.[1]})` : ''}`);
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

  /**
   * Waits for a machine that is stopping to be stopped or asleep. Throws if it goes away, or does not settle in time. Right after a stop
   * was asked the machine may still say it is running for a moment, so then (`afterStop`) only a stopped or sleeping machine counts.
   */
  private async untilDown(ref: string, afterStop = false): Promise<Instance> {
    const until = this.now() + READY_WITHIN_MS;
    for (;;) {
      const instance = await this.client.getInstance(ref);
      const status = String(instance.status);
      if (gone(status)) return instance;
      if (afterStop ? status === 'stopped' || status === 'sleeping' : status !== 'stopping') return instance;
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

  async removeAllFor(botId: string, opts: { recorded?: boolean } = {}): Promise<void> {
    // A machine that failed to come up is still there at the provider (its disk may be billed and hold files): only one already being deleted is left alone
    const listed = await this.client.listInstances();
    const made = listed.filter((instance) => instance.metadata?.creation_id === creationId(botId) && !['deleting', 'deleted'].includes(String(instance.status)));
    for (const instance of made) await this.remove(instance.id);
    // The listing is the newest machines of the whole account and Agent37 does not say whether it is cut. A Brick whose machine was never written down can
    // only be looked for in it, so a listing as long as one that may be cut does not prove there is none left: the purge stays open and tries again
    // (the team hears of it after five tries). A Brick with a recorded machine had that one removed by its reference; the listing is a second look only.
    if (opts.recorded === false && listed.length >= LISTING_MAY_BE_CUT) throw new Error('The list of machines may be cut short, so a machine that was never written down cannot be ruled out');
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

  async deleteSavedCopy(botId: string): Promise<void> {
    await (this.copies.remove ?? deleteSavedCopy)(botId);
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

  // ---------- Cold storage (lib/computer-cold.ts) ----------

  /**
   * Runs `universe-cold prepack` as root: what the computer holds outside its home folder (changed files, added software) is copied into the home
   * folder so one copy carries it, and the home folder is counted. A computer that holds more outside than can be carried says so (`blocked`) and is
   * not packed away: nothing is thrown away to make a copy fit.
   */
  async prepack(ref: string): Promise<PackInventory> {
    const done = await this.client.exec(ref, 'universe-cold prepack', { user: 'root', timeoutMs: 10 * 60_000 });
    const line = /(^|\n)prepack=(\{[^\n]*\})/.exec(done.stdout)?.[2];
    if (!line) throw new Error(`The computer could not be inventoried (exit ${done.exitCode})`);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line);
    } catch {
      throw new Error('The computer\'s inventory could not be read');
    }
    const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
    const homeFiles = count(data.home_files);
    const homeBytes = count(data.home_bytes);
    const outsideFiles = count(data.outside_files);
    const outsideBytes = count(data.outside_bytes);
    if (homeFiles === null || homeBytes === null || outsideFiles === null || outsideBytes === null) throw new Error('The computer\'s inventory was not whole');
    const packages = Array.isArray(data.packages) ? data.packages.filter((name): name is string => typeof name === 'string' && /^[a-z0-9][a-z0-9+.:-]{0,100}$/.test(name)).slice(0, 500) : [];
    const blocked = typeof data.blocked === 'string' && /^[a-z_]{1,40}$/.test(data.blocked) ? data.blocked : null;
    return { homeFiles, homeBytes, outsideFiles, outsideBytes, packages, blocked };
  }

  /** The home folder as a tar.gz stream. Only for a machine that is awake (the address wakes a sleeper). */
  async streamFiles(ref: string): Promise<ReadableStream<Uint8Array>> {
    const url = await this.urlOf(ref);
    const archive = await this.client.archive(url);
    return archive.body as ReadableStream<Uint8Array>;
  }

  /** A throwaway computer, the same shape and the same way out as a Brick's, for a restore to be proved on. Billed until it is removed: the caller removes it. */
  async makeScratch(): Promise<MachineInfo> {
    if (this.image && !imageReady(await this.image())) throw new ImageNotReady();
    await this.checkFunds();
    const id = randomUUID();
    const made = await this.client.createInstance({
      template: this.template,
      name: `scratch-${id.slice(0, 8)}`,
      region: 'us',
      resources: { cpu: BRICK_SHAPE.cpu, memory: BRICK_SHAPE.memory, disk: BRICK_SHAPE.disk },
      metadata: { creation_id: `${SCRATCH_PREFIX}${id}`, made_at: String(this.now()) },
      budget: { monthly_cap_micros: 0, credit_micros: 0 },
      auto_sleep: true,
      idle_timeout_seconds: 300,
      network: BRICK_NETWORK,
    });
    await this.untilHealthy(made.id, made.url);
    await this.budgetClosed(made.id);
    return { ref: made.id, region: made.region ?? 'us' };
  }

  /**
   * Puts a copy onto a computer and checks it: the machine is put in order first (its rule and its budget), then
   * `universe-cold restore` fetches the copy straight from Orbit, compares its SHA-256, unpacks it and compares every file with the copy, and `universe-cold finish`
   * puts back what was outside the home folder and installs the added software again. Never throws for a copy that does not check out: that is a result.
   */
  async restoreInto(ref: string, source: RestoreSource): Promise<RestoreResult> {
    const started = this.now();
    await this.settle(ref);
    const settings = JSON.stringify({ url: source.url, token: source.token, sha256: source.sha256 });
    const restored = await this.client.exec(ref, `universe-cold restore <<'RESTORE_JSON'\n${settings}\nRESTORE_JSON`, { timeoutMs: 20 * 60_000 });
    if (!/(^|\n)restored=1\b/.test(restored.stdout)) {
      const reason = /restored=0 reason=([a-z_]+)/.exec(restored.stdout)?.[1] ?? `exit_${restored.exitCode}`;
      return { ok: false, reason, ms: this.now() - started };
    }
    const finished = await this.client.exec(ref, 'universe-cold finish', { user: 'root', timeoutMs: 15 * 60_000 });
    if (!/(^|\n)finished=1\b/.test(finished.stdout)) {
      const reason = /finished=0 reason=([a-z_]+)/.exec(finished.stdout)?.[1] ?? `exit_${finished.exitCode}`;
      return { ok: false, reason: `finish_${reason}`, ms: this.now() - started };
    }
    return { ok: true, reason: null, ms: this.now() - started };
  }

  /** Asks again until the provider says the machine is gone and no longer in its list (so no longer billed), for up to two minutes. */
  async confirmRemoved(ref: string): Promise<'gone' | 'still_there'> {
    const until = this.now() + 120_000;
    for (;;) {
      let present: Instance | null = null;
      try {
        present = await this.client.getInstance(ref);
      } catch (error) {
        if (!(error instanceof Agent37Error && error.status === 404)) throw error;
      }
      const listed = present ? (await this.client.listInstances()).some((instance) => instance.id === ref && !gone(String(instance.status))) : false;
      if ((!present || String(present.status) === 'deleted') && !listed) return 'gone';
      if (this.now() >= until) return 'still_there';
      await this.pause(5_000);
    }
  }

  /** Removes throwaway computers a restore proof left behind (an Orbit that stopped half way). Only ours (their metadata says so), only older than the given time. */
  async removeScratches(olderThanMs: number): Promise<number> {
    let removed = 0;
    for (const instance of await this.client.listInstances()) {
      const creation = typeof instance.metadata?.creation_id === 'string' ? instance.metadata.creation_id : '';
      if (!creation.startsWith(SCRATCH_PREFIX) || gone(String(instance.status))) continue;
      const madeAt = Number(instance.metadata?.made_at);
      if (!Number.isFinite(madeAt) || this.now() - madeAt < olderThanMs) continue;
      try {
        await this.client.deleteInstance(instance.id);
        removed++;
      } catch (error) {
        if (!(error instanceof Agent37Error && error.status === 404)) console.error('[Computer] Could not remove a throwaway computer:', error instanceof Error ? error.message : 'unknown');
      }
    }
    return removed;
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
