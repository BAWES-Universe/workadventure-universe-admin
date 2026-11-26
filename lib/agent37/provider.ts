import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { LIST_INLINE_BYTES, LIST_MAX_BYTES, LIST_PIECE_END, LIST_READ_PIECE, LIST_SEND_PIECE, LIST_TRIES, asciiJson, checkOutsideManifest, readOutsideManifest, type OutsideManifest } from '@/lib/computer-outside';
import * as Sentry from '@sentry/nextjs';
import type { Check, ComputerProvider, ExecOptions, ExecResult, MachineInfo, PackInventory, ProviderDay, RestoreResult, RestoreSource, SavedCopy, TurnEvent, TurnInput, WatchSession } from '@/lib/computer-provider';
import { WakeReplaced } from '@/lib/computer-wake-replaced';
import { markCommand, parseMark, type MachineMark } from '@/lib/computer-fence-script';
import { readTurn } from '@/lib/agent37/turn-events';
import { Agent37Client, Agent37Error, Agent37Unreached, TurnNotSent, type Instance, type NetworkPolicy } from '@/lib/agent37/client';
import { BRICK_SHAPE, awakeMicrosPerMinute, dayOfRunningMicros, restingMicrosPerMinute } from '@/lib/agent37/rates';
import { deleteSavedCopy, savedCopyOf, storeSavedCopy, type SavedCopyInfo } from '@/lib/agent37/saved-copies';
import { ensureImage, imageReady, type ImageState } from '@/lib/agent37/image';
import { COLD_CTIME_MARGIN_S, UNIVERSE_COLD } from '@/lib/agent37/image-files';

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
/** Where the current `universe-cold` is put on a machine before a pack-away (a root-only folder the file scan skips, next to the list). */
const COLD_SCRIPT = '/usr/local/share/universe/cold-bin/universe-cold';
/** Prints the seconds left of the margin after the unpack of the image (the change time of the image's two marker files, the earlier of the two); nothing at all when it cannot tell. */
const UNPACK_WAIT_COMMAND = `python3 -c 'import os,time;t=min(os.stat(p).st_ctime for p in ("/usr/local/share/universe/built","/usr/local/share/universe/manual-packages.txt"));print("unpack_wait=%d"%max(0,int(t+${COLD_CTIME_MARGIN_S + 1}-time.time())+1))' 2>/dev/null; true`;
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

/** The statuses that say the machine is running, or on its way to running (billed as awake). Anything outside this list and `ASLEEP_STATUSES` and `gone` is not known. */
const AWAKE_STATUSES = ['running', 'starting', 'restarting', 'updating', 'waking', 'provisioning'];
/**
 * The statuses that say the machine is resting or going down. `stopping` counts: this look is also the proof of a stop, and a start on a machine that is still going down waits it out
 * (`wake`), where a throw would end the person's job. A machine that is not there (404, `deleting`, `deleted`, `failed`) is not running either.
 */
const ASLEEP_STATUSES = ['stopped', 'sleeping', 'stopping'];
const gone = (status: string) => status === 'deleting' || status === 'deleted' || status === 'failed';

