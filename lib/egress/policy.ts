import { createHmac, timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

/**
 * The rules of Universe's egress gateway, with no server in them (so the gateway, Orbit and the tests read the same rules).
 *
 * A Brick's computer reaches the internet only through the gateway (its Agent37 network rule lists nothing else). The gateway lets the
 * public web through, and refuses, by the name asked for and by the name in the encrypted connection's opening (SNI):
 *  - Composio's names and the names of the Universe AI providers (those are only ever reached through Orbit, which reserves the cost first);
 *  - a raw address that is not backed by a name that resolves to it;
 *  - private, loopback, link-local, cloud-metadata and other internal addresses, by what the name RESOLVES to as well as by the address typed.
 * Nothing in this file talks to the network.
 */

/** The ports a normal job needs: web (80, 443 and the usual alternates), Git over its own protocol, and SSH. Anything else is refused. */
export const DEFAULT_PORTS: readonly number[] = [22, 80, 443, 8080, 8443, 9418];
/** Ports whose first bytes are always inspected before anything is sent on (the client speaks first there). */
export const WEB_PORTS: readonly number[] = [80, 443, 8080, 8443];

/**
 * Names that are never reached from a computer, written as the name and everything under it. Composio's API and dashboard, and the
 * dashboards of the Universe AI providers (their API names come from Orbit's own list of the providers it uses, see lib/egress/deny-list.ts).
 * Orbit's account API for computers is here too: nothing on a computer has a key for it, but nothing on a computer should reach it.
 */
export const BASE_DENIED_NAMES: readonly string[] = [
  'composio.dev',
  'composio.io',
  'api.agent37.com',
  'console.groq.com',
  'platform.openai.com',
  'console.anthropic.com',
  'platform.claude.com',
  'console.x.ai',
  'console.mistral.ai',
  'console.sarvam.ai',
  'dashboard.sarvam.ai',
  'api.together.xyz',
  'api.together.ai',
  'api.fireworks.ai',
  'api.cerebras.ai',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
];

export interface PolicyConfig {
  /** Names (and everything under them) that are refused, on top of the base list. */
  denyNames: readonly string[];
  allowedPorts: readonly number[];
  /** Extra CIDR ranges that are refused, for our own servers' addresses (`1.2.3.4/32`). */
  denyCidrs: readonly string[];
}

export const defaultPolicy = (): PolicyConfig => ({ denyNames: [], allowedPorts: DEFAULT_PORTS, denyCidrs: [] });

/** A host as the policy compares it: lowercased, no trailing dot, no brackets, punycode. Null when it cannot be a host. */
export function normalizeHost(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.+$/, '').toLowerCase();
  if (host === '' || host.length > 253) return null;
  // A zone on an address (`fe80::1%eth0`) is never a public destination
  if (host.includes('%')) return null;
  if (isIP(host) !== 0) return host;
  if (host.includes(':')) return null;
  const ascii = domainToASCII(host);
  if (ascii === '' || ascii.length > 253) return null;
  if (!/^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/.test(ascii)) return null;
  return ascii;
}

export const isIpLiteral = (host: string): boolean => isIP(host) !== 0;

/** `host:port` as a CONNECT line carries it (an address with colons is in brackets). */
export function splitAuthority(authority: string): { host: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:\[\]]+)):(\d{1,5})$/.exec(authority.trim());
  if (!match) return null;
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = normalizeHost(match[1] ?? match[2]);
  return host ? { host, port } : null;
}

// ---------- Addresses ----------

function ipv4Number(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

const v4Ranges: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // shared address space (carrier NAT), also where some clouds put internal services
  ['100.100.100.200', 32], // a cloud's metadata address that sits inside the public block above on some networks
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, and the cloud metadata address 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['168.63.129.16', 32], // Azure's host address
];

function inV4(ip: string, base: string, bits: number): boolean {
  const value = ipv4Number(ip);
  const start = ipv4Number(base);
  if (value === null || start === null) return false;
  if (bits === 0) return true;
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(start / size);
}

