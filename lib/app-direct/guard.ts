import https from 'node:https';
import { resolveHost } from '@/lib/name-lookup';
import { BlockList, isIP } from 'node:net';
import { isAllowedServerUrl } from '@/lib/mcp/outbound-guard';

/**
 * The strict outgoing guard for key apps (game #2044). Everything a key travels with goes through `guardedRequest`:
 *  - HTTPS only, the usual port only, no sign-in in the address;
 *  - the name is resolved once, EVERY address must be public, and the connection is then made to that address, with the name kept
 *    for the certificate check, so a name that answers differently a moment later cannot send the key somewhere else;
 *  - private, loopback, link-local, shared, reserved, documentation, multicast and translated (IPv4-mapped, NAT64, 6to4) addresses
 *    are refused;
 *  - a redirect is never followed (the key would go with it): it is an answer like any other, `redirected`;
 *  - the answer is cut at a size and the wait at a time, both set by the caller from the Limits settings;
 *  - nothing it throws or returns holds the address, so a key placed in the query never reaches a log through an error.
 */

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
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
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) blocked.addSubnet(net, bits, 'ipv6');

/** True for an address on the public internet. Anything that cannot be read as an address is false. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    // ::ffff:a.b.c.d and ::ffff:hhhh:hhhh carry an IPv4 address: it is the one that counts
    const mapped = /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
    if (mapped) {
      const v4 = mapped[1] ?? `${parseInt(mapped[2], 16) >> 8}.${parseInt(mapped[2], 16) & 255}.${parseInt(mapped[3], 16) >> 8}.${parseInt(mapped[3], 16) & 255}`;
      return isPublicAddress(v4);
    }
    // Any other ::ffff:0:0/96 spelling, and the old IPv4-compatible form ::a.b.c.d
    if (/^::ffff:/i.test(address) || /^::\d/.test(address) || /^0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:ffff:/i.test(address)) return false;
  }
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class GuardError extends Error {
  constructor(
    readonly code: 'blocked' | 'unreachable' | 'timeout' | 'too_big',
    /** Plain words for a log. Never the address and never anything from the request. */
    message: string,
    /** Orbit itself had no room to try (too many name lookups waiting): says nothing about the service. */
    readonly atOurEnd = false,
  ) {
    super(message);
  }
}

/**
 * The service did not answer: no answer in time, or it could not be reached. Never Orbit's own lack of room to try (atOurEnd), and never an
 * address that was refused before anything was sent: Orbit being busy never marks a person's key App as not answering.
 */
export const serviceDidNotAnswer = (error: unknown): boolean =>
  error instanceof GuardError && !error.atOurEnd && (error.code === 'timeout' || error.code === 'unreachable');

export interface GuardedAnswer {
  status: number;
  redirected: boolean;
  /** The answer as text, cut at `maxBytes`. */
  body: string;
  truncated: boolean;
  contentType: string | null;
}

export interface GuardedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}

type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
type Send = (target: { host: string; address: string; family: number; path: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number }) => Promise<GuardedAnswer>;

export interface GuardDeps {
  resolve?: Resolve;
  send?: Send;
}

const defaultResolve: Resolve = (host) => resolveHost(host);

/**
 * The checked address the connection is made to. Passing `lookup` to the request replaces name resolution, so the socket goes to
 * the address that was checked; `servername` keeps the certificate checked against the name.
 */
