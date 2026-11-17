import { randomUUID } from 'node:crypto';
import type { Check, ComputerProvider, ExecOptions, ExecResult, MachineInfo, PackInventory, ProviderDay, RestoreResult, RestoreSource, SavedCopy, TurnEvent, TurnInput, WatchSession } from '@/lib/computer-provider';
import { applyCommand, egressConfig, egressProblem, hostsBlockNames, networkFor, sameNetwork, type EgressConfig } from '@/lib/egress/config';
import { readTurn } from '@/lib/agent37/turn-events';
import { Agent37Client, Agent37Error, Agent37Unreached, type Instance } from '@/lib/agent37/client';
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
 * What a Brick's computer may reach: ONLY Universe's egress gateways (lib/egress). Its Agent37 network rule is an allow list of the gateways'
 * addresses and nothing else, so a program that ignores the proxy settings has no internet at all, and no program can go around the gateway:
 * Agent37 enforces the rule outside the machine. The gateways let the whole public internet through (any port, names and raw addresses, plain
 * and encrypted, WebSocket) and refuse only what is already agreed: Composio, Agent37's own API and the Universe AI providers by name (stop
 * bypassing the metered services), and private, metadata and internal addresses (lib/egress/gateway.ts). A gateway outage never opens a
 * direct route. The design and its price are PROPOSED, pending verification on a real instance (egress-gateway/README.md lists what is to be
 * measured). Which Agent37 product the machines run on is recorded in the readiness page's "internet gateway" line. The rule is written on
 * every machine at creation and checked, and put right, each time one is made ready. With no gateway set up (EGRESS_GATEWAYS and
 * EGRESS_GATEWAY_SECRET) NO computer is made and none is made ready: the rule is never left open ("fails closed").
 */
export class EgressNotSetUp extends Error {
  constructor(message = 'The computers\' internet gateway is not set up') {
    super(message);
    this.name = 'EgressNotSetUp';
  }
}

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
  /** The egress gateways (default: from the environment). Without any, nothing is made and nothing is made ready. */
  egress?: () => EgressConfig | null;
  /** The names of the Universe AI providers, for the hosts file's extra layer. A list that cannot be had is left out: the gateway is what refuses them. */
  providerNames?: () => Promise<string[]>;
}

