import { Agent37Error, Agent37Unreached, type Agent37Client, type Instance } from '@/lib/agent37/client';
import { Agent37ComputerProvider, Agent37FundsLow, BRICK_NETWORK, DESKTOP_PORT, ImageNotReady } from '@/lib/agent37/provider';
import type { ImageState } from '@/lib/agent37/image';
import { isMarkCommand } from '@/lib/computer-fence-script';
import { awakeMicrosPerMinute, dayOfRunningMicros, BRICK_SHAPE } from '@/lib/agent37/rates';

jest.mock('@/lib/agent37/saved-copies', () => ({ savedCopyOf: jest.fn(), storeSavedCopy: jest.fn() }));

const BOOT = '3f2b6c1e-8a44-4d0b-9c15-5e7d2a9b1c33';
/** What a command is, in a word: the mark command carries a whole script. */
const labelled = (command: string) => (isMarkCommand(command) ? 'mark' : command);

/** A pretend Agent37: instances that keep a status, and a record of every call. */
function world(options: { balanceUsd?: number; pastDue?: boolean } = {}) {
  const instances = new Map<string, Instance>();
  const calls: string[] = [];
  const execs: Array<{ id: string; command: string; options: unknown }> = [];
  let healthy = true;
  let execOut: (command: string) => string = () => 'ok';
  let markOut = `boot=${BOOT}\nticks=1234\npart=77:500:p\nrunner=${'a'.repeat(64)}\nmarked=1\n`;
  let revisionAfterUpdate = 2;
  /** What Agent37 holds as each machine's managed budget: the monthly cap and the remaining one-time credit (a machine not here has both at zero). */
  const budgets = new Map<string, { cap: number; credit: number }>();
  const refuse: Record<string, Error | undefined> = {};
  const client = {
    async listInstances() {
      calls.push('list');
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
    async startInstance(id: string) {
      calls.push(`start:${id}`);
      instances.get(id)!.status = 'running';
      return { id, status: 'running' };
    },
    async sleepInstance(id: string) {
      calls.push(`sleep:${id}`);
      instances.get(id)!.status = 'sleeping';
      instances.get(id)!.slept_at = Math.floor(Date.now() / 1000);
      return { id, status: 'sleeping' };
    },
    async stopInstance(id: string) {
      calls.push(`stop:${id}`);
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
      return { exitCode: 0, stdout: isMarkCommand(command) ? markOut : execOut(command), stderr: '', truncated: false };
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
  return { client: client as unknown as Agent37Client, instances, budgets, calls, execs, created, networks, usage, refuse, setHealthy: (value: boolean) => (healthy = value), setExec: (fn: (command: string) => string) => (execOut = fn), setMark: (value: string) => (markOut = value) };
}

function provider(w: ReturnType<typeof world>, extra: { image?: () => Promise<ImageState | null>; reserved?: number; copies?: ConstructorParameters<typeof Agent37ComputerProvider>[0]['copies']; clock?: { t: number } } = {}) {
  const clock = extra.clock ?? { t: 1_000_000 };
  return new Agent37ComputerProvider({
    client: w.client,
    outstandingReserveMicros: async () => extra.reserved ?? 0,
    sleep: async () => {
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
    expect(w.execs.map((entry) => labelled(entry.command))).toEqual(['universe-up', 'mark']);
    expect(w.execs[1].options).not.toHaveProperty('user');
    expect(w.execs[1].command).not.toMatch(/\/run\/universe|mkdir|chown|>\s*"?\$DIR/);
    expect(w.calls.filter((call) => call.startsWith('stop:'))).toEqual([]);
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
    expect(w.execs.map((entry) => labelled(entry.command))).toEqual(['universe-up', 'universe-up', 'mark']);
    expect(w.calls.filter((call) => call.startsWith('stop:') || call.startsWith('start:'))).toEqual(['stop:m1', 'start:m1']);
  });

  it('starts the machine afresh before anything else when asked for a fresh boot, and never otherwise (a computer that worked before and has no mark saved by Orbit)', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.setExec(() => 'ready=1 restart=0\n');
    await p.ready('m1');
    expect(w.calls.filter((call) => call.startsWith('stop:') || call.startsWith('start:'))).toEqual([]);
    await expect(p.ready('m1', { freshBoot: true })).resolves.toMatchObject({ bootId: BOOT });
    // The restart comes before the screen and browser are brought up and before the mark is read: the mark is of the new boot, taken with nothing of an earlier job running
    const second = w.calls.slice(w.calls.lastIndexOf('stop:m1'));
    const kinds = second.flatMap((call) => (call.startsWith('stop:') ? ['stop'] : call.startsWith('start:') ? ['start'] : call.startsWith('exec:m1:') ? [labelled(call.slice('exec:m1:'.length)) === 'universe-up' ? 'up' : isMarkCommand(call.slice('exec:m1:'.length)) ? 'mark' : 'other'] : []));
    expect(kinds).toEqual(['stop', 'start', 'up', 'mark']);
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

  it('is ready when the second ask succeeds after a part that was still coming up', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    let runs = 0;
    w.setExec(() => (++runs === 1 ? 'ready=0 reason=browser\n' : 'ready=1 restart=0\n'));
    await expect(p.ready('m1')).resolves.toMatchObject({ bootId: BOOT });
    expect(w.execs.map((entry) => labelled(entry.command))).toEqual(['universe-up', 'universe-up', 'mark']);
  });

  it('asks again once after the restart too, when the browser is still starting then', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    let runs = 0;
    w.setExec(() => ['ready=1 restart=1\n', 'ready=0 reason=browser\n', 'ready=1 restart=0\n'][Math.min(runs++, 2)]);
    await expect(p.ready('m1')).resolves.toMatchObject({ bootId: BOOT });
    expect(w.execs.map((entry) => labelled(entry.command))).toEqual(['universe-up', 'universe-up', 'universe-up', 'mark']);
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

  it('moves a machine made from an older image to the current one before it is brought up', async () => {
    const w = world();
    const p = provider(w, { image: async () => state({ revision: 2 }) });
    await p.create('bot-1');
    w.instances.get('m1')!.template_revision = 1;
    w.setExec(() => 'ready=1 restart=0\n');
    await p.ready('m1');
    expect(w.calls).toContain('update:m1');
    expect(w.calls.indexOf('update:m1')).toBeLessThan(w.calls.indexOf('exec:m1:universe-up'));
    // a machine already on the current image is left alone
    const again = world();
    const q = provider(again, { image: async () => state({ revision: 2 }) });
    await q.create('bot-1');
    again.instances.get('m1')!.template_revision = 2;
    again.setExec(() => 'ready=1 restart=0\n');
    await q.ready('m1');
    expect(again.calls.some((call) => call.startsWith('update:'))).toBe(false);
  });
});

describe('cold storage operations on a computer', () => {
  const source = { url: 'https://orbit.example/api/computer/archives/a1/download', token: 'tok', sha256: 'a'.repeat(64) };

  it('reads the inventory a pack-away is decided on, as root, and refuses one it cannot read whole', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.setExec(() => 'noise\nprepack={"home_files":12,"home_bytes":3400,"outside_files":2,"outside_bytes":90,"packages":["ffmpeg","bad name!"],"blocked":null}\n');
    await expect(p.prepack('m1')).resolves.toEqual({ homeFiles: 12, homeBytes: 3400, outsideFiles: 2, outsideBytes: 90, packages: ['ffmpeg'], blocked: null });
    expect(w.execs.at(-1)).toMatchObject({ command: 'universe-cold prepack', options: { user: 'root' } });
    w.setExec(() => 'prepack={"home_files":1,"home_bytes":1,"outside_files":9,"outside_bytes":9,"packages":[],"blocked":"too_big_outside"}\n');
    expect((await p.prepack('m1')).blocked).toBe('too_big_outside');
    w.setExec(() => 'nothing useful\n');
    await expect(p.prepack('m1')).rejects.toThrow('could not be inventoried');
    w.setExec(() => 'prepack={"home_files":-1,"home_bytes":1,"outside_files":0,"outside_bytes":0}\n');
    await expect(p.prepack('m1')).rejects.toThrow('not whole');
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
    w.setExec((command) => (command.startsWith('universe-cold restore') ? 'restored=1 files=12\n' : command === 'universe-cold finish' ? 'finished=1\n' : 'ok'));
    const result = await p.restoreInto('m1', source);
    expect(result).toMatchObject({ ok: true, reason: null });
    const commands = w.execs.map((entry) => entry.command);
    expect(commands[0]).toMatch(/^universe-cold restore <<'RESTORE_JSON'/);
    expect(commands[0]).toContain(source.url);
    expect(commands[0]).toContain(source.sha256);
    expect(commands[1]).toBe('universe-cold finish');
    expect(w.execs[1].options).toMatchObject({ user: 'root' });
    // Its budget was read before anything was put on it
    expect(w.calls.indexOf('budget:m1')).toBeGreaterThanOrEqual(0);
    expect(w.calls.indexOf('budget:m1')).toBeLessThan(w.calls.indexOf(`exec:m1:${commands[0]}`));
  });

  it('says why a restore did not check out, in a word, and does not go on to the finish', async () => {
    const w = world();
    const p = provider(w);
    await p.create('bot-1');
    w.setExec((command) => (command.startsWith('universe-cold restore') ? 'restored=0 reason=sha_mismatch\n' : 'ok'));
    await expect(p.restoreInto('m1', source)).resolves.toMatchObject({ ok: false, reason: 'sha_mismatch' });
    expect(w.execs.map((entry) => entry.command)).not.toContain('universe-cold finish');
    w.setExec((command) => (command.startsWith('universe-cold restore') ? 'restored=1\n' : command === 'universe-cold finish' ? 'finished=0 reason=packages\n' : 'ok'));
    await expect(p.restoreInto('m1', source)).resolves.toMatchObject({ ok: false, reason: 'finish_packages' });
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
