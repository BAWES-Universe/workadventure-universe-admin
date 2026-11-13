/**
 * The connection test of an app's link (game #2001, owner discovery): what it sends, which message it takes as the answer, how it
 * reads an event stream, where it sends the sign-in on a redirect, and what it returns. Against a pretend fetch only.
 */
jest.mock('@/lib/mcp/outbound-guard', () => ({
  ...jest.requireActual('@/lib/mcp/outbound-guard'),
  isAllowedServerIp: jest.fn(async () => ({ allowed: true })),
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
    const one: Sent = { url: String(url), headers: { ...(init?.headers as Record<string, string>) }, message: JSON.parse(String(init?.body)) };
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
    expect(sent.map((one) => one.message.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
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
});
