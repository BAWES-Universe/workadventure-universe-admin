/**
 * The connection test of an app's link (game #2001, owner discovery): what it sends, which message it takes as the answer, how it
 * reads an event stream, where it sends the sign-in on a redirect, and what it returns. Against a pretend fetch only.
 */
jest.mock('@/lib/mcp/outbound-guard', () => ({
  ...jest.requireActual('@/lib/mcp/outbound-guard'),
  isAllowedServerIp: jest.fn(async () => ({ allowed: true })),
  // The request itself goes through the pretend fetch (the pinned connection has its own test)
  pinnedFetch: jest.fn(async (url: string, init?: RequestInit) => global.fetch(url, init)),
}));

import { testMcpConnection } from '@/lib/mcp/test-connection';

const fetchBefore = global.fetch;
afterEach(() => {
  global.fetch = fetchBefore;
});

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const sse = (text: string) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const base = { serverUrl: 'https://app.example.com/mcp', authType: 'none', authConfig: null };

type Sent = { url: string; headers: Record<string, string>; message: { id?: string; method: string; params?: { cursor?: string } } };
function pretend(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const one: Sent = { url: String(url), headers: { ...(init?.headers as Record<string, string>) }, message: init?.body ? JSON.parse(String(init.body)) : { method: String(init?.method) } };
    sent.push(one);
    return answer(one);
  }) as unknown as typeof fetch;
  return sent;
}

