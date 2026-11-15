import { createComposioAdapter } from '@/lib/app-adapter/composio';
import { sessionIdOfLink } from '@/lib/instant/sessions';
import { AdapterError } from '@/lib/app-adapter/types';

const answer = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

function make(replies: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> | null }[] = [];
  const adapter = createComposioAdapter({
    apiKey: 'secret-key',
    authConfigFor: async () => null,
    sleep: async () => {},
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next as Response;
    }) as unknown as typeof fetch,
  });
  return { adapter, calls, instant: adapter.instant! };
}

describe('every session says no to Instant out loud, and a tool run never leaves the account to the provider', () => {
  it('sends instant: false on every new session', async () => {
    const { adapter, calls } = make([answer({ session_id: 's1', mcp: { url: 'https://backend.composio.dev/tool_router/s1/mcp' } })]);
    await adapter.appLink({ person: 'p1', toolkits: ['gmail'] });
    expect(calls[0].url).toContain('/tool_router/session');
    expect(calls[0].body).toMatchObject({ instant: false });
  });

  it('refuses a single tool run with no connected account named: the provider may serve that from Instant', async () => {
    const { adapter, calls } = make([]);
    await expect(adapter.use({ person: 'p1', toolkit: 'gmail', tool: 'GMAIL_FETCH_EMAILS', arguments: {}, providerAccountId: null, callId: 'c1' })).rejects.toBeInstanceOf(AdapterError);
    expect(calls).toHaveLength(0);
  });

  it('names the account on a tool run that has one', async () => {
    const { adapter, calls } = make([answer({ successful: true, data: {}, log_id: 'log_1' })]);
    await adapter.use({ person: 'p1', toolkit: 'gmail', tool: 'GMAIL_FETCH_EMAILS', arguments: {}, providerAccountId: 'ca_1', callId: 'c1' });
    expect(calls[0].body).toMatchObject({ connected_account_id: 'ca_1' });
  });
});

describe('an Instant run is sent on purpose through the Instant account', () => {
  it('uses the instant account and an opaque id, with the key only in the header', async () => {
    const { instant, calls } = make([answer({ successful: true, data: { results: [] }, log_id: 'log_9' })]);
    const call = await instant.run({ runUserId: 'universe-instant-r1', tool: 'EXA_SEARCH', arguments: { query: 'x' } });
    expect(call).toEqual({ kind: 'done', successful: true, data: { results: [] }, error: null, logId: 'log_9', chargeMicros: null });
    expect(calls[0].url).toBe('https://backend.composio.dev/api/v3.1/tools/execute/EXA_SEARCH');
    expect(calls[0].body).toEqual({ user_id: 'universe-instant-r1', connected_account_id: 'instant_account', arguments: { query: 'x' } });
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('secret-key');
    expect(JSON.stringify(calls[0].body)).not.toContain('secret-key');
  });

  it('reads a charge reported with the answer', async () => {
    const { instant } = make([answer({ successful: true, data: {}, log_id: 'l', instant_charge: { amount: '0.007', currency: 'USD' } })]);
    expect(await instant.run({ runUserId: 'u', tool: 'EXA_SEARCH', arguments: {} })).toMatchObject({ kind: 'done', chargeMicros: 7_000 });
  });

  it('says a tool that ran and failed is done with successful false', async () => {
    const { instant } = make([answer({ successful: false, data: null, error: 'boom', log_id: 'l' })]);
    expect(await instant.run({ runUserId: 'u', tool: 'EXA_SEARCH', arguments: {} })).toMatchObject({ kind: 'done', successful: false, error: 'boom' });
  });

  it.each([
    [402, 'Metering_WalletBalanceExhausted'],
    [403, 'ManagedCredential_NotEnabled'],
    [401, null],
  ])('reads %s as refused before anything ran', async (status, slug) => {
    const { instant } = make([answer({ error: { slug, code: 1, message: 'x' } }, status)]);
    expect(await instant.run({ runUserId: 'u', tool: 'EXA_SEARCH', arguments: {} })).toEqual({ kind: 'rejected', status, code: slug ?? '1' });
  });

  it('reads a rate limit as refused: it did not run, so it is safe to ask again later', async () => {
    const { instant, calls } = make([answer({}, 429), answer({}, 429), answer({}, 429), answer({}, 429)]);
    expect(await instant.run({ runUserId: 'u', tool: 'EXA_SEARCH', arguments: {} })).toMatchObject({ kind: 'rejected', status: 429 });
    // One request only: a paid run is never sent again by the adapter itself
    expect(calls).toHaveLength(1);
  });

  it.each([400, 404, 422])('reads %s as an invalid request that did not run', async (status) => {
    const { instant } = make([answer({ error: { slug: 'Bad', message: 'x' } }, status)]);
    expect(await instant.run({ runUserId: 'u', tool: 'EXA_SEARCH', arguments: {} })).toMatchObject({ kind: 'invalid', status });
  });

  it.each([500, 502, 503, 408])('reads %s as unclear: it may have run', async (status) => {
    const { instant } = make([answer({}, status)]);
    expect(await instant.run({ runUserId: 'u', tool: 'EXA_SEARCH', arguments: {} })).toEqual({ kind: 'unclear', why: 'server', status });
  });

  it('reads a timeout and a broken connection as unclear, never as a failure', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { instant } = make([timeout, new Error('socket hang up')]);
    expect(await instant.run({ runUserId: 'u', tool: 'EXA_SEARCH', arguments: {} })).toEqual({ kind: 'unclear', why: 'timeout', status: null });
    expect(await instant.run({ runUserId: 'u', tool: 'EXA_SEARCH', arguments: {} })).toEqual({ kind: 'unclear', why: 'network', status: null });
  });

  it('reads an answer that is not an answer as unclear', async () => {
    const { instant } = make([answer({ hello: 'world' }), { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('not json'); } } as unknown as Response]);
    expect(await instant.run({ runUserId: 'u', tool: 'EXA_SEARCH', arguments: {} })).toEqual({ kind: 'unclear', why: 'unreadable', status: 200 });
    expect(await instant.run({ runUserId: 'u', tool: 'EXA_SEARCH', arguments: {} })).toEqual({ kind: 'unclear', why: 'unreadable', status: 200 });
  });
});

