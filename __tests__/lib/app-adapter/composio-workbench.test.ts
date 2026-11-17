import { createComposioAdapter } from '@/lib/app-adapter/composio';
import type { WorkbenchAdapter } from '@/lib/app-adapter/types';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

describe('the provider’s workspace for a code job, as its docs and a live check say', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const make = (handler: Handler, checkFileUrl: (url: string) => Promise<boolean> = async (url) => url.startsWith('https://files.example/')): WorkbenchAdapter => {
    const adapter = createComposioAdapter({
      apiKey: 'secret-key',
      authConfigFor: async () => null,
      checkFileUrl,
      sleep: async () => undefined,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return handler(url, init);
      }) as unknown as typeof fetch,
    });
    if (!adapter.workbench) throw new Error('no workbench');
    return adapter.workbench;
  };
  const sent = (n = 0) => JSON.parse(String(calls[n].init.body));
  beforeEach(() => (calls.length = 0));

  const restricted = (over: Record<string, unknown> = {}) => ({
    session_id: 'sess_1',
    config: {
      instant: false,
      toolkits: { enabled: [] },
      workbench: { enable: true, proxy_execution_enabled: false, tool_execution_enabled: false },
      manage_connections: { enabled: false },
      ...over,
    },
  });

  describe('opening', () => {
    it('asks for no App, no tools in the workspace, no raw requests, no connection tools and no Instant, and keeps the key off everything else', async () => {
      const bench = make(() => json(restricted()));
      await expect(bench.open({ jobUserId: 'codejob-1' })).resolves.toEqual({ sessionId: 'sess_1' });
      expect(calls[0].url).toBe('https://backend.composio.dev/api/v3.1/tool_router/session');
      expect(sent()).toEqual({
        user_id: 'codejob-1',
        toolkits: { enable: [] },
        workbench: { enable: true, enable_proxy_execution: false, enable_tool_execution: false, sandbox_size: 'standard' },
        manage_connections: { enable: false },
        instant: false,
      });
    });

    it.each([
      ['Instant still on', { instant: { enabled: true } }],
      ['an App on', { toolkits: { enabled: ['gmail'] } }],
      ['no toolkits field at all', { toolkits: undefined }],
      ['raw requests on', { workbench: { enable: true, proxy_execution_enabled: true, tool_execution_enabled: false } }],
      ['tools in the workspace on', { workbench: { enable: true, proxy_execution_enabled: false, tool_execution_enabled: true } }],
      ['a field it did not echo', { workbench: { enable: true } }],
      ['connection tools on', { manage_connections: { enabled: true } }],
      ['the workspace off', { workbench: { enable: false, proxy_execution_enabled: false, tool_execution_enabled: false } }],
    ])('is not trusted, and is deleted again, when the provider answers with %s', async (_why, over) => {
      const bench = make((url, init) => (init.method === 'DELETE' ? json({ deleted: true }) : json(restricted(over))));
      await expect(bench.open({ jobUserId: 'codejob-1' })).rejects.toThrow('did not come back restricted');
      expect(calls.map((call) => call.init.method)).toEqual(['POST', 'DELETE']);
      expect(calls[1].url).toContain('/tool_router/session/sess_1');
    });

    it('fails, still, when the deleting fails too', async () => {
      const bench = make((url, init) => (init.method === 'DELETE' ? json({}, 500) : json(restricted({ instant: true }))));
      await expect(bench.open({ jobUserId: 'codejob-1' })).rejects.toThrow('did not come back restricted');
    });

    it('fails when the provider sends no session', async () => {
      await expect(make(() => json({ config: {} })).open({ jobUserId: 'x' })).rejects.toThrow('no job workspace');
    });
  });

  describe('running code', () => {
    it('runs a cell through the provider’s run call and reads what came back', async () => {
      const bench = make(() => json({ result_type: 'completed', log_id: 'log_1', data: { stdout: 'hi\n', stderr: '', results: '2', error: null } }));
      const run = await bench.run({ sessionId: 'sess_1', code: 'print("hi")', timeoutMs: 5000 });
      expect(run).toEqual({ kind: 'done', cell: { ok: true, stdout: 'hi\n', stderr: '', results: '2', error: null, logId: 'log_1' } });
      expect(calls[0].url).toBe('https://backend.composio.dev/api/v3.1/tool_router/session/sess_1/execute');
      expect(sent()).toMatchObject({ tool_slug: 'COMPOSIO_REMOTE_WORKBENCH', arguments: { code_to_execute: 'print("hi")' } });
    });

    it('says a cell did not work when the code raised or the provider did not say it completed', async () => {
      const raised = make(() => json({ result_type: 'completed', data: { stdout: '', stderr: 'Traceback', error: 'NameError' } }));
      expect(await raised.run({ sessionId: 's', code: 'x', timeoutMs: 1000 })).toMatchObject({ kind: 'done', cell: { ok: false, error: 'NameError', stderr: 'Traceback' } });
      const odd = make(() => json({ result_type: 'something_else', data: {} }));
      expect(await odd.run({ sessionId: 's', code: 'x', timeoutMs: 1000 })).toMatchObject({ kind: 'done', cell: { ok: false } });
    });

    it('says gone for a workspace the provider no longer has, failed for any other answer, and timeout when the wait ended', async () => {
      expect(await make(() => json({}, 404)).run({ sessionId: 's', code: 'x', timeoutMs: 1000 })).toEqual({ kind: 'gone' });
      expect(await make(() => json({}, 410)).run({ sessionId: 's', code: 'x', timeoutMs: 1000 })).toEqual({ kind: 'gone' });
      expect(await make(() => json({ error: 'x' }, 500)).run({ sessionId: 's', code: 'x', timeoutMs: 1000 })).toEqual({ kind: 'failed', status: 500 });
      expect(await make(() => new Response('not json', { status: 200 })).run({ sessionId: 's', code: 'x', timeoutMs: 1000 })).toEqual({ kind: 'failed', status: 200 });
      expect(await make(() => { throw new Error('socket'); }).run({ sessionId: 's', code: 'x', timeoutMs: 1000 })).toEqual({ kind: 'failed', status: null });
      const slow = make((url, init) => new Promise<Response>((resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))));
      expect(await slow.run({ sessionId: 's', code: 'x', timeoutMs: 20 })).toEqual({ kind: 'timeout' });
    });

    it('stops the wait the moment the job is cancelled, not when the time is up', async () => {
      const slow = make((url, init) => new Promise<Response>((resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))));
      const controller = new AbortController();
      const pending = slow.run({ sessionId: 's', code: 'x', timeoutMs: 60_000, signal: controller.signal });
      setTimeout(() => controller.abort(), 10);
      expect(await pending).toEqual({ kind: 'timeout' });
    });
  });

  describe('files', () => {
    it('puts a file in through a presigned address the provider gave, and only a public https one', async () => {
      const bench = make((url) => (url.includes('/mounts/') ? json({ upload_url: 'https://files.example/up?sig=1' }) : new Response(null, { status: 200 })));
      await bench.put({ sessionId: 'sess_1', path: 'in/a.txt', bytes: new Uint8Array([1, 2, 3]), timeoutMs: 5000 });
      expect(calls[0].url).toBe('https://backend.composio.dev/api/v3.1/tool_router/session/sess_1/mounts/files/upload_url');
      expect(sent()).toEqual({ mount_relative_path: 'in/a.txt' });
      expect(calls[1]).toMatchObject({ url: 'https://files.example/up?sig=1' });
      expect(calls[1].init.method).toBe('PUT');
      // The key is for the provider alone: the presigned address gets none
      expect(JSON.stringify(calls[1].init.headers ?? {})).not.toContain('secret-key');
    });

    it('does not use an address that is not allowed, and does not send the file there', async () => {
      const bench = make(() => json({ upload_url: 'http://169.254.169.254/latest' }));
      await expect(bench.put({ sessionId: 's', path: 'in/a.txt', bytes: new Uint8Array(1), timeoutMs: 1000 })).rejects.toThrow('no usable file address');
      expect(calls).toHaveLength(1);
      await expect(make(() => json({})).put({ sessionId: 's', path: 'in/a.txt', bytes: new Uint8Array(1), timeoutMs: 1000 })).rejects.toThrow('no usable file address');
    });

    it('fails a put the storage would not take', async () => {
      const bench = make((url) => (url.includes('/mounts/') ? json({ upload_url: 'https://files.example/up' }) : new Response(null, { status: 403 })));
      await expect(bench.put({ sessionId: 's', path: 'in/a.txt', bytes: new Uint8Array(1), timeoutMs: 1000 })).rejects.toThrow('would not take the file (403)');
    });

    it('lists the files under a prefix, page by page, without folders, and passes a missing size on as null', async () => {
      const pages = [
        json({ items: [{ mount_relative_path: 'out/a.txt', size: 3 }, { mount_relative_path: 'out/dir/', size: 0 }], next_cursor: 'c2' }),
        json({ items: [{ mount_relative_path: 'out/b.txt', size: 5 }] }),
      ];
      const bench = make(() => pages.shift() as Response);
      expect(await bench.list({ sessionId: 'sess_1', prefix: 'out/', timeoutMs: 1000 })).toEqual([
        { path: 'out/a.txt', bytes: 3 },
        { path: 'out/b.txt', bytes: 5 },
      ]);
      expect(calls[0].url).toContain('/mounts/files/items?mount_relative_prefix=out%2F&limit=500');
      expect(calls[1].url).toContain('cursor=c2');
      // One entry with no readable size does not hide the others
      expect(await make(() => json({ items: [{ mount_relative_path: 'out/a.txt' }, { mount_relative_path: 'out/b.txt', size: 2 }] })).list({ sessionId: 's', prefix: 'out/', timeoutMs: 1 })).toEqual([
        { path: 'out/a.txt', bytes: null },
        { path: 'out/b.txt', bytes: 2 },
      ]);
    });

    it('stops paging once it has the files asked for, so a folder of thousands is still listed', async () => {
      let page = 0;
      const bench = make(() => {
        page += 1;
        return json({ items: Array.from({ length: 500 }, (_, n) => ({ mount_relative_path: `out/p${page}-${n}.txt`, size: 1 })), next_cursor: `c${page + 1}` });
      });
      // 2,600 files stand behind the cursor; 60 are wanted
      const files = await bench.list({ sessionId: 's', prefix: 'out/', timeoutMs: 1, limit: 60 });
      expect(files).toHaveLength(60);
      expect(page).toBe(1);
      // With no limit, a listing that never ends still is not called complete
      page = 0;
      await expect(bench.list({ sessionId: 's', prefix: 'out/', timeoutMs: 1 })).rejects.toThrow('could not be listed in full');
    });

    it('does not call a listing complete when the pages never end', async () => {
      const bench = make(() => json({ items: [{ mount_relative_path: 'out/a', size: 1 }], next_cursor: 'again' }));
      await expect(bench.list({ sessionId: 's', prefix: 'out/', timeoutMs: 1 })).rejects.toThrow('could not be listed in full');
    });

    it('reads a file when it is inside the limit, from the stream, and says too big when it is not', async () => {
      const file = (body: BodyInit | null, status = 200, headers: Record<string, string> = {}) => (url: string) => (url.includes('/mounts/') ? json({ download_url: 'https://files.example/down' }) : new Response(body, { status, headers }));
      const ok = await make(file('hello')).read({ sessionId: 's', path: 'out/a.txt', maxBytes: 10, timeoutMs: 1000 });
      expect(ok.kind).toBe('ok');
      if (ok.kind === 'ok') expect(new TextDecoder().decode(ok.bytes)).toBe('hello');
      expect(await make(file('hello world!!')).read({ sessionId: 's', path: 'out/a.txt', maxBytes: 10, timeoutMs: 1000 })).toEqual({ kind: 'too_big' });
      // A length the header states is believed only as far as refusing early; a header that lies low is caught by the stream
      expect(await make(file('x'.repeat(50), 200, { 'content-length': '5' })).read({ sessionId: 's', path: 'out/a.txt', maxBytes: 10, timeoutMs: 1000 })).toEqual({ kind: 'too_big' });
      expect(await make(file('x', 200, { 'content-length': '5000' })).read({ sessionId: 's', path: 'out/a.txt', maxBytes: 10, timeoutMs: 1000 })).toEqual({ kind: 'too_big' });
      expect(await make(file(null, 404)).read({ sessionId: 's', path: 'out/a.txt', maxBytes: 10, timeoutMs: 1000 })).toEqual({ kind: 'missing' });
      await expect(make(file(null, 500)).read({ sessionId: 's', path: 'out/a.txt', maxBytes: 10, timeoutMs: 1000 })).rejects.toThrow('would not give the file (500)');
    });
  });

  describe('closing', () => {
    it('is closed only when the provider says it deleted it', async () => {
      expect(await make(() => json({ deleted: true })).close('sess_1')).toBe('closed');
      expect(calls[0].init.method).toBe('DELETE');
      expect(calls[0].url).toBe('https://backend.composio.dev/api/v3.1/tool_router/session/sess_1');
    });

    it('is gone when the provider no longer has it, and an error for any other answer', async () => {
      expect(await make(() => json({}, 404)).close('sess_1')).toBe('gone');
      await expect(make(() => json({ deleted: false })).close('s')).rejects.toThrow('closing a job workspace');
      await expect(make(() => json({}, 500)).close('s')).rejects.toThrow('closing a job workspace');
      await expect(make(() => new Response('', { status: 200 })).close('s')).rejects.toThrow('closing a job workspace');
    });
  });

  describe('looking for what was not ours', () => {
    const log = (id: string, slug: string | null) => ({ id, status: 'success', metadata: slug ? { tool: { slug } } : {} });

    it('counts the runs in the workspace’s own session that were not our code, and finds the session in the provider’s log by its id', async () => {
      const bench = make(() => json({ logs: [log('1', 'COMPOSIO_REMOTE_WORKBENCH'), log('2', 'GMAIL_FETCH_EMAILS'), log('3', 'COMPOSIO_MULTI_EXECUTE_TOOL'), log('4', null), { nope: true }] }));
      expect(await bench.nestedRuns({ sessionId: 'sess_1', sinceMs: Date.now() - 1000 })).toBe(2);
      expect(calls[0].url).toBe('https://backend.composio.dev/api/v3.1/logs/tool_execution');
      expect(sent().filters).toEqual([{ field: 'session_id', operator: '==', value: 'sess_1' }]);
    });

    it('counts none when only our code ran, and says it cannot know when the log cannot be read', async () => {
      expect(await make(() => json({ logs: [log('1', 'COMPOSIO_REMOTE_WORKBENCH')] })).nestedRuns({ sessionId: 's', sinceMs: 0 })).toBe(0);
      expect(await make(() => json({}, 500)).nestedRuns({ sessionId: 's', sinceMs: 0 })).toBeNull();
    });

    it('reads on while pages are full', async () => {
      const full = Array.from({ length: 100 }, (_, i) => log(String(i), 'COMPOSIO_REMOTE_WORKBENCH'));
      const pages = [json({ logs: full, next_cursor: 'n' }), json({ logs: [log('x', 'GMAIL_X')] })];
      expect(await make(() => pages.shift() as Response).nestedRuns({ sessionId: 's', sinceMs: 0 })).toBe(1);
      expect(sent(1).cursor).toBe('n');
    });
  });
});
