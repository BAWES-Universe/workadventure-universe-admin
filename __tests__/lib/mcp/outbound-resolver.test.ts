/**
 * How the outbound guard asks for a name: with the resolver library's own network client, never `dns.lookup`. `dns.lookup` runs getaddrinfo on libuv's few
 * shared worker threads (only two of which may be on slow I/O at once), so two names whose servers never answer would leave every other lookup of the process
 * waiting. The resolver library uses no worker thread and ends each try by itself. What the guard allows does not change.
 */
const asked: Array<{ host: string; kind: 'A' | 'AAAA' }> = [];
let behaviour: (host: string, kind: 'A' | 'AAAA') => Promise<string[]> = async () => [];
const made: unknown[] = [];

jest.mock('node:dns/promises', () => {
  class Resolver {
    constructor(options?: unknown) {
      made.push(options);
    }
    resolve4(host: string) {
      asked.push({ host, kind: 'A' });
      return behaviour(host, 'A');
    }
    resolve6(host: string) {
      asked.push({ host, kind: 'AAAA' });
      return behaviour(host, 'AAAA');
    }
  }
  return { Resolver, lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]) };
});

import { lookup } from 'node:dns/promises';
import { checkOutboundUrl, isAllowedServerIp } from '@/lib/mcp/outbound-guard';

beforeEach(() => {
  asked.length = 0;
  (lookup as jest.Mock).mockClear();
});

const none = Object.assign(new Error('queryA ENODATA'), { code: 'ENODATA' });

describe('the name lookup of the outbound guard', () => {
  it('asks the resolver library, never a worker thread of the process, and ends each try by itself', async () => {
    behaviour = async (_host, kind) => (kind === 'A' ? ['93.184.216.34'] : []);
    expect(await isAllowedServerIp('https://mcp.example.com/mcp')).toEqual({ allowed: true, addresses: [{ address: '93.184.216.34', family: 4 }] });
    expect(lookup).not.toHaveBeenCalled();
    expect(asked.map((one) => one.kind).sort()).toEqual(['A', 'AAAA']);
    expect(made[0]).toMatchObject({ timeout: expect.any(Number), tries: expect.any(Number) });
  });

  it('refuses a name that has one address that is not public, whichever kind of record it came in', async () => {
    behaviour = async (_host, kind) => (kind === 'A' ? ['93.184.216.34'] : ['fd00::1']);
    expect(await isAllowedServerIp('https://mixed.example.com/')).toMatchObject({ allowed: false });
    behaviour = async (_host, kind) => (kind === 'A' ? ['10.0.0.5'] : []);
    expect(await isAllowedServerIp('https://inner.example.com/')).toMatchObject({ allowed: false, error: expect.stringMatching(/private/) });
  });

  it('goes on with the kind of record that exists when the other has none', async () => {
    behaviour = async (_host, kind) => {
      if (kind === 'A') throw none;
      return ['2606:2800:220:1:248:1893:25c8:1946'];
    };
    expect(await isAllowedServerIp('https://v6only.example.com/')).toMatchObject({ allowed: true, addresses: [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }] });
  });

  it('says the name did not resolve when neither kind answers', async () => {
    behaviour = async () => {
      throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(await isAllowedServerIp('https://gone.example.com/')).toMatchObject({ allowed: false, error: expect.stringMatching(/DNS resolution failed/) });
  });

  it('an address written out is its own answer, as it was with dns.lookup: a public one is allowed, a private one is not, and no name is asked for', async () => {
    behaviour = async () => {
      throw none;
    };
    expect(await isAllowedServerIp('https://93.184.216.34/mcp')).toEqual({ allowed: true, addresses: [{ address: '93.184.216.34', family: 4 }] });
    expect(await isAllowedServerIp('https://[2606:2800:220:1:248:1893:25c8:1946]/mcp')).toMatchObject({ allowed: true, addresses: [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }] });
    expect(await isAllowedServerIp('https://10.1.2.3/')).toMatchObject({ allowed: false });
    expect(asked).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses localhost and internal names before any lookup, as before (nothing a hosts file says is ever trusted)', async () => {
    behaviour = async () => ['93.184.216.34'];
    for (const url of ['https://localhost/mcp', 'https://metadata.google.internal/', 'https://db.internal/']) {
      expect(await checkOutboundUrl(url)).toMatchObject({ allowed: false });
    }
    expect(asked).toEqual([]);
  });
});
