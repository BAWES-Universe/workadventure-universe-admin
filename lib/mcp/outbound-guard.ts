/**
 * Outbound destination guard (SSRF prevention) for requests the admin app makes to
 * URLs a bot owner configured: MCP servers and OAuth token endpoints.
 *
 * Moved here unchanged from the connection-test route so the OAuth token exchanges
 * (the authorization callback and the server-side refresh) apply the same check,
 * including the DNS resolution step, before sending credentials anywhere.
 */
import { resolveHost } from '@/lib/name-lookup';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { isIP } from 'net';

/**
 * The IPv4 address inside an IPv4-mapped IPv6 address, in either spelling:
 * `::ffff:127.0.0.1`, or `::ffff:7f00:1`, which is how `new URL()` and DNS lookups
 * canonicalise it. Returns null for anything else. Without the hex form, a mapped
 * loopback or metadata address passed every IPv4 check below (#193 review).
 */
function mappedIpv4(ip: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * IPv4 addresses that are not private in the RFC 1918 sense but are not the public internet either:
 * 0.0.0.0/8, 100.64.0.0/10 (shared address space; some providers' metadata address, 100.100.100.200, is in it),
 * 192.0.0.0/24 and 198.18.0.0/15. The documentation ranges 198.51.100.0/24 and 203.0.113.0/24 stay allowed.
 */
function isSharedOrReservedIpv4(ip: string): boolean {
  // A hostname such as 0.tcp.ngrok.io starts like an address but is a name: only a whole IPv4 address counts
  if (isIP(ip) !== 4) return false;
  return (
    /^0\./.test(ip) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ||
    /^192\.0\.0\./.test(ip) ||
    /^198\.1[89]\./.test(ip)
  );
}

// Reject MCP server URLs that point to internal infrastructure (SSRF prevention)
export function isAllowedServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // Strip brackets from IPv6 literals (new URL('http://[::1]').hostname returns '[::1]')
    const cleanHostname = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

    // Reject localhost variants
    if (cleanHostname === 'localhost' || cleanHostname === '::1') return false;
    if (/^127\.\d+\.\d+\.\d+$/.test(cleanHostname)) return false;    // 127.0.0.0/8 loopback
    if (/^0\.0\.0\.0$/.test(cleanHostname)) return false;
    // Handle IPv4-mapped IPv6 addresses (::ffff:127.0.0.1, ::ffff:7f00:1, etc.). One that
    // cannot be decoded is refused rather than let through unchecked.
    if (/^::ffff:/i.test(cleanHostname)) {
      const ipv4 = mappedIpv4(cleanHostname);
      if (ipv4 === null) return false;
      if (/^127\.\d+\.\d+\.\d+$/.test(ipv4) || ipv4 === '0.0.0.0') return false;
      if (/^10\.\d+\.\d+\.\d+$/.test(ipv4) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(ipv4)) return false;
      if (/^192\.168\.\d+\.\d+$/.test(ipv4) || /^169\.254\.\d+\.\d+$/.test(ipv4)) return false;
      if (isSharedOrReservedIpv4(ipv4)) return false;
    }
    // Reject private IP ranges
    if (/^10\.\d+\.\d+\.\d+$/.test(cleanHostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(cleanHostname)) return false;
    if (/^192\.168\.\d+\.\d+$/.test(cleanHostname)) return false;
    if (/^169\.254\.\d+\.\d+$/.test(cleanHostname)) return false;
    if (isSharedOrReservedIpv4(cleanHostname)) return false;

    // Reject private IPv6 ranges (unique-local, link-local, loopback)
    if (/^f[cd][0-9a-f]{0,3}:/i.test(cleanHostname)) return false; // fc00::/7 unique-local
    if (/^fe[89a-b][0-9a-f]:/i.test(cleanHostname)) return false;         // fe80::/10 link-local
    if (/^::$/.test(cleanHostname)) return false;                    // :: (unspecified)

    // Reject cloud metadata endpoints
    if (cleanHostname === '169.254.169.254') return false;
    if (cleanHostname === 'metadata.google.internal' || cleanHostname === 'metadata.internal') return false;
    if (cleanHostname.endsWith('.internal')) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a hostname to its IP addresses and verify none are private.
 * Catches DNS-based SSRF bypasses (domain → private IP).
 */
export async function isAllowedServerIp(serverUrl: string): Promise<{ allowed: boolean; error?: string; addresses?: { address: string; family: number }[] }> {
  try {
    const parsed = new URL(serverUrl);
    let hostname = parsed.hostname.toLowerCase();
    // Strip brackets from IPv6 literals (new URL('http://[::1]').hostname returns '[::1]')
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }

    // Check IP literal hostnames directly (the hostname-pattern check above cannot
    // catch all private IPv6 ranges, so we must check them here too)
    if (isIP(hostname)) {
      if (hostname === '::1' || hostname === '::' || hostname === '0.0.0.0') {
        return { allowed: false, error: `Server uses loopback address (${hostname})` };
      }
      if (/^127\./.test(hostname)) {
        return { allowed: false, error: `Server uses loopback address (${hostname})` };
      }
      // Handle IPv4-mapped IPv6 (::ffff:127.0.0.1, ::ffff:10.0.0.1, etc.)
      if (/^::ffff:/i.test(hostname)) {
        const ipv4 = mappedIpv4(hostname);
        if (ipv4 === null) {
          return { allowed: false, error: `Server uses an IPv4-mapped IPv6 address that could not be checked (${hostname})` };
        }
        if (/^127\./.test(ipv4) || ipv4 === '0.0.0.0') {
          return { allowed: false, error: `Server uses loopback address via IPv4-mapped IPv6 (${hostname})` };
        }
        if (/^10\./.test(ipv4)) {
          return { allowed: false, error: `Server resolves to private IP via IPv4-mapped IPv6 (${hostname})` };
        }
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(ipv4)) {
          return { allowed: false, error: `Server resolves to private IP via IPv4-mapped IPv6 (${hostname})` };
        }
        if (/^192\.168\./.test(ipv4)) {
          return { allowed: false, error: `Server resolves to private IP via IPv4-mapped IPv6 (${hostname})` };
        }
        if (/^169\.254\./.test(ipv4)) {
          return { allowed: false, error: `Server resolves to link-local via IPv4-mapped IPv6 (${hostname})` };
        }
        if (isSharedOrReservedIpv4(ipv4)) {
          return { allowed: false, error: `Server resolves to a shared or reserved address via IPv4-mapped IPv6 (${hostname})` };
        }
      }
      if (isSharedOrReservedIpv4(hostname)) {
        return { allowed: false, error: `Server uses a shared or reserved IP address (${hostname})` };
      }
      if (/^10\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
          /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname)) {
        return { allowed: false, error: `Server uses private IP address (${hostname})` };
      }
      if (/^f[cd][0-9a-f]{0,3}:/i.test(hostname)) {
        return { allowed: false, error: 'Server uses unique-local IPv6 address (fc00::/7)' };
      }
      if (/^fe[89a-b][0-9a-f]:/i.test(hostname)) {
        return { allowed: false, error: 'Server uses link-local IPv6 address (fe80::/10)' };
      }
      // IP literal that passed all checks — still resolve it to catch CNAME-based bypasses
    }

    const addresses = await resolveHost(hostname);
    for (const addr of addresses) {
      const ip = addr.address;
      // Reject private and loopback ranges
      if (ip === '::1' || ip === '0.0.0.0') {
        return { allowed: false, error: `Server resolves to loopback address (${ip})` };
      }
      if (/^127\./.test(ip)) {
        return { allowed: false, error: `Server resolves to loopback address (${ip})` };
      }
      if (/^10\./.test(ip)) {
        return { allowed: false, error: `Server resolves to private IP range (10.x.x.x)` };
      }
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
        return { allowed: false, error: `Server resolves to private IP range (172.16-31.x.x)` };
      }
      if (/^192\.168\./.test(ip)) {
        return { allowed: false, error: `Server resolves to private IP range (192.168.x.x)` };
      }
      if (/^169\.254\./.test(ip)) {
        return { allowed: false, error: `Server resolves to link-local address (169.254.x.x)` };
      }
      if (isSharedOrReservedIpv4(ip)) {
        return { allowed: false, error: `Server resolves to a shared or reserved address (${ip})` };
      }
      // Handle IPv4-mapped IPv6 in DNS results
      if (/^::ffff:/i.test(ip)) {
        const ipv4 = mappedIpv4(ip);
        if (ipv4 === null) {
          return { allowed: false, error: `Server resolves to an IPv4-mapped IPv6 address that could not be checked (${ip})` };
        }
        if (/^127\./.test(ipv4) || ipv4 === '0.0.0.0') {
          return { allowed: false, error: `Server resolves to loopback via IPv4-mapped IPv6 (${ip})` };
        }
        if (/^10\./.test(ipv4) || /^172\.(1[6-9]|2\d|3[01])\./.test(ipv4)) {
          return { allowed: false, error: `Server resolves to private IP via IPv4-mapped IPv6 (${ip})` };
        }
        if (/^192\.168\./.test(ipv4) || /^169\.254\./.test(ipv4)) {
          return { allowed: false, error: `Server resolves to private/link-local via IPv4-mapped IPv6 (${ip})` };
        }
        if (isSharedOrReservedIpv4(ipv4)) {
          return { allowed: false, error: `Server resolves to a shared or reserved address via IPv4-mapped IPv6 (${ip})` };
        }
      }
      if (addr.family === 6) {
        // IPv6 private ranges
        if (/^fe[89a-b][0-9a-f]:/i.test(ip)) return { allowed: false, error: 'Server resolves to link-local IPv6 address (fe80:)' };
        if (/^f[cd][0-9a-f]{0,3}:/i.test(ip)) return { allowed: false, error: 'Server resolves to unique-local IPv6 address (fc00::/7)' };
        if (ip === '::1') return { allowed: false, error: 'Server resolves to IPv6 loopback' };
      }
    }
    // The addresses that were checked, so a request can be made to exactly these and never to a second look-up of the name
    return { allowed: true, addresses };
  } catch (dnsError: unknown) {
    const message = dnsError instanceof Error ? dnsError.message : 'Unknown error';
    return { allowed: false, error: `DNS resolution failed: ${message}` };
  }
}