describe("Composio's log is read by the run's own id", () => {
  it('finds the lines a run produced with the filter Composio documents', async () => {
    const { instant, calls } = make([answer({ logs: [{ id: 'log_1', status: 'success', timestamp: '2026-11-15T05:00:00.000Z', metadata: { user_id: 'universe-instant-r1', credential_source: 'instant', tool: { slug: 'EXA_SEARCH' }, instant_charge: { amount: '0.0071', currency: 'USD' } } }, { status: 'success' }] })]);
    const lines = await instant.findLogs({ userId: 'universe-instant-r1', fromMs: 1, toMs: 2 });
    expect(lines).toEqual([{ id: 'log_1', status: 'success', chargeMicros: 7_100, credentialSource: 'instant', tool: 'EXA_SEARCH', userId: 'universe-instant-r1', atMs: Date.parse('2026-11-15T05:00:00.000Z') }]);
    expect(calls[0].body).toEqual({ limit: 20, filters: [{ field: 'user_id', operator: '==', value: 'universe-instant-r1' }], time_range: { from: 1, to: 2 } });
  });

  it('reads one line with its saved answer, and says none for a line that is not there', async () => {
    const { instant } = make([answer({ id: 'log_1', status: 'failed', metadata: { user_id: 'u' }, data: { response: { body: { data: { hits: 3 } } } } }), answer({}, 404)]);
    expect(await instant.log('log_1')).toMatchObject({ log: { id: 'log_1', status: 'failed', chargeMicros: null }, response: { data: { hits: 3 } } });
    expect(await instant.log('missing')).toBeNull();
  });

  it('a line with no charge has none: never zero', async () => {
    const { instant } = make([answer({ id: 'log_1', status: 'success', metadata: {} })]);
    expect((await instant.log('log_1'))?.log.chargeMicros).toBeNull();
  });
});

