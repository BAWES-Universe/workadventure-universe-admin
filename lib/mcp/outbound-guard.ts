/**
 * Outbound destination guard (SSRF prevention) for requests the admin app makes to
 * URLs a bot owner configured: MCP servers and OAuth token endpoints.
 *
 * Moved here unchanged from the connection-test route so the OAuth token exchanges
 * (the authorization callback and the server-side refresh) apply the same check,
 * including the DNS resolution step, before sending credentials anywhere.
 */
import { lookup } from 'dns/promises';
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
    }
    // Reject private IP ranges
    if (/^10\.\d+\.\d+\.\d+$/.test(cleanHostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(cleanHostname)) return false;
    if (/^192\.168\.\d+\.\d+$/.test(cleanHostname)) return false;
    if (/^169\.254\.\d+\.\d+$/.test(cleanHostname)) return false;

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
export async function isAllowedServerIp(serverUrl: string): Promise<{ allowed: boolean; error?: string }> {
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

    const addresses = await lookup(hostname, { all: true });
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
      }
      if (addr.family === 6) {
        // IPv6 private ranges
        if (/^fe[89a-b][0-9a-f]:/i.test(ip)) return { allowed: false, error: 'Server resolves to link-local IPv6 address (fe80:)' };
        if (/^f[cd][0-9a-f]{0,3}:/i.test(ip)) return { allowed: false, error: 'Server resolves to unique-local IPv6 address (fc00::/7)' };
        if (ip === '::1') return { allowed: false, error: 'Server resolves to IPv6 loopback' };
      }
    }
    return { allowed: true };
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
