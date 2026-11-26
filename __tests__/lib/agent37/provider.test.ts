import { createHash } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { Agent37Error, Agent37Unreached, type Agent37Client, type Instance } from '@/lib/agent37/client';
import type { ExecOptions } from '@/lib/computer-provider';
import { WakeReplaced } from '@/lib/computer-wake-replaced';
import { UNIVERSE_COLD } from '@/lib/agent37/image-files';
import { asciiJson, LIST_SEND_PIECE } from '@/lib/computer-outside';
import { Agent37ComputerProvider, Agent37FundsLow, BRICK_NETWORK, DESKTOP_PORT, ImageNotReady } from '@/lib/agent37/provider';
import type { ImageState } from '@/lib/agent37/image';
import { isMarkCommand } from '@/lib/computer-fence-script';
import { awakeMicrosPerMinute, dayOfRunningMicros, BRICK_SHAPE } from '@/lib/agent37/rates';

jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));
jest.mock('@/lib/agent37/saved-copies', () => ({ savedCopyOf: jest.fn(), storeSavedCopy: jest.fn() }));

const BOOT = '3f2b6c1e-8a44-4d0b-9c15-5e7d2a9b1c33';
/** What a command is, in a word: the mark command carries a whole script. */
const labelled = (command: string) => (isMarkCommand(command) ? 'mark' : command);

/** A pretend Agent37: instances that keep a status, and a record of every call. */
const COLD_PATH = '/usr/local/share/universe/cold-bin/universe-cold';
const COLD_RUN = `python3 ${COLD_PATH}`;
const COLD_MOVE = `chmod 644 ${COLD_PATH}.new && mv -f ${COLD_PATH}.new ${COLD_PATH}`;
const FINISH = `python3 ${COLD_PATH} finish`;
/** The size a list-put command leaves on the computer (its offset plus the piece it carries). */
const asPutSize = (command: string) => {
  const found = /list-put (\d+) <<'(LIST_[0-9a-f]{24})'\n([^\n]*)\n\2$/.exec(command)!;
  return Number(found[1]) + found[3].length;
};
const LISTPUT = `python3 ${COLD_PATH} list-put`;
const COLD_PREPACK = `python3 ${COLD_PATH} prepack`;
const COLD_SHA = createHash('sha256').update(UNIVERSE_COLD).digest('hex');

