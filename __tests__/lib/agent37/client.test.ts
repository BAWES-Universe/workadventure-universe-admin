import { Agent37Client, Agent37Error, Agent37Unreached } from '@/lib/agent37/client';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client(answers: Array<Response | Error>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = jest.fn(async () => undefined);
  return { api: new Agent37Client({ key: 'sk_live_secret', fetchImpl, sleep }), calls, sleep };
}

describe('the Agent37 client', () => {
  it('sends the account key as a bearer on the account and as X-Agent37-Key on a machine’s own address', async () => {
    const { api, calls } = client([json(200, { id: 'abc', status: 'running', url: 'https://abc.agent37.app' }), json(200, { healthy: true })]);
    await api.getInstance('abc');
    await api.healthy('https://abc.agent37.app/');
    expect(calls[0].url).toBe('https://api.agent37.com/v1/instances/abc');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk_live_secret');
    expect(calls[1].url).toBe('https://abc.agent37.app/v1/health');
    expect((calls[1].init.headers as Record<string, string>)['X-Agent37-Key']).toBe('sk_live_secret');
  });

  it('looks at an instance ONCE for a caller that must answer quickly: no asking again, and its own timeout on the request', async () => {
    const busy = client([json(503, { code: 'try_again' }), json(200, { id: 'abc', status: 'running' })]);
    await expect(busy.api.getInstanceOnce('abc', 3_000)).rejects.toMatchObject({ status: 503 });
    expect(busy.calls).toHaveLength(1);
    expect(busy.sleep).not.toHaveBeenCalled();
    expect(busy.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    const fine = client([json(200, { id: 'abc', status: 'sleeping' })]);
    await expect(fine.api.getInstanceOnce('abc', 3_000)).resolves.toMatchObject({ status: 'sleeping' });
  });

  it('a look whose answer names no status is not reached, once or asked again: `{}`, a list and an empty body say nothing about the machine', async () => {
    for (const body of [json(200, {}), json(200, { id: 'abc' }), json(200, { id: 'abc', status: 7 }), json(200, []), json(200, null)]) {
      const once = client([body.clone()]);
      await expect(once.api.getInstanceOnce('abc', 3_000)).rejects.toMatchObject({ name: 'Agent37Unreached' });
      expect(once.calls).toHaveLength(1);
      const again = client([body]);
      await expect(again.api.getInstance('abc')).rejects.toMatchObject({ name: 'Agent37Unreached' });
    }
  });

  it('asks again when Agent37 says try_again, and gives up after a few waits', async () => {
    const { api, sleep } = client([json(409, { error: { code: 'try_again', message: 'checkpoint' } }), json(200, { id: 'abc', status: 'sleeping' })]);
    await expect(api.sleepInstance('abc')).resolves.toEqual({ id: 'abc', status: 'sleeping' });
    expect(sleep).toHaveBeenCalledTimes(1);
    const stubborn = client(Array.from({ length: 6 }, () => json(409, { code: 'try_again' })));
    await expect(stubborn.api.sleepInstance('abc')).rejects.toMatchObject({ status: 409, code: 'try_again' });
    expect(stubborn.sleep).toHaveBeenCalledTimes(3);
  });

  it('CodeRabbit on #1040: a stop or a sleep asked as a power operation (`refused`) is never repeated after a gateway answer that may have reached the machine (502, 503, 504) or an answer whose own `try_again` is not known to mean "refused"; only a 429 from the edge was not taken, and is asked again. Asked the default way (a restart under a wake\'s ticket) a gateway answer is repeated, as before', async () => {
    for (const status of [502, 503, 504]) {
      for (const call of ['stopInstance', 'sleepInstance'] as const) {
        const gateway = client([json(status, {}), json(200, { id: 'abc', status: 'stopped' })]);
        await expect(gateway.api[call]('abc', 'refused')).rejects.toMatchObject({ status });
        expect(gateway.calls).toHaveLength(1);
        expect(gateway.sleep).not.toHaveBeenCalled();
        const plain = client([json(status, {}), json(200, { id: 'abc', status: 'stopped' })]);
        await expect(plain.api[call]('abc')).resolves.toEqual({ id: 'abc', status: 'stopped' });
        expect(plain.calls).toHaveLength(2);
      }
    }
    const refused = client([json(429, {}), json(429, {}), json(200, { id: 'abc', status: 'stopped' })]);
    await expect(refused.api.stopInstance('abc', 'refused')).resolves.toEqual({ id: 'abc', status: 'stopped' });
    expect(refused.calls).toHaveLength(3);
    // Agent37's own `try_again` (a 503, or a 409) may mean the request was accepted and is being carried out: a power POST is not repeated after it either (CodeRabbit on #1040)
    for (const status of [503, 409]) {
      for (const call of ['stopInstance', 'sleepInstance'] as const) {
        const again = client([json(status, { error: { code: 'try_again' } }), json(200, { id: 'abc', status: 'stopped' })]);
        await expect(again.api[call]('abc', 'refused')).rejects.toMatchObject({ status, code: 'try_again' });
        expect(again.calls).toHaveLength(1);
      }
    }
    // A start is still asked again after a gateway answer: a wake that lands twice is the same wake
    const start = client([json(502, {}), json(200, { id: 'abc', status: 'running' })]);
    await expect(start.api.startInstance('abc')).resolves.toEqual({ id: 'abc', status: 'running' });
  });

  it('hands back the whole list as it comes, and refuses one that says more is to come, so a part of the machines never passes for all of them', async () => {
    const machine = { id: 'a', status: 'running', url: 'https://a.agent37.app', created: 1793794006 };
    const whole = client([json(200, { data: [machine] })]);
    await expect(whole.api.listInstances()).resolves.toEqual([machine]);
    for (const extra of [{ next_cursor: 'abc' }, { has_more: true }, { next: '/v1/instances?page=2' }, { links: { next: 'x' } }, { pagination: { next: 2 } }, { total: 5 }]) {
      const cut = client([json(200, { data: [machine], ...extra })]);
      await expect(cut.api.listInstances()).rejects.toThrow('only part of them');
    }
    // Words that say nothing is left do not refuse it
    const done = client([json(200, { data: [machine], has_more: false, next: null, total: 1 })]);
    await expect(done.api.listInstances()).resolves.toEqual([machine]);
  });

  it('refuses an answer that holds no list (an empty body, `{}`, data that is not a list, a body that is not JSON) and takes a real empty list for what it is', async () => {
    for (const bad of [json(200, {}), json(200, { data: null }), json(200, { data: { a: 1 } }), json(200, [1]), new Response('', { status: 200 }), new Response('<html>', { status: 200 })]) {
      const odd = client([bad]);
      await expect(odd.api.listInstances()).rejects.toThrow('did not answer with a list of machines');
    }
    const empty = client([json(200, { data: [] })]);
    await expect(empty.api.listInstances()).resolves.toEqual([]);
  });

  it('Opus on #1040 (sweep recovery): the one list for the sweep is ONE request with its own timeout, never asked again (503, 429 and a lost answer end it), and a part list or a body with no list is refused like the asked-again list', async () => {
    const machine = { id: 'a', status: 'running', url: 'https://a.agent37.app', created: 1793794006 };
    for (const status of [503, 429, 502]) {
      const busy = client([json(status, { error: { code: 'try_again' } }), json(200, { data: [machine] })]);
      await expect(busy.api.listInstancesOnce(5_000)).rejects.toMatchObject({ status });
      expect(busy.calls).toHaveLength(1);
      expect(busy.sleep).not.toHaveBeenCalled();
    }
    const lost = client([new TypeError('fetch failed'), json(200, { data: [machine] })]);
    await expect(lost.api.listInstancesOnce(5_000)).rejects.toBeInstanceOf(Agent37Unreached);
    expect(lost.calls).toHaveLength(1);
    const fine = client([json(200, { data: [machine] })]);
    await expect(fine.api.listInstancesOnce(5_000)).resolves.toEqual([machine]);
    expect(fine.calls[0].url).toBe('https://api.agent37.com/v1/instances');
    expect(fine.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    const part = client([json(200, { data: [machine], has_more: true })]);
    await expect(part.api.listInstancesOnce(5_000)).rejects.toThrow('only part of them');
    for (const bad of [json(200, {}), json(200, { data: null }), json(200, [1]), new Response('', { status: 200 })]) {
      await expect(client([bad]).api.listInstancesOnce(5_000)).rejects.toThrow();
    }
  });

  it('never asks again for a create: after a lost answer the caller looks first', async () => {
    const { api, calls } = client([json(502, { error: 'bad_gateway' }), json(201, { id: 'x' })]);
    await expect(api.createInstance({ template: 't' })).rejects.toBeInstanceOf(Agent37Error);
    expect(calls).toHaveLength(1);
  });

  it('says a call that got no answer is unreached, and a refusal keeps Agent37’s code', async () => {
    const lost = client([new TypeError('fetch failed')]);
    await expect(lost.api.createInstance({ template: 't' })).rejects.toBeInstanceOf(Agent37Unreached);
    const poor = client([json(402, { error: { code: 'insufficient_balance', message: 'Top up' } })]);
    await expect(poor.api.createInstance({ template: 't' })).rejects.toMatchObject({ status: 402, code: 'insufficient_balance' });
  });

  it('never puts the key in an error', async () => {
    const { api } = client([json(500, { message: 'oops' })]);
    const error = (await api.createInstance({ template: 't' }).catch((e) => e)) as Error;
    expect(String(error.message)).not.toContain('sk_live_secret');
  });

  it('health is false for a gateway failure and for an agent that is not ready', async () => {
    const { api } = client([json(502, { error: 'container_unreachable' }), json(200, { ok: true, healthy: false })]);
    expect(await api.healthy('https://abc.agent37.app')).toBe(false);
    expect(await api.healthy('https://abc.agent37.app')).toBe(false);
  });

  describe('on the machine', () => {
    const header = (call: { init: RequestInit }, name: string) => (call.init.headers as Record<string, string>)[name];

    it('runs a command at the sandbox address with the machine key, and a non-zero exit is an answer', async () => {
      const { api, calls } = client([json(200, { exit_code: 3, stdout: 'out', stderr: 'err', truncated: true })]);
      expect(await api.exec('abc', 'ls -l', { user: 'root' })).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err', truncated: true });
      expect(calls[0].url).toBe('https://sandbox.agent37.app/v1/instances/abc/exec');
      expect(header(calls[0], 'X-Agent37-Key')).toBe('sk_live_secret');
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ command: 'ls -l', user: 'root' });
    });

    it('asks again after a lost answer only when the command has a name, so it never runs twice', async () => {
      const named = client([json(503, { code: 'try_again' }), json(200, { exit_code: 0, stdout: '', stderr: '' })]);
      await named.api.exec('abc', 'true', { name: 'awake:1' });
      expect(named.calls).toHaveLength(2);
      expect(JSON.parse(String(named.calls[1].init.body)).name).toBe('awake:1');
      const plain = client([json(503, { code: 'try_again' }), json(200, { exit_code: 0 })]);
      await expect(plain.api.exec('abc', 'true')).rejects.toMatchObject({ status: 503 });
      expect(plain.calls).toHaveLength(1);
    });

    it('starts a turn as a stream on the machine’s own address, continuing a session when given one', async () => {
      const { api, calls } = client([new Response('event: response.created\ndata: {}\n\n', { status: 200 })]);
      const response = await api.openTurn('https://abc.agent37.app/', { text: 'Fill the form', sessionId: 'sess-1' });
      expect(response.ok).toBe(true);
      expect(calls[0].url).toBe('https://abc.agent37.app/v1/responses');
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ input: 'Fill the form', stream: true, session_id: 'sess-1' });
      expect(header(calls[0], 'X-Agent37-Key')).toBe('sk_live_secret');
    });

    it('reads which turn is running when the session is busy', async () => {
      const { api } = client([json(409, { error: { code: 'session_busy', message: 'busy', response_id: 'resp-9' } })]);
      await expect(api.openTurn('https://abc.agent37.app', { text: 'x' })).rejects.toMatchObject({ status: 409, code: 'session_busy', runningResponseId: 'resp-9' });
    });

    it('says a turn it could not reach is unreached', async () => {
      const { api } = client([new TypeError('fetch failed')]);
      await expect(api.openTurn('https://abc.agent37.app', { text: 'x' })).rejects.toBeInstanceOf(Agent37Unreached);
    });

    it('cancels a turn, and a turn that is not there or already over is not an error', async () => {
      const { api, calls } = client([json(200, { ok: true }), json(404, { error: { code: 'response_not_found' } }), json(409, { error: { code: 'not_running' } }), json(500, { message: 'oops' })]);
      await api.cancelTurn('https://abc.agent37.app', 'resp-1');
      expect(calls[0].url).toBe('https://abc.agent37.app/v1/responses/resp-1/cancel');
      await api.cancelTurn('https://abc.agent37.app', 'gone');
      await api.cancelTurn('https://abc.agent37.app', 'over');
      await expect(api.cancelTurn('https://abc.agent37.app', 'x')).rejects.toBeInstanceOf(Agent37Error);
    });

    it('reconnects to a turn at its stream address', async () => {
      const { api, calls } = client([new Response('', { status: 200 })]);
      await api.reattachTurn('https://abc.agent37.app', 'resp-1');
      expect(calls[0].url).toBe('https://abc.agent37.app/v1/responses/resp-1/stream');
      expect(calls[0].init.method).toBe('GET');
    });

    it('reads the turn a session is running, or none', async () => {
      const { api } = client([json(200, { id: 's', active_response_id: 'resp-2', history: [] }), json(200, { id: 's', active_response_id: null, history: [] })]);
      expect(await api.activeTurn('https://abc.agent37.app', 'sess-1')).toBe('resp-2');
      expect(await api.activeTurn('https://abc.agent37.app', 'sess-1')).toBeNull();
    });

    it('says the machine was not reached, never idle, when the answer about the session is not JSON', async () => {
      const { api } = client([new Response('<html>bad gateway page</html>', { status: 200 }), new Response('{"active_response_id": "resp', { status: 200 }), new Response(' \n', { status: 200 }), new Response('', { status: 200 })]);
      await expect(api.activeTurn('https://abc.agent37.app', 'sess-1')).rejects.toBeInstanceOf(Agent37Unreached);
      await expect(api.activeTurn('https://abc.agent37.app', 'sess-1')).rejects.toBeInstanceOf(Agent37Unreached);
      // Whitespace only, and nothing at all, are no answer either: never "idle"
      await expect(api.activeTurn('https://abc.agent37.app', 'sess-1')).rejects.toBeInstanceOf(Agent37Unreached);
      await expect(api.activeTurn('https://abc.agent37.app', 'sess-1')).rejects.toBeInstanceOf(Agent37Unreached);
    });

    it('says the machine was not reached, never idle, when the answer about the session is empty or only blanks', async () => {
      const { api } = client([new Response('', { status: 200 }), new Response('  \n ', { status: 200 })]);
      await expect(api.activeTurn('https://abc.agent37.app', 'sess-1')).rejects.toBeInstanceOf(Agent37Unreached);
      await expect(api.activeTurn('https://abc.agent37.app', 'sess-1')).rejects.toBeInstanceOf(Agent37Unreached);
    });

    it('says the machine was not reached, never idle, for an empty answer, `null`, a list or a bare value about the session', async () => {
      const { api } = client([new Response('', { status: 200 }), new Response('null', { status: 200 }), new Response('"idle"', { status: 200 }), new Response('7', { status: 200 }), new Response('[]', { status: 200 })]);
      for (let ask = 0; ask < 5; ask++) await expect(api.activeTurn('https://abc.agent37.app', 'sess-1')).rejects.toBeInstanceOf(Agent37Unreached);
    });

    it('gives the saved-files archive a signal, so a machine that stops answering cannot hold a save for ever, and takes the caller’s own', async () => {
      const { api, calls } = client([new Response('bytes', { status: 200 }), new Response('bytes', { status: 200 })]);
      await api.archive('https://abc.agent37.app');
      expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
      expect(calls[0].init.signal!.aborted).toBe(false);
      const mine = new AbortController();
      await api.archive('https://abc.agent37.app', mine.signal);
      expect(calls[1].init.signal).toBe(mine.signal);
    });

    it('sets what the machine may reach on the account address', async () => {
      const { api, calls } = client([json(200, { id: 'abc', status: 'running' })]);
      await api.setNetwork('abc', { allow: ['github.com'] });
      expect(calls[0].url).toBe('https://api.agent37.com/v1/instances/abc');
      expect(calls[0].init.method).toBe('PATCH');
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ network: { allow: ['github.com'] } });
    });
  });

  describe('what Agent37 billed', () => {
    it('reads one UTC day of spend by instance, in micros', async () => {
      const { api, calls } = client([
        json(200, {
          from: '2026-11-15',
          to: '2026-11-15',
          total_micros: 9000,
          instances: [
            { id: 'abc', total_micros: 8000, compute_micros: 7000, llm_micros: 500, brave_micros: 0, composio_micros: 500, perflo_micros: 0, awake_minutes: 60 },
            { id: 'def', total_micros: 1000, compute_micros: 1000, awake_minutes: 0 },
            { total_micros: 5 },
          ],
        }),
      ]);
      const day = await api.usageForDay('2026-11-15');
      expect(calls[0].url).toBe('https://api.agent37.com/v1/usage?from=2026-11-15&to=2026-11-15');
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk_live_secret');
      expect(day).toEqual({
        day: '2026-11-15',
        totalMicros: 9000,
        instances: [
          { id: 'abc', totalMicros: 8000, computeMicros: 7000, awakeMinutes: 60 },
          { id: 'def', totalMicros: 1000, computeMicros: 1000, awakeMinutes: 0 },
        ],
      });
    });

    it('refuses a day that is not a date, and an answer with no total', async () => {
      const { api } = client([json(200, { instances: [] })]);
      await expect(api.usageForDay('yesterday')).rejects.toThrow('date');
      await expect(api.usageForDay('2026-11-15')).rejects.toBeInstanceOf(Agent37Error);
    });
  });

  describe('templates', () => {
    it('makes a build with its size and port, uploads the context with no account key, starts it, and reads where it stands', async () => {
      const { api, calls } = client([
        json(200, { id: 'build-1', upload_url: 'https://upload.example.test/put' }),
        new Response(null, { status: 200 }),
        json(200, { id: 'build-1', status: 'building' }),
        json(200, { status: 'succeeded', data: 'x'.repeat(5000), offset: 5000, template: { revision: 3, image_digest: 'sha256:abc' } }),
      ]);
      expect(await api.createTemplateBuild({ name: 'universe-brick', sizeBytes: 1234, defaultPort: 3737 })).toEqual({ id: 'build-1', uploadUrl: 'https://upload.example.test/put' });
      expect(calls[0].url).toBe('https://api.agent37.com/v1/template-builds');
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'universe-brick', size_bytes: 1234, default_port: 3737 });
      await api.uploadTemplateContext('https://upload.example.test/put', new Uint8Array([1, 2, 3]));
      expect(calls[1].init.method).toBe('PUT');
      expect(JSON.stringify(calls[1].init.headers)).not.toContain('sk_live_secret');
      await api.startTemplateBuild('build-1');
      expect(calls[2].url).toBe('https://api.agent37.com/v1/template-builds/build-1/start');
      const build = await api.templateBuild('build-1');
      expect(calls[3].url).toBe('https://api.agent37.com/v1/template-builds/build-1/logs?offset=0');
      expect(build).toMatchObject({ status: 'succeeded', error: null, template: { revision: 3, imageDigest: 'sha256:abc' } });
      expect(build.log.length).toBe(2000);
    });

    it('reads a failed build’s reason, says a refused upload, and moves a machine to the current image', async () => {
      const { api, calls } = client([json(200, { status: 'failed', data: '', error: { code: 'build_failed', message: 'no chromium' } }), new Response('no', { status: 403 }), json(200, { id: 'abc', status: 'running', template_revision: 3 })]);
      expect(await api.templateBuild('b')).toMatchObject({ status: 'failed', error: { code: 'build_failed', message: 'no chromium' } });
      await expect(api.uploadTemplateContext('https://upload.example.test/put', new Uint8Array(1))).rejects.toMatchObject({ status: 403 });
      expect(await api.updateInstance('abc')).toMatchObject({ template_revision: 3 });
      expect(calls[2].url).toBe('https://api.agent37.com/v1/instances/abc/update');
      expect(calls[2].init.method).toBe('POST');
    });
  });
});
