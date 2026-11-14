import { Agent37Error, Agent37Unreached, type Agent37Client, type Instance } from '@/lib/agent37/client';
import { Agent37ComputerProvider, Agent37FundsLow, DESKTOP_PORT } from '@/lib/agent37/provider';
import { awakeMicrosPerMinute, dayOfRunningMicros, BRICK_SHAPE } from '@/lib/agent37/rates';

jest.mock('@/lib/agent37/saved-copies', () => ({ savedCopyOf: jest.fn(), storeSavedCopy: jest.fn() }));

/** A pretend Agent37: instances that keep a status, and a record of every call. */
function world(options: { balanceUsd?: number; pastDue?: boolean } = {}) {
  const instances = new Map<string, Instance>();
  const calls: string[] = [];
  let healthy = true;
  const refuse: Record<string, Error | undefined> = {};
  const client = {
    async listInstances() {
      calls.push('list');
      return [...instances.values()];
    },
    async createInstance(input: { metadata?: Record<string, string>; budget?: unknown; env?: unknown; auto_sleep?: boolean }) {
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
    async archive(url: string) {
      calls.push(`archive:${url}`);
      return { body: new ReadableStream() } as unknown as Response;
    },
  };
  const created: Array<{ metadata?: Record<string, string>; budget?: unknown; env?: unknown; auto_sleep?: boolean }> = [];
  return { client: client as unknown as Agent37Client, instances, calls, created, refuse, setHealthy: (value: boolean) => (healthy = value) };
}

function provider(w: ReturnType<typeof world>, extra: { reserved?: number; copies?: ConstructorParameters<typeof Agent37ComputerProvider>[0]['copies']; clock?: { t: number } } = {}) {
  const clock = extra.clock ?? { t: 1_000_000 };
  return new Agent37ComputerProvider({
    client: w.client,
    outstandingReserveMicros: async () => extra.reserved ?? 0,
    sleep: async () => {
      clock.t += 3_000;
    },
    now: () => clock.t,
    copies: extra.copies,
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
});
