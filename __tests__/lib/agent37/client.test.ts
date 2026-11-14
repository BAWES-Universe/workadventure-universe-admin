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
});
