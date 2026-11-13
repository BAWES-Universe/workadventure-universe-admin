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
    expect(link).toEqual({ url: 'https://mcp.example/trs_1/mcp', headers: {} });
    expect(sent()).toEqual({ user_id: 'person-1', toolkits: { enable: ['gmail'] }, workbench: { enable: true } });
  });

  it('keeps only headers the provider itself sent', async () => {
    const adapter = make([answer({ mcp: { url: 'https://mcp.example/y', headers: { 'x-thing': 'v', bad: 1 } } })]);
    expect((await adapter.appLink({ person: 'p', toolkits: ['gmail'] })).headers).toEqual({ 'x-thing': 'v' });
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
