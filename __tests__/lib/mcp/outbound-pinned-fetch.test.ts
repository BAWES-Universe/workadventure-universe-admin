/**
 * pinnedFetch: the name is resolved ONCE, every address is checked, and the socket goes to the checked address (DNS rebinding:
 * a second look-up by fetch could answer with an internal address after the check passed). Against a pretend resolver and a pretend
 * socket only.
 */
const lookupMock = jest.fn();
jest.mock('dns/promises', () => ({ lookup: (...args: unknown[]) => lookupMock(...args) }));

const requests: { options: Record<string, unknown>; body?: string }[] = [];
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
          incoming.statusCode = 200;
          incoming.statusMessage = 'OK';
          incoming.headers = { 'content-type': 'application/json' };
          onResponse(incoming);
          incoming.end('{"ok":true}');
        };
        return request;
      },
    },
  };
});

import { pinnedFetch } from '@/lib/mcp/outbound-guard';

beforeEach(() => {
  requests.length = 0;
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

  it('sends nothing when any address of the name is not allowed', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(pinnedFetch('https://mixed.example.com/mcp', { method: 'POST', body: '{}' })).rejects.toThrow(/private/);
    expect(requests).toHaveLength(0);
  });
});
