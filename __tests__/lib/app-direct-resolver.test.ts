/**
 * How the key-app guard asks for a name when it is given no resolver of its own: with the resolver library's own network client, never `dns.lookup`.
 * `dns.lookup` runs getaddrinfo on libuv's few shared worker threads (only two of which may be on slow I/O at once), so two names whose servers never
 * answer would leave every other lookup of the process waiting. The resolver library uses no worker thread and ends each try by itself.
 */
const tries: Array<{ options: unknown; host: string; kind: 'A' | 'AAAA' }> = [];
let behaviour: (host: string, kind: 'A' | 'AAAA') => Promise<string[]> = async () => [];
const made: unknown[] = [];

jest.mock('node:dns/promises', () => {
  class Resolver {
    constructor(options?: unknown) {
      made.push(options);
    }
    resolve4(host: string) {
      tries.push({ options: made.at(-1), host, kind: 'A' });
      return behaviour(host, 'A');
    }
    resolve6(host: string) {
      tries.push({ options: made.at(-1), host, kind: 'AAAA' });
      return behaviour(host, 'AAAA');
    }
  }
  return { Resolver, lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]) };
});

import { lookup } from 'node:dns/promises';
import { guardedRequest } from '@/lib/app-direct/guard';

const answer = { status: 200, headers: {}, body: '{}' } as never;
const request = (timeoutMs = 1000) => ({ url: 'https://api.example.com/', method: 'GET', headers: {}, timeoutMs, maxBytes: 100 });

beforeEach(() => {
  tries.length = 0;
  (lookup as jest.Mock).mockClear();
});

describe('the name lookup of the key-app guard', () => {
  it('asks the resolver library, never a worker thread of the process, and ends each try by itself', async () => {
    behaviour = async (_host, kind) => (kind === 'A' ? ['93.184.216.34'] : []);
    let sentTo = '';
    await guardedRequest(request(), { send: async (target) => ((sentTo = target.address), answer) });
    expect(sentTo).toBe('93.184.216.34');
    expect(lookup).not.toHaveBeenCalled();
    expect(tries.map((one) => one.kind).sort()).toEqual(['A', 'AAAA']);
    // Each try has its own time and a few tries: a name whose servers never answer frees what it holds
    expect(made[0]).toMatchObject({ timeout: expect.any(Number), tries: expect.any(Number) });
  });

  it('still refuses a name with one address that is not public, whichever kind of record it came in', async () => {
    behaviour = async (_host, kind) => (kind === 'A' ? ['93.184.216.34'] : ['::1']);
    await expect(guardedRequest(request(), { send: async () => answer })).rejects.toMatchObject({ code: 'blocked' });
  });

  it('goes on with the kind of record that exists when the other has none', async () => {
    behaviour = async (_host, kind) => {
      if (kind === 'A') throw Object.assign(new Error('queryA ENODATA'), { code: 'ENODATA' });
      return ['2606:2800:220:1:248:1893:25c8:1946'];
    };
    let family = 0;
    await guardedRequest(request(), { send: async (target) => ((family = target.family), answer) });
    expect(family).toBe(6);
  });

  it('says the name did not resolve when neither kind answers, and a name that never answers ends the call at its deadline, with no lookup made by the process', async () => {
    behaviour = async () => {
      throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    await expect(guardedRequest(request(), { send: async () => answer })).rejects.toMatchObject({ code: 'unreachable' });
    behaviour = () => new Promise(() => undefined);
    await expect(guardedRequest(request(60), { send: async () => answer })).rejects.toMatchObject({ code: 'timeout' });
    expect(lookup).not.toHaveBeenCalled();
  });
});
