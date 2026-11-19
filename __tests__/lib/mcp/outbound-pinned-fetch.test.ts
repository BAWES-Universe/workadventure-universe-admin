/**
 * pinnedFetch: the name is resolved ONCE, every address is checked, and the socket goes to the checked address (DNS rebinding:
 * a second look-up by fetch could answer with an internal address after the check passed). Against a pretend resolver and a pretend
 * socket only.
 */
const lookupMock = jest.fn();
jest.mock('dns/promises', () => ({ lookup: (...args: unknown[]) => lookupMock(...args) }));

const requests: { options: Record<string, unknown>; body?: string }[] = [];
let answerStatus = 200;
let destroyed = 0;
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
          incoming.statusCode = answerStatus;
          const destroy = incoming.destroy.bind(incoming);
          incoming.destroy = ((...args: Parameters<typeof destroy>) => {
            destroyed += 1;
            return destroy(...args);
          }) as typeof incoming.destroy;
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
  answerStatus = 200;
  destroyed = 0;
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

  it('keeps every checked address for the socket to try, and no other', async () => {
    lookupMock.mockResolvedValue([
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
    await pinnedFetch('https://two.example.com/mcp', { method: 'POST', body: '{}' });
    const { options } = requests[0];
    const answer = (all: boolean) => new Promise<unknown>((resolve) => (options.lookup as (n: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void)('two.example.com', { all }, (...args: unknown[]) => resolve(args)));
    expect(await answer(true)).toEqual([
      null,
      [
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
        { address: '93.184.216.34', family: 4 },
      ],
    ]);
    expect(await answer(false)).toEqual([null, '2606:2800:220:1:248:1893:25c8:1946', 6]);
  });

  it.each([600, 0, 101])('rejects, and closes the answer, when a server answers with a status that cannot be read (%i)', async (status) => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    answerStatus = status;
    await expect(pinnedFetch('https://hostile.example.com/mcp', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(Error);
    expect(destroyed).toBe(1);
  });

  it('stops waiting for a stalled look-up when the caller gives up, and starts nothing when it answers late', async () => {
    let answerLate: (value: unknown) => void = () => undefined;
    lookupMock.mockReturnValue(new Promise((resolve) => (answerLate = resolve)));
    const stop = new AbortController();
    const pending = pinnedFetch('https://slow.example.com/mcp', { method: 'DELETE', signal: stop.signal });
    stop.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    answerLate([{ address: '93.184.216.34', family: 4 }]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(0);
    // Already given up before it began
    await expect(pinnedFetch('https://slow.example.com/mcp', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toHaveLength(0);
  });
});