/**
 * Both checks in order: the hostname pattern first, then the resolved addresses.
 * Resolves to `{ allowed: false, error }` rather than throwing.
 */
export async function checkOutboundUrl(url: string): Promise<{ allowed: boolean; error?: string }> {
  if (!isAllowedServerUrl(url)) {
    return { allowed: false, error: 'URL points to an internal or private address' };
  }
  return isAllowedServerIp(url);
}

/** Waits for `work`, or ends with the signal's reason when the signal ends first (also when it already has). The listener is taken off when either ends. */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  const reason = () => (signal.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError'));
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(reason());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * The socket's own name look-up, answered from the addresses that were checked: all of them (in the order they came) when the socket asks for all, the
 * first when it asks for one. Nothing is ever resolved here, so an address that was not checked can never be reached.
 */
export function pinnedLookup(addresses: ReadonlyArray<{ address: string; family: number }>) {
  return (_name: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void): void => {
    if (options && options.all) callback(null, addresses.map(({ address, family }) => ({ address, family })));
    else callback(null, addresses[0].address, addresses[0].family);
  };
}

/**
 * A request made to the address that was checked, never to a second look-up of the name. `fetch` resolves the host again after the
 * check, so a name that answers with a public address for the check and an internal one a moment later (DNS rebinding) would reach
 * the internal one. Here the name is resolved once, every address is checked, and the connection is made to the one checked (the
 * certificate is still checked against the name). It never follows a redirect: the caller asks again for each hop and checks it.
 * An unchecked name or an address that is not allowed throws before anything is sent.
 */
export async function pinnedFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('Only http and https addresses are allowed');
  // A stalled resolver never holds a caller that has given up: the wait ends with the signal, and a look-up that answers late starts nothing
  const checked = await untilAborted(isAllowedServerIp(url), init.signal);
  if (!checked.allowed || !checked.addresses || checked.addresses.length === 0) throw new Error(checked.error || 'Server URL resolves to a blocked address');
  const addresses = checked.addresses;
  const useHttps = target.protocol === 'https:';
  const hostname = target.hostname.startsWith('[') ? target.hostname.slice(1, -1) : target.hostname;
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    // The answer is read as it comes, never decoded: a caller's own accept-encoding would let a server send it compressed and the bytes would be handed on as they are
    for (const [name, value] of Object.entries(init.headers ?? {})) if (!['host', 'content-length', 'transfer-encoding', 'accept-encoding'].includes(name.toLowerCase())) headers[name] = value;
    const request = (useHttps ? https : http).request(
      {
        host: hostname,
        port: target.port ? Number(target.port) : useHttps ? 443 : 80,
        method: init.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        headers,
        signal: init.signal,
        agent: false,
        // The name is never resolved again: the socket goes to the addresses that were checked, and to no other. When the first does not answer (a
        // name with an IPv6 and an IPv4 address on a machine with no IPv6 way out) the socket tries the next checked one, as an ordinary connection would
        lookup: pinnedLookup(addresses) as never,
        autoSelectFamily: true,
      } as import('node:http').RequestOptions,
      (incoming) => {
        // This runs when the answer arrives, long after the request was made: what it throws is not seen by any caller's catch, so it ends the request here
        try {
          const status = incoming.statusCode ?? 0;
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const one of value) responseHeaders.append(name, one);
            else if (typeof value === 'string') responseHeaders.set(name, value);
          }
          const noBody = [101, 204, 205, 304].includes(status);
          if (noBody) incoming.resume();
          // A status outside 200-599 (a server that answers 600) is refused by Response itself
          resolve(new Response(noBody ? null : (Readable.toWeb(incoming) as ReadableStream), { status, statusText: incoming.statusMessage ?? '', headers: responseHeaders }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    request.on('error', reject);
    request.end(init.body);
  });
}