/** What reads the boot id (as the normal user; the mark reads the same file). */
const BOOT_ID_COMMAND = 'cat /proc/sys/kernel/random/boot_id';

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
  /** Computers (with the image revision) whose skipped update was already told to Sentry. */
  private readonly skippedUpdate = new Set<string>();

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
  /**
   * Puts a machine in order: its network rule, its image revision and its budget. With `update: false` it is never moved to another image (only the rule and the budget are set): a
   * pack-away must look at the machine as the agent left it, and an image update may replace the disk outside the home folder, or move the build marker so that what was added before it is not seen.
   */
  private async settle(ref: string, options: { update?: boolean | 'unless_outside'; /** Asked right before the image update (it restarts the machine, and can come after minutes of waiting): a start that lost its wake sends nothing (Opus on #1040) */ beforeUpdate?: () => Promise<void>; /** Asked right after the image update returned (the second look, CodeRabbit on #1040) */ afterUpdate?: () => Promise<void> } = {}): Promise<Instance> {
    // The image is only looked up when the machine may be moved to it: a pack-away (`update: false`) needs the rule and the budget, never the image, and is not held up by a lookup that fails
    const state = options.update !== false && this.image ? await this.image() : null;
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
    if (behind && options.update !== false) {
      // A computer that has worked for a Brick may hold files outside its home folder (a tool in /opt, software it installed): the image update replaces the disk outside the home folder and would wipe them. So a computer
      // moved for a job (`unless_outside`) is moved only when it is shown to hold nothing of the kind; one that holds something, or cannot say, stays on its image (told to Sentry) and is
      // moved when it is next made from a copy, which is when its files outside the home folder are put back on a computer of the current image
      if (options.update === 'unless_outside' && !(await this.holdsNothingOutside(ref))) {
        console.error('[Computer] A computer behind the image was not updated: it holds files outside its home folder (or could not say)', { ref, revision: instance.template_revision, image: state.revision });
        // Told to Sentry once for each computer and image revision in this process (every job on the computer asks again, and would say it again)
        const once = `${ref}:${state.revision}`;
        if (!this.skippedUpdate.has(once)) {
          this.skippedUpdate.add(once);
          Sentry.captureMessage('A computer behind the image was not updated: it holds files outside its home folder, or could not say', { level: 'warning', tags: { area: 'computer', step: 'image-update-skipped' }, extra: { ref, revision: instance.template_revision, image: state.revision } });
        }
      } else {
        await options.beforeUpdate?.();
        await this.client.updateInstance(ref);
        await options.afterUpdate?.();
        instance = await this.untilHealthy(ref, instance.url);
      }
    }
    await this.budgetClosed(ref);
    return instance;
  }

  /**
   * True only when the computer itself says it holds nothing outside its home folder that an image update would wipe: no file the image did not have and no added software (`universe-cold outside-check`,
   * the current script sent first, as for a pack-away). Anything else (it holds something, the check could not run, the script could not be sent) is false: nothing is deleted on a guess.
   */
  private async holdsNothingOutside(ref: string): Promise<boolean> {
    try {
      await this.installCold(ref);
      const done = await this.client.exec(ref, `python3 ${COLD_SCRIPT} outside-check`, { user: 'root', timeoutMs: 5 * 60_000 });
      return done.exitCode === 0 && /(^|\n)outside_check=1 any=0\b/.test(done.stdout);
    } catch {
      return false;
    }
  }

  /**
   * A machine made ready for a job: put in order (`settle`), then `universe-up` brings the screen, the browser and the local model address up.
   * The first time on a machine it also writes Hermes' config, and Hermes only reads that when it starts: so the machine is stopped and started
   * once, and `universe-up` is run again.
   */
  async ready(ref: string, options?: { freshBoot?: boolean; stillMine?: () => Promise<boolean> }): Promise<MachineMark | null> {
    // Before EVERY stop or start of the machine in here (each restart waits for the machine to be down between the two, and a start that lost its wake must never send one after the stop that replaced it was proved): the wake is
    // renewed (a fenced beat) and must still be this start's, else nothing is sent (Opus on #1040)
    const owned = async () => {
      if (options?.stillMine && !(await options.stillMine())) throw new WakeReplaced();
    };
    let instance = await this.settle(ref, { update: 'unless_outside', beforeUpdate: owned, afterUpdate: owned });
    // A computer that has worked before and has no mark saved by Orbit may be on a boot that already ran jobs (a machine that slept and woke keeps its boot): it is stopped and started
    // first, so nothing a job started is still running when the mark is taken, and the mark is the first of a boot that no job has used
    // The boot the machine is on now, read before it is stopped: the restart is proved by the mark's boot being another one (a stop that Agent37 turns into a sleep, or a start that resumes the same boot, would leave
    // the mark on the boot the earlier jobs ran on, with a clock reading after what they left running, and the fence would keep it as the computer's own). `null`: not asked for.
    let was: string | null | undefined;
    if (options?.freshBoot) {
      const read = await this.client.exec(ref, BOOT_ID_COMMAND, { timeoutMs: 15_000 }).catch(() => null);
      const seen = read && read.exitCode === 0 ? read.stdout.trim() : '';
      was = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(seen) ? seen : null;
      await owned();
      await this.client.stopInstance(ref);
      await this.untilDown(ref, true);
      await owned();
      await this.client.startInstance(ref);
      // A start that lost its wake while its request was on the way (its sender was paused after the check above) finds out as soon as the request returns: the machine it started is stopped by the caller's cleanup, never left running (CodeRabbit on #1040)
      await owned();
      instance = await this.untilHealthy(ref, instance.url);
    }
    // A part that was still coming up (a browser right after a machine woke or restarted): `universe-up` is safe to run again, so it is
    // asked once more, after the first ask and after the restart
    const again = async (state: { ready: boolean; restart: boolean; reason: string | null }) => {
      if (state.ready || state.restart) return state;
      await this.pause(5_000);
      return this.up(ref);
    };
    let up = await again(await this.up(ref));
    if (up.restart) {
      await owned();
      await this.client.stopInstance(ref);
      await this.untilDown(ref, true);
      await owned();
      await this.client.startInstance(ref);
      await owned();
      await this.untilHealthy(ref, instance.url);
      up = await again(await this.up(ref));
    }
    if (!up.ready) throw new Error(`The computer is not ready${up.reason ? ` (${up.reason})` : ''}`);
    // Last, once the computer is as it should be and before any job has used it: the mark the take-over fence tells the agent's processes by (everything already
    // running is the computer's own, everything started after is the agent's), read here and kept by Orbit, never by the computer: the agent has admin rights there and could
    // rewrite a note. Read as the normal user (root cannot read what the agent's processes are). A computer that cannot be marked cannot be fenced, so it is not ready.
    // A computer is handed over only once the margin after the unpack of its image has passed (a file the agent copies with its old modification time kept is told from the image's own files by its
    // change time, and that cannot be told inside the margin): a brand-new computer waits the few seconds that are left, any other none
    await this.untilUnpackMargin(ref);
    const done = await this.client.exec(ref, markCommand(), { timeoutMs: 30_000 });
    const mark = done.exitCode === 0 ? parseMark(done.stdout) : null;
    if (!mark) {
      const reason = /marked=0 reason=([a-z_]+)/.exec(done.stdout)?.[1];
      throw new Error(`The computer could not be marked${reason ? ` (${reason})` : ''}`);
    }
    // A fresh boot that is not proved (the old boot could not be read, or the mark is of the same one): the computer is ready for its job, but this mark is not to be trusted, because the boot it names
    // may be the one earlier jobs ran on, with a clock reading taken after what they left running. So NO mark is answered (Orbit saves none and the row stays unmarked): a take-over on this computer finds
    // no mark, cannot prove the fence, and stops the machine; the next wake asks for the fresh boot again. The job is never refused for it. Told to Sentry, with both boot ids and the machine, so it is seen.
    if (was !== undefined && (was === null || mark.bootId === was)) {
      const message = was === null ? 'A computer could not be proved to have started afresh: its boot before the restart was not read' : 'A computer could not be proved to have started afresh: its boot did not change';
      console.error('[Computer]', message, { ref, before: was, after: mark.bootId });
      Sentry.captureMessage(message, { level: 'error', tags: { area: 'computer', step: 'fresh-boot' }, extra: { ref, before: was, after: mark.bootId } });
      return null;
    }
    return mark;
  }

  /**
   * Waits until `COLD_CTIME_MARGIN_S` (and a second) after the end of the image's unpack on this computer: the change time of the two marker files the image marks itself with, the earlier of the two,
   * read on the computer itself. The computer says how many seconds are left (0 for any computer that is not new); a computer that cannot say is not waited for (the pack-away then cannot tell the
   * agent's first copies, which is all it costs).
   */
  private async untilUnpackMargin(ref: string): Promise<void> {
    try {
      const done = await this.client.exec(ref, UNPACK_WAIT_COMMAND, { user: 'root', timeoutMs: 30_000 });
      const seconds = Number(/(^|\n)unpack_wait=(\d+)\b/.exec(done.stdout)?.[2] ?? 0);
      if (seconds > 0 && seconds <= COLD_CTIME_MARGIN_S + 5) await this.pause(seconds * 1000);
    } catch (error) {
      console.error('[Computer] Could not tell how long ago the image was unpacked:', error instanceof Error ? error.message : error);
    }
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

  async wake(ref: string, options?: { stillMine?: () => Promise<boolean> }): Promise<void> {
    let instance = await this.client.getInstance(ref);
    // A machine that is still going down cannot be started yet: wait for it to be down (or asleep), then wake it as any other
    if (instance.status === 'stopping') instance = await this.untilDown(ref);
    const status = String(instance.status);
    if (gone(status)) throw new Error(`The computer is ${status}`);
    if (status === 'sleeping' || status === 'stopped') {
      await this.checkFunds();
      // After the waits above (a machine going down, the billing call): a start that lost its wake in the meantime sends nothing (Opus on #1040)
      if (options?.stillMine && !(await options.stillMine())) throw new WakeReplaced();
      await this.client.startInstance(ref);
      // Asked again as soon as the request returns: a start whose sender was paused after the check above, and whose wake was given up on meanwhile, is told so now and its caller stops the machine it started (CodeRabbit on #1040)
      if (options?.stillMine && !(await options.stillMine())) throw new WakeReplaced();
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
      await this.client.sleepInstance(ref, 'refused');
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
    // A power operation of ours: not repeated after a gateway answer that may have reached the machine (the readiness restarts above keep the retry: they run under a wake's own ticket)
    await this.client.stopInstance(ref, 'refused');
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

  async removeAllFor(botId: string): Promise<void> {
    // A machine that failed to come up is still there at the provider (its disk may be billed and hold files): only one already being deleted is left alone.
    // `listInstances` is the whole account in one answer (Agent37 has no pages: checked on 18 Nov, and an answer that says more is to come is refused there),
    // so a machine of this Brick that was never written down is found here too
    const listed = await this.client.listInstances();
    const made = listed.filter((instance) => instance.metadata?.creation_id === creationId(botId) && !['deleting', 'deleted'].includes(String(instance.status)));
    for (const instance of made) await this.remove(instance.id);
  }

  async awake(ref: string): Promise<boolean> {
    return this.awakeFrom(() => this.client.getInstance(ref));
  }

  async awakeOnce(ref: string, timeoutMs: number): Promise<boolean> {
    return this.awakeFrom(() => this.client.getInstanceOnce(ref, timeoutMs));
  }

  private async awakeFrom(look: () => Promise<Instance>): Promise<boolean> {
    try {
      const status = String((await look()).status);
      if (AWAKE_STATUSES.includes(status)) return true;
      if (ASLEEP_STATUSES.includes(status) || gone(status)) return false;
      // Every status Agent37 documents is classified above, so a word here is one it never documented: it says nothing about whether the machine runs. It is "not known", which
      // never pauses a billed job, never moves a proof of awake and never proves a stop (the callers treat a throw so). Said out loud, so the list is looked at
      Sentry.captureMessage('Agent37 said a machine status that is not in the list', { level: 'warning', tags: { area: 'computer', step: 'awake-status' }, extra: { status: status.slice(0, 40) } });
      throw new Agent37Unreached(`status ${status.slice(0, 40)}`);
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
   * not packed away: nothing is thrown away to make a copy fit. The machine is settled for its network rule and budget only and NEVER moved to another image (an update may replace the disk
   * outside the home folder, or move the build marker so that what was added before it is left out of the list). A computer made from an older image has an older `universe-cold` that prints no list,
   * so Orbit sends the current script to it (`installCold`) and runs that one.
   */
  async prepack(ref: string): Promise<PackInventory> {
    const unpacked = (blocked: string): PackInventory => ({ homeFiles: 0, homeBytes: 0, outsideFiles: 0, outsideBytes: 0, packages: [], blocked, outside: null });
    await this.settle(ref, { update: false });
    await this.installCold(ref);
    const done = await this.client.exec(ref, `python3 ${COLD_SCRIPT} prepack`, { user: 'root', timeoutMs: 10 * 60_000 });
    // Agent37 cuts the middle out of what a command prints over 512 KB: what is left of it is never read as an inventory. The script prints one short line (the list itself is
    // read back below, in pieces), so this is a computer that says far more than it should, and it is said so (`blocked`), never guessed from what is left
    const line = /(^|\n)prepack=(\{[^\n]*\})/.exec(done.stdout)?.[2];
    if (!line) {
      if (done.truncated) return unpacked('inventory_output_too_long');
      throw new Error(`The computer could not be inventoried (exit ${done.exitCode})`);
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line);
    } catch {
      if (done.truncated) return unpacked('inventory_output_too_long');
      throw new Error('The computer\'s inventory could not be read');
    }
    const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
    const homeFiles = count(data.home_files);
    const homeBytes = count(data.home_bytes);
    const outsideFiles = count(data.outside_files);
    const outsideBytes = count(data.outside_bytes);
    if (homeFiles === null || homeBytes === null || outsideFiles === null || outsideBytes === null) throw new Error('The computer\'s inventory was not whole');
    const packages = Array.isArray(data.packages) ? data.packages.filter((name): name is string => typeof name === 'string' && /^[a-z0-9][a-z0-9+.:-]{0,100}$/.test(name)).slice(0, 500) : [];
    const blocked = typeof data.blocked === 'string' && /^[a-z0-9_]{1,40}$/.test(data.blocked) ? data.blocked : null;
    const counted = { homeFiles, homeBytes, outsideFiles, outsideBytes, packages };
    if (blocked !== null) return { ...counted, blocked, outside: null };
    // The list of what was copied: required whenever the computer can be packed (a copy with no list would put nothing back), and read to the last field
    let list: unknown = data.manifest;
    if (list === undefined || list === null) {
      const bytes = count(data.manifest_bytes);
      const sha = typeof data.manifest_sha256 === 'string' && /^[0-9a-f]{64}$/.test(data.manifest_sha256) ? data.manifest_sha256 : null;
      if (bytes === null || bytes < 2 || sha === null) throw new Error('The computer\'s list of what is outside its home folder was not whole');
      if (bytes > LIST_MAX_BYTES) return { ...counted, blocked: 'outside_list_too_big', outside: null };
      list = await this.readList(ref, bytes, sha);
    }
    const checked = checkOutsideManifest(list);
    // A computer that holds more than a list can carry, or a name a list cannot keep, is one that cannot be packed away yet: a result, not a failure
    if (!checked.ok && checked.reason !== 'invalid') return { ...counted, blocked: checked.reason, outside: null };
    if (!checked.ok) throw new Error('The computer\'s list of what is outside its home folder was not whole');
    return { ...counted, blocked: null, outside: checked.manifest };
  }

  /**
   * Puts the current `universe-cold` on the machine, at `COLD_SCRIPT` (a root-only folder the scan skips, so it never lands in a copy), whatever image the machine was made from. It is sent as
   * base64 (no piece can gain a line break) in pieces of at most `LIST_SEND_PIECE` bytes, each its own named command; the first makes the file new, the others append. Then the machine's own
   * `sha256sum` of it is compared with Orbit's, and only on a match is it moved into place. A try that fails in any step starts again from the first piece, up to `LIST_TRIES` times, then it is an
   * error (the pack-away is tried again later). Nothing runs from a file that was not checked.
   */
  private async installCold(ref: string): Promise<void> {
    const text = Buffer.from(UNIVERSE_COLD, 'utf8');
    const sha = createHash('sha256').update(text).digest('hex');
    const dir = COLD_SCRIPT.slice(0, COLD_SCRIPT.lastIndexOf('/'));
    // Already there, whole: nothing is sent again (a computer that stays behind the image is asked more than once). The file and its folder are root's and closed to the agent, so what is read here is what runs;
    // a computer that cannot say, or says another sum, is sent the script as before
    try {
      const there = await this.client.exec(ref, `sha256sum ${COLD_SCRIPT}`, { user: 'root', timeoutMs: 30_000 });
      if (there.exitCode === 0 && !there.truncated && /^([0-9a-f]{64})\s/.exec(there.stdout)?.[1] === sha) return;
    } catch {
      // asked again below, by sending it
    }
    let last: unknown = null;
    for (let attempt = 0; attempt < LIST_TRIES; attempt++) {
      if (attempt > 0) await this.pause(1_000);
      const transfer = randomUUID().slice(0, 8);
      const run = (command: string, name: string) => this.client.exec(ref, command, { user: 'root', timeoutMs: 60_000, name: `cold-install:${transfer}:${name}` });
      try {
        for (let at = 0; at < text.length; at += LIST_SEND_PIECE) {
          const piece = text.subarray(at, at + LIST_SEND_PIECE).toString('base64');
          const write = at === 0
            ? `umask 077 && mkdir -p ${dir} && chown root:root ${dir} && chmod 755 ${dir} && printf %s '${piece}' | base64 -d > ${COLD_SCRIPT}.new`
            : `umask 077 && printf %s '${piece}' | base64 -d >> ${COLD_SCRIPT}.new`;
          const put = await run(write, String(at));
          if (put.exitCode !== 0 || put.truncated) throw new Error('The computer could not take the current script');
        }
        const summed = await run(`sha256sum ${COLD_SCRIPT}.new`, 'sum');
        if (summed.exitCode !== 0 || summed.truncated || /^([0-9a-f]{64})\s/.exec(summed.stdout)?.[1] !== sha) throw new Error('The current script did not arrive whole on the computer');
        const moved = await run(`chmod 644 ${COLD_SCRIPT}.new && mv -f ${COLD_SCRIPT}.new ${COLD_SCRIPT}`, 'move');
        if (moved.exitCode !== 0 || moved.truncated) throw new Error('The computer could not put the current script in place');
        return;
      } catch (error) {
        last = error;
      }
    }
    throw last;
  }

  /**
   * The list `prepack` wrote on the computer (a root-only file), read back in pieces of at most `LIST_READ_PIECE` characters, each its own answer well under Agent37's cap.
   * Every piece must be exactly as long as asked and the whole must have the length and SHA-256 the computer printed: a piece that is short, cut or changed is an error (the pack-away
   * is tried again), never a shorter list.
   */
  private async readList(ref: string, bytes: number, sha256: string): Promise<unknown> {
    const whole = () => new Error('The computer\'s list of what is outside its home folder could not be read');
    const transfer = randomUUID().slice(0, 8);
    let text = '';
    while (text.length < bytes) {
      const want = Math.min(LIST_READ_PIECE, bytes - text.length);
      text += await this.readPiece(ref, transfer, text.length, want);
    }
    if (createHash('sha256').update(text, 'latin1').digest('hex') !== sha256) throw whole();
    try {
      return JSON.parse(text);
    } catch {
      throw whole();
    }
  }

  /**
   * One piece of the list. Reading changes nothing, so a piece that failed is asked again, up to `LIST_TRIES` times, each ask under a name of its own (so Agent37 runs it again). The client itself
   * repeats a command under the same name only for an answer that says "try again" (429, 502, 503, 504), and Agent37 then returns the first answer instead of running it twice. A timeout, a lost
   * answer (Agent37 not reached), or a short, cut or failed answer is handled here, by the ask under a new name.
   */
  private async readPiece(ref: string, transfer: string, at: number, want: number): Promise<string> {
    let last: unknown = null;
    for (let attempt = 0; attempt < LIST_TRIES; attempt++) {
      if (attempt > 0) await this.pause(1_000);
      try {
        const got = await this.client.exec(ref, `python3 ${COLD_SCRIPT} list-piece ${at} ${want}`, { user: 'root', timeoutMs: 60_000, name: `cold-read:${transfer}:${at}:${attempt}` });
        const marked = got.exitCode === 0 && !got.truncated ? new RegExp(`(?:^|\\n)listpiece=([^\\n]*)${LIST_PIECE_END.replace(/[|]/g, '\\|')}(?:\\n|$)`).exec(got.stdout)?.[1] : undefined;
        // Exactly as long as asked AND plain printable ASCII (the list is ASCII): the hash is taken over the characters as bytes, so a different character of the same length must not pass
        if (marked !== undefined && marked.length === want && /^[\x20-\x7e]*$/.test(marked)) return marked;
        last = new Error('The computer\'s list of what is outside its home folder could not be read');
      } catch (error) {
        last = error;
      }
    }
    throw last;
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
   * `universe-cold restore` fetches the copy straight from Orbit, compares its SHA-256, unpacks it and compares every file with the copy, and the CURRENT script's `finish` (sent first, as for a pack-away)
   * puts back what was outside the home folder and installs the added software again. Never throws for a copy that does not check out: that is a result.
   */
  async restoreInto(ref: string, source: RestoreSource): Promise<RestoreResult> {
    const started = this.now();
    await this.settle(ref);
    // Every command of a restore runs from the CURRENT script, sent here and checked as for a pack-away, never from the one the machine was made with (an older `finish` ignores the list and copies what the agent
    // left in the home folder, an older `restore` leaves the old proxy lines, an older script has no `list-put`). The folder it is put in can be read by the computer's own user, which `restore` runs as.
    // A script that could not be put there says nothing about the copy: that is thrown, not a copy that did not check out
    await this.installCold(ref);
    const settings = JSON.stringify({ url: source.url, token: source.token, sha256: source.sha256 });
    const restored = await this.client.exec(ref, `python3 ${COLD_SCRIPT} restore <<'RESTORE_JSON'\n${settings}\nRESTORE_JSON`, { timeoutMs: 20 * 60_000 });
    if (!/(^|\n)restored=1\b/.test(restored.stdout)) {
      const reason = /restored=0 reason=([a-z0-9_]+)/.exec(restored.stdout)?.[1] ?? `exit_${restored.exitCode}`;
      return { ok: false, reason, ms: this.now() - started };
    }
    // The list of what prepack copied goes to finish from here, never from the home folder (null for a copy that has none: finish then puts nothing back outside the home folder)
    const outside = readOutsideManifest(source.outside);
    let finishInput = JSON.stringify({ outside });
    // A list that does not fit one command (Linux caps one argument near 128 KiB, and a list of thousands of files is hundreds of KB) is written to a root-only file on the computer
    // in pieces, each its own command, and `finish` reads that file (checking its length and SHA-256); a short list goes as it always did
    if (outside !== null && Buffer.byteLength(finishInput) > LIST_INLINE_BYTES) {
      const sent = await this.sendList(ref, outside);
      if (!sent) return { ok: false, reason: 'finish_outside_transfer', ms: this.now() - started };
      finishInput = JSON.stringify({ outside_file: sent });
    }
    const finished = await this.client.exec(ref, `python3 ${COLD_SCRIPT} finish <<'FINISH_JSON'\n${finishInput}\nFINISH_JSON`, { user: 'root', timeoutMs: 15 * 60_000 });
    if (!/(^|\n)finished=1\b/.test(finished.stdout)) {
      const reason = /finished=0 reason=([a-z0-9_]+)/.exec(finished.stdout)?.[1] ?? `exit_${finished.exitCode}`;
      return { ok: false, reason: `finish_${reason}`, ms: this.now() - started };
    }
    // The script says which it did: put the list back (applied) or, for a copy with no list, nothing outside the home folder (unverified). Neither word, or the wrong one for what was sent,
    // is a script that did not do what was sent to it, and a restore is never called good on that
    const done = /(^|\n)finished=1\b[^\n]*\boutside=(applied|unverified)\b/.exec(finished.stdout)?.[2];
    if (done !== (outside === null ? 'unverified' : 'applied')) return { ok: false, reason: 'finish_outside_not_confirmed', ms: this.now() - started };
    if (done === 'unverified') {
      console.error('[Computer] A copy with no list of what was outside its home folder was restored: nothing outside the home folder was put back');
      return { ok: true, reason: null, ms: this.now() - started, outside: 'unverified' };
    }
    return { ok: true, reason: null, ms: this.now() - started };
  }

  /**
   * Sends a list to the computer in pieces of at most `LIST_SEND_PIECE` characters (plain ASCII, so the cut is never inside a character). Null when a piece was not taken exactly as sent, after
   * the whole send was started again from the first piece up to `LIST_TRIES` times, each try under a new transfer id. Every piece has a name of its own, so the client's repeat of a command after
   * an answer of "try again" (429, 502, 503, 504) returns the first answer instead of running it twice; a timeout or a lost answer (Agent37 not reached) is not repeated by the client and ends the
   * try, and the next try starts from offset 0. A late piece of an earlier try can still arrive after a new try began: it is refused when it is not at the end of the file (`out_of_order`), and
   * whatever lands, `finish` checks the file's length and SHA-256 and refuses it otherwise. A failure that is not a refusal on every try is thrown, as for any other command on the computer.
   */
  private async sendList(ref: string, outside: OutsideManifest): Promise<{ bytes: number; sha256: string } | null> {
    const text = asciiJson(outside);
    if (text.length > LIST_MAX_BYTES) return null;
    let last: unknown = null;
    for (let attempt = 0; attempt < LIST_TRIES; attempt++) {
      if (attempt > 0) await this.pause(1_000);
      try {
        if (await this.sendListOnce(ref, text, randomUUID().slice(0, 8))) return { bytes: text.length, sha256: createHash('sha256').update(text, 'latin1').digest('hex') };
        last = null;
      } catch (error) {
        last = error;
      }
    }
    if (last !== null) throw last;
    return null;
  }

  private async sendListOnce(ref: string, text: string, transfer: string): Promise<boolean> {
    // A line of its own that no piece can contain (a piece is one line cut from a list, and this has a random part)
    const end = `LIST_${randomBytes(12).toString('hex')}`;
    for (let at = 0; at < text.length; at += LIST_SEND_PIECE) {
      const piece = text.slice(at, at + LIST_SEND_PIECE);
      const put = await this.client.exec(ref, `python3 ${COLD_SCRIPT} list-put ${at} <<'${end}'\n${piece}\n${end}`, { user: 'root', timeoutMs: 60_000, name: `cold-put:${transfer}:${at}` });
      if (put.exitCode !== 0 || put.truncated || !new RegExp(`(^|\\n)listput=1 size=${at + piece.length}(\\n|$)`).test(put.stdout)) return false;
    }
    return true;
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
    // Finding the machine comes before any request to the agent: a failure of it is a turn that was never sent
    let url: string;
    try {
      url = await this.urlOf(ref);
    } catch (error) {
      throw new TurnNotSent(error instanceof Error ? error.message : 'The computer could not be found');
    }
    const response = await this.client.openTurn(url, input, signal);
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