const creationId = (botId: string) => `brick:${botId}`;
/** A throwaway computer made to prove a restore carries this in its metadata, so the daily check knows it and a sweep can remove one that was left behind. */
export const SCRATCH_PREFIX = 'scratch:';
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
  private readonly egress: () => EgressConfig | null;
  private readonly providerNames: () => Promise<string[]>;
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
    this.egress = options.egress ?? (() => egressConfig());
    this.providerNames = options.providerNames ?? (async () => (await import('@/lib/egress/deny-list')).deniedProviderNames());
  }

  /** The gateways, or the refusal to go on without them: a computer is never made or made ready with its way out open. */
  private egressOrThrow(): EgressConfig {
    const config = this.egress();
    if (!config) throw new EgressNotSetUp(`The computers' internet gateway is not set up (${egressProblem() ?? 'no gateway'})`);
    return config;
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
    const config = this.egress();
    checks.push(config ? { name: 'internet gateway', ok: true, detail: `Computers reach the open internet through ${config.gateways.length} gateway${config.gateways.length === 1 ? '' : 's'} (the metered services are refused there); the design and its price are proposed, pending verification on a real Agent37 instance` } : { name: 'internet gateway', ok: false, detail: `No computer can start: the internet gateway is not set up (${egressProblem() ?? 'no gateway'})` });
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
    // The way out is the gateway or nothing: no gateway, no machine
    const egress = this.egressOrThrow();
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
        network: networkFor(egress),
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
   * Puts a machine's way out in order, before anything runs on it (for a job and for a restore): its network rule is the gateway allow list
   * (read back, and set again when it is not exactly that), it is moved to the image's current revision when it was made from an older one (its
   * files are kept; the gateway's scripts are in the image), and this machine's gateway key and settings are written. No gateway set up, a rule
   * that cannot be set, or settings that cannot be written means the machine is not handed to anything. Returns whether the rule had to be changed
   * (Agent37 carries a changed rule to the machine within two minutes, so the proof that nothing goes out direct then waits for it).
   */
  private async secure(ref: string): Promise<{ instance: Instance; ruleChanged: boolean }> {
    const egress = this.egressOrThrow();
    const state = this.image ? await this.image() : null;
    let instance = await this.client.getInstance(ref);
    let ruleChanged = false;
    const wanted = networkFor(egress);
    if (!sameNetwork(instance.network, wanted)) {
      try {
        await this.client.setNetwork(ref, wanted);
      } catch {
        throw new Error('The computer is not ready (its network rule could not be set)');
      }
      ruleChanged = true;
    }
    const behind = state && imageReady(state) && state.revision !== null && typeof instance.template_revision === 'number' && instance.template_revision < state.revision;
    if (behind) {
      await this.client.updateInstance(ref);
      instance = await this.untilHealthy(ref, instance.url);
    }
    // The gateway's address and this machine's key go onto it, as root, so the agent cannot change them; the hosts file gets the names as an extra layer
    const names = hostsBlockNames(await this.providerNames().catch(() => []));
    const applied = await this.client.exec(ref, applyCommand(egress, ref, names, this.now()), { user: 'root', timeoutMs: 60_000 });
    if (!/(^|\n)egress=1\b/.test(applied.stdout)) {
      const reason = /egress=0 reason=([a-z_]+)/.exec(applied.stdout)?.[1];
      throw new Error(`The computer is not ready (its gateway settings could not be put in place${reason ? `: ${reason}` : ''})`);
    }
    return { instance, ruleChanged };
  }

  /** Proves the way out is the gateway and only the gateway: it answers with this machine's key, and a direct connection gets nowhere. A rule just changed may take two minutes to arrive, so only then is "direct" waited on. */
  private async proveEgress(ref: string, waitForRule: boolean): Promise<void> {
    const until = this.now() + (waitForRule ? 150_000 : 0);
    for (;;) {
      const done = await this.client.exec(ref, 'universe-egress check', { timeoutMs: 60_000 });
      if (/(^|\n)egress=1\b/.test(done.stdout)) return;
      const reason = /egress=0 reason=([a-z_]+)/.exec(done.stdout)?.[1] ?? `exit ${done.exitCode}`;
      if (reason !== 'direct_reachable' || this.now() >= until) throw new Error(`The computer is not ready (its way out is not only the gateway: ${reason})`);
      await this.pause(10_000);
    }
  }

  /**
   * A machine made ready for a job: its way out put in order (`secure`), then `universe-up` brings the screen, the browser and the local model
   * address up. The first time on a machine it also writes Hermes' config, and Hermes only reads that when it starts: so the machine is
   * stopped and started once, and `universe-up` is run again. Last, the way out is proved to be the gateway and nothing else.
   */
  async ready(ref: string): Promise<void> {
    const { instance: secured, ruleChanged } = await this.secure(ref);
    let instance = secured;
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
      // The restart cleared what is written under /run and not what is on the disk; the gateway key is on the disk, and the forwarder starts with `universe-up`
      up = await again(await this.up(ref));
    }
    if (!up.ready) throw new Error(`The computer is not ready${up.reason ? ` (${up.reason})` : ''}`);
    await this.proveEgress(ref, ruleChanged);
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

  async removeAllFor(botId: string): Promise<void> {
    const made = (await this.client.listInstances()).filter((instance) => instance.metadata?.creation_id === creationId(botId) && !gone(String(instance.status)));
    for (const instance of made) await this.remove(instance.id);
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
    const egress = this.egressOrThrow();
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
      network: networkFor(egress),
    });
    await this.untilHealthy(made.id, made.url);
    return { ref: made.id, region: made.region ?? 'us' };
  }

  /**
   * Puts a copy onto a computer and checks it: the gateway's settings first (the copy comes from Orbit through the gateway), then
   * `universe-cold restore` fetches the copy, compares its SHA-256, unpacks it and compares every file with the copy, and `universe-cold finish`
   * puts back what was outside the home folder and installs the added software again. Never throws for a copy that does not check out: that is a result.
   */
  async restoreInto(ref: string, source: RestoreSource): Promise<RestoreResult> {
    const started = this.now();
    await this.secure(ref);
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
