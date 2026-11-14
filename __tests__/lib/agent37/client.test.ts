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

  it('asks again when Agent37 says try_again, and gives up after a few waits', async () => {
    const { api, sleep } = client([json(409, { error: { code: 'try_again', message: 'checkpoint' } }), json(200, { id: 'abc', status: 'sleeping' })]);
    await expect(api.sleepInstance('abc')).resolves.toEqual({ id: 'abc', status: 'sleeping' });
    expect(sleep).toHaveBeenCalledTimes(1);
    const stubborn = client(Array.from({ length: 6 }, () => json(409, { code: 'try_again' })));
    await expect(stubborn.api.sleepInstance('abc')).rejects.toMatchObject({ status: 409, code: 'try_again' });
    expect(stubborn.sleep).toHaveBeenCalledTimes(3);
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

    it('sets what the machine may reach on the account address', async () => {
      const { api, calls } = client([json(200, { id: 'abc', status: 'running' })]);
      await api.setNetwork('abc', { allow: ['github.com'] });
      expect(calls[0].url).toBe('https://api.agent37.com/v1/instances/abc');
      expect(calls[0].init.method).toBe('PATCH');
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ network: { allow: ['github.com'] } });
    });
  });
});
