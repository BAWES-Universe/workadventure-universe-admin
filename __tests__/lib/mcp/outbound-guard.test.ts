import { lookup } from 'dns/promises';
import { checkOutboundUrl, isAllowedServerIp, isAllowedServerUrl } from '@/lib/mcp/outbound-guard';

/**
 * IPv4-mapped IPv6 addresses (#193 review). `new URL()` canonicalises
 * `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, and the guard only recognised the dotted
 * spelling, so a mapped loopback, metadata or private address passed every check —
 * including the one in front of the credential-bearing token requests.
 */

jest.mock('dns/promises', () => ({
  lookup: jest.fn(),
}));

const mockLookup = lookup as unknown as jest.Mock;

beforeEach(() => {
  mockLookup.mockReset();
  // Like the real resolver, an IP literal resolves to itself. Without this the old code
  // would refuse these addresses only because the mock returned nothing.
  mockLookup.mockImplementation(async (host: string) => [{ address: host, family: host.includes(':') ? 6 : 4 }]);
});

describe('IPv4-mapped IPv6 addresses are checked as the IPv4 address they carry', () => {
  const blocked: Array<[string, string]> = [
    ['https://[::ffff:127.0.0.1]/token', 'loopback, dotted spelling'],
    ['https://[::ffff:7f00:1]/token', 'loopback, hex spelling'],
    ['https://[::ffff:a9fe:a9fe]/latest/meta-data', 'cloud metadata 169.254.169.254'],
    ['https://[::ffff:a00:1]/', 'private 10.0.0.1'],
    ['https://[::ffff:ac10:1]/', 'private 172.16.0.1'],
    ['https://[::ffff:c0a8:101]/', 'private 192.168.1.1'],
  ];

  it.each(blocked)('refuses %s (%s) at the hostname check', (url) => {
    expect(isAllowedServerUrl(url)).toBe(false);
  });

  it.each(blocked)('refuses %s (%s) at the address check', async (url) => {
    const verdict = await isAllowedServerIp(url);
    expect(verdict.allowed).toBe(false);
  });

  it.each(blocked)('refuses %s (%s) through checkOutboundUrl', async (url) => {
    const verdict = await checkOutboundUrl(url);
    expect(verdict.allowed).toBe(false);
  });

  it('still allows a mapped public address', async () => {
    mockLookup.mockResolvedValue([{ address: '::ffff:808:808', family: 6 }]);
    expect(isAllowedServerUrl('https://[::ffff:808:808]/')).toBe(true);
    expect((await isAllowedServerIp('https://[::ffff:808:808]/')).allowed).toBe(true);
  });

  it('refuses a public name that resolves to a mapped loopback address', async () => {
    mockLookup.mockResolvedValue([{ address: '::ffff:7f00:1', family: 6 }]);
    const verdict = await checkOutboundUrl('https://token.example.com/oauth/token');
    expect(verdict.allowed).toBe(false);
    expect(verdict.error).toContain('loopback');
  });

  it('refuses a public name that resolves to mapped cloud metadata', async () => {
    mockLookup.mockResolvedValue([{ address: '::ffff:a9fe:a9fe', family: 6 }]);
    const verdict = await checkOutboundUrl('https://token.example.com/oauth/token');
    expect(verdict.allowed).toBe(false);
  });

  it('still allows an ordinary public host', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect((await checkOutboundUrl('https://auth.example.com/oauth2/token')).allowed).toBe(true);
  });
});

describe('shared and reserved IPv4 ranges (100.64.0.0/10, 0.0.0.0/8, 192.0.0.0/24, 198.18.0.0/15)', () => {
  const blocked = ['0.1.2.3', '100.64.0.1', '100.100.100.200', '100.127.255.254', '192.0.0.8', '198.18.0.1', '198.19.255.255'];
  const allowed = ['100.63.255.255', '100.128.0.1', '198.17.255.255', '198.20.0.1', '198.51.100.7', '203.0.113.9'];

  it.each(blocked)('refuses %s as an address in the URL and as a mapped address', async (ip) => {
    expect(isAllowedServerUrl(`https://${ip}/`)).toBe(false);
    expect(isAllowedServerUrl(`https://[::ffff:${ip}]/`)).toBe(false);
    expect((await isAllowedServerIp(`https://${ip}/`)).allowed).toBe(false);
  });

  it.each(blocked)('refuses a public name that resolves to %s, plain or mapped', async (ip) => {
    mockLookup.mockResolvedValue([{ address: ip, family: 4 }]);
    expect((await checkOutboundUrl('https://token.example.com/oauth/token')).allowed).toBe(false);
    mockLookup.mockResolvedValue([{ address: `::ffff:${ip}`, family: 6 }]);
    expect((await isAllowedServerIp('https://token.example.com/oauth/token')).allowed).toBe(false);
  });

  it.each(allowed)('still allows the public address %s next to those ranges', (ip) => {
    expect(isAllowedServerUrl(`https://${ip}/`)).toBe(true);
  });

  it.each(['0.tcp.ngrok.io', '100.64.example.com', '198.18.example.org', '192.0.0.example.net'])(
    'does not mistake the hostname %s for an address',
    (host) => {
      expect(isAllowedServerUrl(`https://${host}/mcp`)).toBe(true);
    },
  );
});
