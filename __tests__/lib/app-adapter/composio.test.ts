import { createComposioAdapter, forgetManagedAuthConfigs } from '@/lib/app-adapter/composio';
import { adapterIsOn, getAdapter, requireAdapter, setAdapterForTests } from '@/lib/app-adapter';

const answer = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

describe('the ready-made apps adapter is off unless its key is in the environment', () => {
  const before = process.env.COMPOSIO_API_KEY;
  afterEach(() => {
    setAdapterForTests(undefined);
    if (before === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = before;
  });

  it('has no adapter with no key, and refuses to be required', () => {
    delete process.env.COMPOSIO_API_KEY;
    expect(adapterIsOn()).toBe(false);
    expect(getAdapter()).toBeNull();
    expect(() => requireAdapter()).toThrow('off');
  });

  it('a blank key is no key', () => {
    process.env.COMPOSIO_API_KEY = '   ';
    expect(adapterIsOn()).toBe(false);
  });

  it('is built only when a key is there', () => {
    process.env.COMPOSIO_API_KEY = 'key-for-a-test';
    expect(adapterIsOn()).toBe(true);
  });
});

describe('the real adapter speaks the provider as its docs say, against a pretend server', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const make = (replies: Response[]) =>
    createComposioAdapter({
      apiKey: 'secret-key',
      authConfigFor: async (toolkit) => (toolkit === 'gmail' ? 'ac_gmail' : null),
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return replies.shift() as Response;
      }) as unknown as typeof fetch,
    });
  const sent = (n = 0) => JSON.parse(String(calls[n].init.body));
  beforeEach(() => (calls.length = 0));

  it('starts a sign-in with the app’s auth config and the person’s id, and nothing else of theirs', async () => {
    const adapter = make([answer({ redirect_url: 'https://connect.example/x', connected_account_id: 'ca_1', expires_at: 'soon' })]);
    const start = await adapter.startConnect({ person: 'person-1', toolkit: 'gmail', returnUrl: 'https://orbit.example/admin/apps' });
    expect(start).toEqual({ redirectUrl: 'https://connect.example/x', providerAccountId: 'ca_1', expiresAt: 'soon' });
    expect(calls[0].url).toBe('https://backend.composio.dev/api/v3.1/connected_accounts/link');
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('secret-key');
    expect(sent()).toEqual({ auth_config_id: 'ac_gmail', user_id: 'person-1', callback_url: 'https://orbit.example/admin/apps' });
  });

  it('uses the sign-in setup its caller already read, and never reads the setting itself (a caller inside a transaction holds the connection)', async () => {
    const authConfigFor = jest.fn(async () => 'ac_from_setting');
    const adapter = createComposioAdapter({
      apiKey: 'secret-key',
      authConfigFor,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return answer({ redirect_url: 'https://connect.example/g', connected_account_id: 'ca_g', expires_at: null });
      }) as unknown as typeof fetch,
    });
    await adapter.startConnect({ person: 'p', toolkit: 'gmail', returnUrl: 'https://orbit.example', authConfigId: 'ac_given' });
    expect(sent()).toMatchObject({ auth_config_id: 'ac_given' });
    expect(authConfigFor).not.toHaveBeenCalled();
  });

  it('uses the provider’s own managed sign-in setup for an app nobody chose one for: found if there, else made, then remembered', async () => {
    forgetManagedAuthConfigs();
    const adapter = make([
      answer({ items: [] }),
      answer({ toolkit: { slug: 'notion' }, auth_config: { id: 'ac_made', is_composio_managed: true } }),
      answer({ redirect_url: 'https://connect.example/n', connected_account_id: 'ca_n', expires_at: null }),
      answer({ redirect_url: 'https://connect.example/n2', connected_account_id: 'ca_n2', expires_at: null }),
    ]);
    await adapter.startConnect({ person: 'p', toolkit: 'notion', returnUrl: 'https://orbit.example' });
    expect(calls[0].url).toBe('https://backend.composio.dev/api/v3.1/auth_configs?toolkit_slug=notion&is_composio_managed=true&limit=1');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[1].url).toBe('https://backend.composio.dev/api/v3.1/auth_configs');
    expect(sent(1)).toEqual({ toolkit: { slug: 'notion' } });
    expect(sent(2)).toMatchObject({ auth_config_id: 'ac_made', user_id: 'p' });
    // The second time nothing is looked up again
    await adapter.startConnect({ person: 'p', toolkit: 'notion', returnUrl: 'https://orbit.example' });
    expect(calls).toHaveLength(4);
    expect(sent(3)).toMatchObject({ auth_config_id: 'ac_made' });
  });

  it('takes the managed setup the provider already has instead of making another', async () => {
    forgetManagedAuthConfigs();
    const adapter = make([answer({ items: [{ id: 'ac_there' }] }), answer({ redirect_url: 'https://connect.example/s', connected_account_id: 'ca_s', expires_at: null })]);
    await adapter.startConnect({ person: 'p', toolkit: 'slack', returnUrl: 'https://orbit.example' });
    expect(calls).toHaveLength(2);
    expect(sent(1)).toMatchObject({ auth_config_id: 'ac_there' });
  });

  it('fails clearly, without a sign-in page, when the provider gives no setup', async () => {
    forgetManagedAuthConfigs();
    const adapter = make([answer({ items: [] }), answer({ auth_config: {} })]);
    await expect(adapter.startConnect({ person: 'p', toolkit: 'asana', returnUrl: 'https://orbit.example' })).rejects.toThrow('no sign-in setup');
  });

  it('reads a sign-in as finished only when the provider says ACTIVE', async () => {
    const adapter = make([answer({ status: 'ACTIVE' }), answer({ status: 'INITIATED' }), answer({ status: 'EXPIRED' }), answer({}, 404)]);
    expect(await adapter.connectionStatus({ providerAccountId: 'ca_1' })).toBe('active');
    expect(calls[0].url).toBe('https://backend.composio.dev/api/v3.1/connected_accounts/ca_1');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
    expect(await adapter.connectionStatus({ providerAccountId: 'ca_1' })).toBe('pending');
    expect(await adapter.connectionStatus({ providerAccountId: 'ca_1' })).toBe('failed');
    await expect(adapter.connectionStatus({ providerAccountId: 'ca_1' })).rejects.toThrow('Provider answered 404');
  });

  it('asks for the person’s own app link, with the provider’s code sandbox on', async () => {
    const adapter = make([answer({ session_id: 'trs_1', mcp: { type: 'http', url: 'https://mcp.example/trs_1/mcp' } })]);
    const link = await adapter.appLink({ person: 'person-1', toolkits: ['gmail'] });
    expect(link).toEqual({ url: 'https://mcp.example/trs_1/mcp' });
    expect(sent()).toEqual({ user_id: 'person-1', toolkits: { enable: ['gmail'] }, workbench: { enable: true } });
  });

  it('pins the app link to the connected account the person signed in with, a list of one for the app', async () => {
    const adapter = make([answer({ mcp: { url: 'https://mcp.example/pinned' } })]);
    await adapter.appLink({ person: 'person-1', toolkits: ['gmail'], accounts: { gmail: 'ca_9' } });
    expect(sent()).toEqual({ user_id: 'person-1', toolkits: { enable: ['gmail'] }, workbench: { enable: true }, connected_accounts: { gmail: ['ca_9'] } });
  });

  it('never follows a redirect on a request that carries the provider key', async () => {
    const adapter = make([answer({ session_id: 'x', mcp: { url: 'https://mcp.example/y' } })]);
    await adapter.appLink({ person: 'p', toolkits: ['gmail'] });
    expect(calls[0].init.redirect).toBe('error');
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('secret-key');
  });

  it('drops whatever headers the provider’s session answer holds: the key is Orbit’s alone', async () => {
    const adapter = make([answer({ mcp: { url: 'https://mcp.example/y', headers: { 'x-api-key': 'k', 'x-thing': 'v' } } })]);
    expect(await adapter.appLink({ person: 'p', toolkits: ['gmail'] })).toEqual({ url: 'https://mcp.example/y' });
  });

  describe('the app link', () => {
    const linkAnswer = (status: number, body: string, headers: Record<string, string> = {}) =>
      ({ ok: status < 400, status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, text: async () => body }) as unknown as Response;
    const makeLink = (replies: Response[], extra: Partial<Parameters<typeof createComposioAdapter>[0]> = {}) =>
      createComposioAdapter({
        apiKey: 'secret-key',
        authConfigFor: async () => null,
        sleep: async (ms) => void waits.push(ms),
        fetchImpl: (async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          return replies.shift() as Response;
        }) as unknown as typeof fetch,
        ...extra,
      });
    const waits: number[] = [];
    beforeEach(() => (waits.length = 0));

    it('sends the provider key and the link’s session on every message, and gives back the answer and the new session', async () => {
      const adapter = makeLink([linkAnswer(200, '{"result":{}}', { 'content-type': 'application/json', 'mcp-session-id': 's2' })]);
      const out = await adapter.callLink({ url: 'https://app.composio.dev/tool_router/v3/trs_1/mcp', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, sessionId: 's1' });
      expect(out).toEqual({ status: 200, contentType: 'application/json', sessionId: 's2', body: '{"result":{}}' });
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('secret-key');
      expect(headers['mcp-session-id']).toBe('s1');
      expect(headers.accept).toContain('text/event-stream');
      expect(sent()).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    });

    it('never sends the key to a host that is not the provider’s, or over plain http', async () => {
      const adapter = makeLink([]);
      for (const url of ['https://evil.example.com/mcp', 'https://composio.dev.evil.example.com/mcp', 'http://app.composio.dev/mcp', 'http://backend.composio.dev/api/v3.1/tool_router', 'not a link']) {
        await expect(adapter.callLink({ url, message: { method: 'tools/list' }, sessionId: null })).rejects.toThrow();
      }
      expect(calls).toHaveLength(0);
    });

    it('asks again after the wait the provider names when it says too many, and gives up after a few', async () => {
      const ok = linkAnswer(200, '{}');
      const slow = (seconds: string) => linkAnswer(429, '', { 'retry-after': seconds });
      const adapter = makeLink([slow('2'), slow('30'), ok]);
      expect((await adapter.callLink({ url: 'https://app.composio.dev/x/mcp', message: { method: 'tools/list' }, sessionId: null })).status).toBe(200);
      expect(waits).toEqual([2000, 5000]);
      const stubborn = makeLink([slow('1'), slow('1'), slow('1'), slow('1')]);
      expect((await stubborn.callLink({ url: 'https://app.composio.dev/x/mcp', message: { method: 'tools/list' }, sessionId: null })).status).toBe(429);
    });

    it('does the same for its own calls', async () => {
      const adapter = makeLink([
        { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) } as unknown as Response,
        answer({ status: 'ACTIVE' }),
      ]);
      expect(await adapter.connectionStatus({ providerAccountId: 'ca_1' })).toBe('active');
      expect(waits).toEqual([1000]);
    });
  });

  it('runs one tool for one person and reports the provider’s answer', async () => {
    const adapter = make([answer({ successful: true, data: { events: [] }, error: null, log_id: 'log_9' })]);
    const result = await adapter.use({ person: 'p', toolkit: 'gmail', tool: 'GMAIL_FETCH_EMAILS', arguments: { n: 1 }, providerAccountId: 'ca_1', callId: 'c1' });
    expect(result).toEqual({ ok: true, data: { events: [] }, error: null, providerCallId: 'log_9' });
    expect(calls[0].url).toBe('https://backend.composio.dev/api/v3.1/tools/execute/GMAIL_FETCH_EMAILS');
    expect(sent()).toEqual({ user_id: 'p', connected_account_id: 'ca_1', arguments: { n: 1 } });
  });

  it('a provider that says no, or is down, is an error and never a success', async () => {
    const failed = make([answer({ successful: false, data: {}, error: 'nope', log_id: 'l' })]);
    expect((await failed.use({ person: 'p', toolkit: 'gmail', tool: 'T', arguments: {}, providerAccountId: null, callId: 'c' })).ok).toBe(false);
    const down = make([answer({ error: { message: 'x' } }, 503)]);
    await expect(down.use({ person: 'p', toolkit: 'gmail', tool: 'T', arguments: {}, providerAccountId: null, callId: 'c' })).rejects.toThrow('503');
  });
});
