import https from 'https';
import { BlockList, isIP } from 'net';
import { lookup } from 'dns/promises';

/**
 * The only way Orbit calls an address a person typed (#374): an AI key on their own computer, or their own NIM. The
 * game's bot server runs the same rules before every reply.
 *
 * - https only, with a name: never a bare IP, never `localhost`, no user name or password in the address.
 * - The name is looked up first. If ANY address it gives is private, loopback, link-local, carrier-grade, multicast,
 *   reserved or documentation space (home and office networks, the server itself, cloud metadata), the call is refused.
 * - The connection then goes to the address that was checked, never to a second lookup, so the name can't switch to a
 *   private address between the check and the call.
 * - No redirect is followed, the wait is short and the answer has a size cap.
 */

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** Whether a server may connect to this address at all. IPv4-mapped IPv6 addresses are checked as their IPv4. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export type AddressProblem = 'not-https' | 'not-a-name' | 'credentials' | 'private' | 'unresolved';

export class AddressError extends Error {
  constructor(public readonly problem: AddressProblem) {
    super(problem);
  }
}

/** What to tell the person, in plain words, for each way an address can be refused. */
export const ADDRESS_PROBLEM_TEXT: Record<AddressProblem, string> = {
  'not-https': 'The address must start with https://.',
  'not-a-name': 'Use a name like lm.example.com, not a number address or localhost.',
  credentials: 'Leave the user name and password out of the address.',
  private: 'That address points to a private network, so Universe can’t reach it.',
  unresolved: 'That address doesn’t exist. Check the spelling.',
};

export interface CheckedAddress {
  url: URL;
  /** The first checked address, kept for callers that want one. */
  address: string;
  family: 4 | 6;
  /** Every address the name gave, all checked public. The connection may use any of them, so a missing IPv6 route falls back to IPv4. */
  addresses: { address: string; family: 4 | 6 }[];
}

/** Everything about the address that can be checked without a lookup; throws an AddressError. */
export function parsePublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AddressError('not-https');
  }
  if (url.protocol !== 'https:') throw new AddressError('not-https');
  if (url.username || url.password) throw new AddressError('credentials');
  const host = url.hostname.toLowerCase();
  // A name has a dot and a letter somewhere: not an IP in any spelling (1.2.3.4, [::1], 0x7f.1, 2130706433).
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 || !host.includes('.') || !/[a-z]/.test(host) || host === 'localhost' || host.endsWith('.localhost')) {
    throw new AddressError('not-a-name');
  }
  return url;
}

/** Parse, look the name up, and refuse unless every address it gives is public. */
export async function checkPublicHttpsUrl(raw: string): Promise<CheckedAddress> {
  const url = parsePublicHttpsUrl(raw);
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new AddressError('unresolved');
  }
  if (addresses.length === 0) throw new AddressError('unresolved');
  if (addresses.some((entry) => !isPublicAddress(entry.address))) throw new AddressError('private');
  const checked = addresses.map((entry) => ({ address: entry.address, family: entry.family === 6 ? (6 as const) : (4 as const) }));
  return { url, address: checked[0].address, family: checked[0].family, addresses: checked };
}

export interface SafeGetOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export type SafeGetResult =
  | { ok: true; status: number; body: string }
  | { ok: false; reason: 'timeout' | 'unreachable' | 'too-large' };

/**
 * GET a checked address. Redirects are returned as they are (the caller treats any 3xx as a failure) and never followed.
 * The socket connects only to the checked addresses (any of them, so a missing IPv6 route falls back to IPv4), with the
 * name still used for the certificate.
 */
export function safeGet(checked: CheckedAddress, options: SafeGetOptions = {}): Promise<SafeGetResult> {
  const { timeoutMs = 10_000, maxBytes = 1_000_000, headers = {} } = options;
  const { url, addresses } = checked;
  return new Promise<SafeGetResult>((resolve) => {
    let settled = false;
    const finish = (result: SafeGetResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const request = https.request(
      {
        method: 'GET',
        hostname: url.hostname,
        servername: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: { Accept: 'application/json', ...headers },
        // The name is never looked up again: the socket gets the addresses that were checked, and Node tries the next
        // one when the first has no route (a server without IPv6; automatic from Node 20).
        lookup: ((_host: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (lookupOptions && lookupOptions.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }) as never,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish({ ok: false, reason: 'too-large' });
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => finish({ ok: true, status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', () => finish({ ok: false, reason: 'unreachable' }));
      },
    );
    const deadline = setTimeout(() => {
      finish({ ok: false, reason: 'timeout' });
      request.destroy();
    }, timeoutMs);
    request.on('error', () => finish({ ok: false, reason: 'unreachable' }));
    request.end();
  }).catch(() => ({ ok: false as const, reason: 'unreachable' as const }));
}