describe('testMcpConnection', () => {
  it('tells the app the session is open before it lists anything, with the session id it gave', async () => {
    const sent = pretend(({ message }) =>
      message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', result: {} }, { 'mcp-session-id': 'sess-1' }) : message.method === 'tools/list' ? json({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'a' }] } }) : new Response(null, { status: 202 }),
    );
    const result = await testMcpConnection(base);
    expect(result).toMatchObject({ success: true, toolNames: ['a'] });
    expect(sent.map((one) => one.message.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'DELETE']);
    expect(sent[1].headers['Mcp-Session-Id']).toBe('sess-1');
    expect(sent[2].headers['Mcp-Session-Id']).toBe('sess-1');
  });

  it('still lists the tools when the app refuses the notice that the session is open', async () => {
    pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', result: {} }) : message.method === 'tools/list' ? json({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'a' }] } }) : new Response('no', { status: 405 })));
    expect(await testMcpConnection(base)).toMatchObject({ success: true, toolNames: ['a'] });
  });

  it('takes the answer to its own request out of an event stream that sends a notification first, with either line ending', async () => {
    for (const nl of ['\n', '\r\n']) {
      pretend(({ message }) => {
        if (message.method === 'initialize') return sse(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'init', result: {} })}${nl}${nl}`);
        if (message.method === 'tools/list') {
          const notice = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } });
          const answer = JSON.stringify({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'find_events' }] } });
          return sse(`event: message${nl}data: ${notice}${nl}${nl}event: message${nl}data: ${answer}${nl}${nl}`);
        }
        return new Response(null, { status: 202 });
      });
      expect(await testMcpConnection(base)).toMatchObject({ success: true, toolCount: 1, toolNames: ['find_events'] });
    }
  });

  it('does not wait for an event stream that stays open after the answer', async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    pretend(({ message }) => {
      if (message.method !== 'tools/list') return message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', result: {} }) : new Response(null, { status: 202 });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'a' }] } })}\n\n`));
          // never closed
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    expect(await testMcpConnection(base)).toMatchObject({ success: true, toolNames: ['a'] });
    expect(cancelled).toBe(true);
  });

  it('reads every page of a long list of tools, once each name', async () => {
    const sent = pretend(({ message }) => {
      if (message.method === 'initialize') return json({ jsonrpc: '2.0', id: 'init', result: {} });
      if (message.method !== 'tools/list') return new Response(null, { status: 202 });
      return message.params?.cursor === 'p2'
        ? json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'b' }, { name: 'a' }] } })
        : json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'a' }], nextCursor: 'p2' } });
    });
    expect(await testMcpConnection(base)).toMatchObject({ success: true, toolCount: 2, toolNames: ['a', 'b'] });
    expect(sent.filter((one) => one.message.method === 'tools/list').map((one) => one.message.params?.cursor)).toEqual([undefined, 'p2']);
  });

  it('stops following a cursor the app keeps repeating, and says the list is incomplete', async () => {
    pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', result: {} }) : message.method !== 'tools/list' ? new Response(null, { status: 202 }) : json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'a' }], nextCursor: 'same' } })));
    expect(await testMcpConnection(base)).toMatchObject({ success: true, toolNames: ['a'], incomplete: true });
  });

  it('says the list is incomplete when the app still offers a page after the last one that is read, and not when it ends there', async () => {
    const pages = (total: number) =>
      pretend(({ message }) => {
        if (message.method === 'initialize') return json({ jsonrpc: '2.0', id: 'init', result: {} });
        if (message.method !== 'tools/list') return new Response(null, { status: 202 });
        const page = Number(message.id);
        return json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: `tool_${page}` }], ...(page < total ? { nextCursor: `c${page + 1}` } : {}) } });
      });
    pages(21);
    const long = await testMcpConnection(base);
    expect(long).toMatchObject({ success: true, incomplete: true, toolCount: 20 });
    expect(long.toolNames[0]).toBe('tool_1');
    expect(long.toolNames[19]).toBe('tool_20');
    pages(20);
    const exact = await testMcpConnection(base);
    expect(exact).toMatchObject({ success: true, toolCount: 20 });
    expect(exact.incomplete).toBeUndefined();
  });

  it('never returns what an app echoes of the credentials it was sent in an error answer', async () => {
    pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', error: { message: 'bad Authorization: Bearer sk-live-secret-1234567890' } }) : new Response(null, { status: 202 })));
    const opened = await testMcpConnection(base);
    expect(opened.success).toBe(false);
    expect(JSON.stringify(opened)).not.toContain('sk-live-secret-1234567890');

    pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', result: {} }) : message.method !== 'tools/list' ? new Response(null, { status: 202 }) : json({ jsonrpc: '2.0', id: '1', error: { message: 'bad Authorization: Bearer sk-live-secret-1234567890' } })));
    const listed = await testMcpConnection(base);
    expect(listed.success).toBe(false);
    expect(JSON.stringify(listed)).not.toContain('sk-live-secret-1234567890');

    pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', error: { message: 'bad Authorization: Bearer abc123' } }) : new Response(null, { status: 202 })));
    const short = await testMcpConnection(base);
    expect(short.success).toBe(false);
    expect(JSON.stringify(short)).not.toContain('abc123');
  });

  it('fails, rather than breaks, on a list with no tools key or a tool whose name is not text', async () => {
    const answers = [{ result: {} }, { result: { tools: [{ name: 42 }] } }, { result: { tools: ['x'] } }, { result: { tools: [{}] } }, { result: { tools: [{ name: '  ' }] } }];
    for (const answer of answers) {
      pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', result: {} }) : message.method !== 'tools/list' ? new Response(null, { status: 202 }) : json({ jsonrpc: '2.0', id: '1', ...answer })));
      const result = await testMcpConnection(base);
      expect(result).toMatchObject({ success: false, toolCount: 0, toolNames: [] });
    }
  });

  it('keeps the sign-in on a redirect within the same origin, and sends it nowhere else', async () => {
    const withKeys = { ...base, headers: { 'X-API-Key': 'key-1', 'CF-Access-Client-Id': 'id-1', 'CF-Access-Client-Secret': 'secret-1' } };

    const same = pretend((one) => {
      if (one.url === 'https://app.example.com/mcp') return new Response(null, { status: 307, headers: { location: '/mcp/' } });
      return one.message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', result: {} }) : one.message.method !== 'tools/list' ? new Response(null, { status: 202 }) : json({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'a' }] } });
    });
    await testMcpConnection(withKeys);
    const afterSame = same.find((one) => one.url === 'https://app.example.com/mcp/');
    expect(afterSame?.headers['X-API-Key']).toBe('key-1');
    expect(afterSame?.headers['CF-Access-Client-Secret']).toBe('secret-1');

    const other = pretend((one) => (one.url.startsWith('https://app.example.com') ? new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.net/mcp' } }) : new Response('no', { status: 401 })));
    await testMcpConnection(withKeys);
    const away = other.find((one) => one.url === 'https://elsewhere.example.net/mcp');
    expect(away).toBeDefined();
    expect(Object.keys(away!.headers).map((key) => key.toLowerCase()).sort()).toEqual(['accept', 'content-type']);
  });

  const listing = (tools: unknown[] = [{ name: 'a' }], over: Partial<{ init: Response; seen: (one: Sent) => void }> = {}) =>
    pretend((one) => {
      over.seen?.(one);
      if (one.message.method === 'initialize') return over.init ?? json({ jsonrpc: '2.0', id: 'init', result: {} });
      if (one.message.method === 'tools/list') return json({ jsonrpc: '2.0', id: '1', result: { tools } });
      return new Response(null, { status: 202 });
    });

  describe('review findings on the connection test', () => {
    it('keeps a required input that the schema does not declare in its properties', async () => {
      listing([{ name: 'search', inputSchema: { type: 'object', properties: { limit: {} }, required: ['query'] } }]);
      const result = await testMcpConnection(base);
      expect(result.tools?.[0].inputs).toEqual(expect.arrayContaining([{ name: 'query', required: true }, { name: 'limit', required: false }]));
    });

    it('takes only the message whose id is the request id, on a plain answer and on a stream alike', async () => {
      pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', result: {} }) : message.method !== 'tools/list' ? new Response(null, { status: 202 }) : json({ jsonrpc: '2.0', id: 'other', result: { tools: [{ name: 'a' }] } })));
      expect(await testMcpConnection(base)).toMatchObject({ success: false });
      pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', result: {} }) : message.method !== 'tools/list' ? new Response(null, { status: 202 }) : sse(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a' }] } })}\n\n`)));
      expect(await testMcpConnection(base)).toMatchObject({ success: false });
    });

    it('stops reading an answer that is larger than the limit, on a plain answer and on a stream alike', async () => {
      const big = 'x'.repeat(3 * 1024 * 1024);
      pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', result: {} }) : message.method !== 'tools/list' ? new Response(null, { status: 202 }) : json({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'a', description: big }] } })));
      expect(await testMcpConnection(base)).toMatchObject({ success: false });
      // One chunk that crosses the limit is not read at all, even when the answer is in it
      pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', result: {} }) : message.method !== 'tools/list' ? new Response(null, { status: 202 }) : sse(`data: ${JSON.stringify({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'a', description: big }] } })}\n\n`)));
      expect(await testMcpConnection(base)).toMatchObject({ success: false });
    });

    it('never returns the configured credentials, even when an app sends one back as a bare error message', async () => {
      const keyed = { ...base, authType: 'api-key', headers: { 'X-Tenant': 'tenant-secret-77' } };
      jest.resetModules();
      const key = 'plainkey123456';
      jest.doMock('@/lib/encryption', () => ({ decryptApiKey: () => key }));
      const { testMcpConnection: run } = await import('@/lib/mcp/test-connection');
      pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', error: { message: `${key} is not allowed for tenant-secret-77` } }) : new Response(null, { status: 202 })));
      const opened = await run({ ...keyed, authConfig: 'x' });
      expect(JSON.stringify(opened)).not.toContain(key);
      expect(JSON.stringify(opened)).not.toContain('tenant-secret-77');
      pretend(() => new Response(`${key}`, { status: 401, statusText: key, headers: { 'www-authenticate': `Basic realm="${key}"` } }));
      const refused = await run({ ...keyed, authConfig: 'x' });
      expect(JSON.stringify(refused)).not.toContain(key);
      jest.dontMock('@/lib/encryption');
    });

    it('never returns a credential that has a quote, a backslash or a slash in it, in JSON’s own spelling or as read out of it', async () => {
      const keyed = { ...base, authType: 'api-key' };
      jest.resetModules();
      const key = 'ab"cd\\ef/gh12345';
      jest.doMock('@/lib/encryption', () => ({ decryptApiKey: () => key }));
      const { testMcpConnection: run } = await import('@/lib/mcp/test-connection');
      const spellings = [key, JSON.stringify(key).slice(1, -1), JSON.stringify(key).slice(1, -1).replace(/\//g, '\\/')];
      const none = (result: unknown) => spellings.forEach((spelling) => expect(JSON.stringify(result)).not.toContain(JSON.stringify(spelling).slice(1, -1)));
      pretend(() => new Response(JSON.stringify({ error: `rejected ${key}` }), { status: 401, headers: { 'content-type': 'application/json' } }));
      const refused = await run({ ...keyed, authConfig: 'x' });
      none(refused);
      expect(refused).toMatchObject({ success: false, status: 401 });
      expect(refused.error).toContain('rejected');
      // The same in the body as the server wrote it, with the slash escaped too
      pretend(() => new Response(`{"error":"rejected ${spellings[2]}"}`, { status: 401 }));
      none(await run({ ...keyed, authConfig: 'x' }));
      // An answer to the request itself that is an error object with no message
      pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', error: { code: -1, data: key } }) : new Response(null, { status: 202 })));
      none(await run({ ...keyed, authConfig: 'x' }));
      jest.dontMock('@/lib/encryption');
    });

    it('sends fixed protocol headers, not custom ones, to another origin on a redirect', async () => {
      const custom = { ...base, headers: { Accept: 'text/plain; secret=1', 'Content-Type': 'text/plain; secret=2' } };
      const other = pretend((one) => (one.url.startsWith('https://app.example.com') ? new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.net/mcp' } }) : new Response('no', { status: 401 })));
      await testMcpConnection(custom);
      const away = other.find((one) => one.url === 'https://elsewhere.example.net/mcp');
      expect(away?.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' });
    });

    it('sends the session id only to the origin that issued it, and the negotiated version everywhere', async () => {
      const sent = pretend((one) => {
        if (one.url === 'https://app.example.com/mcp') return new Response(null, { status: 307, headers: { location: 'https://issuer.example.net/mcp' } });
        if (one.message.method === 'initialize') return json({ jsonrpc: '2.0', id: 'init', result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 'sess-9' });
        if (one.message.method === 'tools/list') return json({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'a' }] } });
        return new Response(null, { status: 202 });
      });
      await testMcpConnection(base);
      const original = sent.filter((one) => one.url === 'https://app.example.com/mcp');
      expect(original.length).toBeGreaterThan(1);
      for (const one of original.slice(1)) expect(one.headers['Mcp-Session-Id']).toBeUndefined();
      const issuer = sent.filter((one) => one.url === 'https://issuer.example.net/mcp' && one.message.method === 'tools/list');
      expect(issuer[0].headers['Mcp-Session-Id']).toBe('sess-9');
      expect(issuer[0].headers['MCP-Protocol-Version']).toBe('2025-06-18');
      expect(original[1].headers['MCP-Protocol-Version']).toBe('2025-06-18');
    });

    it('answers a CR-only event without waiting for another chunk', async () => {
      pretend(({ message }) => {
        if (message.method === 'initialize') return json({ jsonrpc: '2.0', id: 'init', result: {} });
        if (message.method !== 'tools/list') return new Response(null, { status: 202 });
        const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'a' }] } })}\r\r`)); } });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      });
      expect(await testMcpConnection(base)).toMatchObject({ success: true, toolNames: ['a'] });
    });

    it('never returns a credential with a quote in it from a JSON error answer: not as the error code, not in the kept body', async () => {
      const key = 'abc"def12345';
      jest.resetModules();
      jest.doMock('@/lib/encryption', () => ({ decryptApiKey: () => key }));
      const { testMcpConnection: run } = await import('@/lib/mcp/test-connection');
      // The body says it escaped (a quote in a JSON text is written \"), and once read it is the key again
      pretend(() => new Response(JSON.stringify({ error: `bad key ${key}`, error_description: `${key} refused` }), { status: 401, headers: { 'content-type': 'application/json' } }));
      const refused = await run({ ...base, authType: 'api-key', authConfig: 'x' });
      expect(refused.success).toBe(false);
      expect(JSON.stringify(refused)).not.toContain('def12345');
      expect(refused.errorCode).toContain('[removed]');
      expect(refused.errorBody).not.toContain('def12345');
      // Cut short, so it is no longer JSON: the key as JSON writes it is still removed
      pretend(() => new Response(`{"error":"bad key ${JSON.stringify(key).slice(1, -1)}", "more": "x`, { status: 401 }));
      expect(JSON.stringify(await run({ ...base, authType: 'api-key', authConfig: 'x' }))).not.toContain('def12345');
      jest.dontMock('@/lib/encryption');
    });

    it('never returns a credential an app echoes as the reason phrase of a redirect that has no Location', async () => {
      const key = 'plainkey123456';
      jest.resetModules();
      jest.doMock('@/lib/encryption', () => ({ decryptApiKey: () => key }));
      const { testMcpConnection: run } = await import('@/lib/mcp/test-connection');
      pretend(() => new Response(null, { status: 302, statusText: key }));
      const result = await run({ ...base, authType: 'api-key', authConfig: 'x' });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain(key);
      jest.dontMock('@/lib/encryption');
    });

    it('says plainly that an app names a protocol version this check does not know, still reads what it can do, and closes the session it opened', async () => {
      const sent = pretend(({ message }) => {
        if (message.method === 'initialize') return json({ jsonrpc: '2.0', id: 'init', result: { protocolVersion: '2099-01-01' } }, { 'mcp-session-id': 'sess-v' });
        if (message.method === 'tools/list') return json({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'a' }] } });
        return new Response(null, { status: 202 });
      });
      const result = await testMcpConnection(base);
      // The app is not called broken: its tools are read, and the version is said beside the result
      expect(result).toMatchObject({ success: true, toolCount: 1, toolNames: ['a'] });
      expect(result.note).toContain('2099-01-01');
      expect(sent.map((one) => one.message.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'DELETE']);
      // A version the check does not know is not sent back as the one in force
      expect(sent.find((one) => one.message.method === 'tools/list')!.headers).not.toHaveProperty('MCP-Protocol-Version');
      // An app that names none passes with no note (it applies its own default)
      pretend(({ message }) => (message.method === 'initialize' ? json({ jsonrpc: '2.0', id: 'init', result: {} }) : message.method === 'tools/list' ? json({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'a' }] } }) : new Response(null, { status: 202 })));
      const none = await testMcpConnection(base);
      expect(none).toMatchObject({ success: true });
      expect(none.note).toBeUndefined();
    });

    it('closes the session at the address that opened it, with the sign-in on the configured origin only', async () => {
      const keyed = { ...base, authType: 'bearer', authConfig: 'x' };
      jest.resetModules();
      jest.doMock('@/lib/encryption', () => ({ decryptApiKey: () => 'tok-close-123' }));
      const { testMcpConnection: run } = await import('@/lib/mcp/test-connection');
      const answer = (one: Sent) => {
        if (one.url === 'https://app.example.com/mcp') return new Response(null, { status: 307, headers: { location: 'https://app.example.com/mcp/' } });
        if (one.message.method === 'initialize') return json({ jsonrpc: '2.0', id: 'init', result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 'sess-same' });
        if (one.message.method === 'tools/list') return json({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'a' }] } });
        return new Response(null, { status: 202 });
      };
      // /mcp redirects to /mcp/: the session lives at /mcp/, and is closed there with the sign-in (same origin)
      let sent = pretend(answer);
      await run(keyed);
      let closing = sent.find((one) => one.message.method === 'DELETE')!;
      expect(closing.url).toBe('https://app.example.com/mcp/');
      expect(closing.headers).toMatchObject({ Authorization: 'Bearer tok-close-123', 'Mcp-Session-Id': 'sess-same', 'MCP-Protocol-Version': '2025-06-18' });
      // The session is issued by another origin: it is closed there, with its session id and the version, and none of what was configured
      sent = pretend((one) => (one.url === 'https://app.example.com/mcp' ? new Response(null, { status: 307, headers: { location: 'https://issuer.example.net/mcp' } }) : answer(one)));
      await run({ ...keyed, headers: { 'X-Tenant': 'tenant-1' } });
      closing = sent.find((one) => one.message.method === 'DELETE')!;
      expect(closing.url).toBe('https://issuer.example.net/mcp');
      expect(closing.headers['Mcp-Session-Id']).toBe('sess-same');
      expect(closing.headers['Authorization']).toBeUndefined();
      expect(closing.headers['X-Tenant']).toBeUndefined();
      jest.dontMock('@/lib/encryption');
    });

    it('does not let closing the session hold up a finished test beyond its three seconds, whatever it is waiting for', async () => {
      jest.useFakeTimers();
      try {
        // The close never gets as far as an answer (a name that never resolves, or a server that never replies)
        global.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.method === 'DELETE') return new Promise<Response>(() => undefined);
          const message = JSON.parse(String(init?.body));
          if (message.method === 'initialize') return json({ jsonrpc: '2.0', id: 'init', result: {} }, { 'mcp-session-id': 'sess-slow' });
          if (message.method === 'tools/list') return json({ jsonrpc: '2.0', id: '1', result: { tools: [{ name: 'a' }] } });
          return new Response(null, { status: 202 });
        }) as unknown as typeof fetch;
        let result: unknown = null;
        const running = testMcpConnection(base).then((one) => (result = one));
        await jest.advanceTimersByTimeAsync(2_900);
        expect(result).toBeNull();
        await jest.advanceTimersByTimeAsync(300);
        await running;
        expect(result).toMatchObject({ success: true, toolNames: ['a'] });
      } finally {
        jest.useRealTimers();
      }
    });

    it('closes the session it opened, and says a non-JSON answer in fixed words', async () => {
      const sent = listing([{ name: 'a' }], { init: json({ jsonrpc: '2.0', id: 'init', result: {} }, { 'mcp-session-id': 'sess-2' }) });
      await testMcpConnection(base);
      const closing = sent.find((one) => one.message.method === 'DELETE');
      expect(closing?.headers['Mcp-Session-Id']).toBe('sess-2');
      pretend(() => new Response('<html>secret-token-abcdef</html>', { status: 200, headers: { 'content-type': 'application/json' } }));
      const bad = await testMcpConnection(base);
      expect(bad.success).toBe(false);
      expect(bad.error).not.toContain('secret-token-abcdef');
    });
  });
});
