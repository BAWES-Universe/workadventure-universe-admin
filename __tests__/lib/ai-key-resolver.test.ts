/**
 * How the address check for a person's own AI key or voice server asks for a name: with the resolver library's own network client, never `dns.lookup`.
 * `dns.lookup` runs getaddrinfo on libuv's few shared worker threads (only two of which may be on slow I/O at once), so two names whose servers never
 * answer would leave every other lookup of the process waiting. The resolver library uses no worker thread and ends each try by itself. What is allowed
 * (a public name, every address public, https, no address written out) does not change.
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

import { lookup as nodeLookup } from 'node:dns/promises';
import { AddressError, checkPublicHttpsUrl } from '@/lib/ai-key-fetch';

beforeEach(() => {
  asked.length = 0;
  (nodeLookup as jest.Mock).mockClear();
});

const none = Object.assign(new Error('queryA ENODATA'), { code: 'ENODATA' });
const refused = (raw: string) => checkPublicHttpsUrl(raw).then(() => null, (error) => (error instanceof AddressError ? error.problem : `other:${String(error)}`));

describe('the name lookup of the own-key address check', () => {
  it('asks the resolver library, never a worker thread of the process, and ends each try by itself', async () => {
    behaviour = async (_host, kind) => (kind === 'A' ? ['93.184.216.34'] : []);
    const checked = await checkPublicHttpsUrl('https://lm.example.com/v1/models');
    expect(checked.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(nodeLookup).not.toHaveBeenCalled();
    expect(asked.map((one) => one.kind).sort()).toEqual(['A', 'AAAA']);
    expect(made[0]).toMatchObject({ timeout: expect.any(Number), tries: expect.any(Number) });
  });

  it('keeps every address of both kinds for the connection, and refuses the name when even one is not public', async () => {
    behaviour = async (_host, kind) => (kind === 'A' ? ['93.184.216.34'] : ['2606:2800:220:1:248:1893:25c8:1946']);
    const checked = await checkPublicHttpsUrl('https://dual.example.com/');
    expect(checked.addresses.map((one) => one.family).sort()).toEqual([4, 6]);
    behaviour = async (_host, kind) => (kind === 'A' ? ['93.184.216.34'] : ['fd00::1']);
    expect(await refused('https://mixed.example.com/')).toBe('private');
    behaviour = async (_host, kind) => (kind === 'A' ? ['169.254.169.254'] : []);
    expect(await refused('https://metadata.example.com/')).toBe('private');
  });

  it('goes on with the kind of record that exists when the other has none', async () => {
    behaviour = async (_host, kind) => {
      if (kind === 'A') throw none;
      return ['2606:2800:220:1:248:1893:25c8:1946'];
    };
    const checked = await checkPublicHttpsUrl('https://v6only.example.com/');
    expect(checked).toMatchObject({ family: 6, address: '2606:2800:220:1:248:1893:25c8:1946' });
  });

  it('says a name that does not exist does not exist, whichever way neither kind answers', async () => {
    behaviour = async () => {
      throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(await refused('https://gone.example.com/')).toBe('unresolved');
    behaviour = async () => [];
    expect(await refused('https://empty.example.com/')).toBe('unresolved');
  });

  it('still refuses an address written out, localhost and a name without a dot before any lookup', async () => {
    behaviour = async () => ['93.184.216.34'];
    for (const raw of ['https://127.0.0.1/', 'https://8.8.8.8/', 'https://[::1]/', 'https://localhost/', 'https://intranet/']) {
      expect(await refused(raw)).toBe('not-a-name');
    }
    expect(await refused('http://lm.example.com/')).toBe('not-https');
    expect(asked).toEqual([]);
  });
});