function world(options: { balanceUsd?: number; pastDue?: boolean } = {}) {
  const instances = new Map<string, Instance>();
  const calls: string[] = [];
  /** How each stop and sleep asked to be repeated (the second argument the provider gave). */
  const retries: string[] = [];
  const execs: Array<{ id: string; command: string; options: unknown }> = [];
  let healthy = true;
  let coldSum: string | null = COLD_SHA;
  let coldInstall = true;
  /** The sum of the script already in place on the computer (null: none there). */
  let coldInPlace: string | null = null;
  let execOut: (command: string) => string | { stdout: string; exitCode?: number; truncated?: boolean } = () => 'ok';
  let markOut = `boot=${BOOT}\nticks=1234\npart=77:500:p\nrunner=${'a'.repeat(64)}\nmarked=1\n`;
  const revisionAfterUpdate = 2;
  /** What Agent37 holds as each machine's managed budget: the monthly cap and the remaining one-time credit (a machine not here has both at zero). */
  const budgets = new Map<string, { cap: number; credit: number }>();
  const refuse: Record<string, Error | undefined> = {};
  const client = {
    async listInstances() {
      calls.push('list');
      return [...instances.values()];
    },
    /** The one look at the whole account (one request, never asked again): a test makes it fail with `refuse.listOnce`. */
    async listInstancesOnce(timeoutMs: number) {
      calls.push(`listOnce:${timeoutMs}`);
      if (refuse.listOnce) throw refuse.listOnce;
      return [...instances.values()];
    },
    async createInstance(input: { metadata?: Record<string, string>; budget?: unknown; env?: unknown; auto_sleep?: boolean; network?: unknown }) {
      calls.push('create');
      if (refuse.create) {
        const error = refuse.create;
        refuse.create = undefined;
        // A lost answer after the machine WAS made
        if (error instanceof Agent37Unreached) instances.set('made1', { id: 'made1', status: 'running', url: 'https://made1.agent37.app', metadata: input.metadata, region: 'us' });
        throw error;
      }
      const instance = { id: `m${instances.size + 1}`, status: 'running', url: `https://m${instances.size + 1}.agent37.app`, metadata: input.metadata, region: 'us' } as Instance;
      instances.set(instance.id, instance);
      created.push(input);
      return instance;
    },
    async getInstance(id: string) {
      calls.push(`get:${id}`);
      const found = instances.get(id);
      if (!found) throw new Agent37Error(404, 'not_found', 'gone');
      return found;
    },
    async getInstanceOnce(id: string, timeoutMs: number) {
      calls.push(`getOnce:${id}:${timeoutMs}`);
      const found = instances.get(id);
      if (!found) throw new Agent37Error(404, 'not_found', 'gone');
      return found;
    },
    async startInstance(id: string) {
      calls.push(`start:${id}`);
      instances.get(id)!.status = 'running';
      return { id, status: 'running' };
    },
    async sleepInstance(id: string, retry?: string) {
      calls.push(`sleep:${id}`);
      retries.push(`sleep:${retry ?? 'any'}`);
      instances.get(id)!.status = 'sleeping';
      instances.get(id)!.slept_at = Math.floor(Date.now() / 1000);
      return { id, status: 'sleeping' };
    },
    async stopInstance(id: string, retry?: string) {
      calls.push(`stop:${id}`);
      retries.push(`stop:${retry ?? 'any'}`);
      instances.get(id)!.status = 'stopped';
      return { id, status: 'stopped' };
    },
    async deleteInstance(id: string) {
      calls.push(`delete:${id}`);
      if (!instances.has(id)) throw new Agent37Error(404, 'not_found', 'gone');
      instances.delete(id);
      return { id, deleted: true };
    },
    async signedUrl(id: string, port: number, ttl: number) {
      calls.push(`signed:${id}:${port}:${ttl}`);
      return { url: `https://${id}.agent37.app/?a37_token=t` };
    },
    async billing() {
      calls.push('billing');
      return { balance_usd: options.balanceUsd ?? 5, past_due: options.pastDue ?? false };
    },
    async healthy() {
      calls.push('health');
      return healthy;
    },
    async exec(id: string, command: string, options?: unknown) {
      calls.push(`exec:${id}:${command}`);
      execs.push({ id, command, options });
      // Putting the current script on the machine (before a pack-away) is answered here unless a test says otherwise
      const answer = command === `sha256sum ${COLD_PATH}` ? (coldInPlace === null ? { stdout: '', exitCode: 1 } : { stdout: `${coldInPlace}  ${COLD_PATH}\n` }) : isMarkCommand(command) ? markOut : /^sha256sum /.test(command) && coldSum !== null ? { stdout: `${coldSum}  ${COLD_PATH}.new\n` } : /^(umask 077 && |chmod 644 )/.test(command) && coldInstall ? { stdout: '' } : execOut(command);
      return typeof answer === 'string' ? { exitCode: 0, stdout: answer, stderr: '', truncated: false } : { exitCode: answer.exitCode ?? 0, stdout: answer.stdout, stderr: '', truncated: answer.truncated ?? false };
    },
    async openTurn(url: string, input: { text: string; sessionId?: string | null }) {
      calls.push(`turn:${url}:${input.text}`);
      return new Response(`event: response.created\ndata: ${JSON.stringify({ id: 'resp-1', session_id: 'sess-1' })}\n\nevent: response.completed\ndata: ${JSON.stringify({ output_text: 'done', usage: null })}\n\n`);
    },
    async reattachTurn(url: string, responseId: string) {
      calls.push(`reattach:${url}:${responseId}`);
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ output_text: '', usage: null })}\n\n`);
    },
    async cancelTurn(url: string, responseId: string) {
      calls.push(`cancel:${url}:${responseId}`);
    },
    async activeTurn(url: string, sessionId: string) {
      calls.push(`active:${url}:${sessionId}`);
      return 'resp-2';
    },
    async updateInstance(id: string) {
      calls.push(`update:${id}`);
      const found = instances.get(id)!;
      found.status = 'running';
      found.template_revision = revisionAfterUpdate;
      return { id, status: 'running', template_revision: revisionAfterUpdate };
    },
    async setNetwork(id: string, network: unknown) {
      calls.push(`network:${id}`);
      networks.push({ id, network });
      if (refuse.network) {
        const error = refuse.network;
        refuse.network = undefined;
        throw error;
      }
      instances.get(id)!.network = network as Instance['network'];
      return instances.get(id)!;
    },
    async usageForDay(day: string) {
      calls.push(`usage:${day}`);
      return usage;
    },
    async getBudget(id: string) {
      calls.push(`budget:${id}`);
      const b = budgets.get(id) ?? { cap: 0, credit: 0 };
      return { monthlyCapMicros: b.cap, monthlyRemainingMicros: b.cap, creditRemainingMicros: b.credit };
    },
    async setMonthlyCap(id: string, micros: number) {
      calls.push(`cap:${id}:${micros}`);
      budgets.set(id, { cap: micros, credit: budgets.get(id)?.credit ?? 0 });
    },
    async archive(url: string) {
      calls.push(`archive:${url}`);
      return { body: new ReadableStream() } as unknown as Response;
    },
  };
  const created: Array<{ metadata?: Record<string, string>; budget?: unknown; env?: unknown; auto_sleep?: boolean; network?: unknown }> = [];
  const networks: Array<{ id: string; network: unknown }> = [];
  const usage: { day: string; totalMicros: number; instances: Array<{ id: string; totalMicros: number; computeMicros: number; awakeMinutes: number }> } = { day: '2026-11-15', totalMicros: 0, instances: [] };
  return { client: client as unknown as Agent37Client, instances, budgets, calls, retries, execs, created, networks, usage, refuse, setHealthy: (value: boolean) => (healthy = value), setExec: (fn: (command: string) => string | { stdout: string; exitCode?: number; truncated?: boolean }) => (execOut = fn), setMark: (value: string) => (markOut = value), setColdSum: (value: string | null) => (coldSum = value), setColdInstall: (value: boolean) => (coldInstall = value), setColdInPlace: (value: string | null) => (coldInPlace = value) };
}

function provider(w: ReturnType<typeof world>, extra: { slept?: number[]; sleepLog?: string[]; image?: () => Promise<ImageState | null>; reserved?: number; copies?: ConstructorParameters<typeof Agent37ComputerProvider>[0]['copies']; clock?: { t: number } } = {}) {
  const clock = extra.clock ?? { t: 1_000_000 };
  return new Agent37ComputerProvider({
    client: w.client,
    outstandingReserveMicros: async () => extra.reserved ?? 0,
    sleep: async (ms?: number) => {
      extra.slept?.push(ms ?? 0);
      // With a log asked for, a pause really takes a turn of the event loop and says when it began and when it ended: a caller that does not wait for it is seen
      if (extra.sleepLog) {
        extra.sleepLog.push(`sleep-begin:${ms ?? 0}`);
        await new Promise((resolve) => setImmediate(resolve));
        extra.sleepLog.push(`sleep-end:${ms ?? 0}`);
      }
      clock.t += 3_000;
    },
    now: () => clock.t,
    copies: extra.copies,
    image: extra.image,
  });
}

describe('the Agent37 provider', () => {
  it('makes one machine for a Brick with its id in the metadata, a $0 managed budget, no env and auto sleep on', async () => {
    const w = world();
    const info = await provider(w).create('bot-1');
    expect(info).toEqual({ ref: 'm1', region: 'us' });
    expect(w.created[0].metadata).toEqual({ creation_id: 'brick:bot-1' });
    expect(w.created[0].budget).toEqual({ monthly_cap_micros: 0, credit_micros: 0 });
    expect(w.created[0].env).toBeUndefined();
    expect(w.created[0].auto_sleep).toBe(true);
  });

  it('makes a machine with the network rule written down: the public web, never a private range', async () => {
    const w = world();
    await provider(w).create('bot-1');
    expect(w.created[0].network).toBe(BRICK_NETWORK);
    expect(BRICK_NETWORK).toBe('allow-all');
  });

  it('adopts the machine a Brick already has instead of making a second one', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    const again = await p.create('bot-1');
    expect(again.ref).toBe('m1');
    expect(w.created).toHaveLength(1);
    // The Brick of a deleted machine is not adopted
    w.instances.get('m1')!.status = 'deleted';
    expect((await p.create('bot-1')).ref).toBe('m2');
  });

  it('after a create whose answer was lost, finds the machine that was made and adopts it', async () => {
    const w = world();
    w.refuse.create = new Agent37Unreached('TimeoutError');
    const info = await provider(w).create('bot-1');
    expect(info.ref).toBe('made1');
    expect(w.calls.filter((call) => call === 'create')).toHaveLength(1);
  });

  it('after a lost create that made nothing, says so and makes none', async () => {
    const w = world();
    w.refuse.create = new Agent37Error(503, 'no_capacity', 'No host');
    await expect(provider(w).create('bot-1')).rejects.toBeInstanceOf(Agent37Error);
    expect(w.instances.size).toBe(0);
  });

  it('does not make or wake a machine when the wallet cannot cover the room held for jobs and a day of running', async () => {
    const day = dayOfRunningMicros(BRICK_SHAPE) / 1_000_000;
    const poor = world({ balanceUsd: day + 0.5 });
    await expect(provider(poor, { reserved: 1_000_000 }).create('bot-1')).rejects.toBeInstanceOf(Agent37FundsLow);
    expect(poor.calls).not.toContain('create');
    const enough = world({ balanceUsd: day + 1.5 });
    await expect(provider(enough, { reserved: 1_000_000 }).create('bot-1')).resolves.toBeDefined();
    const overdrawn = world({ pastDue: true });
    await expect(provider(overdrawn).create('bot-1')).rejects.toBeInstanceOf(Agent37FundsLow);
  });

  it('an unreadable wallet is a no', async () => {
    const w = world();
    (w.client as unknown as { billing: () => Promise<never> }).billing = async () => {
      throw new Agent37Unreached('TimeoutError');
    };
    await expect(provider(w).create('bot-1')).rejects.toBeInstanceOf(Agent37FundsLow);
  });

  describe('the checkup for the team', () => {
    const built = async (): Promise<ImageState> => ({ hash: 'h', state: 'ready', buildId: 'b', revision: 3, startedAt: new Date(0).toISOString(), failures: 0, error: null });
    const named = (checks: Array<{ name: string; ok: boolean; detail: string }>) => Object.fromEntries(checks.map((check) => [check.name, check]));

    it('says the key works, the wallet carries a job and the image is built, and creates and wakes nothing', async () => {
      const w = world();
      const checks = named(await provider(w, { image: built }).checkup());
      expect(checks['agent37 key'].ok).toBe(true);
      expect(checks['agent37 wallet'].ok).toBe(true);
      expect(checks['computer image']).toMatchObject({ ok: true });
      // It only looks (the wallet, the list of machines, their budgets): nothing is made, woken or changed
      expect(w.calls.filter((call) => call !== 'billing' && call !== 'list' && !call.startsWith('budget:'))).toEqual([]);
    });

    it('says a wallet that cannot carry a job, an overdrawn one, and a key that was refused, and never shows the key', async () => {
      const day = dayOfRunningMicros(BRICK_SHAPE) / 1_000_000;
      expect(named(await provider(world({ balanceUsd: day + 0.5 }), { reserved: 1_000_000, image: built }).checkup())['agent37 wallet']).toMatchObject({ ok: false });
      expect(named(await provider(world({ pastDue: true }), { image: built }).checkup())['agent37 wallet']).toMatchObject({ ok: false, detail: 'The wallet is overdrawn' });
      const refused = world();
      (refused.client as unknown as { billing: () => Promise<never> }).billing = async () => {
        throw new Agent37Error(401, 'unauthorized', 'bad key a37_secret_value');
      };
      const checks = await provider(refused, { image: built }).checkup();
      expect(named(checks)['agent37 key']).toMatchObject({ ok: false, detail: 'Agent37 refused the key' });
      expect(JSON.stringify(checks)).not.toContain('a37_secret_value');
    });

    it('says the wallet could not be checked, not that the key failed, when what is set aside cannot be read', async () => {
      const w = world();
      const p = new Agent37ComputerProvider({
        client: w.client,
        outstandingReserveMicros: async () => {
          throw new Error('database down');
        },
        sleep: async () => undefined,
        now: () => 1_000_000,
        image: built,
      });
      const checks = named(await p.checkup());
      expect(checks['agent37 key']).toMatchObject({ ok: true });
      expect(checks['agent37 wallet']).toMatchObject({ ok: false, detail: 'What is already set aside could not be read' });
    });

    it('says where the image stands: building, failed with the reason, not started', async () => {
      const state = (over: Partial<ImageState>) => async (): Promise<ImageState | null> => ({ hash: 'h', state: 'building', buildId: 'b', revision: null, startedAt: new Date(0).toISOString(), failures: 0, error: null, ...over });
      expect(named(await provider(world(), { image: state({}) }).checkup())['computer image']).toMatchObject({ ok: false, detail: 'The computer image is being built' });
      expect(named(await provider(world(), { image: state({ state: 'failed', failures: 2, error: 'no such package' }) }).checkup())['computer image'].detail).toContain('no such package');
      expect(named(await provider(world(), { image: async () => null }).checkup())['computer image'].ok).toBe(false);
    });
  });

  it('wakes a resting machine with one start, and waits until its agent answers', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    await p.rest('m1');
    w.setHealthy(false);
    const clock = { t: 1_000_000 };
    const slow = provider(w, { clock });
    let tries = 0;
    (w.client as unknown as { healthy: () => Promise<boolean> }).healthy = async () => ++tries >= 3;
    await slow.wake('m1');
    expect(w.calls.filter((call) => call === 'start:m1')).toHaveLength(1);
    expect(tries).toBe(3);
  });

  it('gives up when a machine is not ready in time, and never starts one that is running', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.calls.length = 0;
    await p.wake('m1');
    expect(w.calls).not.toContain('start:m1');
    w.setHealthy(false);
    await expect(p.wake('m1')).rejects.toThrow('did not become ready');
  });

  it('waits for a machine that is stopping to be down, then starts it exactly once', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.instances.get('m1')!.status = 'stopping';
    let reads = 0;
    const get = w.client.getInstance.bind(w.client);
    (w.client as unknown as { getInstance: (id: string) => Promise<Instance> }).getInstance = async (id) => {
      const instance = await get(id);
      // Two reads say stopping, the third says stopped; the start brings it up
      if (instance.status === 'stopping' && ++reads >= 3) instance.status = 'stopped';
      return instance;
    };
    await p.wake('m1');
    expect(w.calls.filter((call) => call === 'start:m1')).toHaveLength(1);
    expect(w.instances.get('m1')!.status).toBe('running');
  });

  it('says the plain timeout when a machine never leaves stopping, and starts nothing', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.instances.get('m1')!.status = 'stopping';
    await expect(p.wake('m1')).rejects.toThrow('did not become ready in time');
    expect(w.calls.some((call) => call.startsWith('start'))).toBe(false);
  });

  it('rests a running machine with Agent37’s sleep, and a machine that already rests is left alone', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    await p.rest('m1');
    await p.rest('m1');
    expect(w.calls.filter((call) => call === 'sleep:m1')).toHaveLength(1);
  });

  it('stops and removes; a machine that is already gone is not an error', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    await p.stop('m1');
    await p.stop('m1');
    expect(w.calls.filter((call) => call === 'stop:m1')).toHaveLength(1);
    await p.remove('m1');
    await expect(p.remove('m1')).resolves.toBeUndefined();
  });

  it('removes every machine made for a Brick, also one Universe never wrote down, and leaves other Bricks\' machines alone', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    await p.create('bot-2');
    // A second machine made for bot-1 whose answer was lost, so it was never written down
    w.instances.set('stray', { id: 'stray', status: 'sleeping', url: 'https://stray.agent37.app', metadata: { creation_id: 'brick:bot-1' }, region: 'us' } as Instance);
    // And one that failed to come up: it is still there at the provider, so it goes too
    w.instances.set('broken', { id: 'broken', status: 'failed', url: '', metadata: { creation_id: 'brick:bot-1' }, region: 'us' } as Instance);
    await p.removeAllFor('bot-1');
    expect([...w.instances.keys()]).toEqual(['m2']);
    // Nothing made for it: nothing to do, and no error
    await expect(p.removeAllFor('bot-1')).resolves.toBeUndefined();
    await expect(p.removeAllFor('never-had-one')).resolves.toBeUndefined();
  });

  it('finds and removes a machine nobody wrote down, however many machines the account has and however new they all are: the list is the whole account, so the oldest Brick is clear too', async () => {
    const w = world();
    const p = provider(w);
    const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
    for (let n = 0; n < 250; n++) w.instances.set(`other-${n}`, { id: `other-${n}`, status: 'running', url: '', metadata: { creation_id: `brick:other-${n}` }, region: 'us', created: at('2026-11-11T00:00:00Z') + n } as Instance);
    // Nothing of this Brick is there: clear, with every other machine newer than its computer record and a long list
    await expect(p.removeAllFor('bot-1')).resolves.toBeUndefined();
    w.instances.set('mine', { id: 'mine', status: 'running', url: '', metadata: { creation_id: 'brick:bot-1' }, region: 'us', created: at('2026-11-12T00:00:00Z') } as Instance);
    await p.removeAllFor('bot-1');
    expect(w.instances.has('mine')).toBe(false);
    expect(w.instances.size).toBe(250);
  });

  it('says whether a machine is running, to prove a stop: running is awake, stopped, sleeping and gone are not', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    expect(await p.awake('m1')).toBe(true);
    await p.rest('m1');
    expect(await p.awake('m1')).toBe(false);
    await p.remove('m1');
    expect(await p.awake('m1')).toBe(false);
  });

  describe('the look says only what its status says (Sentry on a4ed472c: an odd status is never taken for asleep)', () => {
    const withStatus = async (status: string) => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      w.instances.get('m1')!.status = status as Instance['status'];
      return p;
    };

    it.each(['running', 'starting', 'restarting', 'updating', 'waking', 'provisioning'])('%s is awake, in both looks', async (status) => {
      const p = await withStatus(status);
      expect(await p.awake('m1')).toBe(true);
      expect(await p.awakeOnce('m1', 3_000)).toBe(true);
    });

    it.each(['stopped', 'sleeping', 'stopping', 'deleting', 'deleted', 'failed'])('%s is not running, in both looks', async (status) => {
      const p = await withStatus(status);
      expect(await p.awake('m1')).toBe(false);
      expect(await p.awakeOnce('m1', 3_000)).toBe(false);
    });

    it.each(['hibernating', 'migrating', ''])('the status "%s" is not known: both looks throw instead of saying asleep, so nothing is paused, no proof moves and no stop is proved', async (status) => {
      const p = await withStatus(status);
      await expect(p.awake('m1')).rejects.toBeInstanceOf(Agent37Unreached);
      await expect(p.awakeOnce('m1', 3_000)).rejects.toBeInstanceOf(Agent37Unreached);
    });

    it('a status that is not documented is told to Sentry with the word, and a documented one is not', async () => {
      const said = Sentry.captureMessage as jest.Mock;
      said.mockClear();
      try {
        await expect((await withStatus('hibernating')).awake('m1')).rejects.toBeInstanceOf(Agent37Unreached);
        expect(said).toHaveBeenCalledTimes(1);
        expect(said).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ level: 'warning', extra: { status: 'hibernating' } }));
        said.mockClear();
        for (const status of ['running', 'stopping', 'sleeping', 'stopped', 'failed']) await (await withStatus(status)).awake('m1');
        expect(said).not.toHaveBeenCalled();
      } finally {
        said.mockClear();
      }
    });
  });

  it('the quick look reads the same, from one request with the caller’s timeout', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.calls.length = 0;
    expect(await p.awakeOnce('m1', 3_000)).toBe(true);
    await p.rest('m1');
    expect(await p.awakeOnce('m1', 3_000)).toBe(false);
    expect(w.calls.filter((call) => call.startsWith('getOnce:'))).toEqual(['getOnce:m1:3000', 'getOnce:m1:3000']);
    await p.remove('m1');
    expect(await p.awakeOnce('m1', 3_000)).toBe(false);
  });

  it('looking never wakes: a machine that is not running has no screen and no signed link is asked for', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    const live = await p.watch('m1');
    expect(live).not.toBeNull();
    expect(w.calls).toContain(`signed:m1:${DESKTOP_PORT}:60`);
    await p.rest('m1');
    w.calls.length = 0;
    expect(await p.watch('m1')).toBeNull();
    expect(w.calls.some((call) => call.startsWith('signed') || call.startsWith('start') || call === 'health')).toBe(false);
  });

  it('prices a minute at Agent37’s published rate for the shape', () => {
    expect(provider(world()).microsPerMinute()).toBe(awakeMicrosPerMinute(BRICK_SHAPE));
  });

  describe('saving files', () => {
    const copy = (bytes = 1234) => ({ bytes, savedAt: new Date() });

    it('streams the folder of a running machine into the saved copy', async () => {
      const w = world();
      const store = jest.fn(async () => copy());
      const p = provider(w, { copies: { latest: async () => null, store } });
      await p.create('bot-1');
      const saved = await p.saveFiles('m1');
      expect(saved.bytes).toBe(1234);
      expect(store).toHaveBeenCalledWith('bot-1', expect.anything());
      expect(w.calls).toContain('archive:https://m1.agent37.app');
    });

    it('does not wake a resting machine whose copy is as it was left', async () => {
      const w = world();
      const store = jest.fn();
      const p = provider(w, { copies: { latest: async () => copy(99), store } });
      await p.create('bot-1');
      await p.rest('m1');
      w.calls.length = 0;
      const saved = await p.saveFiles('m1');
      expect(saved.bytes).toBe(99);
      expect(w.calls.some((call) => call.startsWith('start') || call.startsWith('archive'))).toBe(false);
      expect(store).not.toHaveBeenCalled();
    });

    it('does not wake a stopped machine that has a copy, even when the wallet is low', async () => {
      const w = world({ balanceUsd: 0 });
      w.instances.set('s1', { id: 's1', status: 'stopped', url: 'https://s1.agent37.app', metadata: { creation_id: 'brick:bot-9' } });
      const p = provider(w, { copies: { latest: async () => copy(77), store: jest.fn() } });
      const saved = await p.saveFiles('s1');
      expect(saved.bytes).toBe(77);
      expect(w.calls.some((call) => call.startsWith('start') || call === 'billing')).toBe(false);
    });

    it('wakes a resting machine once, for the save, when there is no copy that matches it', async () => {
      const w = world();
      const store = jest.fn(async () => copy());
      const p = provider(w, { copies: { latest: async () => null, store } });
      await p.create('bot-1');
      await p.rest('m1');
      await p.saveFiles('m1');
      expect(w.calls.filter((call) => call === 'start:m1')).toHaveLength(1);
      expect(store).toHaveBeenCalledTimes(1);
    });

    it('a save that fails says so, so a machine is never removed on the word of a copy that was not made', async () => {
      const w = world();
      const p = provider(w, {
        copies: {
          latest: async () => null,
          store: async () => {
            throw new Error('gzip stream ended early');
          },
        },
      });
      await p.create('bot-1');
      await expect(p.saveFiles('m1')).rejects.toThrow('ended early');
    });
  });

  describe('the agent and commands on a machine', () => {
    it('runs a command on the machine as it is asked, with its options', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      expect(await p.exec('m1', 'universe-fence', { name: 'x', timeoutMs: 5000 })).toMatchObject({ exitCode: 0, stdout: 'ok' });
      expect(w.execs).toEqual([{ id: 'm1', command: 'universe-fence', options: { name: 'x', timeoutMs: 5000 } }]);
    });

    it('starts a turn at the machine’s own address and gives its events', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      const seen = [];
      for await (const event of await p.openTurn('m1', { text: 'Fill the form' })) seen.push(event.type);
      expect(seen).toEqual(['created', 'completed']);
      expect(w.calls).toContain('turn:https://m1.agent37.app:Fill the form');
    });

    it('reconnects, cancels and asks which turn is running at the same address', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      for await (const event of await p.reattachTurn('m1', 'resp-1')) void event;
      await p.cancelTurn('m1', 'resp-1');
      expect(await p.activeTurn('m1', 'sess-1')).toBe('resp-2');
      expect(w.calls).toEqual(expect.arrayContaining(['reattach:https://m1.agent37.app:resp-1', 'cancel:https://m1.agent37.app:resp-1', 'active:https://m1.agent37.app:sess-1']));
    });

    it('does not reach a machine that is gone', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      w.instances.get('m1')!.status = 'deleted';
      await expect(p.openTurn('m1', { text: 'x' })).rejects.toThrow('deleted');
      await expect(p.cancelTurn('m1', 'r')).rejects.toThrow('deleted');
    });
  });
});

describe('the look at every machine of the account (the sweep stops a machine that runs behind a stopped row, CodeRabbit on #1040)', () => {
  it('says each machine by its status in ONE request: awake for a running or starting one, asleep for a stopped, sleeping, stopping or gone one, not known for a status Agent37 never documented (said to Sentry)', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    await p.create('bot-2');
    await p.create('bot-3');
    await p.create('bot-4');
    const set = (id: string, status: string) => {
      (w.instances.get(id) as { status: string }).status = status;
    };
    set('m1', 'running');
    set('m2', 'stopping');
    set('m3', 'sleeping');
    set('m4', 'quantum');
    (Sentry.captureMessage as jest.Mock).mockClear();
    w.calls.length = 0;
    const said = await p.awakeMachinesOnce(5_000);
    expect(said.get('m1')).toBe(true);
    expect(said.get('m2')).toBe(false);
    expect(said.get('m3')).toBe(false);
    expect(said.get('m4')).toBeNull();
    // One request with the short timeout, no other call
    expect(w.calls).toEqual(['listOnce:5000']);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Agent37 said a machine status that is not in the list', expect.objectContaining({ level: 'warning' }));
  });

  it('a list that gets no clean answer throws (an error, a rate limit) and is asked once: nothing is read from it', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.refuse.listOnce = new Agent37Error(429, null, 'slow down');
    w.calls.length = 0;
    await expect(p.awakeMachinesOnce(5_000)).rejects.toBeInstanceOf(Agent37Error);
    expect(w.calls).toEqual(['listOnce:5000']);
  });
});

describe("Agent37's bill for a day", () => {
  it('says which machine of Agent37 is a Brick of ours, one that is not ours, and one that is gone, and what its published rates make of the awake minutes', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.instances.set('other1', { id: 'other1', status: 'stopped', url: 'https://other1.agent37.app', metadata: null });
    w.usage.totalMicros = 30_000;
    w.usage.instances.push(
      { id: 'm1', totalMicros: 12_000, computeMicros: 11_000, awakeMinutes: 60 },
      { id: 'other1', totalMicros: 400, computeMicros: 400, awakeMinutes: 0 },
      { id: 'removed1', totalMicros: 300, computeMicros: 300, awakeMinutes: 10 },
    );
    const day = await p.dayUsage('2026-11-15');
    expect(w.calls).toContain('usage:2026-11-15');
    expect(day.totalMicros).toBe(30_000);
    const byRef = Object.fromEntries(day.instances.map((entry) => [entry.ref, entry]));
    expect(byRef.m1).toMatchObject({ kind: 'brick', botId: 'bot-1', totalMicros: 12_000, computeMicros: 11_000, awakeMinutes: 60 });
    expect(byRef.other1).toMatchObject({ kind: 'other', botId: null });
    expect(byRef.removed1).toMatchObject({ kind: 'gone', botId: null });
    // 60 awake minutes at the published awake rate, the other 1380 minutes of the day at the disk's rate
    const awake = awakeMicrosPerMinute(BRICK_SHAPE);
    const rest = (BRICK_SHAPE.disk * 90_000) / (730 * 60);
    expect(byRef.m1.expectedMicros).toBeCloseTo(60 * awake + 1380 * rest, 0);
  });
});

describe("Agent37's bill for a day, when the list of machines does not hold them all", () => {
  it('looks a billed machine up by its id before calling it gone, so a machine past the list is still a Brick of ours', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.usage.totalMicros = 1_300;
    w.usage.instances.push({ id: 'm1', totalMicros: 1_000, computeMicros: 900, awakeMinutes: 10 }, { id: 'removed1', totalMicros: 300, computeMicros: 300, awakeMinutes: 10 });
    // The list shows only the newest machines: m1 is not on it, although it exists
    (w.client as unknown as { listInstances: () => Promise<Instance[]> }).listInstances = async () => [];
    const day = await p.dayUsage('2026-11-15');
    const byRef = Object.fromEntries(day.instances.map((entry) => [entry.ref, entry]));
    expect(byRef.m1).toMatchObject({ kind: 'brick', botId: 'bot-1' });
    expect(byRef.removed1).toMatchObject({ kind: 'gone' });
  });

  it('does not take a machine it could not look up for one that is gone: the day is not checked until Agent37 answers', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.usage.instances.push({ id: 'm1', totalMicros: 1_000, computeMicros: 900, awakeMinutes: 10 });
    (w.client as unknown as { listInstances: () => Promise<Instance[]> }).listInstances = async () => [];
    (w.client as unknown as { getInstance: (id: string) => Promise<Instance> }).getInstance = async () => {
      throw new Agent37Error(503, 'unavailable', 'try later');
    };
    await expect(p.dayUsage('2026-11-15')).rejects.toBeInstanceOf(Agent37Error);
  });
});

describe('getting a machine ready for a job', () => {
  const state = (over: Partial<ImageState> = {}): ImageState => ({ hash: 'h', state: 'ready', buildId: 'b', revision: 2, startedAt: new Date(0).toISOString(), failures: 0, error: null, ...over });

  it('makes no machine until the image is built, and says so', async () => {
    const w = world();
    for (const image of [null, state({ state: 'building' }), state({ state: 'failed', failures: 1, error: 'x' })]) {
      await expect(provider(w, { image: async () => image }).create('bot-1')).rejects.toBeInstanceOf(ImageNotReady);
    }
    expect(w.calls).not.toContain('create');
    expect((await provider(w, { image: async () => state() }).create('bot-1')).ref).toBe('m1');
  });

  it('runs universe-up, and is ready when it says so', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.setExec(() => 'ready=1 restart=0\n');
    // The mark the take-over fence tells the agent's processes by is read last, and handed to Orbit (which keeps it): the computer writes nothing, and the command runs as the normal user
    await expect(p.ready('m1')).resolves.toEqual({ bootId: BOOT, ticks: 1234, parts: [{ pid: 77, start: 500, kind: 'part' }], runners: ['a'.repeat(64)] });
    // The wait for the margin after the image's unpack is asked first, as root; the mark is read as the normal user
    expect(w.execs.map((entry) => labelled(entry.command))).toEqual(['universe-up', expect.stringContaining('unpack_wait='), 'mark']);
    expect(w.execs[1].options).toMatchObject({ user: 'root' });
    expect(w.execs[2].options).not.toHaveProperty('user');
    expect(w.execs[2].command).not.toMatch(/\/run\/universe|mkdir|chown|>\s*"?\$DIR/);
    expect(w.calls.filter((call) => call.startsWith('stop:'))).toEqual([]);
  });

  it('a brand-new computer is handed over only after the margin that follows the unpack of its image (the computer says how many seconds are left), a computer that is not new is not waited for, and one that cannot say is not held up', async () => {
    const answer = (wait: string) => (command: string) => (command === 'universe-up' ? 'ready=1 restart=0\n' : command.includes('unpack_wait=') ? wait : 'ok');
    for (const [said, expected] of [['unpack_wait=7\n', [7000]], ['unpack_wait=0\n', []], ['', []], ['unpack_wait=99999\n', []], ['not a number\n', []]] as const) {
      const w = world();
      const slept: number[] = [];
      // Everything the computer is asked and every pause, in the order they began and ended
      const order: string[] = [];
      const p = provider(w, { slept, sleepLog: order });
      await p.create('bot-1');
      slept.length = 0;
      order.length = 0;
      const ask = w.client.exec.bind(w.client);
      (w.client as unknown as { exec: (id: string, command: string, options?: ExecOptions) => Promise<unknown> }).exec = async (id, command, options) => {
        order.push(isMarkCommand(command) ? 'mark' : command.includes('unpack_wait=') ? 'unpack-asked' : command);
        return ask(id, command, options);
      };
      w.setExec(answer(said));
      await expect(p.ready('m1')).resolves.toMatchObject({ bootId: BOOT });
      expect(slept).toEqual(expected);
      // The wait ENDED before the mark was read (a wait that is not waited for would let the mark be read inside the margin): asked, waited, then marked, nothing between
      expect(order.filter((entry) => entry !== 'universe-up')).toEqual(['unpack-asked', ...expected.flatMap((ms) => [`sleep-begin:${ms}`, `sleep-end:${ms}`]), 'mark']);
      // The note the fence tells by is written after the wait, never before
      const commands = w.execs.map((entry) => labelled(entry.command));
      expect(commands.at(-1)).toBe('mark');
    }
    // A command that fails does not make the computer not ready
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    const execute = w.client.exec.bind(w.client);
    (w.client as unknown as { exec: (id: string, command: string, options?: ExecOptions) => Promise<unknown> }).exec = async (id, command, options) => {
      if (command.includes('unpack_wait=')) throw new Agent37Unreached('lost');
      return execute(id, command, options);
    };
    w.setExec((command) => (command === 'universe-up' ? 'ready=1 restart=0\n' : 'ok'));
    await expect(p.ready('m1')).resolves.toMatchObject({ bootId: BOOT });
  });

  describe('the network rule when a machine is made ready', () => {
    it('sets it on a machine whose rule is not the one we want (a machine made before the rule, or one that drifted), once, before anything runs on it', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      w.instances.get('m1')!.network = 'deny-all';
      w.setExec(() => 'ready=1 restart=0\n');
      await p.ready('m1');
      expect(w.networks).toEqual([{ id: 'm1', network: BRICK_NETWORK }]);
      expect(w.calls.indexOf('network:m1')).toBeLessThan(w.calls.indexOf('exec:m1:universe-up'));
    });

    it('sets it when Agent37 does not say what the rule is, and leaves it when it already is the one we want', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      w.setExec(() => 'ready=1 restart=0\n');
      delete w.instances.get('m1')!.network;
      await p.ready('m1');
      expect(w.networks).toHaveLength(1);
      w.instances.get('m1')!.network = BRICK_NETWORK;
      await p.ready('m1');
      expect(w.networks).toHaveLength(1);
    });

    it('is not ready when the rule cannot be set: a machine whose reach is not known is never handed to a job', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      w.setExec(() => 'ready=1 restart=0\n');
      delete w.instances.get('m1')!.network;
      w.refuse.network = new Agent37Error(400, 'invalid_request', 'no');
      await expect(p.ready('m1')).rejects.toThrow('network rule');
      expect(w.execs).toEqual([]);
    });
  });

  it('is not ready when the mark for the fence cannot be read: a computer that cannot be fenced is never handed to a job', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.setExec(() => 'ready=1 restart=0\n');
    w.setMark('marked=0 reason=write\n');
    await expect(p.ready('m1')).rejects.toThrow('could not be marked (write)');
    w.setMark('');
    await expect(p.ready('m1')).rejects.toThrow('could not be marked');
  });

  it('stops and starts a machine once when its config was just written, then runs universe-up again', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    let runs = 0;
    w.setExec(() => (++runs === 1 ? 'ready=1 restart=1\n' : 'ready=1 restart=0\n'));
    await p.ready('m1');
    // The note is written once, after the restart (a note from before it would be for the old boot)
    expect(w.execs.map((entry) => labelled(entry.command))).toEqual(['universe-up', 'universe-up', expect.stringContaining('unpack_wait='), 'mark']);
    expect(w.calls.filter((call) => call.startsWith('stop:') || call.startsWith('start:'))).toEqual(['stop:m1', 'start:m1']);
  });

  describe('a fresh boot', () => {
    const OLD_BOOT = '11111111-2222-4333-8444-555555555555';
    const reading = (boot: string) => (command: string) => (command === 'cat /proc/sys/kernel/random/boot_id' ? `${boot}\n` : 'ready=1 restart=0\n');

    it('starts the machine afresh before anything else when asked for it, and never otherwise (a computer that worked before and has no mark saved by Orbit)', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      w.setExec(reading(OLD_BOOT));
      await p.ready('m1');
      expect(w.calls.filter((call) => call.startsWith('stop:') || call.startsWith('start:'))).toEqual([]);
      await expect(p.ready('m1', { freshBoot: true })).resolves.toMatchObject({ bootId: BOOT });
      // The restart comes before the screen and browser are brought up and before the mark is read: the mark is of the new boot, taken with nothing of an earlier job running
      const second = w.calls.slice(w.calls.lastIndexOf('stop:m1'));
      const kinds = second.flatMap((call) => (call.startsWith('stop:') ? ['stop'] : call.startsWith('start:') ? ['start'] : call.startsWith('exec:m1:') ? [labelled(call.slice('exec:m1:'.length)) === 'universe-up' ? 'up' : isMarkCommand(call.slice('exec:m1:'.length)) ? 'mark' : 'other'] : []));
      // The wait for the margin after the image's unpack (shown as 'other') comes between the start-up and the mark
      expect(kinds).toEqual(['stop', 'start', 'up', 'other', 'mark']);
    });

    it('answers no mark when the boot did not change, and is still ready: a stop that became a sleep, or a start that resumed the same boot, never leaves a mark on the boot the jobs ran on, and never refuses the job (Opus on #1033)', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      w.setExec(reading(BOOT));
      const sent = Sentry.captureMessage as jest.Mock;
      sent.mockClear();
      const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(p.ready('m1', { freshBoot: true })).resolves.toBeNull();
        expect(sent).toHaveBeenCalledWith(expect.stringContaining('did not change'), expect.objectContaining({ level: 'error', extra: expect.objectContaining({ ref: 'm1', before: BOOT, after: BOOT }) }));
      } finally {
        logged.mockRestore();
      }
    });

    it('answers no mark when the boot before the restart could not be read: nothing proves the restart gave a new one, and the job still runs', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      w.setExec((command) => (command === 'cat /proc/sys/kernel/random/boot_id' ? 'cat: no such file\n' : 'ready=1 restart=0\n'));
      const sent = Sentry.captureMessage as jest.Mock;
      sent.mockClear();
      const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(p.ready('m1', { freshBoot: true })).resolves.toBeNull();
        expect(sent).toHaveBeenCalledWith(expect.stringContaining('was not read'), expect.objectContaining({ extra: expect.objectContaining({ ref: 'm1', before: null, after: BOOT }) }));
      } finally {
        logged.mockRestore();
      }
    });

    it('asks nothing of the boot when no fresh boot is asked for', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      w.setExec(reading(BOOT));
      await expect(p.ready('m1')).resolves.toMatchObject({ bootId: BOOT });
      expect(w.execs.some((entry) => entry.command === 'cat /proc/sys/kernel/random/boot_id')).toBe(false);
    });
  });

  it('CodeRabbit on #1040, Opus F4: a stop or a sleep that is a power operation of ours asks not to be repeated after a gateway answer, and the readiness restarts (under a wake\'s own ticket) keep the retry', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    await p.rest('m1');
    w.instances.get('m1')!.status = 'running';
    await p.stop('m1');
    expect(w.retries).toEqual(['sleep:refused', 'stop:refused']);
    // The fresh-boot restart and the restart a part asked for are readiness steps: the default retry
    w.retries.length = 0;
    let runs = 0;
    w.setExec(() => (++runs === 1 ? 'ready=1 restart=1\n' : 'ready=1 restart=0\n'));
    await p.ready('m1');
    expect(w.retries).toEqual(['stop:any']);
  });

  it('after asking a machine to stop, waits until it is really stopped, not just until it stops saying "stopping"', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    let runs = 0;
    w.setExec(() => (++runs === 1 ? 'ready=1 restart=1\n' : 'ready=1 restart=0\n'));
    const real = w.client.stopInstance.bind(w.client);
    let reads = 0;
    (w.client as unknown as { stopInstance: (id: string) => Promise<unknown> }).stopInstance = async (id) => {
      await real(id);
      // The stop was accepted but the machine still says it is running for two reads
      w.instances.get(id)!.status = 'running';
      return { id, status: 'stopping' };
    };
    const get = w.client.getInstance.bind(w.client);
    (w.client as unknown as { getInstance: (id: string) => Promise<Instance> }).getInstance = async (id) => {
      const instance = await get(id);
      if (w.calls.includes(`stop:${id}`) && !w.calls.includes(`start:${id}`) && instance.status === 'running' && ++reads >= 3) instance.status = 'stopped';
      return instance;
    };
    await p.ready('m1');
    const order = w.calls.filter((call) => call.startsWith('stop:') || call.startsWith('start:'));
    expect(order).toEqual(['stop:m1', 'start:m1']);
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  describe('a start that lost its wake sends no power call (Opus on #1040: stillMine is asked right before EVERY stop and start)', () => {
    const OLD_BOOT = '11111111-2222-4333-8444-555555555555';
    const prepare = async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      let ups = 0;
      // A fresh boot AND a part that asks for a restart: all four power calls of `ready` are reached
      w.setExec((command) => (command === 'cat /proc/sys/kernel/random/boot_id' ? `${OLD_BOOT}\n` : command === 'universe-up' ? (++ups === 1 ? 'ready=1 restart=1\n' : 'ready=1 restart=0\n') : 'ok'));
      return { w, p };
    };
    const power = (w: { calls: string[] }) => w.calls.filter((call) => call.startsWith('stop:') || call.startsWith('start:'));

    // The asks of a fresh boot that is followed by a restart a part asked for: before the stop, before the start, right after the start (the sender may have been paused since the check), then the same again
    it.each([
      [1, []],
      [2, ['stop:m1']],
      [3, ['stop:m1', 'start:m1']],
      [4, ['stop:m1', 'start:m1']],
      [5, ['stop:m1', 'start:m1', 'stop:m1']],
      [6, ['stop:m1', 'start:m1', 'stop:m1', 'start:m1']],
    ])('ready: refused at ask %i, only the calls before it were sent, and WakeReplaced is thrown', async (refusedAt, sent) => {
      const { w, p } = await prepare();
      let asks = 0;
      await expect(p.ready('m1', { freshBoot: true, stillMine: async () => ++asks < refusedAt })).rejects.toBeInstanceOf(WakeReplaced);
      expect(power(w)).toEqual(sent);
      expect(asks).toBe(refusedAt);
    });

    it('ready: true before and false right after a start: the start was sent once, WakeReplaced is thrown, and no health poll, universe-up or mark follows (freshBoot start, then the restart a part asked for)', async () => {
      for (const refusedAt of [3, 6]) {
        const { w, p } = await prepare();
        let asks = 0;
        await expect(p.ready('m1', { freshBoot: true, stillMine: async () => ++asks !== refusedAt })).rejects.toBeInstanceOf(WakeReplaced);
        const at = w.calls.lastIndexOf('start:m1');
        expect(w.calls.filter((call) => call === 'start:m1')).toHaveLength(refusedAt === 3 ? 1 : 2);
        // Nothing follows the start: no health poll (getInstance), no exec of any kind, no other power call
        expect(w.calls.slice(at + 1)).toEqual([]);
      }
    });

    it('ready: a start that still owns its wake asks before each of the four calls and after each start, and every call is sent once', async () => {
      const { w, p } = await prepare();
      const order: string[] = [];
      await expect(p.ready('m1', { freshBoot: true, stillMine: async () => (order.push(`ask@${power(w).length}`), true) })).resolves.toMatchObject({ bootId: BOOT });
      expect(power(w)).toEqual(['stop:m1', 'start:m1', 'stop:m1', 'start:m1']);
      // Asked right before each call, and again right after each start (CodeRabbit on #1040)
      expect(order).toEqual(['ask@0', 'ask@1', 'ask@2', 'ask@2', 'ask@3', 'ask@4']);
    });

    it('ready: an Orbit that asks nothing (no stillMine) restarts as before', async () => {
      const { w, p } = await prepare();
      await expect(p.ready('m1', { freshBoot: true })).resolves.toMatchObject({ bootId: BOOT });
      expect(power(w)).toEqual(['stop:m1', 'start:m1', 'stop:m1', 'start:m1']);
    });

    it('wake: refused after the waits (a machine going down, the billing call), no start is sent', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      await p.rest('m1');
      w.calls.length = 0;
      let asks = 0;
      await expect(p.wake('m1', { stillMine: async () => (asks++, false) })).rejects.toBeInstanceOf(WakeReplaced);
      expect(asks).toBe(1);
      expect(w.calls).not.toContain('start:m1');
      // Still its own: started once
      await p.wake('m1', { stillMine: async () => true });
      expect(w.calls.filter((call) => call === 'start:m1')).toHaveLength(1);
    });

    it('wake: a start whose sender was paused after the check and lost its wake is told right after the request returns, not after the wait for the machine to be healthy (CodeRabbit on #1040)', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      await p.rest('m1');
      // The machine never answers as healthy: without the second ask the start would wait for it (and fail with the error of the wait, the machine left running)
      w.setHealthy(false);
      w.calls.length = 0;
      let asks = 0;
      await expect(p.wake('m1', { stillMine: async () => ++asks < 2 })).rejects.toBeInstanceOf(WakeReplaced);
      expect(asks).toBe(2);
      expect(w.calls.filter((call) => call === 'start:m1')).toHaveLength(1);
    });

    it('wake: a machine that is already running is not asked about (nothing is sent to it)', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      let asks = 0;
      await p.wake('m1', { stillMine: async () => (asks++, false) });
      expect(asks).toBe(0);
    });
  });

  it('is ready when the second ask succeeds after a part that was still coming up', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    let runs = 0;
    w.setExec(() => (++runs === 1 ? 'ready=0 reason=browser\n' : 'ready=1 restart=0\n'));
    await expect(p.ready('m1')).resolves.toMatchObject({ bootId: BOOT });
    expect(w.execs.map((entry) => labelled(entry.command))).toEqual(['universe-up', 'universe-up', expect.stringContaining('unpack_wait='), 'mark']);
  });

  it('asks again once after the restart too, when the browser is still starting then', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    let runs = 0;
    w.setExec(() => ['ready=1 restart=1\n', 'ready=0 reason=browser\n', 'ready=1 restart=0\n'][Math.min(runs++, 2)]);
    await expect(p.ready('m1')).resolves.toMatchObject({ bootId: BOOT });
    expect(w.execs.map((entry) => labelled(entry.command))).toEqual(['universe-up', 'universe-up', 'universe-up', expect.stringContaining('unpack_wait='), 'mark']);
    expect(w.calls.filter((call) => call.startsWith('stop:') || call.startsWith('start:'))).toEqual(['stop:m1', 'start:m1']);
  });

  it('says the machine is not ready, with the reason, when a part did not come up', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.setExec(() => 'ready=0 reason=browser\n');
    await expect(p.ready('m1')).rejects.toThrow('not ready (browser)');
    // asked a second time before giving up: a part that was still coming up is not a failure
    expect(w.execs.filter((entry) => entry.command === 'universe-up')).toHaveLength(2);
    w.setExec(() => 'nothing useful');
    await expect(p.ready('m1')).rejects.toThrow('not ready');
  });

  describe('a machine behind the image (the image update replaces the disk outside the home folder)', () => {
    const CHECK = `${COLD_RUN} outside-check`;
    /** A machine on revision 1 while the image is on 2, answering the check with `says` and everything else as a ready computer. */
    async function behind(says: string | { stdout: string; exitCode?: number } | Error) {
      const w = world();
      const p = provider(w, { image: async () => state({ revision: 2 }) });
      await p.create('bot-1');
      w.instances.get('m1')!.template_revision = 1;
      w.setExec((command) => {
        if (command === CHECK) {
          if (says instanceof Error) throw says;
          return says;
        }
        return 'ready=1 restart=0\n';
      });
      return { w, p };
    }

    it('a start that lost its wake sends no image update (Opus on #1040: stillMine is asked right before it, after the check that can take minutes), and ready throws WakeReplaced', async () => {
      const { w, p } = await behind('outside_check=1 any=0\n');
      let asks = 0;
      await expect(p.ready('m1', { stillMine: async () => (asks++, false) })).rejects.toBeInstanceOf(WakeReplaced);
      expect(asks).toBe(1);
      expect(w.calls).not.toContain('update:m1');
      expect(w.calls.filter((call) => call.startsWith('stop:') || call.startsWith('start:'))).toEqual([]);
      // Still its own: the update is sent once, after the check
      await expect(p.ready('m1', { stillMine: async () => true })).resolves.toMatchObject({ bootId: BOOT });
      expect(w.calls.filter((call) => call === 'update:m1')).toHaveLength(1);
    });

    it('a start that lost its wake while the image update was on its way is told as soon as it returns, before anything else is brought up (CodeRabbit on #1040)', async () => {
      const { w, p } = await behind('outside_check=1 any=0\n');
      let asks = 0;
      (Sentry.captureMessage as jest.Mock).mockClear();
      await expect(p.ready('m1', { stillMine: async () => ++asks < 2 })).rejects.toBeInstanceOf(WakeReplaced);
      expect(asks).toBe(2);
      expect(w.calls.filter((call) => call === 'update:m1')).toHaveLength(1);
      expect(w.execs.some((entry) => entry.command === 'universe-up')).toBe(false);
      // The update was sent and the wake that sent it was lost: one warning, with the machine and both revisions (Opus on #1040)
      const warnings = (Sentry.captureMessage as jest.Mock).mock.calls.filter((call) => (call[1] as { tags?: { step?: string } })?.tags?.step === 'late-image-update-under-replacement');
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toMatchObject({ level: 'warning', tags: { area: 'computer' }, extra: { ref: 'm1', revision: 1, image: 2 } });
    });

    it('a start that is still its own after the image update, and one that lost its wake BEFORE the update (nothing was sent), warn nothing', async () => {
      const own = await behind('outside_check=1 any=0\n');
      (Sentry.captureMessage as jest.Mock).mockClear();
      await own.p.ready('m1', { stillMine: async () => true });
      const lost = await behind('outside_check=1 any=0\n');
      await expect(lost.p.ready('m1', { stillMine: async () => false })).rejects.toBeInstanceOf(WakeReplaced);
      expect((Sentry.captureMessage as jest.Mock).mock.calls.filter((call) => (call[1] as { tags?: { step?: string } })?.tags?.step === 'late-image-update-under-replacement')).toEqual([]);
    });

    it('a machine that is not behind the image is not asked about for an update (nothing is sent)', async () => {
      const w = world();
      const p = provider(w, { image: async () => state({ revision: 2 }) });
      await p.create('bot-1');
      w.setExec(() => 'ready=1 restart=0\n');
      let asks = 0;
      await p.ready('m1', { stillMine: async () => (asks++, true) });
      expect(asks).toBe(0);
    });

    it('moves it to the current image only after the computer says it holds nothing outside its home folder, and before it is brought up', async () => {
      const { w, p } = await behind('outside_check=1 any=0\n');
      (Sentry.captureMessage as jest.Mock).mockClear();
      await expect(p.ready('m1')).resolves.toMatchObject({ bootId: BOOT });
      expect(w.calls).toContain('update:m1');
      const asked = w.calls.indexOf(`exec:m1:${CHECK}`);
      expect(asked).toBeGreaterThan(-1);
      expect(asked).toBeLessThan(w.calls.indexOf('update:m1'));
      expect(w.calls.indexOf('update:m1')).toBeLessThan(w.calls.indexOf('exec:m1:universe-up'));
      // The check is the CURRENT script (sent first, as for a pack-away) run as root
      expect(w.execs.find((entry) => entry.command === CHECK)?.options).toMatchObject({ user: 'root' });
      expect(w.calls.findIndex((call) => /^exec:m1:.*cold-bin\/universe-cold\.new/.test(call))).toBeLessThan(asked);
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it.each([
      ['the computer holds files or software outside its home folder', 'outside_check=1 any=1\n'],
      ['the check ended with a reason', 'outside_check=0 reason=image_marker_missing\n'],
      ['the check said nothing a check says', 'nothing useful\n'],
      ['the check ran but exited with an error', { stdout: 'outside_check=1 any=0\n', exitCode: 1 }],
      ['the check could not be asked (the computer was not reached)', new Agent37Unreached('lost')],
    ])('does NOT move it when %s: nothing outside its home folder is deleted on a guess, the job still runs, and it is told to Sentry', async (_name, says) => {
      const { w, p } = await behind(says);
      (Sentry.captureMessage as jest.Mock).mockClear();
      await expect(p.ready('m1')).resolves.toMatchObject({ bootId: BOOT });
      expect(w.calls.some((call) => call.startsWith('update:'))).toBe(false);
      expect(w.execs.some((entry) => entry.command === 'universe-up')).toBe(true);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining('not updated'), expect.objectContaining({ level: 'warning' }));
    });

    it('does not move it when the current script could not be put on the computer (the check cannot run)', async () => {
      const { w, p } = await behind('outside_check=1 any=0\n');
      w.setColdInstall(false);
      w.setColdSum(null);
      w.setExec((command) => (command.startsWith('sha256sum') ? { stdout: '', exitCode: 1 } : command === CHECK ? 'outside_check=1 any=0\n' : 'ready=1 restart=0\n'));
      await expect(p.ready('m1')).resolves.toMatchObject({ bootId: BOOT });
      expect(w.calls.some((call) => call.startsWith('update:'))).toBe(false);
    });

    it('sends the script once to a machine that stays behind: a second job finds it in place (its sum is the right one) and sends no piece again, but a wrong or missing one is sent', async () => {
      const { w, p } = await behind('outside_check=1 any=1\n');
      const pieces = () => w.execs.filter((entry) => /base64 -d/.test(entry.command)).length;
      await p.ready('m1');
      expect(pieces()).toBeGreaterThan(0);
      // The first job put it there: the computer now says the sum of the current script
      w.setColdInPlace(COLD_SHA);
      w.execs.length = 0;
      await p.ready('m1');
      expect(pieces()).toBe(0);
      expect(w.execs.some((entry) => entry.command === CHECK)).toBe(true);
      // Another script in place (an older one) is sent over
      w.setColdInPlace('c'.repeat(64));
      w.execs.length = 0;
      await p.ready('m1');
      expect(pieces()).toBeGreaterThan(0);
    });

    it('tells Sentry once for each computer and image revision, however many jobs it runs; another revision is told again', async () => {
      const w = world();
      let revision = 2;
      const p = provider(w, { image: async () => state({ revision }) });
      await p.create('bot-1');
      w.instances.get('m1')!.template_revision = 1;
      w.setExec((command) => (command === CHECK ? 'outside_check=1 any=1\n' : 'ready=1 restart=0\n'));
      (Sentry.captureMessage as jest.Mock).mockClear();
      await p.ready('m1');
      await p.ready('m1');
      await p.ready('m1');
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(w.calls.some((call) => call.startsWith('update:'))).toBe(false);
      // The image moved on again: a new fact about the same computer, told again (once)
      revision = 3;
      await p.ready('m1');
      await p.ready('m1');
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
    });

    it('asks nothing of a machine already on the current image, and leaves it where it is', async () => {
      const w = world();
      const p = provider(w, { image: async () => state({ revision: 2 }) });
      await p.create('bot-1');
      w.instances.get('m1')!.template_revision = 2;
      w.setExec(() => 'ready=1 restart=0\n');
      await p.ready('m1');
      expect(w.calls.some((call) => call.startsWith('update:'))).toBe(false);
      expect(w.execs.some((entry) => entry.command.includes('outside-check'))).toBe(false);
    });

    it('a restore onto a computer behind the image still moves it first (a computer made for a restore holds nothing yet)', async () => {
      const w = world();
      const p = provider(w, { image: async () => state({ revision: 2 }) });
      await p.create('bot-1');
      w.instances.get('m1')!.template_revision = 1;
      w.setExec(() => 'ok');
      await p.restoreInto('m1', { url: 'https://orbit.example/x', token: 't', sha256: 'a'.repeat(64) }).catch(() => null);
      expect(w.calls).toContain('update:m1');
      expect(w.execs.some((entry) => entry.command.includes('outside-check'))).toBe(false);
    });
  });
});

describe('cold storage operations on a computer', () => {
  const source = { url: 'https://orbit.example/api/computer/archives/a1/download', token: 'tok', sha256: 'a'.repeat(64) };

  const SHA = 'b'.repeat(64);
  const manifest = { files: [['f', '/etc/app.conf', 4, 0o640, SHA], ['l', '/opt/tool/latest', 0, 0, 'run.sh']], packages: ['ffmpeg'] };

  it('reads the inventory a pack-away is decided on, as root, with the list of what it copied, and refuses one it cannot read whole', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.setExec(() => `noise\nprepack=${JSON.stringify({ home_files: 12, home_bytes: 3400, outside_files: 2, outside_bytes: 90, packages: ['ffmpeg', 'bad name!'], blocked: null, manifest })}\n`);
    await expect(p.prepack('m1')).resolves.toEqual({ homeFiles: 12, homeBytes: 3400, outsideFiles: 2, outsideBytes: 90, packages: ['ffmpeg'], blocked: null, outside: manifest });
    expect(w.execs.at(-1)).toMatchObject({ command: COLD_PREPACK, options: { user: 'root' } });
    // A computer that cannot be packed has no list (and needs none)
    w.setExec(() => 'prepack={"home_files":1,"home_bytes":1,"outside_files":9,"outside_bytes":9,"packages":[],"blocked":"too_big_outside","manifest":null}\n');
    expect((await p.prepack('m1')).blocked).toBe('too_big_outside');
    w.setExec(() => 'nothing useful\n');
    await expect(p.prepack('m1')).rejects.toThrow('could not be inventoried');
    w.setExec(() => 'prepack={"home_files":-1,"home_bytes":1,"outside_files":0,"outside_bytes":0}\n');
    await expect(p.prepack('m1')).rejects.toThrow('not whole');
    // One that can be packed but has no usable list is not packed (a copy with no list would put nothing back)
    for (const bad of [undefined, null, { files: [['f', '/etc/a', 1, 0o600, 'nothex']], packages: [] }, { files: [['f', '/home/node/x', 1, 0o600, SHA]], packages: [] }]) {
      w.setExec(() => `prepack=${JSON.stringify({ home_files: 1, home_bytes: 1, outside_files: 0, outside_bytes: 0, packages: [], blocked: null, manifest: bad })}\n`);
      await expect(p.prepack('m1')).rejects.toThrow('list of what is outside');
    }
  });

  describe('a long list of what is outside the home folder (Sentry on #1035)', () => {
    /** Thousands of files with long paths: the list is far over one command line (128 KiB) and over what Agent37 prints in one answer (512 KB). */
    const crowd = (count: number, extra: Partial<{ path: string }> = {}) => ({
      files: Array.from({ length: count }, (_, i) => ['f', extra.path && i === 0 ? extra.path : `/opt/many/${String(i).padStart(5, '0')}-${'x'.repeat(150)}`, 10 + i, 0o644, SHA] as ['f', string, number, number, string]),
      packages: ['ffmpeg'],
    });
    const hash = (text: string) => createHash('sha256').update(text, 'latin1').digest('hex');
    const line = (list: unknown, over: Record<string, unknown> = {}) => {
      const text = asciiJson(list);
      return `prepack=${JSON.stringify({ home_files: 12, home_bytes: 3400, outside_files: 3000, outside_bytes: 90, packages: ['ffmpeg'], blocked: null, manifest_bytes: text.length, manifest_sha256: hash(text), ...over })}\n`;
    };
    /** The computer: prints the line, and answers `python3 /usr/local/share/universe/cold-bin/universe-cold list-piece OFFSET LENGTH` from the list it holds, the way the script does. */
    const holding = (w: ReturnType<typeof world>, list: unknown, over: Record<string, unknown> = {}, tweak: (piece: string, at: number) => string = (piece) => piece) => {
      // The script writes plain ASCII (every other character is an escape), so that is what it serves
      const text = asciiJson(list);
      w.setExec((command) => {
        if (command === COLD_PREPACK) return line(list, over);
        const asked = /^python3 \/usr\/local\/share\/universe\/cold-bin\/universe-cold list-piece (\d+) (\d+)$/.exec(command);
        if (!asked) return 'ok';
        const at = Number(asked[1]);
        const piece = tweak(text.slice(at, at + Number(asked[2])), at);
        return `listpiece=${piece}|end|\n`;
      });
    };

    it('reads a list far longer than one answer in pieces, each asked as root, and every byte is checked', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      const list = crowd(3000);
      expect(JSON.stringify(list).length).toBeGreaterThan(512 * 1024);
      holding(w, list);
      const result = await p.prepack('m1');
      expect(result).toMatchObject({ blocked: null, outsideFiles: 3000, packages: ['ffmpeg'] });
      expect(result.outside).toEqual(list);
      const reads = w.execs.filter((entry) => entry.command.startsWith('python3 /usr/local/share/universe/cold-bin/universe-cold list-piece'));
      expect(reads.length).toBeGreaterThanOrEqual(3);
      for (const read of reads) {
        expect(read.options).toMatchObject({ user: 'root' });
        expect(Number(/ (\d+)$/.exec(read.command)![1])).toBeLessThanOrEqual(200_000);
      }
    });

    it('the modes of folders that are not 0755 travel with the list and are kept on the copy (a private folder stays private when a restore makes it again)', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      const list = { ...crowd(3), dirs: [['/opt/many/private', 0o700]] };
      holding(w, list);
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: null, outside: list });
      // And a restore sends them to finish with the rest of the list
      w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=1\n' : command.includes(FINISH) ? 'finished=1 files=3 packages=0 outside=applied\n' : 'ok'));
      await expect(p.restoreInto('m1', { ...source, outside: list as never })).resolves.toMatchObject({ ok: true });
      expect(w.execs.find((entry) => entry.command.includes(FINISH))!.command).toContain('"dirs":[["/opt/many/private",448]]');
    });

    it('a piece that is short, cut, missing or changed is an error (the pack-away is tried again), never a shorter or different list', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      const list = crowd(3000);
      holding(w, list, {}, (piece) => piece.slice(0, -1));
      await expect(p.prepack('m1')).rejects.toThrow('could not be read');
      holding(w, list, {}, (piece, at) => (at === 0 ? piece : piece.replace(/x/, 'y')));
      await expect(p.prepack('m1')).rejects.toThrow('could not be read');
      // Same length, one character changed in the last piece: only the SHA-256 can tell
      holding(w, list, {}, (piece, at) => (at > 0 ? `${piece.slice(0, -2)}9${piece.slice(-1)}` : piece));
      await expect(p.prepack('m1')).rejects.toThrow('could not be read');
      w.setExec((command) => (command === COLD_PREPACK ? line(list) : { stdout: 'listpiece=x|end|\n', truncated: true }));
      await expect(p.prepack('m1')).rejects.toThrow('could not be read');
      w.setExec((command) => (command === COLD_PREPACK ? line(list) : { stdout: '', exitCode: 1 }));
      await expect(p.prepack('m1')).rejects.toThrow('could not be read');
      // A line that says no length or no SHA-256 is not a list
      for (const over of [{ manifest_bytes: null }, { manifest_sha256: 'nothex' }, { manifest_bytes: 1 }]) {
        holding(w, list, over);
        await expect(p.prepack('m1')).rejects.toThrow('list of what is outside');
      }
    });

    it('every reason the script can give for a computer that cannot be packed (digits too) is read as a blocked computer, never a throw', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      // The reasons are read from the script itself, so a new one cannot be forgotten here
      const reasons = [...new Set([...UNIVERSE_COLD.matchAll(/(?:blocked = |stop\()"([a-z0-9_]+)"/g)].map((found) => found[1]))];
      expect(reasons).toEqual(expect.arrayContaining(['outside_name_not_utf8', 'packages_too_many', 'outside_too_big', 'outside_link', 'outside_list_too_big']));
      for (const reason of reasons) {
        w.setExec(() => `prepack=${JSON.stringify({ home_files: 1, home_bytes: 1, outside_files: 0, outside_bytes: 0, packages: [], blocked: reason, manifest_bytes: null, manifest_sha256: null })}\n`);
        await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: reason, outside: null });
      }
    });

    it('a piece with the right length but a character that is not plain printable ASCII is read again, never taken: the hash reads each character as one byte, so another character of the same length would pass it', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      const list = crowd(3);
      let changed = false;
      // The first answer for the first piece has its first x replaced by a character that is as long and hashes to the same byte (U+0178 is 0x78 in latin1)
      holding(w, list, {}, (piece, at) => {
        if (at !== 0 || changed) return piece;
        changed = true;
        return piece.replace('x', '\u0178');
      });
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: null, outside: list });
      expect(changed).toBe(true);
      // The piece at offset 0 was asked twice: the changed answer was refused, the second was taken
      expect(w.execs.filter((entry) => / list-piece 0 \d+$/.test(entry.command))).toHaveLength(2);
    });

    it('a pack-away is not held up by a lookup of the image that fails: it never moves the machine to the image, so it does not look at it', async () => {
      const w = world();
      let looked = 0;
      let down = false;
      const p = provider(w, { image: async () => {
        looked++;
        if (down) throw new Error('image lookup down');
        return { hash: 'h', state: 'ready', buildId: 'b', revision: 2, startedAt: new Date(0).toISOString(), failures: 0, error: null } as ImageState;
      } });
      await p.create('bot-1');
      down = true;
      looked = 0;
      holding(w, { files: [], packages: [] });
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: null });
      expect(looked).toBe(0);
    });

    it('output Agent37 cut (over 512 KB, the middle removed) is a computer that is blocked with a reason, never an inventory read from what is left', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      // The line itself cut: nothing to read
      w.setExec(() => ({ stdout: `${'noise\n'.repeat(100)}prepack={"home_files":1,"home_bytes":\n[... 700000 bytes cut ...]\nxxxx}`, truncated: true }));
      await expect(p.prepack('m1')).resolves.toEqual({ homeFiles: 0, homeBytes: 0, outsideFiles: 0, outsideBytes: 0, packages: [], blocked: 'inventory_output_too_long', outside: null });
      w.setExec(() => ({ stdout: 'noise only\n', truncated: true }));
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: 'inventory_output_too_long' });
      // The same output that was not cut is still an error of its own
      w.setExec(() => 'noise only\n');
      await expect(p.prepack('m1')).rejects.toThrow('could not be inventoried');
      // A short line that survived the cut whole is read as it is
      w.setExec((command) => (command === COLD_PREPACK ? { stdout: `${'noise\n'.repeat(1000)}${line({ files: [], packages: [] })}`, truncated: true } : { stdout: 'listpiece={"files":[],"packages":[]}|end|\n' }));
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: null, outside: { files: [], packages: [] } });
    });

    it('a name a database would refuse, more software than a list can carry, or more files than it can carry is a blocked computer with a reason, never a failure', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      // A file name that is not valid UTF-8 reads as a lone surrogate
      holding(w, crowd(3, { path: '/opt/many/bad-\udcff-name' }));
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: 'outside_name_not_utf8', outside: null, outsideFiles: 3000 });
      holding(w, { files: [['l', '/opt/tool/odd', 0, 0, 'to-\ud800']], packages: [] });
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: 'outside_name_not_utf8', outside: null });
      // A pair is a character, not a lone surrogate: a name in any script is fine
      holding(w, { files: [['f', '/opt/many/\u0627\u0644-\ud83d\ude00', 1, 0o644, SHA]], packages: [] });
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: null });
      holding(w, { files: [], packages: Array.from({ length: 2001 }, (_, i) => `pkg${i}`) });
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: 'packages_too_many', outside: null });
      holding(w, { files: [], packages: Array.from({ length: 2000 }, (_, i) => `pkg${i}`) });
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: null });
      holding(w, crowd(5001));
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: 'outside_too_big', outside: null });
      holding(w, crowd(5000));
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: null });
      // A list that is not the shape the script prints is still an error
      holding(w, { files: [['f', '/home/node/x', 1, 0o600, SHA]], packages: [] });
      await expect(p.prepack('m1')).rejects.toThrow('list of what is outside');
      // A list longer than a computer may hand over is blocked before any piece is read
      holding(w, crowd(1), { manifest_bytes: 33 * 1024 * 1024 });
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: 'outside_list_too_big' });
      expect(w.execs.at(-1)!.command).toBe(COLD_PREPACK);
    });

    it('a restore sends a list too long for one command in pieces, each command well under the 128 KiB a single argument may be, then finish reads that file', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      const list = crowd(3000);
      // A name in another script too: sent as plain ASCII escapes, so no piece is cut inside a character
      list.files[1][1] = '/opt/many/\u0627\u0644\u0645\u0644\u0641-\ud83d\ude00';
      const received: string[] = [];
      w.setExec((command) => {
        if (command.startsWith(`${COLD_RUN} restore`)) return 'restored=1\n';
        const put = /^python3 \/usr\/local\/share\/universe\/cold-bin\/universe-cold list-put (\d+) <<'(LIST_[0-9a-f]{24})'\n([^\n]*)\n\2$/.exec(command);
        if (put) {
          expect(Number(put[1])).toBe(received.join('').length);
          received.push(put[3]);
          return `listput=1 size=${received.join('').length}\n`;
        }
        return command.includes(FINISH) ? 'finished=1 files=3000 packages=1 outside=applied\n' : 'ok';
      });
      await expect(p.restoreInto('m1', { ...source, outside: list as never })).resolves.toMatchObject({ ok: true, reason: null });
      const text = received.join('');
      expect(JSON.parse(text)).toEqual(list);
      expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
      expect(received.length).toBeGreaterThan(8);
      const commands = w.execs.map((entry) => entry.command);
      for (const command of commands) expect(Buffer.byteLength(command)).toBeLessThan(100 * 1024);
      const puts = w.execs.filter((entry) => entry.command.includes(LISTPUT));
      for (const put of puts) expect(put.options).toMatchObject({ user: 'root' });
      const finish = w.execs.at(-1)!;
      expect(finish.command).toBe(`${FINISH} <<'FINISH_JSON'\n${JSON.stringify({ outside_file: { bytes: text.length, sha256: hash(text) } })}\nFINISH_JSON`);
      expect(finish.options).toMatchObject({ user: 'root' });
      // Every piece went before the finish, after the restore
      expect(commands.findIndex((command) => command.includes(LISTPUT))).toBe(commands.findIndex((command) => command.startsWith(`${COLD_RUN} restore`)) + 1);
    });

    it('a piece the computer did not take exactly as sent is a failed restore with a reason, and finish is never run', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      const list = crowd(3000);
      const answers: Array<(command: string) => string | { stdout: string; exitCode?: number; truncated?: boolean }> = [
        () => 'listput=0 reason=not_written\n',
        () => ({ stdout: 'listput=1 size=1\n' }),
        // The size it says is the right one: the exit code is the only thing wrong with this answer
        (command) => ({ stdout: `listput=1 size=${asPut(command)}\n`, exitCode: 1 }),
        () => '',
      ];
      for (const answer of answers) {
        w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=1\n' : command.includes(LISTPUT) ? answer(command) : 'ok'));
        await expect(p.restoreInto('m1', { ...source, outside: list as never })).resolves.toMatchObject({ ok: false, reason: 'finish_outside_transfer' });
        expect(w.execs.some((entry) => entry.command.includes(FINISH))).toBe(false);
        w.execs.length = 0;
      }
    });

    it('every piece, sent or read, has a name of its own, so Agent37 runs it again only when we mean it to and returns the first answer to a repeat of the same ask', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      const list = crowd(3000);
      holding(w, list);
      await p.prepack('m1');
      w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=1\n' : command.includes(LISTPUT) ? { stdout: `listput=1 size=${asPut(command)}\n` } : 'finished=1 files=0 packages=0 outside=applied\n'));
      await p.restoreInto('m1', { ...source, outside: list as never });
      const named = w.execs.filter((entry) => /list-(piece|put)/.test(entry.command));
      expect(named.length).toBeGreaterThan(12);
      const names = named.map((entry) => (entry.options as { name?: string }).name);
      expect(names.every((name) => typeof name === 'string' && /^cold-(read|put):[0-9a-f]{8}:\d+/.test(name))).toBe(true);
      expect(new Set(names).size).toBe(names.length);
      // The same list sent twice does not reuse a name (a name that is remembered would return the first answer for the second send)
      const again = w.execs.length;
      await p.restoreInto('m1', { ...source, outside: list as never });
      const second = w.execs.slice(again).filter((entry) => entry.command.includes(LISTPUT)).map((entry) => (entry.options as { name?: string }).name);
      expect(second.some((name) => names.includes(name))).toBe(false);
    });

    /** The size a put command would leave on the computer (its offset plus the piece it carries). */
    const asPut = (command: string) => {
      const found = /^python3 \/usr\/local\/share\/universe\/cold-bin\/universe-cold list-put (\d+) <<'(LIST_[0-9a-f]{24})'\n([^\n]*)\n\2$/.exec(command)!;
      return Number(found[1]) + found[3].length;
    };

    it('one piece that fails once does not fail the restore: the whole send starts again from the first piece, which makes the file new', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      const list = crowd(3000);
      for (const failure of ['refused', 'thrown', 'cut'] as const) {
        w.execs.length = 0;
        let failed = false;
        w.setExec((command) => {
          if (command.startsWith(`${COLD_RUN} restore`)) return 'restored=1\n';
          if (!command.includes(LISTPUT)) return 'finished=1 files=0 packages=0 outside=applied\n';
          if (!failed && command.startsWith(`${LISTPUT} 49152 `)) {
            failed = true;
            if (failure === 'thrown') throw new Agent37Unreached('lost');
            return failure === 'refused' ? 'listput=0 reason=not_written\n' : { stdout: 'listput=1 size=1\n', truncated: true };
          }
          return `listput=1 size=${asPut(command)}\n`;
        });
        await expect(p.restoreInto('m1', { ...source, outside: list as never })).resolves.toMatchObject({ ok: true, reason: null });
        const offsets = w.execs.filter((entry) => entry.command.includes(LISTPUT)).map((entry) => Number(/list-put (\d+)/.exec(entry.command)![1]));
        // 0, 49152 (failed), then again from 0 and all the way through
        expect(offsets.slice(0, 2)).toEqual([0, 49152]);
        expect(offsets.slice(2, 4)).toEqual([0, 49152]);
        expect(offsets.at(-1)).toBeGreaterThan(400_000);
        const finishes = w.execs.filter((entry) => entry.command.includes(FINISH));
        expect(finishes).toHaveLength(1);
      }
    });

    it('a send that fails on every try is a failed restore (a refusal) or the error itself (Agent37 not reached), after three tries, and finish never runs', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      const list = crowd(3000);
      w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=1\n' : 'listput=0 reason=not_written\n'));
      await expect(p.restoreInto('m1', { ...source, outside: list as never })).resolves.toMatchObject({ ok: false, reason: 'finish_outside_transfer' });
      expect(w.execs.filter((entry) => entry.command.startsWith(`${LISTPUT} 0 `))).toHaveLength(3);
      w.execs.length = 0;
      w.setExec((command) => {
        if (command.startsWith(`${COLD_RUN} restore`)) return 'restored=1\n';
        throw new Agent37Unreached('down');
      });
      await expect(p.restoreInto('m1', { ...source, outside: list as never })).rejects.toThrow('down');
      expect(w.execs.filter((entry) => entry.command.startsWith(`${LISTPUT} 0 `))).toHaveLength(3);
      expect(w.execs.some((entry) => entry.command.includes(FINISH))).toBe(false);
    });

    it('a piece read that fails once (thrown, short, cut, no exit 0) is asked again and the list is still read whole; three failures in a row are an error', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      const list = crowd(3000);
      const text = JSON.stringify(list);
      for (const failure of ['thrown', 'short', 'cut', 'exit'] as const) {
        for (const at of [0, 200_000]) {
          let failed = 0;
          w.setExec((command) => {
            if (command === COLD_PREPACK) return line(list);
            const asked = /^python3 \/usr\/local\/share\/universe\/cold-bin\/universe-cold list-piece (\d+) (\d+)$/.exec(command)!;
            const from = Number(asked[1]);
            const piece = text.slice(from, from + Number(asked[2]));
            if (from === at && failed < 1) {
              failed++;
              if (failure === 'thrown') throw new Agent37Unreached('lost');
              if (failure === 'short') return `listpiece=${piece.slice(0, -1)}|end|\n`;
              if (failure === 'cut') return { stdout: `listpiece=${piece}|end|\n`, truncated: true };
              return { stdout: '', exitCode: 1 };
            }
            return `listpiece=${piece}|end|\n`;
          });
          await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: null, outside: list });
          expect(failed).toBe(1);
        }
      }
      let failures = 0;
      w.setExec((command) => {
        if (command === COLD_PREPACK) return line(list);
        if (/ 200000 \d+$/.test(command)) {
          failures++;
          throw new Agent37Unreached('lost');
        }
        const asked = /^python3 \/usr\/local\/share\/universe\/cold-bin\/universe-cold list-piece (\d+) (\d+)$/.exec(command)!;
        return `listpiece=${text.slice(Number(asked[1]), Number(asked[1]) + Number(asked[2]))}|end|\n`;
      });
      await expect(p.prepack('m1')).rejects.toThrow('lost');
      expect(failures).toBe(3);
    });

    it('a piece that ends in a space is read whole even when the end of the answer is trimmed on the way (the computer prints an end marker after it)', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      // A path with a space as the very last character of the first piece (a piece is 200,000 characters)
      const original = JSON.stringify(crowd(3000));
      expect(original[199_999]).toBe('x');
      const padded = JSON.parse(`${original.slice(0, 199_999)} ${original.slice(200_000)}`) as ReturnType<typeof crowd>;
      const whole = JSON.stringify(padded);
      expect(whole[199_999]).toBe(' ');
      w.setExec((command) => {
        if (command === COLD_PREPACK) return line(padded);
        const asked = /^python3 \/usr\/local\/share\/universe\/cold-bin\/universe-cold list-piece (\d+) (\d+)$/.exec(command)!;
        const from = Number(asked[1]);
        // What the script prints, after a transport that strips white space from the end of an answer
        return { stdout: `listpiece=${whole.slice(from, from + Number(asked[2]))}|end|\n`.trimEnd() };
      });
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: null, outside: padded });
    });

    it('a list that fits one command is still sent as it always was (no pieces)', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=1\n' : command.includes(FINISH) ? 'finished=1 files=0 packages=0 outside=applied\n' : 'ok'));
      await p.restoreInto('m1', { ...source, outside: crowd(100) as never });
      const run = w.execs.map((entry) => entry.command).filter((command) => command.startsWith(`${COLD_RUN} restore`) || command.includes(FINISH) || command.includes(LISTPUT));
      expect(run.map((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restore' : 'finish'))).toEqual(['restore', 'finish']);
      expect(run[1]).toBe(`${FINISH} <<'FINISH_JSON'\n${JSON.stringify({ outside: crowd(100) })}\nFINISH_JSON`);
    });
  });

  describe('a pack-away never moves the computer to another image, and runs the script Orbit sends', () => {
    const state = (over: Partial<ImageState> = {}): ImageState => ({ hash: 'h', state: 'ready', buildId: 'b', revision: 2, startedAt: new Date(0).toISOString(), failures: 0, error: null, ...over });
    const printsList = (w: ReturnType<typeof world>) => w.setExec((command) => (command === COLD_PREPACK ? `prepack=${JSON.stringify({ home_files: 12, home_bytes: 3400, outside_files: 2, outside_bytes: 90, packages: [], blocked: null, manifest })}\n` : 'ok'));
    /** What the machine would have written: the base64 of every install command, decoded and joined. */
    const written = (w: ReturnType<typeof world>) => Buffer.concat(w.execs.map((entry) => /^umask 077 && .*printf %s '([A-Za-z0-9+/=]*)' \| base64 -d >>? /.exec(entry.command)?.[1]).filter((piece): piece is string => piece !== undefined).map((piece) => Buffer.from(piece, 'base64'))).toString('utf8');

    it('a machine on an older image is NOT updated: its rule and budget are set, the current script is sent and checked, then run from where it was put', async () => {
      const w = world();
      const p = provider(w, { image: async () => state({ revision: 2 }) });
      await p.create('bot-1');
      w.instances.get('m1')!.template_revision = 1;
      // What create did is not evidence of what prepack does: the log starts empty, and the machine is one whose network rule is another and whose monthly cap is not zero
      w.calls.length = 0;
      w.instances.get('m1')!.network = 'block-all' as never;
      w.budgets.set('m1', { cap: 5_000_000, credit: 0 });
      printsList(w);
      await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: null, outside: manifest });
      // The image update would replace the disk outside the home folder (or move the build marker): it is never asked for here
      expect(w.calls.some((call) => call.startsWith('update:'))).toBe(false);
      expect(w.instances.get('m1')!.template_revision).toBe(1);
      // Both are put right by prepack itself, before the first command runs on the machine
      const firstExec = w.calls.findIndex((call) => call.startsWith('exec:m1:'));
      expect(firstExec).toBeGreaterThanOrEqual(0);
      expect(w.calls.indexOf('network:m1')).toBeGreaterThanOrEqual(0);
      expect(w.calls.indexOf('network:m1')).toBeLessThan(firstExec);
      expect(w.calls.indexOf('cap:m1:0')).toBeGreaterThanOrEqual(0);
      expect(w.calls.indexOf('cap:m1:0')).toBeLessThan(firstExec);
      expect(w.instances.get('m1')!.network).toBe('allow-all');
      expect(w.budgets.get('m1')!.cap).toBe(0);
      // The first thing asked is whether the current script is already in place (it is not here); the rest is as before
      expect(w.execs[0].command).toBe(`sha256sum ${COLD_PATH}`);
      const commands = w.execs.map((entry) => entry.command).filter((command) => command !== `sha256sum ${COLD_PATH}`);
      // First the script goes over (a root-only folder, a file made new), then the machine's own sha256sum, then the move, then prepack from the installed path, then the list
      expect(commands[0]).toMatch(/^umask 077 && mkdir -p \/usr\/local\/share\/universe\/cold-bin && chown root:root \/usr\/local\/share\/universe\/cold-bin && chmod 755 \/usr\/local\/share\/universe\/cold-bin && printf %s '[A-Za-z0-9+/=]+' \| base64 -d > \/usr\/local\/share\/universe\/cold-bin\/universe-cold\.new$/);
      expect(commands.slice(-3)).toEqual([`sha256sum ${COLD_PATH}.new`, COLD_MOVE, COLD_PREPACK]);
      expect(commands.indexOf(`sha256sum ${COLD_PATH}.new`)).toBeLessThan(commands.indexOf(COLD_MOVE));
      expect(commands.indexOf(COLD_MOVE)).toBeLessThan(commands.indexOf(COLD_PREPACK));
      expect(commands.some((command) => command.startsWith('universe-cold '))).toBe(false);
      for (const entry of w.execs) expect(entry.options).toMatchObject({ user: 'root' });
      // Every command stays far under what one argument may be (about 128 KiB)
      for (const command of commands) expect(Buffer.byteLength(command)).toBeLessThan(100 * 1024);
      // What went over is the current script, byte for byte
      expect(written(w)).toBe(UNIVERSE_COLD);
    });

    it('a machine already on the current image is sent the script too (there is no revision to branch on), and is not updated either', async () => {
      const w = world();
      const p = provider(w, { image: async () => state({ revision: 2 }) });
      await p.create('bot-1');
      w.instances.get('m1')!.template_revision = 2;
      printsList(w);
      await p.prepack('m1');
      expect(w.calls.some((call) => call.startsWith('update:'))).toBe(false);
      expect(written(w)).toBe(UNIVERSE_COLD);
      // A machine that does not say its revision is sent it as well
      const w2 = world();
      const q = provider(w2, { image: async () => state({ revision: 2 }) });
      await q.create('bot-1');
      delete (w2.instances.get('m1') as { template_revision?: number }).template_revision;
      printsList(w2);
      await q.prepack('m1');
      expect(written(w2)).toBe(UNIVERSE_COLD);
    });

    it('a script that did not arrive whole (the machine\'s sha256sum is not Orbit\'s) is an error after three tries, it is never moved into place, and prepack is never run', async () => {
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      printsList(w);
      w.setColdSum('0'.repeat(64));
      await expect(p.prepack('m1')).rejects.toThrow('did not arrive whole');
      const commands = w.execs.map((entry) => entry.command).filter((command) => command !== `sha256sum ${COLD_PATH}`);
      expect(commands.filter((command) => command.startsWith('sha256sum'))).toHaveLength(3);
      expect(commands.some((command) => command.startsWith('chmod 644'))).toBe(false);
      expect(commands).not.toContain(COLD_PREPACK);
      // No answer, or one that is not a hash, is the same
      for (const answer of ['', 'not a hash\n', `${COLD_SHA.toUpperCase()}  x\n`]) {
        w.execs.length = 0;
        w.setColdSum(null);
        w.setExec((command) => (command.startsWith('sha256sum') ? answer : 'ok'));
        await expect(p.prepack('m1')).rejects.toThrow('did not arrive whole');
        expect(w.execs.some((entry) => entry.command.startsWith('chmod 644') || entry.command === COLD_PREPACK)).toBe(false);
      }
    });

    it('a command that is lost or fails once starts the install again from the first piece, each command under a name of its own, and the pack-away goes on', async () => {
      for (const failure of ['thrown', 'exit', 'cut'] as const) {
        const w = world();
        const p = provider(w);
        await p.create('bot-1');
        printsList(w);
        const execute = w.client.exec.bind(w.client);
        let failed = false;
        // Every command that is asked, the one that fails too (the machine's own log only holds the ones that ran)
        const asked: Array<{ command: string; name?: string }> = [];
        (w.client as unknown as { exec: (id: string, command: string, options?: ExecOptions) => Promise<unknown> }).exec = async (id, command, options) => {
          asked.push({ command, name: (options as { name?: string } | undefined)?.name });
          if (!failed && command.startsWith('umask 077')) {
            failed = true;
            if (failure === 'thrown') throw new Agent37Unreached('lost');
            return { exitCode: failure === 'exit' ? 1 : 0, stdout: '', stderr: '', truncated: failure === 'cut' };
          }
          return execute(id, command, options);
        };
        await expect(p.prepack('m1')).resolves.toMatchObject({ blocked: null });
        expect(failed).toBe(true);
        const names = w.execs.filter((entry) => !entry.command.startsWith('python3') && entry.command !== `sha256sum ${COLD_PATH}`).map((entry) => (entry.options as { name?: string }).name);
        expect(names.every((name) => typeof name === 'string' && name.startsWith('cold-install:'))).toBe(true);
        expect(new Set(names).size).toBe(names.length);
        // One command for each piece of the script (the script is a few pieces of at most 48 KiB: each its own command, the first makes the file new)
        expect(w.execs.filter((entry) => entry.command.startsWith('umask 077'))).toHaveLength(Math.ceil(Buffer.byteLength(UNIVERSE_COLD) / LIST_SEND_PIECE));
        // The failed first piece and the piece the new try starts with are the same first piece (offset zero: the file is made new), under two different names
        const firsts = asked.filter((entry) => entry.command.startsWith('umask 077 && mkdir -p'));
        expect(firsts).toHaveLength(2);
        expect(firsts[0].command).toBe(firsts[1].command);
        expect(firsts[0].name).not.toBe(firsts[1].name);
        const allNames = asked.filter((entry) => !entry.command.startsWith('python3')).map((entry) => entry.name);
        expect(new Set(allNames).size).toBe(allNames.length);
      }
      // Lost on every try: the error itself, and prepack never runs
      const w = world();
      const p = provider(w);
      await p.create('bot-1');
      (w.client as unknown as { exec: () => Promise<unknown> }).exec = async () => {
        throw new Agent37Unreached('down');
      };
      await expect(p.prepack('m1')).rejects.toThrow('down');
    });
  });

  it('makes a throwaway computer with the same network rule and a closed budget, named so it is never mistaken for a Brick’s', async () => {
    const w = world();
    const info = await provider(w).makeScratch();
    expect(info.ref).toBe('m1');
    const made = w.created[0];
    expect(made.metadata?.creation_id).toMatch(/^scratch:/);
    expect(Number(made.metadata?.made_at)).toBeGreaterThan(0);
    expect(made.network).toBe(BRICK_NETWORK);
    expect(made.budget).toEqual({ monthly_cap_micros: 0, credit_micros: 0 });
    // A Brick's own lookup never finds it
    const brick = await provider(w).create('bot-1');
    expect(brick.ref).not.toBe('m1');
  });

  it('restores a copy: the machine put in order first, then the fetch and check, then the finish as root', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=1 files=12\n' : command.includes(FINISH) ? 'finished=1 files=0 packages=0 outside=applied\n' : 'ok'));
    const result = await p.restoreInto('m1', { ...source, outside: manifest as never });
    expect(result).toMatchObject({ ok: true, reason: null });
    expect(result.outside).toBeUndefined();
    const commands = w.execs.map((entry) => entry.command);
    const at = commands.findIndex((command) => command.startsWith(`${COLD_RUN} restore`));
    expect(commands[at]).toMatch(/^python3 \/usr\/local\/share\/universe\/cold-bin\/universe-cold restore <<'RESTORE_JSON'/);
    expect(commands[at]).toContain(source.url);
    expect(commands[at]).toContain(source.sha256);
    // The current script is put on the machine and checked before anything is restored, and `finish` runs from that fresh copy, as root, never the installed one
    expect(commands.slice(0, at)).toContain(`sha256sum ${COLD_PATH}.new`);
    expect(commands.slice(0, at)).toContain(COLD_MOVE);
    expect(commands.slice(0, at).some((command) => command.startsWith(`${COLD_RUN} finish`))).toBe(false);
    // Nothing runs from the image's own script: every cold command is the current one, run from where it was put
    expect(commands.some((command) => command.startsWith('universe-cold '))).toBe(false);
    // The finish gets the list Orbit kept for the copy, on standard input (never read from the home folder)
    expect(commands[at + 1]).toBe(`${FINISH} <<'FINISH_JSON'\n${JSON.stringify({ outside: manifest })}\nFINISH_JSON`);
    expect(w.execs[at + 1].options).toMatchObject({ user: 'root' });
    // Its budget was read before anything was put on it
    expect(w.calls.indexOf('budget:m1')).toBeGreaterThanOrEqual(0);
    expect(w.calls.indexOf('budget:m1')).toBeLessThan(w.calls.indexOf(`exec:m1:${commands[0]}`));
  });

  it('a machine that does not say its image revision (an old image) is sent the current script first, and restore, every list piece and finish all run from it, never from the image\'s own universe-cold (Opus verdict on #1035)', async () => {
    const w = world();
    const p = provider(w, { image: async () => ({ hash: 'h', state: 'ready', buildId: 'b', revision: 2, startedAt: new Date(0).toISOString(), failures: 0, error: null }) });
    await p.create('bot-1');
    delete (w.instances.get('m1') as { template_revision?: number }).template_revision;
    w.execs.length = 0;
    const list = { files: Array.from({ length: 2500 }, (_, i) => ['f', `/opt/many/file-${i}-${'x'.repeat(40)}`, 1, 0o644, 'a'.repeat(64)]), packages: [] };
    w.setExec((command) => {
      if (command.startsWith(`${COLD_RUN} restore`)) return 'restored=1\n';
      if (command.includes(LISTPUT)) return `listput=1 size=${asPutSize(command)}\n`;
      return command.includes(FINISH) ? 'finished=1 files=2500 packages=0 outside=applied\n' : 'ok';
    });
    await expect(p.restoreInto('m1', { ...source, outside: list as never })).resolves.toMatchObject({ ok: true });
    const commands = w.execs.map((entry) => entry.command);
    const restore = commands.findIndex((command) => command.startsWith(`${COLD_RUN} restore`));
    // The pieces of the script, the machine's own sum and the move all come before the restore
    expect(commands.slice(0, restore).some((command) => command.startsWith('umask 077 && '))).toBe(true);
    expect(commands.slice(0, restore)).toContain(`sha256sum ${COLD_PATH}.new`);
    expect(commands.slice(0, restore)).toContain(COLD_MOVE);
    // Every cold command that follows is the current script, from where it was put
    const cold = commands.slice(restore).filter((command) => /universe-cold/.test(command));
    expect(cold.length).toBeGreaterThan(3);
    for (const command of cold) expect(command.startsWith(`python3 ${COLD_PATH} `)).toBe(true);
    expect(commands.some((command) => command.startsWith('universe-cold '))).toBe(false);
    // The restore runs as the computer's own user (no user given), the list pieces and finish as root
    const asked = w.execs.find((entry) => entry.command.startsWith(`${COLD_RUN} restore`))!;
    expect((asked.options as { user?: string } | undefined)?.user).toBeUndefined();
  });

  it('a script that could not be put on the computer is thrown (never a copy that did not check out), and neither restore nor finish was run', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.execs.length = 0;
    w.setColdInstall(false);
    w.setColdSum(null);
    w.setExec((command) => (command.startsWith('sha256sum') ? { stdout: '', exitCode: 1 } : 'ok'));
    await expect(p.restoreInto('m1', source)).rejects.toThrow();
    const commands = w.execs.map((entry) => entry.command);
    expect(commands.some((command) => command.startsWith(`${COLD_RUN} restore`) || command.includes(FINISH) || command.includes(LISTPUT))).toBe(false);
  });

  it('says why a restore did not check out, in a word, and does not go on to the finish', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=0 reason=sha_mismatch\n' : 'ok'));
    await expect(p.restoreInto('m1', source)).resolves.toMatchObject({ ok: false, reason: 'sha_mismatch' });
    expect(w.execs.map((entry) => entry.command).filter((command) => command.includes(FINISH))).toEqual([]);
    w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=1\n' : command.includes(FINISH) ? 'finished=0 reason=packages\n' : 'ok'));
    await expect(p.restoreInto('m1', source)).resolves.toMatchObject({ ok: false, reason: 'finish_packages' });
    w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=1\n' : command.includes(FINISH) ? 'finished=0 reason=outside_tampered\n' : 'ok'));
    await expect(p.restoreInto('m1', { ...source, outside: manifest as never })).resolves.toMatchObject({ ok: false, reason: 'finish_outside_tampered' });
  });

  it('keeps the number in a reason (how many files differed), which a reason of letters alone lost', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=0 reason=differs_12\n' : 'ok'));
    await expect(p.restoreInto('m1', source)).resolves.toMatchObject({ ok: false, reason: 'differs_12' });
    w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=1\n' : command.includes(FINISH) ? 'finished=0 reason=outside_missing_2\n' : 'ok'));
    await expect(p.restoreInto('m1', { ...source, outside: manifest as never })).resolves.toMatchObject({ ok: false, reason: 'finish_outside_missing_2' });
  });

  it('is never good on a finish that does not say it put the list back: no marker, or the wrong one for what was sent', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    const answer = (finish: string) => w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=1\n' : command.includes(FINISH) ? finish : 'ok'));
    // An older script says only finished=1 (no marker), or says unverified for a list that was sent, or applied for none
    answer('finished=1 files=0 packages=0\n');
    await expect(p.restoreInto('m1', { ...source, outside: manifest as never })).resolves.toMatchObject({ ok: false, reason: 'finish_outside_not_confirmed' });
    answer('finished=1 files=0 packages=0 outside=unverified\n');
    await expect(p.restoreInto('m1', { ...source, outside: manifest as never })).resolves.toMatchObject({ ok: false, reason: 'finish_outside_not_confirmed' });
    answer('finished=1 files=0 packages=0 outside=applied\n');
    await expect(p.restoreInto('m1', source)).resolves.toMatchObject({ ok: false, reason: 'finish_outside_not_confirmed' });
    answer('finished=1 files=0 packages=0 outside=applied\n');
    await expect(p.restoreInto('m1', { ...source, outside: manifest as never })).resolves.toMatchObject({ ok: true });
  });

  it('a copy with no list is restored with a null list, and the result says nothing outside the home folder was put back; a list that is not exactly one is sent as null', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.setExec((command) => (command.startsWith(`${COLD_RUN} restore`) ? 'restored=1\n' : command.includes(FINISH) ? 'finished=1 files=0 packages=0 outside=unverified\n' : 'ok'));
    await expect(p.restoreInto('m1', source)).resolves.toMatchObject({ ok: true, reason: null, outside: 'unverified' });
    expect(w.execs.at(-1)!.command).toBe(`${FINISH} <<'FINISH_JSON'\n{"outside":null}\nFINISH_JSON`);
    await p.restoreInto('m1', { ...source, outside: { files: [['f', '/etc/x', 1, 0, 'nothex']], packages: [] } as never });
    expect(w.execs.at(-1)!.command).toContain('{"outside":null}');
  });

  it('confirms a computer is gone only when the provider no longer lists it, and says it is still there otherwise', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    await p.remove('m1');
    await expect(p.confirmRemoved('m1')).resolves.toBe('gone');
    const stuck = world();
    const q = provider(stuck);
    await q.create('bot-1');
    // Still listed (the delete was asked and Agent37 has not finished): never "gone"
    await expect(q.confirmRemoved('m1')).resolves.toBe('still_there');
  });

  it('removes only throwaway computers that are old enough, never a Brick’s', async () => {
    const w = world();
    const clock = { t: 10_000_000 };
    const p = provider(w, { clock });
    await p.create('bot-1');
    await p.makeScratch();
    expect(await p.removeScratches(60 * 60_000)).toBe(0);
    clock.t += 2 * 60 * 60_000;
    expect(await p.removeScratches(60 * 60_000)).toBe(1);
    expect([...w.instances.keys()]).toEqual(['m1']);
  });
});

describe('Agent37 managed spending stays shut (monthly cap AND one-time credit)', () => {
  const open = (w: ReturnType<typeof world>, id: string, cap: number, credit: number) => w.budgets.set(id, { cap, credit });

  it('reads both parts of a new machine’s budget when it is made, and again when it is made ready', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    expect(w.created[0].budget).toEqual({ monthly_cap_micros: 0, credit_micros: 0 });
    expect(w.calls.filter((call) => call === 'budget:m1')).toHaveLength(1);
    w.setExec(() => 'ready=1 restart=0\n');
    await p.ready('m1');
    expect(w.calls.filter((call) => call === 'budget:m1')).toHaveLength(2);
  });

  it('sets a monthly cap that is not zero back to zero (and reads it again) before handing the machine on', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    open(w, 'm1', 5_000_000, 0);
    w.setExec(() => 'ready=1 restart=0\n');
    await expect(p.ready('m1')).resolves.toMatchObject({ bootId: BOOT });
    expect(w.calls).toContain('cap:m1:0');
    expect(w.budgets.get('m1')).toEqual({ cap: 0, credit: 0 });
  });

  it('does not hand over a machine that still holds one-time credit: a $0 cap alone leaves it spendable, and the credit is never spent down', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    open(w, 'm1', 0, 2_000_000);
    w.setExec(() => 'ready=1 restart=0\n');
    await expect(p.ready('m1')).rejects.toThrow('managed budget is not zero');
    expect(w.execs).toEqual([]);
    // Nothing was done to the credit: no top-up, no cap raised
    expect(w.calls.filter((call) => call.startsWith('cap:') && !call.endsWith(':0'))).toEqual([]);
    expect(w.budgets.get('m1')).toEqual({ cap: 0, credit: 2_000_000 });
  });

  it('checks the budget of a machine it adopts (one nobody wrote down may have been topped up) and refuses it when credit is left', async () => {
    const w = world();
    w.instances.set('old1', { id: 'old1', status: 'running', url: 'https://old1.agent37.app', metadata: { creation_id: 'brick:bot-1' }, region: 'us' } as Instance);
    open(w, 'old1', 0, 1_000);
    await expect(provider(w).create('bot-1')).rejects.toThrow('managed budget is not zero');
    open(w, 'old1', 0, 0);
    await expect(provider(w).create('bot-1')).resolves.toMatchObject({ ref: 'old1' });
  });

  it('checks the budget of a machine a copy is restored onto, before anything is put on it, and of a throwaway one', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    open(w, 'm1', 0, 500);
    await expect(p.restoreInto('m1', { url: 'https://orbit.example/d', token: 't', sha256: 'a'.repeat(64) })).rejects.toThrow('managed budget is not zero');
    expect(w.execs).toEqual([]);
    const scratch = world();
    const q = provider(scratch);
    await q.makeScratch();
    expect(scratch.calls).toContain('budget:m1');
  });

  it('says in the checkup how many machines still have budget, and that the broker is what guards paid actions', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    const named = (checks: Array<{ name: string; ok: boolean; detail: string }>) => Object.fromEntries(checks.map((check) => [check.name, check]));
    expect(named(await p.checkup())['agent37 managed budget']).toMatchObject({ ok: true });
    open(w, 'm1', 0, 700);
    expect(named(await p.checkup())['agent37 managed budget']).toMatchObject({ ok: false });
    const broker = named(await p.checkup())['orbit broker'];
    expect(broker.detail).toMatch(/Orbit/);
  });

  it('keeps the open internet: a machine is made with allow-all and nothing about a gateway', async () => {
    const w = world();
    await provider(w).create('bot-1');
    expect(w.created[0].network).toBe(BRICK_NETWORK);
    expect(BRICK_NETWORK).toBe('allow-all');
    expect(JSON.stringify(w.created[0])).not.toMatch(/gateway|proxy|3128/);
  });
});
