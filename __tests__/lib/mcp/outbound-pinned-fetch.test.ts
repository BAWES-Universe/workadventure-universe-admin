/**
 * pinnedFetch: the name is resolved ONCE, every address is checked, and the socket goes to the checked address (DNS rebinding:
 * a second look-up by fetch could answer with an internal address after the check passed). Against a pretend resolver and a pretend
 * socket only.
 */
const lookupMock = jest.fn();
jest.mock('dns/promises', () => ({ lookup: (...args: unknown[]) => lookupMock(...args) }));

const requests: { options: Record<string, unknown>; body?: string }[] = [];
// What the pretend server answers, and whether the answer comes after the request call has returned (as a real one does)
const mockReply = { status: 200, later: false };
jest.mock('node:https', () => {
  const { EventEmitter } = jest.requireActual('node:events') as typeof import('node:events');
  const { PassThrough } = jest.requireActual('node:stream') as typeof import('node:stream');
  return {
    __esModule: true,
    default: {
      request: (options: Record<string, unknown>, onResponse: (response: unknown) => void) => {
        const request = new EventEmitter() as import('node:events').EventEmitter & { end: (body?: string) => void };
        request.end = (body?: string) => {
          requests.push({ options, body });
          const incoming = new PassThrough() as import('node:stream').PassThrough & { statusCode?: number; statusMessage?: string; headers?: Record<string, string> };
          incoming.statusCode = mockReply.status;
          incoming.statusMessage = 'OK';
          incoming.headers = { 'content-type': 'application/json' };
          if (mockReply.later) setTimeout(() => onResponse(incoming), 5);
          else onResponse(incoming);
          incoming.end('{"ok":true}');
        };
        return request;
      },
    },
  };
});

import { createServer, connect, type AddressInfo } from 'node:net';
import { pinnedFetch, pinnedLookup } from '@/lib/mcp/outbound-guard';

beforeEach(() => {
  requests.length = 0;
  mockReply.status = 200;
  mockReply.later = false;
  lookupMock.mockReset();
});

describe('pinnedFetch', () => {
  it('connects to the address that was checked and never resolves the name a second time', async () => {
    // A rebinding name: public for the first look-up, internal for any later one
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const response = await pinnedFetch('https://rebind.example.com/mcp?x=1', { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.test' }, body: '{"a":1}' });
    expect(await response.json()).toEqual({ ok: true });
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    const { options } = requests[0];
    expect(options).toMatchObject({ host: 'rebind.example.com', port: 443, method: 'POST', path: '/mcp?x=1' });
    // What the socket's own name look-up answers is the checked address, for one address or all of them
    const answer = (all: boolean) => new Promise<unknown>((resolve) => (options.lookup as (n: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void)('rebind.example.com', { all }, (...args: unknown[]) => resolve(args)));
    expect(await answer(false)).toEqual([null, '93.184.216.34', 4]);
    expect(await answer(true)).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
    // The caller's Host header is never sent
    expect(Object.keys(options.headers as object).map((name) => name.toLowerCase())).not.toContain('host');
  });

  it('never lets a caller\'s own accept-encoding replace identity, whatever its case: the answer is not decoded here', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    await pinnedFetch('https://plain.example.com/mcp', { method: 'POST', headers: { 'Accept-Encoding': 'gzip', 'accept-encoding': 'br' }, body: '{}' });
    const sent = Object.entries(requests[0].options.headers as Record<string, string>).filter(([name]) => name.toLowerCase() === 'accept-encoding');
    expect(sent).toEqual([['accept-encoding', 'identity']]);
  });

  it('rejects an answer it cannot make a response of (a status of 600, which comes after the request call returned) instead of leaving the caller waiting', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    mockReply.status = 600;
    mockReply.later = true;
    await expect(pinnedFetch('https://odd.example.com/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({ name: 'RangeError' });
  });

  it('hands the socket every checked address, in order, so a first one that does not answer falls back to the next, and never an address that was not checked', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '2606:4700::6810:84e5', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
    await pinnedFetch('https://dual.example.com/mcp', { method: 'POST', body: '{}' });
    const { options } = requests[0];
    const answer = (all: boolean) => new Promise<unknown>((resolve) => (options.lookup as (n: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void)('dual.example.com', { all }, (...args: unknown[]) => resolve(args)));
    expect(await answer(true)).toEqual([null, [{ address: '2606:4700::6810:84e5', family: 6 }, { address: '93.184.216.34', family: 4 }]]);
    expect(await answer(false)).toEqual([null, '2606:4700::6810:84e5', 6]);
    // The socket is allowed to try the next address of those it was given
    expect(options).toMatchObject({ autoSelectFamily: true });
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('a real socket given a first address that refuses and a second that answers connects to the second, through the same look-up', async () => {
    const server = createServer((socket) => socket.end('hi'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // ::1 has nothing listening on this port (or no IPv6 at all): the first address fails and the second is the one that answers
      const lookup = pinnedLookup([
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ]);
      const got = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: 'pinned.example.com', port, lookup: lookup as never, autoSelectFamily: true });
        socket.setEncoding('utf8');
        let text = '';
        socket.on('data', (chunk) => (text += chunk));
        socket.on('end', () => resolve(text));
        socket.on('error', reject);
      });
      expect(got).toBe('hi');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends nothing when any address of the name is not allowed', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(pinnedFetch('https://mixed.example.com/mcp', { method: 'POST', body: '{}' })).rejects.toThrow(/private/);
    expect(requests).toHaveLength(0);
  });
});