/** The 16 bytes of an IPv6 address, or null when it is not one. */
function ipv6Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let text = ip.toLowerCase();
  // A dotted tail (::ffff:1.2.3.4) is turned into two groups
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = ipv4Number(dotted[2]);
    if (v4 === null) return null;
    text = `${dotted[1]}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const [head, tail, ...extra] = text.split('::');
  if (extra.length > 0) return null;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  const all = [...left, ...Array(tail === undefined ? 0 : missing).fill('0'), ...right];
  if (all.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const n = parseInt(group, 16);
    bytes.push(n >> 8, n & 255);
  }
  return bytes;
}

const v4From = (bytes: number[], at: number) => `${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`;

/**
 * Whether an address is one a computer must never reach: this machine, a private network, the cloud's metadata services, a multicast or
 * reserved range, or an IPv6 address that carries one of those inside (v4-mapped, NAT64, 6to4, Teredo). An address that is not an address is refused too.
 */
export function isInternalAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Ranges.some(([base, bits]) => inV4(ip, base, bits));
  if (kind !== 6) return true;
  const bytes = ipv6Bytes(ip);
  if (!bytes) return true;
  const allZero = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  if (allZero(0, 15) && (bytes[15] === 0 || bytes[15] === 1)) return true; // :: and ::1
  if (allZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return isInternalAddress(v4From(bytes, 12)); // ::ffff:a.b.c.d
  if (allZero(0, 12)) return true; // ::a.b.c.d (deprecated, never public)
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && allZero(4, 12)) return isInternalAddress(v4From(bytes, 12)); // 64:ff9b::/96
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isInternalAddress(v4From(bytes, 2)); // 6to4 carries an IPv4 address
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // Teredo
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // documentation
  if (bytes[0] === 0x01 && allZero(1, 8)) return true; // 100::/64 discard
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local (and AWS's fd00:ec2::254)
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (bytes[0] === 0xff) return true; // multicast
  return false;
}

/** Whether an address is in one of the CIDR ranges (IPv4 only: our own servers are on IPv4). */
export function inAnyRange(ip: string, cidrs: readonly string[]): boolean {
  if (isIP(ip) === 6) {
    const bytes = ipv6Bytes(ip);
    if (bytes && bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return inAnyRange(v4From(bytes, 12), cidrs);
    return false;
  }
  return cidrs.some((cidr) => {
    const [base, bits] = cidr.split('/');
    const n = bits === undefined ? 32 : Number(bits);
    return Number.isInteger(n) && n >= 0 && n <= 32 && inV4(ip, base, n);
  });
}

// ---------- Names ----------

/** A name is refused when it is a denied name or sits under one (`x.backend.composio.dev`), never by a partial word (`notcomposio.dev` is not `composio.dev`). */
export function nameDenied(host: string, config: Pick<PolicyConfig, 'denyNames'>): boolean {
  if (isIpLiteral(host)) return false;
  const names = [...BASE_DENIED_NAMES, ...config.denyNames];
  return names.some((name) => {
    const clean = normalizeHost(name);
    return clean !== null && !isIpLiteral(clean) && (host === clean || host.endsWith(`.${clean}`));
  });
}

export type Refusal = { ok: false; status: 400 | 403 | 407 | 502; reason: string };
export type Allowed = { ok: true };

/** The checks that need no lookup: the port, the name, and an address typed in place of a name. */
export function checkTarget(host: string, port: number, config: PolicyConfig): Allowed | Refusal {
  if (!config.allowedPorts.includes(port)) return { ok: false, status: 403, reason: 'port_refused' };
  if (nameDenied(host, config)) return { ok: false, status: 403, reason: 'name_refused' };
  if (isIpLiteral(host)) {
    if (isInternalAddress(host) || inAnyRange(host, config.denyCidrs)) return { ok: false, status: 403, reason: 'internal_address' };
  }
  return { ok: true };
}

/** What a name resolved to: refused when any answer is internal or ours, because a name that can point inside is never connected to. */
export function checkResolved(addresses: readonly string[], config: Pick<PolicyConfig, 'denyCidrs'>): Allowed | Refusal {
  if (addresses.length === 0) return { ok: false, status: 502, reason: 'no_address' };
  for (const address of addresses) {
    if (isInternalAddress(address) || inAnyRange(address, config.denyCidrs)) return { ok: false, status: 403, reason: 'resolves_inside' };
  }
  return { ok: true };
}

// ---------- What the first bytes of a connection say ----------

export type Hello = { kind: 'need_more' } | { kind: 'not_tls' } | { kind: 'tls'; sni: string | null };

/** The most a TLS record may hold, plus its 5-byte header: a ClientHello longer than this is not one. */
const MAX_HELLO = 16384 + 5;

/** Reads the server name out of a TLS ClientHello. `need_more` until the whole first record is here; `not_tls` for anything else. */
export function readClientHello(buf: Uint8Array): Hello {
  if (buf.length < 1) return { kind: 'need_more' };
  if (buf[0] !== 0x16) return { kind: 'not_tls' };
  if (buf.length < 5) return { kind: 'need_more' };
  if (buf[1] !== 0x03) return { kind: 'not_tls' };
  const recordLength = (buf[3] << 8) | buf[4];
  if (recordLength > 16384 || recordLength < 4) return { kind: 'not_tls' };
  if (buf.length < 5 + recordLength) return { kind: 'need_more' };
  const end = 5 + recordLength;
  let at = 5;
  if (buf[at] !== 0x01) return { kind: 'not_tls' };
  const take = (n: number) => {
    if (at + n > end) throw new RangeError('short');
    const from = at;
    at += n;
    return from;
  };
  try {
    take(4); // handshake type and length
    take(2 + 32); // version and random
    const sessionLength = buf[take(1)];
    take(sessionLength);
    const suites = (buf[take(1)] << 8) | buf[take(1)];
    take(suites);
    const compression = buf[take(1)];
    take(compression);
    if (at === end) return { kind: 'tls', sni: null };
    const extensionsLength = (buf[take(1)] << 8) | buf[take(1)];
    const extensionsEnd = Math.min(end, at + extensionsLength);
    while (at + 4 <= extensionsEnd) {
      const type = (buf[take(1)] << 8) | buf[take(1)];
      const length = (buf[take(1)] << 8) | buf[take(1)];
      if (type !== 0x0000) {
        take(length);
        continue;
      }
      const listLength = (buf[take(1)] << 8) | buf[take(1)];
      const listEnd = at + Math.min(listLength, length - 2);
      while (at + 3 <= listEnd) {
        const nameType = buf[take(1)];
        const nameLength = (buf[take(1)] << 8) | buf[take(1)];
        const from = take(nameLength);
        if (nameType === 0) return { kind: 'tls', sni: normalizeHost(Buffer.from(buf.subarray(from, from + nameLength)).toString('latin1')) ?? '?' };
      }
      return { kind: 'tls', sni: null };
    }
    return { kind: 'tls', sni: null };
  } catch {
    return { kind: 'not_tls' };
  }
}

export const HELLO_LIMIT = MAX_HELLO;

/** The Host of a plain HTTP request's first bytes, `need_more` while the headers are not all here, null when it is not HTTP (or has no Host). */
export function readHttpHost(buf: Uint8Array): { kind: 'need_more' } | { kind: 'not_http' } | { kind: 'http'; host: string | null } {
  const text = Buffer.from(buf.subarray(0, Math.min(buf.length, 8192))).toString('latin1');
  const lineEnd = text.indexOf('\n');
  if (lineEnd < 0) return text.length < 8192 && /^([A-Z]{0,10}|[A-Z]{3,10} \S*|[A-Z]{3,10} \S+ (H|HT|HTT|HTTP|HTTP\/|HTTP\/1|HTTP\/1\.|HTTP\/1\.[01]\r?)?)$/.test(text) ? { kind: 'need_more' } : { kind: 'not_http' };
  if (!/^[A-Z]{3,10} \S+ HTTP\/1\.[01]\r?$/.test(text.slice(0, lineEnd))) return { kind: 'not_http' };
  const headersEnd = text.search(/\r?\n\r?\n/);
  if (headersEnd < 0) return text.length >= 8192 ? { kind: 'not_http' } : { kind: 'need_more' };
  const match = /\r?\nhost:[ \t]*([^\r\n]*)/i.exec(text.slice(0, headersEnd));
  if (!match) return { kind: 'http', host: null };
  const value = match[1].trim();
  const authority = value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.split(':')[0];
  return { kind: 'http', host: normalizeHost(authority) ?? '?' };
}

// ---------- The gateway's key for one computer ----------

/** Longest a key may be good for, whatever the key says: a key that claims more is refused. */
export const MAX_KEY_LIFE_MS = 4 * 24 * 60 * 60 * 1000;
/** How long Orbit makes one. Written again each time a computer is made ready (every job start), so a computer in use never runs out. */
export const KEY_LIFE_MS = 3 * 24 * 60 * 60 * 1000;

const signature = (secret: string, machine: string, expires: number) => createHmac('sha256', secret).update(`egress-v1|${machine}|${expires}`).digest('base64url');

/** A key for one computer: good for this machine only, until `expires`. The gateway checks it with the same secret; it holds no state. */
export function mintEgressKey(secret: string, machine: string, now: number = Date.now(), lifeMs: number = KEY_LIFE_MS): { user: string; pass: string; expiresAt: number } {
  const expiresAt = Math.floor((now + lifeMs) / 1000);
  return { user: machine, pass: `${expiresAt}.${signature(secret, machine, expiresAt)}`, expiresAt: expiresAt * 1000 };
}

export type KeyCheck = { ok: true; machine: string } | { ok: false };

export function verifyEgressKey(secret: string, user: string, pass: string, now: number = Date.now()): KeyCheck {
  if (!secret || typeof user !== 'string' || typeof pass !== 'string' || user.length === 0 || user.length > 100 || pass.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(user)) return { ok: false };
  const dot = pass.indexOf('.');
  if (dot < 1) return { ok: false };
  const expires = Number(pass.slice(0, dot));
  if (!Number.isInteger(expires) || expires * 1000 <= now || expires * 1000 > now + MAX_KEY_LIFE_MS) return { ok: false };
  const given = Buffer.from(pass.slice(dot + 1));
  const wanted = Buffer.from(signature(secret, user, expires));
  return given.length === wanted.length && timingSafeEqual(given, wanted) ? { ok: true, machine: user } : { ok: false };
}

/** `Proxy-Authorization: Basic ...` to a user and password, or null. */
export function readBasic(header: string | undefined): { user: string; pass: string } | null {
  if (!header || !/^basic /i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 1 ? null : { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}