// The shapes below were recorded from one real Instant run (EXA_SEARCH, 15 Nov 2026) once Instant was switched on for the project.
describe('the real answer and the real log of an Instant run are read as they come', () => {
  const realAnswer = { data: { requestId: 'e1', resolvedSearchType: '', results: [{ id: 'https://composio.dev/', title: 'Composio', url: 'https://composio.dev/' }], searchTime: 960.3 }, successful: true, error: null, log_id: 'log_pyJaRBT1OADr' };
  const realLog = {
    id: 'log_pyJaRBT1OADr',
    timestamp: '2026-11-15T05:45:48.854Z',
    status: 'success',
    metadata: { user_id: 'universe-instant-probe-1', connected_account_id: '', credential_source: 'instant_account', instant_charge: '0', toolkit: { slug: 'exa' }, tool: { slug: 'EXA_SEARCH', version: '20261112_00' } },
    data: { success: true, response: { status_code: null, body: { successfull: true, error: null, data: realAnswer.data, successful: true } } },
  };

  it('the answer carries no charge: the run is done with the log id, and the charge is asked of the log', async () => {
    const { instant } = make([answer(realAnswer)]);
    expect(await instant.run({ runUserId: 'universe-instant-probe-1', tool: 'EXA_SEARCH', arguments: { query: 'composio' } })).toEqual({ kind: 'done', successful: true, data: realAnswer.data, error: null, logId: 'log_pyJaRBT1OADr', chargeMicros: null });
  });

  it('the log says the charge as text ("0"), the credential source, the run id, and keeps the saved answer under data.response.body', async () => {
    const { instant } = make([answer(realLog)]);
    const found = await instant.log('log_pyJaRBT1OADr');
    expect(found?.log).toMatchObject({ id: 'log_pyJaRBT1OADr', status: 'success', chargeMicros: 0, credentialSource: 'instant_account', tool: 'EXA_SEARCH', userId: 'universe-instant-probe-1' });
    expect((found?.response as { data: unknown }).data).toEqual(realAnswer.data);
  });

  it('the search by run id finds the same line (the list shape has no data block)', async () => {
    const { data: _unused, ...listed } = realLog;
    void _unused;
    const { instant } = make([answer({ logs: [listed], next_cursor: 'abc' })]);
    const lines = await instant.findLogs({ userId: 'universe-instant-probe-1', fromMs: 1, toMs: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: 'log_pyJaRBT1OADr', chargeMicros: 0, userId: 'universe-instant-probe-1' });
  });
});

describe('sessions are read back before they count as denied', () => {
  it('reads a session that says nothing as allowing Instant, and only an explicit false as denied', async () => {
    const { instant } = make([answer({ config: { instant: { return_instant_charge: false } } }), answer({ config: { instant: false } }), answer({}, 404)]);
    expect(await instant.sessionInstant('a')).toBe('allowed');
    expect(await instant.sessionInstant('b')).toBe('denied');
    expect(await instant.sessionInstant('c')).toBe('gone');
  });

  it('switches Instant off with a PATCH and trusts it only when it reads back as off', async () => {
    const { instant, calls } = make([answer({ config: { instant: false }, config_version: 2 }), answer({ config: { instant: { x: 1 } } })]);
    expect(await instant.denySessionInstant('s1')).toBe('denied');
    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].body).toEqual({ instant: false });
    await expect(instant.denySessionInstant('s2')).rejects.toBeInstanceOf(AdapterError);
  });

  it('finds the session in an app link', () => {
    expect(sessionIdOfLink('https://backend.composio.dev/tool_router/trs_abc-1/mcp')).toBe('trs_abc-1');
    expect(sessionIdOfLink('https://app.composio.dev/tool_router/v3/trs_abc/mcp')).toBe('trs_abc');
    expect(sessionIdOfLink('https://mcp.example/whatever/mcp')).toBeNull();
    expect(sessionIdOfLink('nonsense')).toBeNull();
  });
});

describe('the tool listing', () => {
  it('reads the pricing words and whether the tool is served as Instant', async () => {
    const { instant, calls } = make([answer({ slug: 'EXA_SEARCH', toolkit: { slug: 'exa' }, description: 'Search', input_parameters: { type: 'object' }, instant: { supported: true, price: { description: '$0.007 per search', discount: '100' } } })]);
    expect(await instant.tool('EXA_SEARCH')).toEqual({ slug: 'EXA_SEARCH', toolkit: 'exa', description: 'Search', inputSchema: { type: 'object' }, instantSupported: true, priceWords: '$0.007 per search' });
    expect(calls[0].url).toContain('include_pricing=true');
  });
});