const defaultSend: Send = (target) =>
  new Promise<GuardedAnswer>((resolve, reject) => {
    let settled = false;
    const done = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    // A body goes with its exact length, counted in bytes once: without it Node sends the body in chunks, and some services answer that
    // with 411 or 400. Whatever length or transfer coding the caller named is dropped (any spelling), so the two can never disagree.
    const payload = target.body === undefined ? null : Buffer.from(target.body, 'utf8');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(target.headers)) if (!['content-length', 'transfer-encoding', 'host'].includes(name.toLowerCase())) headers[name] = value;
    headers.host = target.host;
    if (payload) headers['content-length'] = String(payload.length);
    const request = https.request(
      {
        host: target.host,
        port: 443,
        method: target.method,
        path: target.path,
        headers,
        servername: target.host,
        // Node may ask for one address or for all of them; either way the answer is the one that was checked
        lookup: ((_name: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options && options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        }) as never,
        agent: false,
        rejectUnauthorized: true,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const redirected = status >= 300 && status < 400;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        response.on('data', (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > target.maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - target.maxBytes))));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const finish = () =>
          done(() =>
            resolve({
              status,
              redirected,
              body: redirected ? '' : Buffer.concat(chunks).toString('utf8'),
              truncated,
              contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : null,
            }),
          );
        response.on('end', finish);
        response.on('close', finish);
        response.on('error', () => (truncated ? finish() : done(() => reject(new GuardError('unreachable', 'The answer broke off')))));
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      done(() => reject(new GuardError('timeout', 'No answer in time')));
    }, target.timeoutMs);
    request.on('error', () => done(() => reject(new GuardError('unreachable', 'The service could not be reached'))));
    if (payload) request.write(payload);
    request.end();
  });

/** The address after the checks, split for the connection; throws `blocked` for anything not allowed. */
export function targetOf(url: string): { host: string; path: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GuardError('blocked', 'Not an address');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new GuardError('blocked', 'Only https on the usual port');
  const host = parsed.hostname.toLowerCase();
  if (isIP(host) || host.startsWith('[') || !isAllowedServerUrl(`https://${host}/`)) throw new GuardError('blocked', 'A private place');
  return { host, path: `${parsed.pathname}${parsed.search}` };
}

/** Name lookups still waiting for the system's resolver, including ones whose caller has already given up. */
let lookupsInFlight = 0;
const MAX_LOOKUPS_IN_FLIGHT = 16;

export async function guardedRequest(request: GuardedRequest, deps: GuardDeps = {}): Promise<GuardedAnswer> {
  const { host, path } = targetOf(request.url);
  // One deadline for the whole call: the name is asked for inside it, and the request gets only what is left
  const startedAt = Date.now();
  let addresses: { address: string; family: number }[];
  let stopWaiting: ReturnType<typeof setTimeout> | undefined;
  // A name lookup cannot be cancelled: after the deadline it goes on until the resolver gives up (it ends each try by itself, and uses no worker thread that
  // other work needs). So it counts as in flight until it SETTLES, not until the caller gave up, and only so many run at once: a service whose name never
  // answers cannot pile lookups up
  if (lookupsInFlight >= MAX_LOOKUPS_IN_FLIGHT) throw new GuardError('unreachable', 'Too many name lookups are waiting', true);
  lookupsInFlight += 1;
  let lookup: Promise<{ address: string; family: number }[]>;
  try {
    lookup = (deps.resolve ?? defaultResolve)(host);
  } catch (error) {
    lookupsInFlight -= 1;
    throw error;
  }
  void lookup.then(
    () => (lookupsInFlight -= 1),
    () => (lookupsInFlight -= 1),
  );
  try {
    addresses = await Promise.race([
      lookup,
      new Promise<never>((_resolve, reject) => {
        stopWaiting = setTimeout(() => reject(new GuardError('timeout', 'No answer in time')), request.timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof GuardError) throw error;
    throw new GuardError('unreachable', 'The name did not resolve');
  } finally {
    clearTimeout(stopWaiting);
  }
  const timeLeft = request.timeoutMs - (Date.now() - startedAt);
  if (timeLeft <= 0) throw new GuardError('timeout', 'No answer in time');
  if (addresses.length === 0) throw new GuardError('unreachable', 'The name did not resolve');
  // Every address, not only the one used: a name that also points inside is refused whole
  if (!addresses.every((entry) => isPublicAddress(entry.address))) throw new GuardError('blocked', 'A private place');
  const chosen = addresses[0];
  return (deps.send ?? defaultSend)({
    host,
    address: chosen.address,
    family: chosen.family,
    path,
    method: request.method,
    headers: request.headers,
    body: request.body,
    timeoutMs: timeLeft,
    maxBytes: request.maxBytes,
  });
}
